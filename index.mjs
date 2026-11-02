// magpie 插件完整模板
//
// 九项全实现，一项不缺。复制后改 PROVIDER / BASE / 各 TODO 即可。
//
// ⚠ 这份模板是**一个供应商**的形态。如果同一厂商有国内 / 国际两套云、
//   而且必须是 magpie 里的两张卡（两组登录态并存），别在这份上打补丁 ——
//   照 MULTI-PROVIDER.md 的 makePlugin(SITE) 骨架重写，五条铁律照抄。
//
// ═══════════════════════════════════════════════════════════════════════
// 九项清单
// ═══════════════════════════════════════════════════════════════════════
//
//  钩子（magpie 会调）
//   ① config(cfg)                     声明 provider + 静态模型表
//   ② auth.methods[].authorize()      登录
//   ③ auth.refresh(auth, provider)    续期
//   ④ auth.loader(getAuth, provider)  请求接管
//   ⑤ auth.usage(getAuth, provider)   额度 → 卡片进度条
//   ⑥ auth.checkin(getAuth, provider) 签到
//   ⑦ provider.models(provider,{auth}) 每账号目录
//   ⑧ "chat.headers"(input, output)   每请求加头
//
//  数据字段（不是钩子但决定 UI）
//   ⑨ accountId / uid                 卡片显示名 + 同名区分
//      auth.icon / magpie.icon         卡片图标
//      auth.maxConcurrency             并发数
//
// ═══════════════════════════════════════════════════════════════════════
// 三条铁律
// ═══════════════════════════════════════════════════════════════════════
//
// 1. config.models 必须有内容 —— 未登录也要有，否则显示 "0 models"
// 2. authorize() 立刻返回 —— 真正等登录的是 callback()，否则和 magpie 死锁
// 3. refresh 返回的是合并 —— client.auth.set 是整体替换，两者不同
//
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// ⚠ 这是一个模板 —— 改完下面三行才有意义
// ═══════════════════════════════════════════════════════════════════════
//
//   PROVIDER        改成厂商自己的 id（agent 用 <id>/<model> 命名）
//   PROVIDER_NAME   供应商名 —— 必须 <中文> <English>，英文照抄厂商官方品牌写法
//                   （插件卡片标题是 package.json 的 name，同一套约定）
//   BASE            上游 API 基址
//
// 然后实现 index.mjs 底部的五个 TODO 函数。
//
// ═══════════════════════════════════════════════════════════════════════

// ── 额度窗口的构造器 ─────────────────────────────────────────────────
// 见 src/quota.mjs：它把「写错不报错、但 GUI 和智能路由会坏」的五类写法变成运行时错误。
// 派生仓库把 src/ 一起带走即可（GUIDE 第 1 步已写明）。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

import { usage as buildUsage, usageWindow } from "./src/quota.mjs"
import { createRefreshLock } from "./src/refresh-lock.mjs"
import { createUsageCache } from "./src/usage-cache.mjs"
import { startDeviceGrant, approvalUrl, pollForKey, openIsolatedBrowser } from "./src/device-login.mjs"

// ── 配置 ──────────────────────────────────────────────────────────────

const PROVIDER = "alysis" // ⚠ 改成厂商 id，如 "huawei"
const PROVIDER_NAME = "Alysis Code 免费额度" // ⚠ 改成 <中文> <English>，英文照抄厂商官方写法
const BASE = "https://vzigujbcjjmpntxhmyvr.supabase.co/functions/v1/llm/v1"
const SDK = "@ai-sdk/openai-compatible" // 决定 API 形状，见下表
const REFRESH_LEAD_MS = 5 * 60_000
// Alysis 云端函数 API（设备码、账号状态）；和网关同源，但不是凭据。
const CLOUD_API = "https://vzigujbcjjmpntxhmyvr.supabase.co/functions/v1"

// npm 包 → API 形状
//   @ai-sdk/anthropic        → Anthropic Messages  /messages
//   @ai-sdk/openai           → OpenAI Responses    /responses
//   @ai-sdk/google           → Gemini              /models/<id>:streamGenerateContent
//   @ai-sdk/openai-compatible → Chat completions   /chat/completions

// ── 模型表 ────────────────────────────────────────────────────────────

