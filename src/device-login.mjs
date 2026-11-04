// src/device-login.mjs —— 隔离浏览器 + 设备码登录（RFC 8628 风格）
//
// 为什么需要它：Alysis 的登录态可以「读本机客户端」（默认路径，根本不打开浏览器）。
// 但客户端没登录时，只能用网页批准设备码。直接让 magpie 打开默认浏览器会复用
// 用户日常浏览器里的 alysis 会话（用户明确要求不要这样），所以这里：
//   1. POST device-code 拿 user_code；
//   2. 用一次性的 Chromium user-data-dir 打开 /activate?code=…（不碰默认浏览器）；
//   3. 页面就绪后由 prepare() 自动处理：未登录先落到「注册」、登录后自动填 code 并提交；
//   4. 轮询 device-token 拿 slk_ key；
//   5. 关闭窗口并删掉临时 profile。
//
// 协议事实来自 Alysis Code CLI（alysis_code/alysis_cloud.py、account_login.py）：
//   POST {cloud}/device-code  {"client_name", "installation_id"}
//     → { device_code, user_code, verification_url, interval, expires_in }
//   POST {cloud}/device-token {"device_code"}
//     → { status: "pending"|"approved"|"denied"|"expired", key }
// 只用 https；云地址不是凭据，服务端自己认设备。

import { spawn } from "node:child_process"
import crypto from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { findBrowser } from "./browser-login.mjs"
import { USER_AGENT } from "./context.mjs"

const DEFAULT_CLOUD_API = "https://vzigujbcjjmpntxhmyvr.supabase.co/functions/v1"
const SITE_URL = "https://alysiscode.com"
const DEFAULT_INTERVAL_S = 3
const DEFAULT_EXPIRES_S = 15 * 60
const POLL_TIMEOUT_MS = 15 * 60_000
const PREPARE_TIMEOUT_MS = 5 * 60_000

function cloudApi() {
  const raw = process.env.ALYSIS_CLOUD_API_URL || DEFAULT_CLOUD_API
  return String(raw).replace(/\/+$/, "")
}

function postJson(url, body, timeoutMs = 15_000) {
  return fetch(url, {
    method: "POST",
    // 设备码服务也在真上游上：显式带官方 UA，别透传宿主的 `magpie/<version>`
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    const text = await res.text()
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
    if (!res.ok) {
      const message = data?.error?.message || data?.message || text.slice(0, 160)
      throw new Error(`设备码服务 HTTP ${res.status}：${message}`)
    }
    if (!data) throw new Error("设备码服务返回的不是 JSON")
    return data
  })
}

/** 发起设备码登录，返回 grant（user_code / device_code / 轮询参数）。 */
export async function startDeviceGrant({ clientName, installationId } = {}) {
  const body = {
    client_name: String(clientName || `magpie-alysis-auth @ ${process.env.COMPUTERNAME || "host"}`).slice(0, 80),
    installation_id: String(installationId || crypto.randomUUID()),
  }
  const data = await postJson(`${cloudApi()}/device-code`, body)
  const deviceCode = String(data.device_code || "").trim()
  const userCode = String(data.user_code || "").trim()
  if (!deviceCode || !userCode) throw new Error("设备码服务没有返回 device_code / user_code")
  const interval = Number(data.interval)
  const expiresIn = Number(data.expires_in)
  return {
    deviceCode,
    userCode,
    intervalS: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_S,
    expiresInS: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_S,
  }
}

/** 用户批准页地址（隔离浏览器打开这个，不碰默认浏览器）。 */
export function approvalUrl(userCode) {
  return `${SITE_URL}/activate?code=${encodeURIComponent(String(userCode || ""))}`
}

/**
 * 轮询 device-token，直到 approved（返回 slk_ key）或 denied / expired。
 * @returns {Promise<string>} gateway key
 */
