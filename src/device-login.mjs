// src/device-login.mjs —— 隔离浏览器 + 设备码登录（RFC 8628 风格）
//
// 为什么需要它：Alysis 的登录态可以「读本机客户端」（默认路径，根本不打开浏览器）。
// 但客户端没登录时，只能用网页批准设备码。直接让 magpie 打开默认浏览器会复用
// 用户日常浏览器里的 alysis 会话（用户明确要求不要这样），所以这里：
//   1. POST device-code 拿 user_code；
//   2. 用一次性的 Chromium user-data-dir 打开 /activate?code=…（不碰默认浏览器）；
//   3. 轮询 device-token 拿 slk_ key；
//   4. 关闭窗口并删掉临时 profile。
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
import { tmpdir } from "node:os"
import { join } from "node:path"

import { findBrowser } from "./browser-login.mjs"

const DEFAULT_CLOUD_API = "https://vzigujbcjjmpntxhmyvr.supabase.co/functions/v1"
const SITE_URL = "https://alysiscode.com"
const DEFAULT_INTERVAL_S = 3
const DEFAULT_EXPIRES_S = 15 * 60
const POLL_TIMEOUT_MS = 15 * 60_000

function cloudApi() {
  const raw = process.env.ALYSIS_CLOUD_API_URL || DEFAULT_CLOUD_API
  return String(raw).replace(/\/+$/, "")
}

function postJson(url, body, timeoutMs = 15_000) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
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

/**
 * 打开一个一次性隔离浏览器窗口（独立 user-data-dir，退出即删除）。
 * 不等待任何 Cookie / 页面状态 —— 只负责把批准页摆到用户面前。
 * @returns {{ close: () => void, profile: string, browser: string }}
 */
export function openIsolatedBrowser(url, { browser = findBrowser() } = {}) {
  if (!browser?.path) throw new Error("没有找到 Chromium 内核浏览器（Chrome / Edge / 360 / QQ 等）")
  const profile = mkdtempSync(join(tmpdir(), "magpie-alysis-login-"))
  const child = spawn(
    browser.path,
    [
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
  const close = () => {
    if (closed) return
    closed = true
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
  return { close, profile, browser: browser.name }
}

export const _internal = { cloudApi, DEFAULT_CLOUD_API, SITE_URL, POLL_TIMEOUT_MS }
