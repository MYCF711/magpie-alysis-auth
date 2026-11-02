# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。

## 0.1.1 — 2026-11-02

**修复**

- 额度读不到时不再抛 `QuotaShapeError` 打死 usage 钩子：返回 `error` 让卡片显示原因，账号在路由里保持可用（之前会导致 magpie 记 "used 必填" 并丢弃这个 provider 的额度）

## 0.1.0 — 2026-11-02

**初始版本**

- provider id = `alysis`；从本机 Alysis Code 客户端导入已登录的免费账号（`slk_` key），不用粘贴 key
- 模型目录从本机 alysis2api 的 `/v1/models` 自动发现（上游有多少就列多少），静态表兜底 6 个
- 按上游协议分流：DeepSeek / GLM 走 `@ai-sdk/openai-compatible`，GPT-6 Luna 走 `@ai-sdk/openai`（Responses），Claude Haiku 走 `@ai-sdk/anthropic`（Messages）
- 额度卡片：5 小时 / 7 天公平使用窗口 + 免费余额，来自上游 account-status
- 签到：无（免费额度按月自动 refill，不是每日签到）
- 依赖本机 alysis2api 反代（`http://127.0.0.1:8788/v1`）；没启动时返回 503 和启动提示，不静默失败
- 首发：npm `magpie-alysis-auth@0.1.0` + GitHub Release