export async function pollForKey(grant, { signal, timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + Math.min(timeoutMs, (grant.expiresInS || DEFAULT_EXPIRES_S) * 1000)
  const intervalMs = Math.max(1, (Number(grant.intervalS) || DEFAULT_INTERVAL_S) * 1000)
  for (;;) {
    if (signal?.aborted) throw new Error("登录已取消")
    const data = await postJson(`${cloudApi()}/device-token`, { device_code: grant.deviceCode })
    const status = String(data.status || "").toLowerCase()
    if (status === "approved") {
      const key = String(data.key || "").trim()
      if (!key) throw new Error("设备码已批准，但服务端没有返回 key")
      return key
    }
    if (status === "denied") throw new Error("登录已被拒绝")
    if (["expired", "not_found", "already_claimed"].includes(status)) {
      throw new Error("登录码已过期，请重新发起")
    }
    if (Date.now() + intervalMs > deadline) throw new Error("等待批准超时，请重新发起")
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

// ── 一次性隔离浏览器 ──────────────────────────────────────────────────

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

async function pageWsUrl(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      const pages = await res.json()
      const page = Array.isArray(pages) ? pages.find((p) => p?.type === "page" && p.webSocketDebuggerUrl) : null
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // 浏览器还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return ""
}

function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  ws.addEventListener("message", (event) => {
    let msg = null
    try {
      msg = JSON.parse(String(event.data))
    } catch {
      return
    }
    const entry = msg?.id ? pending.get(msg.id) : null
    if (!entry) return
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(msg.error.message || "CDP error"))
    else entry.resolve(msg.result)
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(new Error("CDP 连不上隔离浏览器")), { once: true })
  })
  return {
    ready,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      try {
        ws.close()
      } catch {}
    },
  }
}

/**
 * 打开一个一次性隔离浏览器窗口（独立 user-data-dir，退出即删除）。
 *
 * @param {string} url
 * @param {{
 *   browser?: {name:string, path:string} | null,
 *   prepare?: (page: { evaluate: (expr: string) => Promise<any> }) => Promise<"done" | "wait">,
 * }} [options]
 *   prepare 在窗口打开后后台轮询调用（每 1.2 秒），返回 "done" 结束。
 * @returns {Promise<{ close: () => void, profile: string, browser: string, evaluate: (expr: string) => Promise<any> }>}
 */
export async function openIsolatedBrowser(url, { browser = findBrowser(), prepare } = {}) {
  if (!browser?.path) throw new Error("没有找到 Chromium 内核浏览器（Chrome / Edge / 360 / QQ 等）")
  const profile = mkdtempSync(join(tmpdir(), "magpie-alysis-login-"))
  const port = await freePort()
  const child = spawn(
    browser.path,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      url,
    ],
    { stdio: "ignore", windowsHide: false, detached: false },
  )

  let closed = false
  let conn = null

  const close = () => {
    if (closed) return
    closed = true
    try {
      conn?.close()
    } catch {}
    try {
      child.kill()
    } catch {}
    // Windows 上浏览器退出后仍会短暂持有 profile 里的文件句柄，立即 rm 会失败。
    // 后台重试删除（最多 5 次），不阻塞 finally。
    let tries = 0
    const remove = () => {
      tries += 1
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {
        if (tries < 5) setTimeout(remove, 500)
      }
    }
    setTimeout(remove, 600)
  }

  const page = {
    profile,
    browser: browser.name,
    close,
    async evaluate(expression) {
      if (closed) throw new Error("隔离浏览器已关闭")
      if (!conn) {
        const wsUrl = await pageWsUrl(port)
        if (!wsUrl) throw new Error("隔离浏览器没有暴露调试端口")
        conn = cdpConnect(wsUrl)
        await conn.ready
      }
      const result = await conn.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      return result?.result?.value
    },
  }

  if (typeof prepare === "function") {
    void (async () => {
      const deadline = Date.now() + PREPARE_TIMEOUT_MS
      while (!closed && Date.now() < deadline) {
        try {
          if ((await prepare(page)) === "done") return
        } catch {
          // 页面还没就绪 / 导航中：下一轮再试
        }
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
    })()
  }

  return page
}

export const _internal = { cloudApi, DEFAULT_CLOUD_API, SITE_URL, POLL_TIMEOUT_MS, PREPARE_TIMEOUT_MS }
