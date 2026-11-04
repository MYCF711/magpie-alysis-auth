// tests/device-login.test.mjs —— 隔离浏览器设备码登录的语义锁
//
// 锁三件事：
//   1. 批准页 URL 必须带 user_code 且做 URL 编码（默认浏览器绝不会被用到）
//   2. device-token 的状态机：pending 继续等、approved 返回 key、denied/expired 抛错
//   3. 隔离窗口只接受 Chromium 浏览器；没有就明确报错，不退回默认浏览器
//
// 全部离线：globalThis.fetch 被替换成桩，不碰真实网络。

import test from "node:test"
import assert from "node:assert/strict"

import { approvalUrl, pollForKey, startDeviceGrant, openIsolatedBrowser } from "../src/device-login.mjs"

function stubFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return () => {
    globalThis.fetch = original
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("approvalUrl：带 code 且做 URL 编码，指向 activate 页", () => {
  assert.equal(approvalUrl("AB-12"), "https://alysiscode.com/activate?code=AB-12")
  assert.equal(approvalUrl("a b&c"), "https://alysiscode.com/activate?code=a%20b%26c")
  assert.equal(approvalUrl(""), "https://alysiscode.com/activate?code=")
})

test("startDeviceGrant：解析 device_code / user_code / interval / expires_in", async () => {
  const restore = stubFetch(async (url, init) => {
    assert.match(String(url), /\/device-code$/)
    const body = JSON.parse(String(init.body))
    assert.equal(body.client_name, "magpie-alysis-code @ test")
    assert.ok(body.installation_id)
    return jsonResponse({ device_code: "dc-1", user_code: "UC-1", interval: 5, expires_in: 900 })
  })
  try {
    const grant = await startDeviceGrant({ clientName: "magpie-alysis-code @ test", installationId: "i-1" })
    assert.deepEqual(
      { deviceCode: grant.deviceCode, userCode: grant.userCode, intervalS: grant.intervalS, expiresInS: grant.expiresInS },
      { deviceCode: "dc-1", userCode: "UC-1", intervalS: 5, expiresInS: 900 },
    )
  } finally {
    restore()
  }
})

test("startDeviceGrant：缺 user_code 直接失败，不臆造", async () => {
  const restore = stubFetch(async () => jsonResponse({ device_code: "dc-only" }))
  try {
    await assert.rejects(() => startDeviceGrant({}), /没有返回 device_code \/ user_code/)
  } finally {
    restore()
  }
})

test("pollForKey：pending 继续等，approved 返回 slk_ key", async () => {
  let calls = 0
  const restore = stubFetch(async () => {
    calls += 1
    if (calls < 3) return jsonResponse({ status: "pending" })
    return jsonResponse({ status: "approved", key: "slk_test_key" })
  })
  try {
    const key = await pollForKey({ deviceCode: "dc", userCode: "u", intervalS: 0.005, expiresInS: 10 })
    assert.equal(key, "slk_test_key")
    assert.equal(calls, 3)
  } finally {
    restore()
  }
})

test("pollForKey：denied 抛错，不再轮询", async () => {
  let calls = 0
  const restore = stubFetch(async () => {
    calls += 1
    return jsonResponse({ status: "denied" })
  })
  try {
    await assert.rejects(
      () => pollForKey({ deviceCode: "dc", userCode: "u", intervalS: 0.005, expiresInS: 10 }),
      /登录已被拒绝/,
    )
    assert.equal(calls, 1)
  } finally {
    restore()
  }
})

test("pollForKey：expired / already_claimed 都按过期处理", async () => {
  for (const status of ["expired", "already_claimed", "not_found"]) {
    const restore = stubFetch(async () => jsonResponse({ status }))
    try {
      await assert.rejects(
        () => pollForKey({ deviceCode: "dc", userCode: "u", intervalS: 0.005, expiresInS: 10 }),
        /登录码已过期/,
      )
    } finally {
      restore()
    }
  }
})

test("openIsolatedBrowser：没有 Chromium 浏览器就明确报错，不退回默认浏览器", async () => {
  await assert.rejects(() => openIsolatedBrowser("https://example.com", { browser: null }), /没有找到 Chromium 内核浏览器/)
  await assert.rejects(() => openIsolatedBrowser("https://example.com", { browser: { path: "" } }), /没有找到 Chromium 内核浏览器/)
})
