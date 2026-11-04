// 共享上下文 —— 框里所有小插头都读这一份
//
// ⚠ 改这里，不要改各个 hook 文件里的常量。
//   针脚模块只关心「怎么填这一个针脚」，厂商信息全在这儿。

/** 厂商 id：agent 用 `<id>/<model>` 命名，改完全世界都要跟着改 */
export const PROVIDER = "alysis"

/** 卡片上显示的供应商名：必须 <中文> <English>，英文照抄厂商官方品牌写法 */
export const PROVIDER_NAME = "Alysis Code 免费额度"

/** 上游 API 基址 */
export const BASE = "http://127.0.0.1:8788/v1"

/**
 * 打上游的 UA —— **一个插件只留这一个常量，所有出站点（api / chat / loader /
 * usage / models / hooks）都引用它**。
 *
 * ⚠ 值必须是「官方客户端」的 UA，**不能是 `<产品名>/<版本号>`**：上游网关按
 * `<product>/<version>` 形态认「第三方客户端」，命中即回
 * `403 {"error_code":"TM.00000001","error_msg":"网络繁忙，请稍后重试"}`；
 * 而不显式设 UA 时宿主会把 `magpie/<version>` 原样透传，同样命中。
 * Alysis 的官方客户端就是官方网页（Cookie / 网页里创建的 slk_ key），
 * 所以这里逐字用一条完整合法的 Chrome UA —— 别改版本号，也别退回产品名。
 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/**
 * 决定 API 形状，别乱选：
 *   @ai-sdk/anthropic         → Anthropic Messages  /messages
 *   @ai-sdk/openai            → OpenAI Responses    /responses
 *   @ai-sdk/google            → Gemini              /models/<id>:streamGenerateContent
 *   @ai-sdk/openai-compatible → Chat completions    /chat/completions
 */
export const SDK = "@ai-sdk/openai-compatible"

/** api_key 只活几分钟/几小时时，提前多久换 */
export const REFRESH_LEAD_MS = 5 * 60_000

/**
 * 图标 —— **两处必须一致**，缺一份就有地方显示灰方块：
 *   auth.icon（本文件导出，hooks/methods 用）→ 供应商列表那一行、用量概览的卡
 *   package.json 的 magpie.icon            → 插件列表那一行、插件详情页左上角
 * 见 HOOKS.md「插件自己的图标」。
 */
export const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMWYyOTM3Ii8+PHRleHQgeD0iNjQiIHk9Ijg0IiBmb250LXNpemU9IjYwIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiM2MGE1ZmEiIHRleHQtYW5jaG9yPSJtaWRkbGUiPkE8L3RleHQ+PC9zdmc+"

// ── 模型表 ────────────────────────────────────────────────────────────
//
// ⚠ context 必须实测，不要凭印象填。这个数字会被转给 agent（DSH 等），
//   决定它什么时候压缩对话：填小了浪费容量、还会把路由组整体的窗口拉低；
//   填大了 agent 以为有余量，请求超了上游才报错。
//   别把「最大输出」当「上下文」—— DeepSeek 系常见 128K 输出 / 1M 上下文。
//
// ⚠ 这里只是**未登录时的兜底**。一旦能拉到账号自己的列表，
//   hooks/models.mjs 会把它整份换掉 —— 所以别把它当权威。

/** [id, 显示名, 上下文窗口, reasoning 档位] */
export const MODELS = [
  ["model-a", "Model A", 200_000, ["low", "high"]],
  ["model-b", "Model B", 1_000_000],
]

/** 静态模型表（未登录 / 拉取失败时兜底，必须有内容） */
export function staticModels() {
  const out = {}
  for (const [id, name, context, efforts] of MODELS) {
    out[id] = {
      id,
      name,
      api: { id, url: BASE, npm: SDK },
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context, output: 64_000 },
      // config 钩子的静态模型走 modalities；capabilities.input 是 provider.models 路径的字段。
      // 两个都写，避免「只写 capabilities 而 config 路径读不到模态」。
      modalities: { input: ["text"], output: ["text"] },
      capabilities: {
        temperature: true,
        reasoning: Array.isArray(efforts) && efforts.length > 0,
        toolcall: true,
        attachment: false,
        // HOOKS 十一之三：五个模态键必须显式写布尔（省略 image ≠ text）
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true },
      },
      ...(efforts?.length ? { variants: Object.fromEntries(efforts.map((e) => [e, {}])) } : {}),
    }
  }
  return out
}

/** 框里所有小插头拿到的同一份上下文 */
export const ctx = { PROVIDER, PROVIDER_NAME, BASE, SDK, ICON, REFRESH_LEAD_MS, MODELS, staticModels }
