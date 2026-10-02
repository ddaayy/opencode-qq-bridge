// bridge.test.ts — 桥接层回归：STREAMING=off 黄金文案 / PROGRESS_TOOL_CALL 门控 / 群聊不走流式 / 流式接线
import "./setup-env.js"
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { createBridge, resolveSendPath } from "../src/bridge.js"
import type { Config } from "../src/config.js"
import type { EventRouter } from "../src/opencode/events.js"
import type { SessionManager } from "../src/opencode/sessions.js"
import type { EventEnvelope, OpencodeClient } from "../src/opencode/client.js"
import type { MessageContext } from "../src/qq/types.js"

const SID = "ses_test_1"
const realFetch = globalThis.fetch
let apiCalls: Array<{ url: string; body: Record<string, unknown> }> = []

beforeEach(() => {
  apiCalls = []
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    if (u.includes("getAppAccessToken")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), { status: 200 })
    }
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    apiCalls.push({ url: u, body })
    return new Response(JSON.stringify({ id: "mid", timestamp: 1 }), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// ---- 桩 -------------------------------------------------------------------

class FakeRouter {
  listeners = new Map<string, (e: EventEnvelope) => void>()
  permissionCallbacks: Array<(p: unknown) => void> = []
  firstRegister: Promise<void>
  private resolveFirst!: () => void

  constructor() {
    this.firstRegister = new Promise((r) => {
      this.resolveFirst = r
    })
  }

  register(sessionId: string, cb: (e: EventEnvelope) => void): void {
    this.listeners.set(sessionId, cb)
    this.resolveFirst()
  }

  unregister(sessionId: string): void {
    this.listeners.delete(sessionId)
  }

  registerPermissionCallback(cb: (p: unknown) => void): void {
    this.permissionCallbacks.push(cb)
  }

  emit(e: EventEnvelope): void {
    const sid = (e.data as Record<string, unknown> | undefined)?.sessionID
    if (typeof sid === "string") this.listeners.get(sid)?.(e)
  }
}

function makeConfig(
  over: {
    streaming?: Partial<Config["streaming"]>
    progress?: Partial<Config["progress"]>
  } = {},
): Config {
  return {
    qq: { appId: "app1", clientSecret: "sec", sandbox: false },
    opencode: { baseUrl: "", externalUrl: false },
    allowedUsers: [],
    maxReplyLength: 3000,
    streaming: { enabled: false, intervalMs: 1500, chunkSize: 500, ...over.streaming },
    progress: {
      enabled: true,
      max: 0,
      minIntervalMs: 0,
      heartbeatMs: 60 * 1000,
      textMax: 600,
      toolCall: true,
      toolResult: true,
      toolResultMax: 300,
      ...over.progress,
    },
    texts: {},
  }
}

function makeClient(): OpencodeClient {
  const client = {
    server: { baseUrl: "http://local", password: "" },
    reconnect: async () => false,
    session: {
      prompt: async () => ({}),
      messages: async () => ({ data: [] }),
    },
    permission: { reply: async () => ({}) },
    event: { subscribe: () => ({}) },
  }
  return client as unknown as OpencodeClient
}

function makeSessions(): SessionManager {
  return {
    getOrCreate: async () => ({ sessionId: SID }),
    getModel: () => ({}),
    getAgent: () => undefined,
  } as unknown as SessionManager
}

function ev(type: string, data: Record<string, unknown> = {}): EventEnvelope {
  return { type, data: { sessionID: SID, ...data } }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor 超时")
    await new Promise((r) => setTimeout(r, 5))
  }
}

type Bridge = ReturnType<typeof createBridge>

/** 驱动一次完整对话：投递消息 → 等待事件监听注册 → 同步喂事件序列 */
async function runConversation(bridge: Bridge, router: FakeRouter, ctx: MessageContext, events: EventEnvelope[]): Promise<void> {
  void bridge.handleMessage(ctx)
  await router.firstRegister
  for (const e of events) router.emit(e)
}

const c2cCtx = (): MessageContext => ({ type: "c2c", userId: "U1", msgId: "MID1", content: "你好" })

function markdownContent(body: Record<string, unknown>): string {
  return (body.markdown as { content: string }).content
}

// ---- 回归：STREAMING=off 黄金文案 -----------------------------------------

