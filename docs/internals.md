# 内部实现与证据

## 数据通道：本机 alysis2api 反代

插件不直接调用 Alysis 的上游网关，而是走同目录仓库 `alysis2api` 提供的本地 OpenAI 兼容反代
（`http://127.0.0.1:8788/v1`）。原因：

1. **429 排队**：免费层 `deepseek-flash` / `glm-5.3-flash` 的容量池在高峰会返回
   `429 hosted_capacity_exceeded`（"capacity is busy. Retry in N seconds"），反代负责解析、
   等待、重试，并在流式请求期间发 SSE keepalive。插件不重复实现这层。
2. **协议分流**：上游按模型走三个不同协议（chat / responses / messages），反代统一暴露，
   插件只用按 `api.npm` 选择正确的 AI SDK 包。
3. **多账号与额度**：账号池、冷却、本地用量统计都在反代里；插件只读 `/v1/models` 与 `/v1/usage`。

反代没启动时，`loader.fetch` 捕获 `ECONNREFUSED` 并返回 503 + 启动提示，不抛未处理异常。

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
| 本地反代没启动 | 503 + `alysis2api_unreachable`，提示启动命令 |
| 模型不在账号目录 | 上游 403 `model_not_allowed` 原样透传（不是 401） |
| 登录态失效 | 401 + `X-Magpie-Sign-In: expired` |

⚠ 没有把模型级错误写成 401 —— 那会让 magpie 停掉整个账号并 failover（脚手架坑 6）。

## 与脚手架的差异

- `tests/mount.test.mjs` 按本插件实现调整：允许按模型不同的 `api.npm`、允许带 `image`
  的 `modalities`、`usage()` 断形状不断言外部进程结果。
- `auth.refresh` 保留 `refreshLock` 闸，但返回 `undefined`（`slk_` key 不轮换）。
- 新增 `readLocalAlysisKey()` / `npmFor()` 两个内部 helper，不导出成插件函数。