/** [id, 显示名, 上下文窗口, reasoning efforts] */
// ══════════════════════════════════════════════════════════════════════
// ⚠ context 必须实测，不要凭印象填
// ══════════════════════════════════════════════════════════════════════
//
// 这个数字会被 magpie 转给 agent（DSH 等），决定它什么时候压缩对话。
// 填小了：模型明明能收 100 万，agent 在 12.8 万就开始压缩，浪费容量；
//         更要紧的是路由组按「组内最大」算窗口，一个填小的成员会把整组拉低。
// 填大了：agent 以为还有余量，请求超了上游才报错，用户看到的是
//         「内容太长了」这种莫名其妙的错误。
//
// 实测办法：造一份约 N token 的文本发过去，看 usage.prompt_tokens 和是否 200。
//   别把「最大输出」当成「上下文」—— DeepSeek 系常见 128K 输出 / 1M 上下文，
//   两个数字长得很像，填反了差 8 倍。
//
// 模型表 —— 上下文窗口来自 Alysis 网关的元数据（1M）。
// [id, 显示名, 上下文窗口, reasoning efforts, API 形状(npm), 是否支持视觉]
// Alysis 网关按模型分流协议：deepseek/glm 走 chat/completions，
// gpt-6-luna 走 responses，claude 走 messages —— 这里用不同的 npm 包表达。
const MODELS = [
  ["deepseek-flash", "DeepSeek V4.1 Flash", 1_000_000, ["low", "medium", "high"], null, true],
  ["deepseek-chat", "DeepSeek Chat", 1_000_000, ["low", "medium", "high"], null, true],
  ["deepseek-reasoner", "DeepSeek Reasoner", 1_000_000, ["low", "medium", "high"], null, true],
  ["glm-5.3-flash", "GLM 5.3 Flash", 1_000_000, ["low", "medium", "high"], null, false],
  ["gpt-6-luna", "GPT-6 Luna", 1_000_000, ["low", "medium", "high"], "@ai-sdk/openai", false],
  ["claude-haiku-5-5", "Claude Haiku 5.5", 1_000_000, ["low", "medium", "high"], "@ai-sdk/anthropic", true],
]

/** 别名 → 上游真实模型 id（上游只认 deepseek-flash 等 4 个 id，不认别名）。 */
const API_ID = {
  "deepseek-chat": "deepseek-flash",
  "deepseek-reasoner": "deepseek-flash",
}

/** 静态模型表（未登录 / 拉取失败时兜底） */
function staticModels() {
  const out = {}
  for (const [id, name, context, efforts, npm, vision] of MODELS) {
    out[id] = {
      id,
      name,
      api: { id: API_ID[id] || id, url: BASE, npm: npm || SDK },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context, output: 128_000 },
      // config 钩子的静态模型走 modalities；capabilities.input 是 provider.models 路径的字段。
      // 两个都写，避免「只写 capabilities 而 config 路径读不到模态」。
      modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
      capabilities: {
        temperature: true,
        reasoning: Array.isArray(efforts) && efforts.length > 0,
        toolcall: true,
        attachment: false,
        // HOOKS 十一之三：五个模态键必须显式写布尔（省略 image ≠ text）
        input: { text: true, image: Boolean(vision), audio: false, video: false, pdf: false },
        output: { text: true },
      },
      ...(efforts?.length ? { variants: Object.fromEntries(efforts.map((e) => [e, {}])) } : {}),
    }
  }
  return out
}

/** 按 id 推断该用哪种 API 形状（动态模型没有协议字段）。 */
function npmFor(id) {
  const clean = String(id || "").toLowerCase()
  if (clean.includes("luna")) return "@ai-sdk/openai"
  if (clean.includes("claude") || clean.startsWith("anthropic")) return "@ai-sdk/anthropic"
  return SDK
}

// ── 本机 Alysis Code 登录态 ───────────────────────────────────────────
// 和 ima / magicrew 插件的做法一致：桌面客户端已经登录过，插件直接读它的凭证，
// 不让用户粘贴任何东西。只读，不写客户端目录。

function localCredentialCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
  const out = []
  if (process.env.ALYSIS_CONFIG_DIR) {
    out.push(path.join(process.env.ALYSIS_CONFIG_DIR, "credentials.json"))
  }
  out.push(path.join(local, "alysis", "alysis", "credentials.json"))
  out.push(path.join(local, "alysis-code", "credentials.json"))
  out.push(path.join(roaming, "Alysis Code", "credentials.json"))
  out.push(path.join(os.homedir(), ".alysis", "credentials.json"))
  return out
}

