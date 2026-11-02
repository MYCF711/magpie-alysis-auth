// tests/mount.test.mjs —— 入口 / 九钩子挂载契约
//
// 派生自 magpie-plugin-scaffold（MIT），针对 alysis 插件调整：
//   ① 入口只导出一个函数（magpie 会把每个函数导出都当插件工厂调用）
//   ② _internal 是对象（helper 不暴露成插件）
//   ③ 九项钩子齐全
//   ④ config() 未登录也有模型（否则卡片显示 "0 models"）
//   ⑤ authorize() 立刻返回 Promise（真正的导入在 callback 里）
//   ⑥ loader() 给 baseURL / apiKey / fetch
//   ⑦ usage 构造器可用，窗口形状符合契约
//
// 全部离线；不需要 magpie 进程、不需要凭据。
// 跑法：node --test tests/mount.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import * as entry from "../index.mjs"
import { _internal } from "../index.mjs"
import { usage, usageWindow } from "../src/quota.mjs"

const { AlysisAuthPlugin } = entry

test("入口只导出一个函数（插件工厂）", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
  assert.deepEqual(functions, ["AlysisAuthPlugin"])
})

test("_internal 是对象，helper 不暴露成顶层函数导出", () => {
  assert.equal(typeof _internal, "object")
  assert.equal(typeof _internal.PROVIDER, "string")
  assert.equal(_internal.PROVIDER, "alysis")
  assert.equal(typeof _internal.staticModels, "function")
  assert.ok(Array.isArray(_internal.MODELS))
  assert.equal(typeof _internal.readLocalAlysisKey, "function")
})

test("九项钩子齐全", async () => {
  const plugin = await AlysisAuthPlugin({ client: {}, directory: undefined })
  assert.equal(typeof plugin.config, "function")
  assert.ok(plugin.auth && typeof plugin.auth === "object")
  assert.equal(plugin.auth.provider, _internal.PROVIDER)
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.ok(Array.isArray(plugin.auth.methods) && plugin.auth.methods.length >= 1)
  assert.equal(typeof plugin.auth.methods[0].authorize, "function")
  assert.equal(typeof plugin.provider.models, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(plugin.provider.id, _internal.PROVIDER)
  assert.ok(plugin.auth.icon?.startsWith("data:image/"), "图标必须内嵌（外部 URL 在 git 源下不渲染）")
  assert.ok(Number.isInteger(plugin.auth.maxConcurrency) && plugin.auth.maxConcurrency >= 1)
})

test("config() 未登录也声明了模型，且 modalities / 五个 input 布尔都在", async () => {
  const plugin = await AlysisAuthPlugin({ client: {} })
  const cfg = {}
  await plugin.config(cfg)
  const models = cfg.provider?.[_internal.PROVIDER]?.models
  assert.ok(models && Object.keys(models).length > 0, "config.models 不能为空（铁律 1）")
  for (const [id, model] of Object.entries(models)) {
    // config 路径读的是 modalities，不是 capabilities；只写后者等于没写。
    assert.ok(Array.isArray(model.modalities.input), `${id}.modalities.input 必须是数组`)
    assert.ok(model.modalities.input.includes("text"), `${id}.modalities.input 必须含 text`)
    assert.ok(Array.isArray(model.modalities.output), `${id}.modalities.output 必须是数组`)
    // HOOKS 十一之三只规定了 capabilities.input 的五个模态键；output 不发明字段
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(typeof model.capabilities.input[key], "boolean", `${id}.capabilities.input.${key} 必须是布尔`)
    }
    assert.equal(typeof model.capabilities.output.text, "boolean", `${id}.capabilities.output.text 必须是布尔`)
  }
})

test("authorize 是 async 函数，且立刻返回（不 await 登录）", async () => {
  const plugin = await AlysisAuthPlugin({ client: {} })
  const method = plugin.auth.methods[0]
  assert.equal(typeof method.authorize, "function")
  assert.equal(method.authorize.constructor.name, "AsyncFunction")

  // 铁律 2：authorize 必须立刻返回一个带 callback 的 flow，不能等用户。
  const started = Date.now()
  const flow = await method.authorize(undefined)
  assert.ok(Date.now() - started < 1_000, "authorize 不能阻塞")
  assert.equal(typeof flow.callback, "function")
  assert.equal(typeof flow.url, "string")
  assert.equal(flow.opened, true)
})

