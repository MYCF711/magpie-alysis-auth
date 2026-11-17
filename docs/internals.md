# 内部实现与证据

## 数据通道：直连 Alysis 上游网关

插件**直接调上游**，不经过任何本地反代或中间进程（0.1.9 起）：

| 用途 | 地址 | 用谁的 key |
| --- | --- | --- |
| 模型请求 | `https://vzigujbcjjmpntxhmyvr.supabase.co/functions/v1/llm/v1` | 该账号自己的 `slk_`（`Authorization: Bearer`） |
| 模型目录 | 同基址 `GET /models` | 同上，目录属于这个 key |
| 额度 | `https://vzigujbcjjmpntxhmyvr.supabase.co/functions/v1/account-status` | 同上 |

为什么不走本地反代：反代是单账号池，多个 Alysis 账号会串账 —— 所有卡片都显示第一张卡的额度，
模型列表和请求也都落到同一个号上。每账号直连后，请求、模型、额度三者都用账号自己的 key。

代价：429 不再由本地排队消化。上游容量忙时 429 原样返回，交给 magpie 的账号路由换号或降级；
插件不改写流式响应、不读流。

连不上网关（`ECONNREFUSED` / `fetch failed`）时，`loader.fetch` 捕获后返回 503 +
`alysis_upstream_unreachable`，不抛未处理异常。

## 登录：导入本机凭证

`authorize()` 立刻返回（铁律 2），真正的读取放在 `callback()`：

```
%LOCALAPPDATA%\alysis\alysis\credentials.json   ← CLI runtime 写入的位置
%LOCALAPPDATA%\alysis-code\credentials.json
%APPDATA%\Alysis Code\credentials.json
~\.alysis\credentials.json
```

文件格式：

```json
{ "profile_keys": { "alysis": "slk_…" } }
```

插件只读这些文件，不写。`uid` 用 key 的 SHA-256 前 12 位（区分多账号），`accountId` 留空
（本机凭证没有用户名；按规范「名字取不到就是空串」，不拿内部 ID 冒充名字）。

## 浏览器隔离（备选登录方式）

默认路径不打开任何浏览器。本机客户端没登录时，用「在隔离浏览器里登录」：

1. `POST {cloud}/device-code`（`client_name` + 随机 `installation_id`）拿 `user_code`；
2. `openIsolatedBrowser()` 用独立 `--user-data-dir=%TEMP%\magpie-alysis-login-*` 启动 Chromium，
   打开 `https://alysiscode.com/activate?code=<user_code>` —— 没有用户日常浏览器的 Cookie / 扩展 / 同步；
3. 轮询 `POST {cloud}/device-token` 直到 `approved`，拿 `slk_` key；
4. `finally` 里 kill 浏览器并删除整个临时 profile。

协议来自 Alysis Code CLI：`alysis_code/alysis_cloud.py`（端点与 URL）与 `account_login.py`
（`_request_device_code` / `_poll_for_key` 的字段与状态机）。云地址不是凭据，服务端按设备键认证。

找不到 Chromium 内核浏览器时明确报错，**不会退回默认浏览器** —— 退回就等于复用用户日常会话。

## 模型目录

`provider.models()` 调 `GET {BASE}/models`，反代自己按 `models.cacheSeconds` 从上游
`/models` 自动发现并缓存。返回字段：

```json
{ "id": "deepseek-flash", "context_length": 1000000, "supports_vision": true,
  "supports_reasoning": true, "description": "…" }
```

三态降级（按脚手架坑 17）：

- 接口失败 → 退回静态 6 条（`staticModels()`），列表不空；
- 接口成功但某条缺字段 → 用静态表里该 id 的配置补齐，不猜；
- 登录失效（明确 401 / `invalid_key`）→ 抛 `signIn: "expired"`。

静态表按 id 推断协议：含 `luna` → `@ai-sdk/openai`（Responses），含 `claude` →
`@ai-sdk/anthropic`（Messages），其余 `@ai-sdk/openai-compatible`（Chat）。

## 额度

`GET {BASE}/usage` 返回 `account_status.billing`（来自上游 account-status）：

| 字段 | 含义 |
| --- | --- |
| `cap_5h_microusd` / `burn_5h_microusd` | 5 小时公平使用上限 / 已用（micro-USD） |
| `cap_7d_microusd` / `burn_7d_microusd` | 7 天窗口 |
| `balance_microusd` | 免费余额 |
| `free_next_refill_at` | 月度补充时间（作为 `until`） |

窗口用 `src/quota.mjs` 构造：

- 5 小时、7 天：占比型（`used` 必填，`span` 18000 / 604800）；
- 余额：钱包型（只给 `balance`，不给 `used` —— 否则抛 `QuotaShapeError`）。

上游读不到时返回一条 `textOnly` 窗口说明原因，而不是伪造 0%。

## 签到

无。免费额度按月 refill，`checkin` 返回 `{ outcome: "inactive" }`。

## 错误语义

| 场景 | 返回 |
| --- | --- |
| 连不上上游网关 | 503 + `alysis_upstream_unreachable`，提示检查网络或代理 |
| 模型不在账号目录 | 上游 403 `model_not_allowed` 原样透传（不是 401） |
| 登录态失效 | 401 + `X-Magpie-Sign-In: expired` |

⚠ 没有把模型级错误写成 401 —— 那会让 magpie 停掉整个账号并 failover（脚手架坑 6）。

## 与脚手架的差异

- `tests/mount.test.mjs` 按本插件实现调整：允许按模型不同的 `api.npm`、允许带 `image`
  的 `modalities`、`usage()` 断形状不断言外部进程结果。
- `auth.refresh` 保留 `refreshLock` 闸，但返回 `undefined`（`slk_` key 不轮换）。
- 新增 `readLocalAlysisKey()` / `npmFor()` 两个内部 helper，不导出成插件函数。