describe("bridge 回归（STREAMING=off + 无 TEXT_*）", () => {
  test("进度与最终回复与现行硬编码逐字相同", async () => {
    const router = new FakeRouter()
    const bridge = createBridge(makeConfig(), makeClient(), router as unknown as EventRouter, makeSessions())
    await runConversation(bridge, router, c2cCtx(), [
      ev("session.text.started"),
      ev("session.text.delta", { delta: "第一段" }),
      ev("session.text.ended", { text: "第一段" }),
      ev("session.tool.input.started", { id: "call1", name: "bash" }),
      ev("session.tool.success", { id: "call1", content: [{ type: "text", text: "done ok" }] }),
      ev("session.text.started"),
      ev("session.text.delta", { delta: "第二段" }),
      ev("session.text.ended", { text: "第二段" }),
      ev("session.tool.failed", { error: "boom" }),
      ev("session.idle"),
    ])
    await waitFor(() => apiCalls.some((c) => c.body?.msg_id === "MID1"))
    // 进度走主动消息（无 msg_id），顺序与文案逐字断言
    const proactive = apiCalls.filter((c) => c.body?.msg_type === 2 && !c.body?.msg_id)
    expect(proactive.map((c) => markdownContent(c.body))).toEqual([
      "🔧 调用工具：bash",
      "📄 bash 返回：done ok",
      "💬 第一段",
      "❌ 工具失败：boom",
    ])
    // 最终回复走被动消息（msg_id 锚定）
    const replies = apiCalls.filter((c) => c.body?.msg_id === "MID1")
    expect(replies.map((c) => markdownContent(c.body))).toEqual(["第二段"])
  })

  test("PROGRESS_TOOL_CALL=off：🔧 不发、📄 仍发", async () => {
    const router = new FakeRouter()
    const bridge = createBridge(
      makeConfig({ progress: { toolCall: false } }),
      makeClient(),
      router as unknown as EventRouter,
      makeSessions(),
    )
    await runConversation(bridge, router, c2cCtx(), [
      ev("session.tool.input.started", { id: "call1", name: "bash" }),
      ev("session.tool.success", { id: "call1", content: [{ type: "text", text: "done ok" }] }),
      ev("session.text.started"),
      ev("session.text.delta", { delta: "答案" }),
      ev("session.text.ended", { text: "答案" }),
      ev("session.idle"),
    ])
    await waitFor(() => apiCalls.some((c) => c.body?.msg_id === "MID1"))
    const proactive = apiCalls.filter((c) => c.body?.msg_type === 2 && !c.body?.msg_id)
    expect(proactive.map((c) => markdownContent(c.body))).toEqual(["📄 bash 返回：done ok"])
    const replies = apiCalls.filter((c) => c.body?.msg_id === "MID1")
    expect(replies.map((c) => markdownContent(c.body))).toEqual(["答案"])
  })
})

// ---- 回归：群聊不构造流式 ---------------------------------------------------

describe("bridge 群聊 + STREAMING=on", () => {
  test("零 stream_messages 调用，仍走 sendGroupMessage", async () => {
    const router = new FakeRouter()
    const bridge = createBridge(
      makeConfig({ streaming: { enabled: true } }),
      makeClient(),
      router as unknown as EventRouter,
      makeSessions(),
    )
    const ctx: MessageContext = { type: "group", userId: "U1", groupId: "G1", msgId: "MID1", content: "你好" }
    await runConversation(bridge, router, ctx, [
      ev("session.tool.input.started", { id: "call1", name: "bash" }),
      ev("session.tool.success", { id: "call1", content: [{ type: "text", text: "ok" }] }),
      ev("session.text.started"),
      ev("session.text.delta", { delta: "群聊回复" }),
      ev("session.text.ended", { text: "群聊回复" }),
      ev("session.idle"),
    ])
    await waitFor(() => apiCalls.some((c) => c.url.includes("/v2/groups/G1/messages") && c.body?.msg_id === "MID1"))
    expect(apiCalls.every((c) => !c.url.includes("stream_messages"))).toBe(true)
    expect(apiCalls.some((c) => c.url.includes("/v2/groups/G1/messages"))).toBe(true)
    // 进度与最终回复都走群消息
    const proactive = apiCalls.filter((c) => c.url.includes("/v2/groups/G1/messages") && !c.body?.msg_id)
    expect(proactive.map((c) => markdownContent(c.body))).toEqual(["🔧 调用工具：bash", "📄 bash 返回：ok"])
  })
})

// ---- 流式接线 ---------------------------------------------------------------