test("loader() 给 baseURL / apiKey / fetch；未登录返回空对象", async () => {
  const plugin = await AlysisAuthPlugin({ client: {} })
  const out = await plugin.auth.loader(async () => ({ type: "oauth", access: "access-token" }), { id: "alysis" })
  assert.equal(typeof out.fetch, "function")
  assert.equal(typeof out.baseURL, "string")
  assert.ok(out.baseURL.startsWith("http"))
  assert.equal(out.apiKey, "access-token")

  const empty = await plugin.auth.loader(async () => null, { id: "alysis" })
  assert.deepEqual(empty, {})
})

test("provider.models：未登录返回静态模型表；条目 API 字段完整", async () => {
  const plugin = await AlysisAuthPlugin({ client: {} })
  const models = await plugin.provider.models({}, { auth: null })
  assert.ok(models && Object.keys(models).length > 0)
  const allowedNpm = ["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic"]
  for (const [id, model] of Object.entries(models)) {
    assert.equal(model.id, id)
    assert.equal(model.api.url, _internal.BASE)
    assert.ok(allowedNpm.includes(model.api.npm), `${id}.api.npm 必须是已知形状，实际 ${model.api.npm}`)
  }
})

test("usage 构造器可用：至少造一条参与路由的窗口", () => {
  const value = usage({
    plan: "Test",
    windows: [usageWindow({ name: "5 小时", used: 37, span: 18_000, resetsAt: "2026-10-30T12:00:00Z" })],
  })
  assert.equal(typeof value.plan, "string")
  assert.equal(value.windows.length, 1)
  assert.equal(Number.isFinite(value.windows[0].used), true)
  assert.equal(typeof value.windows[0].aside === "boolean" || value.windows[0].aside === undefined, true)
})

test("usage() 未登录时给出 error 而不是伪造 0", async () => {
  const plugin = await AlysisAuthPlugin({ client: {} })
  const anonymous = await plugin.auth.usage(async () => null, { id: "alysis" })
  assert.equal(anonymous.error, "未登录")
  assert.deepEqual(anonymous.windows, [])

  // 有凭据时：本地反代在跑就返回真实窗口；没跑就 error + 空窗口。
  // 两种情况都不能是「伪造的 0%」——断言形状，不断言依赖外部进程的结果。
  const withAuth = await plugin.auth.usage(async () => ({ type: "oauth", access: "x" }), { id: "alysis" })
  assert.ok(Array.isArray(withAuth.windows), "windows 必须是数组")
  if (withAuth.error === undefined) {
    assert.ok(withAuth.windows.length > 0, "没有 error 就必须至少有一条窗口")
    for (const w of withAuth.windows) {
      assert.equal(typeof w.name, "string")
      assert.ok(w.used !== undefined || w.balance !== undefined || w.text === true, "窗口要么有占比/余额，要么是 text-only")
    }
  }
})

test("chat.headers 只给本 provider 的请求加头", async () => {
  const plugin = await AlysisAuthPlugin({ client: {} })
  const header = `x-${_internal.PROVIDER}-session`
  const mine = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: _internal.PROVIDER }, sessionID: "sess-1" }, mine)
  assert.equal(mine.headers[header], "sess-1")

  const other = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "sess-1" }, other)
  assert.deepEqual(other.headers, {})
})

test("auth.refresh 走 refresh lock，而不是裸调上游", () => {
  // 模块行为由 tests/refresh-lock.test.mjs 锁，这里只防止未来重构把闸拆掉。
  const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
  assert.match(source, /import \{ createRefreshLock \} from "\.\/src\/refresh-lock\.mjs"/)
  assert.match(source, /refreshLock\.run\(\s*`\$\{PROVIDER\}\\n\$\{auth\.refresh\}`/)
})

test("登录复用本机 Alysis Code 凭证：只读，且覆盖候选路径", () => {
  const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
  assert.match(source, /LOCALAPPDATA/)
  assert.match(source, /profile_keys/)
  assert.match(source, /slk_/)
  // 插件不写 magpie / 客户端目录
  assert.doesNotMatch(source, /writeFileSync\([^)]*magpie/i)
})
