# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。

## 0.1.7 — 2026-11-03

**修复**

- 同一个 Alysis 账号重复登录会并排出现两张卡（`MYCF711` 和 `Signed in (xxxxxx)`）：`auth.single: true`，并且登录时从 account-status 读取 `display_name` 作为 accountId，同名账号自动合并

## 0.1.6 — 2026-11-03

**回退**

- 撤销「隔离浏览器默认到注册」：登录页不再自动切换，登录/注册交给用户自己点 —— 锁定注册会让已注册用户点「登录」后被反复弹回注册页
- 保留：登录成功后自动回到 /activate 填设备码；面板 URL 仍是正常地址
## 0.1.5 — 2026-11-02

**修复**

- 登录面板不再显示 `about:blank`：主方式显示 `/account`，隔离方式显示 `/login?lang=auto`（`opened: true` 仍然阻止 magpie 打开默认浏览器）
- 隔离方式说明补充：不要用「重新打开」，那条会用默认浏览器
## 0.1.4 — 2026-11-02

**改进**

- 隔离浏览器直接打开 /login?lang=auto，并自动切到「注册」视图（隔离 profile 没有登录态，首次使用的人大概率还没账号；已有账号点一下「已经有帐户？登录」即可）
- 登录成功后自动回到 /activate 并填入设备码，用户只需要完成注册或登录这一步
## 0.1.3 — 2026-11-02

**修复**

- 隔离浏览器关闭后后台重试删除临时 profile（Windows 文件句柄释放慢会残留目录）
- 浏览器探测不再把 reg 查询的 stderr 打进插件日志
## 0.1.2 — 2026-11-02

**新增**

- 登录方式「在隔离浏览器里登录」：设备码 + 一次性 Chromium user-data-dir 打开 `/activate`，不复用默认浏览器凭证；窗口关闭即删除 profile
- 默认登录方式的 url 改为 `about:blank`：magpie 不会顺手打开默认浏览器（GUI 也一样）

**修复**

- 设备码轮询间隔支持亚秒值（测试用），生产仍按服务端 interval

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