describe("bridge STREAMING=on（C2C）", () => {
  test("WAITING 首片 msg_id 锚定 → 正文流 → 终片，不再发全量回复", async () => {
    const router = new FakeRouter()
    const bridge = createBridge(
      makeConfig({ streaming: { enabled: true, intervalMs: 200 } }),
      makeClient(),
      router as unknown as EventRouter,
      makeSessions(),
    )
    const body = "好".repeat(30)
    await runConversation(bridge, router, c2cCtx(), [
      ev("session.text.started"),
      ev("session.text.delta", { delta: body }),
      ev("session.text.ended", { text: body }),
      ev("session.idle"),
    ])
    await waitFor(() => apiCalls.filter((c) => c.url.includes("stream_messages")).length >= 4)
    const ss = apiCalls.filter((c) => c.url.includes("stream_messages")).map((c) => c.body)
    expect(ss).toHaveLength(4)
    expect(ss[0]).toMatchObject({ content_raw: "请稍候", index: 0, input_mode: "replace", input_state: 1, msg_id: "MID1" })
    // 占位流终片：官方 close 形状 = replace + 该流最后成功内容 + state10（真机 404 修复）
    expect(ss[1]).toMatchObject({ content_raw: "请稍候", input_mode: "replace", input_state: 10 })
    expect(ss[2]).toMatchObject({ content_raw: body, index: 0, input_mode: "replace", input_state: 1, msg_id: "MID1" })
    // 正文终片 = replace + 全量 + state10（官方 update() 全文语义）
    expect(ss[3]).toMatchObject({ content_raw: body, input_mode: "replace", input_state: 10 })
    // 每片都携带 msg_id（官方 SDK 语义，真机续片缺 msg_id 报 50015001）
    expect(ss.every((x) => x.msg_id === "MID1")).toBe(true)
    // 同一流 msg_seq 恒定
    expect(ss[0].msg_seq).toBe(ss[1].msg_seq)
    expect(ss[2].msg_seq).toBe(ss[3].msg_seq)
    // 正文已流式投递：不再发普通 /messages 回复
    expect(apiCalls.filter((c) => c.url.endsWith("/v2/users/U1/messages"))).toHaveLength(0)
  })

  test("sendfile 标记：正文流剥离标记，finish 成功后只发文件错误提示、无全量正文", async () => {
    const router = new FakeRouter()
    const bridge = createBridge(
      makeConfig({ streaming: { enabled: true, intervalMs: 200 } }),
      makeClient(),
      router as unknown as EventRouter,
      makeSessions(),
    )
    const body = "这是带标记的正文内容".repeat(3) // 36 字符 ≥ 24
    const marker = "[[sendfile:/tmp/qq-bridge-test-no-such-file.txt]]"
    await runConversation(bridge, router, c2cCtx(), [
      ev("session.text.started"),
      ev("session.text.delta", { delta: body + marker }),
      ev("session.text.ended", { text: body + marker }),
      ev("session.idle"),
    ])
    // 文件不存在 → deliverResult 发出「文件发送失败」被动回复
    await waitFor(() => apiCalls.some((c) => c.url.endsWith("/v2/users/U1/messages")))
    const ss = apiCalls.filter((c) => c.url.includes("stream_messages")).map((c) => c.body)
    const streamed = ss.map((s) => s.content_raw as string).join("")
    expect(streamed).toContain(body)
    expect(streamed).not.toContain("sendfile")
    expect(streamed).not.toContain("/tmp/qq-bridge-test-no-such-file.txt")
    // 唯一的普通消息是文件失败提示，不含流式正文（证明 finish 比对成功、未走全量回退）
    const msgs = apiCalls.filter((c) => c.url.endsWith("/v2/users/U1/messages"))
    expect(msgs).toHaveLength(1)
    expect(markdownContent(msgs[0].body)).toContain("文件发送失败")
    expect(markdownContent(msgs[0].body)).not.toContain(body)
  })

  test("思考标签：finish 基准叠加剥离（与流式缓冲共用同一函数），不误走全量回退", async () => {
    const router = new FakeRouter()
    const bridge = createBridge(
      makeConfig({ streaming: { enabled: true, intervalMs: 200 } }),
      makeClient(),
      router as unknown as EventRouter,
      makeSessions(),
    )
    const body = "这是最终结论".repeat(6) // 36 字符 ≥ 24
    const reply = body + "<thinking>内部推理不应外泄</thinking>"
    await runConversation(bridge, router, c2cCtx(), [
      ev("session.text.started"),
      ev("session.text.delta", { delta: reply }),
      ev("session.text.ended", { text: reply }),
      ev("session.idle"),
    ])
    await waitFor(() => apiCalls.filter((c) => c.url.includes("stream_messages")).length >= 4)
    const ss = apiCalls.filter((c) => c.url.includes("stream_messages")).map((c) => c.body)
    const streamed = ss.map((s) => s.content_raw as string).join("")
    expect(streamed).toContain(body)
    expect(streamed).not.toContain("内部推理")
    // finish 基准 = 剥思考标签后的文本 → 比对成功，不发全量回复
    expect(apiCalls.filter((c) => c.url.endsWith("/v2/users/U1/messages"))).toHaveLength(0)
  })
})

// ---- resolveSendPath：URL 原样返回，本地路径行为不变 --------------------------

describe("resolveSendPath", () => {
  test("http/https URL 原样返回（含查询串），不拼本地路径", () => {
    expect(resolveSendPath("https://example.com/a.png?w=100")).toBe("https://example.com/a.png?w=100")
    expect(resolveSendPath("http://example.com/a.mp3")).toBe("http://example.com/a.mp3")
  })
  test("本地路径与 file:// 行为不变", () => {
    expect(resolveSendPath("/tmp/a.txt")).toBe("/tmp/a.txt")
    expect(resolveSendPath("relative/a.txt")).toBe("relative/a.txt")
    expect(resolveSendPath("file:///tmp/a.txt")).toBe("/tmp/a.txt")
  })
})