/** @returns {{ key: string, file: string } | null} */
function readLocalAlysisKey() {
  for (const file of localCredentialCandidates()) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
      const key = data?.profile_keys?.alysis
      if (typeof key === "string" && /^slk_[A-Za-z0-9_-]{8,}$/.test(key.trim())) {
        return { key: key.trim(), file }
      }
    } catch {
      // 文件不存在 / 不是 JSON：继续找下一个候选
    }
  }
  return null
}

function fingerprint(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 12)
}

/** 调 account-status 拿卡片上显示的账号名（失败返回空串，绝不编造）。 */
async function resolveAccountId(key) {
  if (!key) return ""
  try {
    const response = await fetch(`${CLOUD_API}/account-status`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return ""
    const data = await response.json()
    const name = String(
      data?.display_name || data?.user?.display_name || data?.email || data?.user?.email || "",
    ).trim()
    // 内部 ID / 纯十六进制指纹不当名字用
    if (!name || /^[0-9a-f]{8,}$/i.test(name)) return ""
    return name
  } catch {
    return ""
  }
}

// ── 插件入口 ──────────────────────────────────────────────────────────

export const AlysisAuthPlugin = async (_ctx, _options) => {
  // 同一 refresh_token 的并发续期合并成一次，成功后 60 秒内回放结果。
  // 键必须是凭据身份（refresh_token），不能用 provider id —— 同渠道多账号会串结果。
  const refreshLock = createRefreshLock({ replayMs: 60_000 })

  // 额度卡片会被频繁刷新：成功 60 秒、失败 5 秒，同 key 并发合并。
  // key 用凭据身份，不能用 provider id —— 同渠道多账号会串额度。
  const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })

  // _ctx 是宿主给的上下文：{ client, directory, … }。
  // 打日志用 _ctx?.client?.app?.log?.({ service, level, message })。
  //
  // ⚠ 不要往 magpie 的目录里写任何东西（包括它自己的 ~/.cache/magpie/*.json）：
  //   那份文件属于 magpie。插件只读，不写。
  //   卡片标题、「源码」按钮、市场文案的载体是 registry 条目，见 registry-entry.json。

  return {

  // ═══ ① 声明 provider ══════════════════════════════════════════════
  config: async (cfg) => {
    cfg.provider ??= {}
    // ⚠ 用 ??= ，不要覆盖用户在 plugins.json 里配的
    cfg.provider[PROVIDER] ??= {
      name: PROVIDER_NAME,
      npm: SDK,
      api: BASE,
      models: staticModels(), // ⚠ 未登录时也必须有内容
    }
  },

  auth: {
    provider: PROVIDER,

    // ── 数据字段（不是钩子）────────────────────────────────────────
    // ⚠ 图标要写两份，缺一份就有地方显示灰方块：
    //   这里 auth.icon        → 供应商列表那一行、用量概览的卡
    //   package.json 的
    //     magpie.icon        → 插件列表那一行、插件详情页左上角
    //   两处内容一样，直接抄同一份 data URI。见 HOOKS.md「插件自己的图标」。
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMWYyOTM3Ii8+PHRleHQgeD0iNjQiIHk9Ijg0IiBmb250LXNpemU9IjYwIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiM2MGE1ZmEiIHRleHQtYW5jaG9yPSJtaWRkbGUiPkE8L3RleHQ+PC9zdmc+",
    maxConcurrency: 4, // 1-1000
    // 不设 single：不同的 Alysis 账号可以并存，第二个登录不会顶掉第一个。
    // 同一个账号的重复登录靠 accountId 合并（resolveAccountId 从 account-status
    // 取 display_name）；两个 key 指向同一账号时不会再多出一张卡。
    refreshLead: REFRESH_LEAD_MS,

    // ═══ ② 登录 ═══════════════════════════════════════════════════
    methods: [
      {
        type: "oauth",
        label: `Sign in with ${PROVIDER_NAME}`,

        // 可选：登录前的问题
        prompts: [
          // {
          //   type: "select",
          //   key: "region",
          //   message: "Region",
          //   options: [
          //     { label: "Global", value: "global" },
          //     { label: "China", value: "cn", hint: "xxx.cn" },
          //   ],
          // },
          // {
          //   type: "text",            // 或 "password"（不显示输入）
          //   key: "team",
          //   message: "Team id",
          //   placeholder: "t-...",
          //   when: { key: "region", op: "eq", value: "global" },
          //   validate: (v) => (/^t-/.test(v) ? undefined : "Starts with t-"),
          // },
        ],

        /**
         * ⚠ 必须立刻返回，不能在这里 await 用户完成登录。
         *   否则和 magpie 双向死锁。真正等登录的是 callback()。
         *
         * inputs 只在有 prompts 时传入，否则是 undefined。
         */
        async authorize(_inputs) {
          // 铁律 2：authorize 立刻返回；读本机登录态放在 callback 里做。
          // url 只是给面板显示一个正常地址；opened: true 让 magpie 不要打开它
          // （打开默认浏览器会复用用户日常浏览器里的 alysis 会话）。
          return {
            url: "https://alysiscode.com/account",
            instructions:
              "本插件复用本机 Alysis Code 客户端已经登录的免费账号（slk_ key），不用输入任何东西，也不会打开浏览器。请确认 Alysis Code 已登录，然后点继续。",
            method: "auto", // "auto" | "code"（code = 用户要粘贴授权码）
            opened: true, // true = 插件自己已经开了页面，magpie 别再开

            async callback() {
              try {
                const found = readLocalAlysisKey()
                if (!found) {
                  return {
                    type: "failed",
                    error:
                      "没有找到本机 Alysis Code 的登录凭证。请先打开 Alysis Code 并用免费账号登录（或运行 `alysis login`），然后重试。",
                  }
                }
                return {
                  type: "success",
                  access: found.key,
                  // slk_ key 长期有效、不轮换；refresh 只是为了让字段齐全。
                  refresh: found.key,
                  // slk_ key 不会过期：给一个远期时间，避免 magpie 反复触发续期。
                  expires: Date.now() + 365 * 24 * 3600 * 1000,

                  // ⚠ accountId 是「名字」，不是身份：本机登录态里没有用户名，
                  //   按规范返回空串（宿主会回退成供应商名），内部指纹只进 uid。
                  accountId: await resolveAccountId(found.key),
                  uid: fingerprint(found.key),
                }
              } catch (e) {
                return { type: "failed", error: `读取 Alysis Code 登录态失败：${e?.message ?? e}` }
              }
            },
          }
        },
      },

      // 备选：隔离浏览器 + 设备码（本机 Alysis Code 没登录时用）。
      // 绝不用默认浏览器：设备码由插件发起，批准页在一个一次性的 Chromium
      // user-data-dir 里打开，关闭后整个 profile 删掉。
      {
        type: "oauth",
        label: `在隔离浏览器里登录（${PROVIDER_NAME}）`,

        async authorize() {
          // 铁律 2：立刻返回。设备码与浏览器都在 callback 里。
          return {
            url: "https://alysiscode.com/login?lang=auto", // 只用于面板显示；opened: true 阻止 magpie 打开它
            opened: true,
            instructions:
              "会打开一个一次性的隔离浏览器窗口（独立配置，不会复用默认浏览器里的登录态），并自动切到注册页。请在窗口里完成注册/登录，插件会自动填好设备码；窗口关闭后自动完成。请不要用「重新打开」——那条会用默认浏览器。",
            method: "auto",

            async callback() {
              let win = null
              try {
                const grant = await startDeviceGrant()
                const activate = approvalUrl(grant.userCode)
                // 隔离窗口直接落在登录页，并且默认切到「注册」——隔离 profile 里没有
                // 任何登录态，首次使用的人大概率还没有账号。已有账号的人点一下「登录」即可。
                win = await openIsolatedBrowser("https://alysiscode.com/login?lang=auto", {
                  prepare: async (page) => {
                    const state = await page.evaluate(`
                      (() => {
                        const ACTIVATE = ${JSON.stringify(activate)};
                        const CODE = ${JSON.stringify(grant.userCode)};
                        const path = location.pathname;
                        const nodes = Array.from(document.querySelectorAll("a,button"));
                        const textOf = (n) => (n.textContent || "").trim();

                        // 1) 还在加载 / 空白页：等
                        if (!path || path === "/" || path === "blank") return "wait";

                        // 2) 批准页：填码并提交
                        if (path.startsWith("/activate")) {
                          const input = document.querySelector('input[name="code"]');
                          const submit = document.querySelector('[data-activate-submit]');
                          if (input) {
                            if (input.value !== CODE) {
                              input.value = CODE;
                              input.dispatchEvent(new Event("input", { bubbles: true }));
                              input.dispatchEvent(new Event("change", { bubbles: true }));
                            }
                            if (submit && !submit.disabled) { submit.click(); return "done"; }
                          }
                          return "wait";
                        }

                        // 3) 登录页：什么都不点。登录还是注册由用户自己选 ——
                        //    锁定注册会让人点「登录」后被反复弹回注册页。
                        if (path.startsWith("/login") || path.startsWith("/signup") || path.startsWith("/register")) {
                          return "wait";
                        }

                        // 4) 登录成功后落在账户页：回到批准页填码
                        location.href = ACTIVATE;
                        return "wait";
                      })()
                    `)
                    return state === "done" ? "done" : "wait"
                  },
                })
                const key = await pollForKey(grant)
                if (!/^slk_/.test(key)) {
                  return { type: "failed", error: "服务端返回的 key 不是 slk_ 开头，拒绝保存" }
                }
                return {
                  type: "success",
                  access: key,
                  refresh: key,
                  expires: Date.now() + 365 * 24 * 3600 * 1000,
                  accountId: await resolveAccountId(key),
                  uid: fingerprint(key),
                }
              } catch (e) {
                return { type: "failed", error: `隔离浏览器登录失败：${e?.message ?? e}` }
              } finally {
                win?.close()
              }
            },
          }
        },
      },

      // API key 方式（可选）
      // {
      //   type: "api",
      //   label: `${PROVIDER_NAME} API key`,
      //   placeholder: "xxx-...",
      //   // 没有 authorize → 原样保存 { type: "api", key }
      //   // 有 authorize(inputs) → 返回 { type: "success", key }
      // },
    ],

    // ═══ ③ 续期 ═══════════════════════════════════════════════════
    /**
     * 返回值 **合并** 到旧账号上（与 client.auth.set 的整体替换不同）。
     *
     * 运行时机：OAuth 账号的 expires 距现在 < refreshLead 时，
     * 在 loader / models / usage / 请求之前。
     *
     * 串行化：同一 refresh_token 的并发续期会合并成一次（`src/refresh-lock.mjs`），
     * 成功后 60 秒内回放结果 —— 一次性 refresh_token 不会被用两次，
     * 宿主 `auth.refresh` 与请求链路同时触发也不会各花一次旧 token。
     *
     * expires 为 0 或不存在的账号永不续期。
     */
    async refresh(auth, provider) {
      // Alysis 的 slk_ key 长期有效、不轮换；真正会过期的是上游的账号会话，
      // 这里保留续期闸，但只做「合并」语义的空续期：
      // 返回 undefined = 不续期，原有 access/refresh/expires 全部保留。
      if (!auth?.access) return undefined
      await refreshLock.run(`${PROVIDER}\n${auth.refresh}`, async () => undefined)
      return undefined
    },

    // ═══ ④ 请求接管 ═══════════════════════════════════════════════
    /**
     * 每个账号跑一次（登录态变化后会重跑）。
     *
     * 返回的字段：
     *   baseURL  请求去哪（优先于模型的 api 和 provider 的 api）
     *   apiKey   按 npm 包自动加头：
     *              @ai-sdk/anthropic → x-api-key
     *              @ai-sdk/google    → x-goog-api-key
     *              其它              → Authorization: Bearer
     *   headers  每个请求都加
     *   fetch    真正的请求函数
     *
     * 请求头的设置顺序（后者覆盖前者）：
     *   sdkHeaders(apiKey) → loader.headers → gateway 的 → chat.headers 的
     */
    async loader(getAuth, provider) {
      const auth = await getAuth()
      if (!auth) return {}

      return {
        baseURL: BASE,
        // 每个账号用自己的 slk_ key 直连上游；magpie 按 SDK 自动加 Authorization / x-api-key。
        apiKey: auth.access || "sk-local",
        headers: {
          "user-agent": "alysis-magpie/0.1.0",
        },

        async fetch(input, init) {
          // ⚠ 每次重新读 auth —— 可能已被 refresh 更新
          const fresh = await getAuth()
          if (!fresh) throw new Error(`${PROVIDER_NAME} 未登录`)

          const req = input instanceof Request ? input : null
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : req?.url ?? ""

          // 合并请求头：先取进来的，再被我们的覆盖
          const incoming = new Headers(init?.headers ?? req?.headers ?? {})
          const headers = {
            authorization: `Bearer ${fresh.access || "sk-local"}`,
            "content-type": "application/json",
          }
          for (const [k, v] of incoming) {
            const lower = k.toLowerCase()
            // 这几个必须由我们决定
            if (["authorization", "x-api-key", "host", "content-length", "user-agent"].includes(lower)) continue
            headers[k] = v
          }

          let body = init?.body
          if (body === undefined && req) body = await req.text()

          // 不读流、不改 body：429 与限流原样交给 magpie 的账号路由处理。
          try {
            return await fetch(url, {
              method: init?.method ?? "POST",
              headers,
              body,
              signal: init?.signal ?? req?.signal ?? AbortSignal.timeout(300_000),
            })
          } catch (e) {
            const message = String(e?.message ?? e)
            if (/ECONNREFUSED|fetch failed|connect/i.test(message)) {
              return new Response(
                JSON.stringify({
                  error: {
                    message:
                      `${PROVIDER_NAME} 的本地反代没有运行。` +
                      `连不上 Alysis 网关（${BASE}）。检查网络或代理设置后重试。`,
                    type: "upstream_unreachable",
                    code: "alysis_upstream_unreachable",
                  },
                }),
                { status: 503, headers: { "content-type": "application/json; charset=utf-8" } },
              )
            }
            throw e
          }
        },
      }
    },

    // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
    /**
     * 决定卡片上的进度条。
     *
     * windows[].name     → 进度条上方的标签
     * windows[].used     → 已用百分比（0-100，超额 >100）
     * windows[].display  → 数字显示，如 "2,131.63 / 3,400 积分"
     * windows[].amount   → 已用
     * windows[].limit    → 总量
     * windows[].unit     → 单位
     * windows[].resetsAt → 重置时间
     * windows[].aside    → true 表示用光不停账号（附加额度）
     *
     * 只给 used 不给 display/amount/limit → 只有光秃秃的进度条。
     */
    async usage(getAuth, provider) {
      const auth = await getAuth()
      if (!auth) return { error: "未登录", windows: [] }

      // 只缓存有凭据身份的账号；匿名调用本来就不会打到上游。
      const usageKey = auth.uid ?? auth.accountId ?? auth.refresh ?? auth.access ?? auth.key
      if (!usageKey) return { error: "未登录", windows: [] }

      let u
      try {
        u = await usageCache.read(String(usageKey), () => fetchUsage(auth))
      } catch (e) {
        // 上游失败 → 让卡片显示原因。抛出去 magpie 只会记成「读取失败」，用户看不到原因。
        return { error: String(e?.message ?? e), windows: [] }
      }

      // ⚠ 窗口由 src/quota.mjs 的构造器生成 —— 它在**写法错**时直接抛 QuotaShapeError：
      //   写错的窗口不会让插件崩，只会让 GUI 显示「剩余额度未知」、让这个号在智能路由里
      //   被当成不存在，而日志里什么都没有。
      const windows = []

      // ① 5 小时滚动额度（占比型：used 必填）
      if (u.fiveHour?.used !== undefined) {
        windows.push(
          usageWindow({
            name: "5 小时额度",
            used: u.fiveHour.used,
            amount: u.fiveHour.amount,
            limit: u.fiveHour.limit,
            unit: "USD",
            span: 18_000,
          }),
        )
      }

      // ② 7 天滚动额度
      if (u.weekly?.used !== undefined) {
        windows.push(
          usageWindow({
            name: "7 天额度",
            used: u.weekly.used,
            amount: u.weekly.amount,
            limit: u.weekly.limit,
            unit: "USD",
            span: 604_800,
          }),
        )
      }

      // ③ 钱包型余额：只给 balance，**不要**给 used
      if (u.balance !== undefined) {
        windows.push(usageWindow({ name: "剩余余额", balance: u.balance, unit: "USD" }))
      }

      // ④ 上游读不到时交给卡片的 error，不要造一条 textOnly 窗口：
      //   usage() 会拒绝「所有窗口都不参与路由」的账号（路由页会显示
      //   「剩余额度未知」并排在最后），而伪造 used: 0 又会让空号排到队首。
      if (!windows.length) {
        return {
          error: "上游暂时返回不了额度（账号未登录或 account-status 不可用）",
          windows: [],
        }
      }

      return buildUsage({
        plan: u.plan,
        user: u.user,
        until: u.until,
        renew: "auto",
        balance: u.balance !== undefined ? `$${u.balance.toFixed(4)}` : undefined,
        windows,
      })
    },

    // ═══ ⑥ 签到 ═══════════════════════════════════════════════════
    /**
     * 调用规则（magpie 契约原文）：
     *   - 按 **北京时间**，每账号每天一次
     *   - 当天失败后还会再调
     *   - 抛异常 = 失败
     *   - 在账号的 scope 里，它刷新的 token 会存到该账号
     *
     * outcome 六种：
     *   "claimed"     刚签到成功
     *   "done"        今天已经签过了
     *   "ineligible"  这个账号不能参加
     *   "inactive"    没有签到活动
     *   "captcha"     厂商要验证码 —— 让用户去官方 App 手动签，永不解
     *   "failed"      失败
     */
    async checkin(getAuth, provider) {
      const auth = await getAuth()
      if (!auth) return { outcome: "failed", message: "未登录" }

      // Alysis 免费额度是每月自动 refill（free_next_refill_at），没有每日签到。
      return {
        outcome: "inactive",
        message: `${PROVIDER_NAME} 没有每日签到：免费额度按月自动补充`,
      }
    },
  },

  // ═══ ⑦ 每账号的模型目录 ═══════════════════════════════════════
  /**
   * magpie 为每个账号调一次，在该账号的 scope 和代理里。
   *
   * provider.models 是「上次的列表」（models.dev + config 钩子给的）。
   *
   * 失败回退的三种方式：
   *   1. fetch 失败后原样返回 provider.models
   *   2. 抛异常
   *   3. 返回自己的列表并设 list[Symbol.for("magpie.fellBack")] = true
   *
   * ⚠ 局部成功时**不要**标 fellBack —— 那样 magpie 会整份丢弃。
   *
   * 登录态失效 → 抛带 signIn: "expired" 的错误。
   */
  provider: {
    id: PROVIDER,

    async models(provider, { auth } = {}) {
      const fallback = staticModels()
      if (!auth || auth.type !== "oauth") return fallback

      try {
        // 不写死模型：模型列表每账号直连上游 /models 自动发现。
        const live = await fetchLiveModels(auth)
        if (!live.length) return fallback

        const out = {}
        for (const m of live) {
          const base = fallback[m.id]
          if (base) {
            // 静态表里有的：保留配置，只更新名字/窗口/视觉能力
            out[m.id] = {
              ...base,
              id: m.id,
              name: m.name ?? base.name,
              limit: { ...base.limit, context: m.context ?? base.limit.context },
              capabilities: {
                ...base.capabilities,
                input: {
                  ...base.capabilities.input,
                  image: m.vision ?? base.capabilities.input.image,
                },
              },
              ...(m.vision !== undefined
                ? { modalities: { input: m.vision ? ["text", "image"] : ["text"], output: ["text"] } }
                : {}),
            }
            continue
          }
          // 动态出现的新模型（上游以后新增的）：按 id 推断协议，能力保守写
          const npm = npmFor(m.id)
          out[m.id] = {
            id: m.id,
            name: m.name ?? m.id,
            api: { id: m.id, url: BASE, npm },
            status: "active",
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: m.context ?? 1_000_000, output: 128_000 },
            modalities: { input: m.vision ? ["text", "image"] : ["text"], output: ["text"] },
            capabilities: {
              temperature: true,
              reasoning: true,
              toolcall: true,
              attachment: false,
              input: { text: true, image: Boolean(m.vision), audio: false, video: false, pdf: false },
              output: { text: true },
            },
            variants: { low: {}, medium: {}, high: {} },
          }
        }

        // 别名在上游没有独立 id：模型名留给用户选，api.id 指向真实模型。
        for (const [alias, target] of Object.entries(API_ID)) {
          if (out[alias] || !out[target]) continue
          out[alias] = { ...out[target], id: alias, api: { ...out[target].api, id: target } }
        }
        return out
      } catch (e) {
        // 登录被拒 → 标记账号（明确 401 / unauthorized 才这么做）
        if (/401|unauthorized|invalid_key|登录已失效/i.test(String(e?.message))) {
          throw Object.assign(new Error("登录已失效"), { signIn: "expired" })
        }
        // 本地反代没起来 / 上游暂时失败：退回静态兜底，不让模型列表整个空掉
        return fallback
      }
    },
  },

  // ═══ ⑧ 每请求加头 ═════════════════════════════════════════════
  /**
   * input.sessionID 是 magpie 的会话 id，同一会话多轮不变。
   * 可以用来做服务端的 session / cache 头。
   */
  "chat.headers": async (input, output) => {
    const id = input?.model?.providerID ?? input?.provider?.info?.id
    if (id !== PROVIDER || !input?.sessionID) return
    output.headers["x-alysis-session"] = String(input.sessionID).slice(0, 128)
  },
  }
}

