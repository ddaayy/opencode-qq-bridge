// bridge.test.ts — 桥接层回归：STREAMING=off 黄金文案 / PROGRESS_TOOL_CALL 门控 / 群聊不走流式 / 流式接线
import "./setup-env.js"
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { createBridge, resolveSendPath, sendFileHintText, SEND_FILE_MAX_BYTES } from "../src/bridge.js"
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

  formCallbacks: Array<(e: unknown) => void> = []

  registerFormCallback(cb: (e: unknown) => void): void {
    this.formCallbacks.push(cb)
  }

  hasListener(sessionId: string): boolean {
    return this.listeners.has(sessionId)
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
    streaming: { enabled: false, intervalMs: 1500, chunkSize: 500, maxScenes: 3, ...over.streaming },
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

function makeClient(
  opts: {
    /** 记录对 OpenCode 的调用（prompt / form.reply / form.cancel） */
    calls?: Array<{ url: string; body?: unknown }>
    /** listBySession 返回的待答表单（模拟服务端已有 pending form） */
    pendingForms?: Array<Record<string, unknown>>
  } = {},
): OpencodeClient {
  const calls = opts.calls ?? []
  const client = {
    server: { baseUrl: "http://local", password: "" },
    reconnect: async () => false,
    session: {
      prompt: async (params: unknown) => {
        calls.push({ url: "session.prompt", body: params })
        return {}
      },
      messages: async () => ({ data: [] }),
    },
    permission: { reply: async () => ({}) },
    event: { subscribe: () => ({}) },
    form: {
      listBySession: async () => ({ data: opts.pendingForms ?? [] }),
      reply: async (params: { sessionID: string; formID: string; answer: Record<string, unknown> }) => {
        calls.push({ url: `form.reply/${params.formID}`, body: params.answer })
        return {}
      },
      cancel: async (params: { sessionID: string; formID: string }) => {
        calls.push({ url: `form.cancel/${params.formID}` })
        return {}
      },
    },
  }
  return client as unknown as OpencodeClient
}

function makeSessions(): SessionManager {
  return {
    getOrCreate: async () => ({ sessionId: SID }),
    getSession: () => ({ sessionId: SID }),
    findUserIdBySessionId: () => "U1",
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

// ---- 发文件：体积上限与系统提示文案（必须与 sender.ts 实现一致）-------------

describe("发文件上限与系统提示", () => {
  test("SEND_FILE_MAX_BYTES 默认 200MB（= QQ 官方 file_type=4 硬限制）", () => {
    expect(SEND_FILE_MAX_BYTES).toBe(200 * 1024 * 1024)
  })

  test("提示：>4MB 走官方分片上传并一次性下发（单文件、无需合并）+ 体积上限两层口径", () => {
    const hint = sendFileHintText()
    expect(hint).toContain(">4MB")
    expect(hint).toContain("官方分片上传")
    expect(hint).toContain("一次性下发")
    expect(hint).toContain("单个完整文件")
    expect(hint).toContain("无需手动合并")
    expect(hint).toContain("200MB")
    expect(hint).toContain("850031")
    // 新口径：默认由 SEND_FILE_MAX_BYTES 在入口拦截报「文件过大」；chunked 内部 200MB 硬校验仅兜底
    expect(hint).toContain("SEND_FILE_MAX_BYTES")
    expect(hint).toContain("文件过大")
    expect(hint).toContain("兜底")
  })

  test("提示：旧说法（会刷很多条 / 需要手动合并 / 100MB / 超了会报 850031）已删除", () => {
    const hint = sendFileHintText()
    expect(hint).not.toContain("会刷很多条")
    expect(hint).not.toContain("需要手动合并")
    expect(hint).not.toContain("100MB")
    expect(hint).not.toContain("超了会报 850031")
  })
})

// ---- AI 提问（question 工具 → pending form） --------------------------------

/** 与线上真实 pending form 同构的题目（两题） */
function questionForm(): { id: string; sessionID: string; title: string; metadata: Record<string, unknown>; fields: Array<Record<string, unknown>> } {
  return {
    id: "frm_q1",
    sessionID: SID,
    title: "Questions",
    metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } },
    fields: [
      {
        key: "q0",
        title: "是否现在装",
        description: "要我现在直接帮你装好吗？",
        type: "string",
        options: [
          { value: "装 A (推荐)", label: "装 A (推荐)", description: "推荐理由" },
          { value: "只装 B", label: "只装 B" },
          { value: "先别装", label: "先别装" },
        ],
        custom: true,
      },
      {
        key: "q1",
        title: "拉哪个模型",
        type: "string",
        options: [
          { value: "m1 (推荐)", label: "m1 (推荐)" },
          { value: "m2", label: "m2" },
        ],
        custom: true,
      },
    ],
  }
}

function emitFormEvent(router: FakeRouter, type: "created" | "cancelled" | "replied"): void {
  router.formCallbacks[0]?.({ type, ...questionForm() })
}

describe("bridge AI 提问（question 表单）", () => {
  test("form.created → 主动推送题目（标题/选项/作答提示齐全）", async () => {
    const router = new FakeRouter()
    createBridge(makeConfig(), makeClient(), router as unknown as EventRouter, makeSessions())
    emitFormEvent(router, "created")
    await waitFor(() => apiCalls.some((c) => c.body?.msg_type === 2 && !c.body?.msg_id))
    const pushed = apiCalls.filter((c) => c.body?.msg_type === 2 && !c.body?.msg_id)
    const text = markdownContent(pushed[0].body)
    expect(text).toContain("**第 1 题：是否现在装**")
    expect(text).toContain("**第 2 题：拉哪个模型**")
    expect(text).toContain("要我现在直接帮你装好吗？")
    expect(text).toContain("1. 装 A (推荐)")
    expect(text).toContain("3. 先别装")
    expect(text).toContain("按顺序回复每题的序号，例如：1 1")
    expect(text).toContain("/cancel")
  })

  test("回复序号 → 提交 form.reply（不转发新 prompt）并确认", async () => {
    const router = new FakeRouter()
    const ocCalls: Array<{ url: string; body?: unknown }> = []
    const bridge = createBridge(
      makeConfig(),
      makeClient({ calls: ocCalls }),
      router as unknown as EventRouter,
      makeSessions(),
    )
    emitFormEvent(router, "created")
    await waitFor(() => apiCalls.some((c) => c.body?.msg_type === 2 && !c.body?.msg_id))

    await bridge.handleMessage({ type: "c2c", userId: "U1", msgId: "MID2", content: "1 2" })
    await waitFor(() => ocCalls.some((c) => c.url.startsWith("form.reply/")))

    expect(ocCalls.find((c) => c.url === "form.reply/frm_q1")?.body).toEqual({
      q0: "装 A (推荐)",
      q1: "m2",
    })
    // 不应把这条消息当成新 prompt 转发给 opencode
    expect(ocCalls.some((c) => c.url === "session.prompt")).toBe(false)
    const replies = apiCalls.filter((c) => c.body?.msg_id === "MID2")
    expect(replies).toHaveLength(1)
    expect(markdownContent(replies[0].body)).toContain("已选择：是否现在装=装 A (推荐)；拉哪个模型=m2")

    // 作答后没有在途等待 → 桥重新挂监听接管后续输出，喂 idle 让它收尾，避免测试泄漏定时器
    await waitFor(() => router.listeners.has(SID))
    router.emit(ev("session.execution.succeeded"))
    await waitFor(() => !router.listeners.has(SID))
  })

  test("/cancel → 放弃提问并恢复可对话", async () => {
    const router = new FakeRouter()
    const ocCalls: Array<{ url: string; body?: unknown }> = []
    const bridge = createBridge(
      makeConfig(),
      makeClient({ calls: ocCalls }),
      router as unknown as EventRouter,
      makeSessions(),
    )
    emitFormEvent(router, "created")
    await waitFor(() => apiCalls.some((c) => c.body?.msg_type === 2 && !c.body?.msg_id))

    await bridge.handleMessage({ type: "c2c", userId: "U1", msgId: "MID3", content: "/cancel" })
    await waitFor(() => ocCalls.some((c) => c.url.startsWith("form.cancel/")))
    expect(ocCalls.some((c) => c.url === "form.cancel/frm_q1")).toBe(true)
    const replies = apiCalls.filter((c) => c.body?.msg_id === "MID3")
    expect(markdownContent(replies[0].body)).toContain("已放弃本次提问")

    // 提问已丢弃：同一条内容之后按普通消息走
    void bridge.handleMessage({ type: "c2c", userId: "U1", msgId: "MID4", content: "1 2" })
    await waitFor(() => router.listeners.has(SID))
    expect(ocCalls.some((c) => c.url === "form.reply/frm_q1")).toBe(false)
    router.emit(ev("session.execution.succeeded"))
    await waitFor(() => !router.listeners.has(SID))
  })

  test("内存态为空但服务端仍有表单 → 补发题目并拦下消息（不转发）", async () => {
    const router = new FakeRouter()
    const ocCalls: Array<{ url: string; body?: unknown }> = []
    const bridge = createBridge(
      makeConfig(),
      makeClient({ calls: ocCalls, pendingForms: [questionForm()] }),
      router as unknown as EventRouter,
      makeSessions(),
    )
    await bridge.handleMessage({ type: "c2c", userId: "U1", msgId: "MID5", content: "你好" })

    // 补发的题目（主动）+ 拦截提示（被动）
    const pushed = apiCalls.filter((c) => c.body?.msg_type === 2 && !c.body?.msg_id)
    expect(markdownContent(pushed[0].body)).toContain("是否现在装")
    const replies = apiCalls.filter((c) => c.body?.msg_id === "MID5")
    expect(markdownContent(replies[0].body)).toContain("AI 正在等你回答")
    expect(ocCalls.some((c) => c.url === "session.prompt")).toBe(false)

    // 第二条消息已被内存态接管为「作答」
    void bridge.handleMessage({ type: "c2c", userId: "U1", msgId: "MID6", content: "2 1" })
    await waitFor(() => ocCalls.some((c) => c.url === "form.reply/frm_q1"))
    expect(ocCalls.find((c) => c.url === "form.reply/frm_q1")?.body).toEqual({ q0: "只装 B", q1: "m1 (推荐)" })
    await waitFor(() => router.listeners.has(SID))
    router.emit(ev("session.execution.succeeded"))
    await waitFor(() => !router.listeners.has(SID))
  })

  test("已切换会话后，旧提问不再拦截（/new 场景）", async () => {
    const router = new FakeRouter()
    const ocCalls: Array<{ url: string; body?: unknown }> = []
    const bound = { sessionId: SID }
    const sessions = {
      getOrCreate: async () => bound,
      getSession: () => bound,
      getModel: () => ({}),
      getAgent: () => undefined,
      findUserIdBySessionId: () => "U1",
    } as unknown as SessionManager
    const bridge = createBridge(
      makeConfig(),
      makeClient({ calls: ocCalls }),
      router as unknown as EventRouter,
      sessions,
    )
    emitFormEvent(router, "created")
    await waitFor(() => apiCalls.some((c) => c.body?.msg_type === 2 && !c.body?.msg_id))

    // 用户切到别的会话：旧提问作废，消息按新会话正常转发
    bound.sessionId = "ses_other"
    await bridge.handleMessage({ type: "c2c", userId: "U1", msgId: "MID7", content: "1 2" })
    await waitFor(() => router.listeners.has("ses_other"))
    expect(ocCalls.some((c) => c.url.startsWith("form.reply/"))).toBe(false)
    expect(ocCalls.some((c) => c.url === "session.prompt")).toBe(true)
    router.emit(ev("session.execution.succeeded", { sessionID: "ses_other" }))
    await waitFor(() => !router.listeners.has("ses_other"))
  })
})