// ── 实现：额度 / 模型目录 ───────────────────────────────────────────

/**
 * 从上游 account-status 拿额度（每个账号自己的 key）。
 * 数据来自上游 Alysis hosted gateway 的 account-status：
 *   billing.cap_5h_microusd / burn_5h_microusd  —— 5 小时公平使用窗口
 *   billing.cap_7d_microusd / burn_7d_microusd  —— 7 天窗口
 *   billing.balance_microusd                    —— 免费余额
 * 金额单位是 micro-USD（1e-6 美元）。
 */
async function fetchUsage(auth) {
  // 每账号直连 account-status：额度属于 key 自己，不经过本机反代（那会用池里的号串账）。
  const res = await fetch(`${CLOUD_API}/account-status`, {
    headers: { authorization: `Bearer ${auth.access || ""}` },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`account-status HTTP ${res.status}`)
  const account = await res.json()
  const billing = account?.billing || {}

  const usd = (micro) => (Number.isFinite(micro) ? micro / 1_000_000 : undefined)
  const percent = (burn, cap) => {
    if (!Number.isFinite(burn) || !Number.isFinite(cap) || cap <= 0) return undefined
    return Math.max(0, (burn / cap) * 100)
  }

  const fiveHour = {
    used: percent(billing.burn_5h_microusd, billing.cap_5h_microusd),
    amount: usd(billing.burn_5h_microusd),
    limit: usd(billing.cap_5h_microusd),
  }
  const weekly = {
    used: percent(billing.burn_7d_microusd, billing.cap_7d_microusd),
    amount: usd(billing.burn_7d_microusd),
    limit: usd(billing.cap_7d_microusd),
  }

  const tier = String(billing.tier || "").trim()
  const plan = tier ? `${tier} plan` : undefined
  const user = String(account.display_name || account.email || "").trim()

  return {
    plan,
    user,
    until: billing.current_period_end || billing.free_next_refill_at || undefined,
    balance: usd(billing.balance_microusd),
    fiveHour,
    weekly,
  }
}

/**
 * 每账号直连上游 GET /models：目录属于 key 自己，不经过本机反代。
 */
async function fetchLiveModels(auth) {
  const res = await fetch(`${BASE}/models`, {
    headers: { authorization: `Bearer ${auth.access || ""}` },
    signal: AbortSignal.timeout(12_000),
  })
  if (res.status === 401) throw new Error("401 登录已失效")
  if (!res.ok) throw new Error(`上游 /v1/models HTTP ${res.status}`)
  const data = await res.json()
  const rows = Array.isArray(data?.data) ? data.data : []
  return rows
    .filter((m) => m && typeof m.id === "string" && m.id.trim())
    .map((m) => ({
      id: m.id.trim(),
      name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : undefined,
      context: Number.isFinite(m.context_length) ? m.context_length : undefined,
      vision: typeof m.supports_vision === "boolean" ? m.supports_vision : undefined,
    }))
}

// 供测试引用（⚠ 入口文件不要导出 helper 函数，否则会被当插件调用）
export const _internal = {
  PROVIDER,
  BASE,
  staticModels,
  MODELS,
  readLocalAlysisKey,
  npmFor,
}
