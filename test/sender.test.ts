// sender.test.ts — StreamSession 状态机：首片/场景切换/节流/错误恢复/收尾/sendfile 标记与思考标签剥离/主动开流通道
// 正文路径为官方 SDK 语义：replace + 全量文本（每帧携带当前累计全文，index 每帧递增）。
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { StreamSession, sendFileToQQ, splitFileParts, detectUrlFileType, isHttpUrl, type StreamSessionOptions } from "../src/qq/sender.js"
import { renderCopy } from "../src/copy.js"
import type { MessageContext } from "../src/qq/types.js"
import { mkdtempSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const realFetch = globalThis.fetch

// ---- 测试基建 -------------------------------------------------------------

function c2cCtx(): MessageContext {
  return { type: "c2c", userId: "U1", msgId: "MID1", content: "hi" }
}

interface ShardBody {
  content_raw: string
  index: number
  input_mode: string
  input_state: number
  content_type: string
  msg_seq: number
  msg_id?: string
  stream_msg_id?: string
}

interface Recorded {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  ok: boolean
}

/** fetch 记录器：可选按请求体注入失败响应（返回 Response 即失败） */
function makeRecorder(fail?: (body: Record<string, unknown>) => Response | undefined) {
  const calls: Recorded[] = []
  let n = 0
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    n += 1
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    const failed = fail?.(body)
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body, ok: !failed })
    if (failed) return failed
    return new Response(JSON.stringify({ id: `id-${n}`, timestamp: 1 }), { status: 200 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

function shards(calls: Recorded[]): ShardBody[] {
  return calls.filter((c) => c.body.content_raw !== undefined).map((c) => c.body as unknown as ShardBody)
}

/** 仅成功下发的分片（失败尝试不计入） */
function okShards(calls: Recorded[]): ShardBody[] {
  return calls.filter((c) => c.ok && c.body.content_raw !== undefined).map((c) => c.body as unknown as ShardBody)
}

/** 仅统计成功下发的分片内容（失败尝试不计入） */
function sentText(calls: Recorded[]): string {
  return okShards(calls)
    .map((s) => s.content_raw)
    .join("")
}

/** 自动推进假时钟：每次 now() 调用前进 step ⇒ throttle/退避计算出的等待恒 ≤ 0，零真实 sleep */
function autoClock(step: number): () => number {
  let t = 1_000_000
  return () => (t += step)
}

function baseOpts(
  fetchImpl: typeof fetch,
  now: () => number,
  over: Partial<StreamSessionOptions> = {},
): StreamSessionOptions {
  return {
    token: async () => "tok",
    ctx: c2cCtx(),
    render: (scene, vars) => renderCopy(scene, vars),
    intervalMs: 1500,
    chunkSize: 500,
    fetchImpl,
    now,
    ...over,
  }
}

/** 同一条流内所有分片 msg_seq 必须恒定（官方文档语义；每片都带 msg_id，新流首片以 index0 识别） */
function expectMsgSeqConstantPerStream(list: ShardBody[]): void {
  let current: number | null = null
  for (const s of list) {
    if (s.index === 0) current = s.msg_seq // 新流首片
    expect(s.msg_seq).toBe(current)
  }
}

const A40 = "A".repeat(40)
const B40 = "B".repeat(40)
const C40 = "C".repeat(40)
const A30 = "A".repeat(30)
const B30 = "B".repeat(30)

// 会话登记：afterEach 兜底 abort，避免 dots timer 泄漏到其他用例
const live: StreamSession[] = []
function track<T extends StreamSession>(s: T): T {
  live.push(s)
  return s
}

afterEach(async () => {
  for (const s of live) {
    try {
      await s.abort()
    } catch {
      // ignore
    }
  }
  live.length = 0
  globalThis.fetch = realFetch
})

// ---- 首片与场景切换 -------------------------------------------------------

describe("StreamSession.start", () => {
  test("发 WAITING 首片：index0/state1/replace/msg_id 被动锚定", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    expect(s.state).toBe("streaming")
    const list = shards(calls)
    expect(list).toHaveLength(1)
    expect(list[0].content_raw).toBe("请稍候")
    expect(list[0].index).toBe(0)
    expect(list[0].input_mode).toBe("replace")
    expect(list[0].input_state).toBe(1)
    expect(list[0].content_type).toBe("markdown")
    expect(list[0].msg_id).toBe("MID1")
    expect(list[0].stream_msg_id).toBeUndefined()
    expect(typeof list[0].msg_seq).toBe("number")
    expect(calls[0].url).toBe("https://api.sgroup.qq.com/v2/users/U1/stream_messages")
    expect(calls[0].headers.Authorization).toBe("QQBot tok")
  })
})

describe("StreamSession.switchScene", () => {
  test("场景切换零开流：走主动消息（/messages 端点、无 msg_id），占位流保持原样", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const proactive: Recorded[] = []
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      proactive.push({ url: String(url), headers: {}, body })
      return new Response(JSON.stringify({ id: "p1", timestamp: 1 }), { status: 200 })
    }) as typeof fetch
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.switchScene("TOOL_CALL", { tool: "bash" })
    // 零开流：流式分片仍只有 WAITING 首片（不关旧流、不另起场景流）
    const list = shards(calls)
    expect(list).toHaveLength(1)
    expect(list[0].content_raw).toBe("请稍候")
    // 场景文案走 /v2/users/{openid}/messages 主动消息（非 stream_messages），不带 msg_id
    expect(proactive).toHaveLength(1)
    expect(proactive[0].url).toBe("https://api.sgroup.qq.com/v2/users/U1/messages")
    expect(proactive[0].body.msg_id).toBeUndefined()
    expect((proactive[0].body.markdown as { content: string }).content).toBe("🔧 调用工具：bash")
    expect(s.state).toBe("streaming")
  })

  test("正文流进行中 switchScene(TEXT) 重置正文流：全量终片 + deliveredBody 清零 + 下段 index0", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    await s.switchScene("TEXT", { snippet: "x" })
    expect(s.deliveredBody).toBe("")
    let list = shards(calls)
    // 段落终片 = replace + 该段全量 + state10
    expect(list[3]).toMatchObject({
      content_raw: A40,
      input_mode: "replace",
      input_state: 10,
      stream_msg_id: "id-3",
    })
    // 下一段正文另起新流
    await s.pushBody(B40)
    list = shards(calls)
    expect(list[4]).toMatchObject({
      content_raw: B40,
      index: 0,
      input_mode: "replace",
      input_state: 1,
      msg_id: "MID1",
    })
    expect(s.deliveredBody).toBe(B40)
  })

  test("正文流进行中其他场景走主动消息且不打断正文流", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const proactive: Recorded[] = []
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      proactive.push({ url: String(url), headers: {}, body })
      return new Response(JSON.stringify({ id: "p1", timestamp: 1 }), { status: 200 })
    }) as typeof fetch
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    await s.switchScene("TOOL_CALL", { tool: "t" })
    expect(proactive).toHaveLength(1)
    expect(proactive[0].url).toBe("https://api.sgroup.qq.com/v2/users/U1/messages")
    // 正文流未关闭：仍只有 WAITING open/close + body open 三片
    expect(shards(calls)).toHaveLength(3)
    // 后续正文以 replace+全量续帧（携带累计全文）
    await s.pushBody(B40)
    const list = shards(calls)
    expect(list[3]).toMatchObject({ content_raw: A40 + B40, input_mode: "replace", index: 1, stream_msg_id: "id-3" })
  })
})

// ---- 开流预算（占位+正文合并核算，MAX_STREAM_OPENS = 4 - 1 = 3；场景消息零开流消耗） --------

describe("StreamSession 开流预算", () => {
  test("[MAJOR] 连续多段 TEXT 重置：开流总数 ≤ 预算，超预算后无 msg_id 新流首片，finish false 且兜底可走", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const proactive: Recorded[] = []
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      proactive.push({ url: String(url), headers: {}, body })
      return new Response(JSON.stringify({ id: "p1", timestamp: 1 }), { status: 200 })
    }) as typeof fetch
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start() // WAITING：开流 1/3
    const segs = [A40, B40, C40, "D".repeat(40), "E".repeat(40)]
    for (const seg of segs) {
      await s.pushBody(seg)
      await s.switchScene("TEXT", { snippet: "x" })
    }
    const list = okShards(calls)
    // 开流总数 = 占位① + 正文② + 重置③ = 3 ≤ MAX_STREAM_OPENS（被动 4 次预留 1 次兜底；
    // 场景消息一律走主动消息，零开流消耗）
    // 每片都带 msg_id，开流以 index0 识别
    const opens = list.filter((x) => x.index === 0)
    expect(opens).toHaveLength(3)
    expect(opens.map((x) => x.content_raw)).toEqual(["请稍候", A40, B40])
    // 第 3 段起预算用尽：不再有新开流首片（后续分片至多复用流内 stream_msg_id）
    const lastOpenIdx = list.findIndex((x) => x.content_raw === B40 && x.index === 0)
    expect(list.slice(lastOpenIdx + 1).every((x) => x.index > 0)).toBe(true)
    // 超预算段落只缓冲不发送：第 3~5 段正文从未出现在任何流式分片里
    expect(sentText(calls)).not.toContain(C40)
    // 场景降级为主动消息（不带 msg_id，不占被动名额）
    expect(proactive.length).toBeGreaterThanOrEqual(1)
    expect(proactive.every((p) => p.url === "https://api.sgroup.qq.com/v2/users/U1/messages")).toBe(true)
    // finish 比对失败 → bridge 走全量兜底
    expect(await s.finish(segs.join(""))).toBe(false)
    // 兜底路径可走：fallbackToReply 以同 msg_id 被动回复发出全量（第 4 次 = 预留名额）
    await s.fallbackToReply(segs.join(""))
    const replies = proactive.filter((p) => p.body.msg_id === "MID1")
    expect(replies).toHaveLength(1)
    expect((replies[0].body.markdown as { content: string }).content).toContain(A40)
    expect((replies[0].body.markdown as { content: string }).content).toContain("E".repeat(40))
  })

  test("预算内 TEXT 重置行为不变：每段仍另起新流首片（index0/msg_id），deliveredBody 跟随本段", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    await s.switchScene("TEXT", { snippet: "x" })
    await s.pushBody(B40)
    const opens = okShards(calls).filter((x) => x.index === 0)
    // WAITING + 2 段正文 = 3 次开流，均在预算内：重置语义与既有行为一致
    expect(opens).toHaveLength(3)
    expect(opens[2]).toMatchObject({
      content_raw: B40,
      index: 0,
      input_mode: "replace",
      input_state: 1,
      msg_id: "MID1",
    })
    expect(s.deliveredBody).toBe(B40)
    expect(s.state).toBe("streaming")
    expectMsgSeqConstantPerStream(okShards(calls))
  })
})

// ---- 节流与缓冲 -----------------------------------------------------------

describe("StreamSession.pushBody 节流", () => {
  test("冻结时钟（未越过 intervalMs 窗口）时真实等待 intervalMs", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const frozen = () => 5_000_000
    const s = track(new StreamSession(baseOpts(fetchImpl, frozen, { intervalMs: 400 })))
    await s.start() // 首片不等待（lastSendAt=-Infinity）
    const t0 = Date.now()
    await s.pushBody(A40) // close + open 两次发送，各等待 400ms
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(700) // 2×400ms − 容差
    expect(shards(calls).length).toBeGreaterThanOrEqual(3)
  })

  test("假时钟推进越过 intervalMs 窗口后零真实等待", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(400), { intervalMs: 400 })))
    await s.start()
    const t0 = Date.now()
    await s.pushBody(A40)
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(300) // 若仍等待应为 ~800ms
    expect(shards(calls)).toHaveLength(3)
  })

  test("minFlushChars：缓冲不足 24 字符不开正文流，补足后开流", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("a".repeat(23))
    expect(shards(calls)).toHaveLength(1) // 仅 WAITING 首片
    await s.pushBody("b") // 累计 24
    const list = shards(calls)
    expect(list).toHaveLength(3) // WAITING close + 正文 open
    expect(list[2].content_raw).toBe("a".repeat(23) + "b")
    expect(list[2].input_mode).toBe("replace")
  })
})

// ---- 每片携带 msg_id（真机 50015001 修复：官方 SDK msgId 无条件写入每帧） ------

describe("StreamSession 每片携带 msg_id", () => {
  test("续片与终片都携带 msg_id（缺 msg_id 的续片真机报 50015001）", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    await s.pushBody(B40) // 续片
    await s.finish(A40 + B40) // 终片
    const list = shards(calls)
    expect(list.length).toBeGreaterThanOrEqual(5)
    expect(list.every((x) => x.msg_id === "MID1")).toBe(true)
    // 续片/终片同时携带 stream_msg_id（流内续传）与 msg_id（被动锚定）
    const cont = list.filter((x) => x.index >= 1)
    expect(cont.length).toBeGreaterThanOrEqual(2)
    expect(cont.every((x) => x.stream_msg_id !== undefined && x.msg_id === "MID1")).toBe(true)
  })

  test("dots 动画帧携带 msg_id", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500), { intervalMs: 1 })))
    await s.start()
    await new Promise((r) => setTimeout(r, 50)) // 等 dots timer 触发若干帧
    const frames = shards(calls).filter((x) => x.index >= 1)
    expect(frames.length).toBeGreaterThanOrEqual(2)
    expect(frames.every((x) => x.msg_id === "MID1")).toBe(true)
    expect(frames.every((x) => x.stream_msg_id !== undefined)).toBe(true)
  })

  test("增量帧无 24 字符门槛：开流后有变化的 delta 即发帧（官方语义）", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40) // 开流（40 ≥ MIN_FLUSH_CHARS）
    await s.pushBody("x") // 增量 1 字符也发帧
    const list = okShards(calls)
    expect(list[3].content_raw).toBe(A40 + "x")
    expect(list[3].index).toBe(1)
    expect(list[3].msg_id).toBe("MID1")
  })
})

// ---- 主动开流通道（STREAMING_PROACTIVE，默认 off） ------------------------------

describe("StreamSession 主动开流（proactive）", () => {
  test("proactive=on：首片省略 msg_id（主动通道），msg_seq 保留，续片/终片同样不带 msg_id", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500), { proactive: true })))
    await s.start()
    await s.pushBody(A40)
    await s.pushBody(B40) // 续片
    expect(await s.finish(A40 + B40)).toBe(true) // 终片
    const list = shards(calls)
    // 首片：无 msg_id 字段（主动开流，不占被动预算）；msg_seq 仍在（官方 SDK 无条件携带）
    expect(list[0].msg_id).toBeUndefined()
    expect(typeof list[0].msg_seq).toBe("number")
    // 整条流所有分片都不带 msg_id（预算解耦：续片带 msg_id 会让 (msg_id,msg_seq) 对重新上线占名额）
    expect(list.every((x) => x.msg_id === undefined)).toBe(true)
    expect(list.every((x) => typeof x.msg_seq === "number")).toBe(true)
    // 续片/终片仍携带 stream_msg_id（流内续传）
    const cont = list.filter((x) => x.index >= 1)
    expect(cont.length).toBeGreaterThanOrEqual(2)
    expect(cont.every((x) => x.stream_msg_id !== undefined)).toBe(true)
    expect(s.state).toBe("finished")
  })

  test("proactive=off（缺省）：首片带 msg_id 被动锚定（回归）", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500), { proactive: false })))
    await s.start()
    const list = shards(calls)
    expect(list[0].msg_id).toBe("MID1")
    expect(typeof list[0].msg_seq).toBe("number")
  })

  test("proactive 预算 10：WAITING + 9 段正文开流，第 10 段起仅缓冲（对照被动预算 3）", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const proactive: Recorded[] = []
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      proactive.push({ url: String(url), headers: {}, body })
      return new Response(JSON.stringify({ id: "p1", timestamp: 1 }), { status: 200 })
    }) as typeof fetch
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500), { proactive: true })))
    await s.start() // WAITING：开流 1/10
    const segs = [A40, B40, C40, "D".repeat(40), "E".repeat(40), "F".repeat(40), "G".repeat(40), "H".repeat(40), "I".repeat(40), "J".repeat(40)]
    for (const seg of segs) {
      await s.pushBody(seg)
      await s.switchScene("TEXT", { snippet: "x" })
    }
    const list = okShards(calls)
    // 开流总数 = WAITING + 9 段正文 = 10（主动通道不占被动预算，受主动消息 20/qpm 频控约束放宽）
    const opens = list.filter((x) => x.index === 0)
    expect(opens).toHaveLength(10)
    // 第 10 段（J）预算用尽：从未出现在任何流式分片里，只缓冲
    expect(sentText(calls)).not.toContain("J".repeat(40))
    // finish 比对失败 → bridge 走全量兜底
    expect(await s.finish(segs.join(""))).toBe(false)
  })

  test("proactive 开流失败 → state=failed，fallbackToReply 仍走被动 replyToQQ（带 msg_id）", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { fetchImpl } = makeRecorder(() => new Response(JSON.stringify({ code: 500001, message: "server error" }), { status: 500 }))
      const replies: Recorded[] = []
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
        replies.push({ url: String(url), headers: {}, body })
        return new Response(JSON.stringify({ id: "r1", timestamp: 1 }), { status: 200 })
      }) as typeof fetch
      const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500), { proactive: true })))
      await s.start() // 主动开流失败（非频控）→ markFailed
      expect(s.state).toBe("failed")
      // 兜底路径：fallbackToReply 以同 msg_id 被动回复发出全量（主动模式不占被动名额，恒有预算）
      await s.fallbackToReply(A40)
      expect(replies).toHaveLength(1)
      expect(replies[0].url).toBe("https://api.sgroup.qq.com/v2/users/U1/messages")
      expect(replies[0].body.msg_id).toBe("MID1")
      expect((replies[0].body.markdown as { content: string }).content).toBe(A40)
    } finally {
      errSpy.mockRestore()
    }
  })
})

// ---- 错误恢复 -------------------------------------------------------------

describe("StreamSession 错误恢复", () => {
  test("40007 前缀冲突 → 安全终片结束流 + state=failed（不再另起新流续传）", async () => {
    let failedOnce = false
    const { calls, fetchImpl } = makeRecorder((body) => {
      if (
        !failedOnce &&
        body.input_mode === "replace" &&
        body.input_state === 1 &&
        body.index >= 1 &&
        body.stream_msg_id
      ) {
        failedOnce = true
        return new Response(JSON.stringify({ code: 40007, message: "prefix conflict" }), { status: 400 })
      }
      return undefined
    })
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    await s.pushBody(B40) // 全量帧撞 40007 → 结束流 + failed
    const list = shards(calls)
    // 冲突终片：replace + 最后成功下发内容 + state10（官方 close 形状，内容幂等不改写）
    expect(list[list.length - 1]).toMatchObject({ content_raw: A40, input_mode: "replace", input_state: 10 })
    // 不再另起新流续传：新开流首片（index0）只有 WAITING 与正文 open 两个
    expect(list.filter((x) => x.index === 0)).toHaveLength(2)
    expect(s.state).toBe("failed")
    expect(s.deliveredBody).toBe(A40) // lastAcceptedFull 停在最后一次成功下发
    // failed 后 finish false（bridge 走全量兜底），后续 pushBody 零请求
    const ok = await s.finish(A40 + B40)
    expect(ok).toBe(false)
    const callsBefore = calls.length
    await s.pushBody(C40)
    expect(calls.length).toBe(callsBefore)
  })

  test("占位流终片 404「已经提交」→ 良性忽略：日志降级 console.log，流程不变（真机修复）", async () => {
    const { calls, fetchImpl } = makeRecorder((body) => {
      // 占位流终片（replace+state10+stream_msg_id）撞 404：平台已自动终局该流
      if (body.input_mode === "replace" && body.input_state === 10 && body.stream_msg_id) {
        return new Response(JSON.stringify({ message: "已经提交的消息内容不可修改" }), { status: 404 })
      }
      return undefined
    })
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {})
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
      await s.start()
      await s.pushBody("短文本") // 不足 24 字符，不开正文流
      const ok = await s.finish("短文本") // 占位流终片 → 404
      expect(ok).toBe(false) // 短文本从未流式投递（既有语义，与 404 无关）
      expect(s.state).toBe("finished")
      // 良性降级：console.log 提及平台已终局，不再走 console.error
      const benign = logSpy.mock.calls.filter((c) => String(c[0]).includes("已经提交"))
      expect(benign).toHaveLength(1)
      const errors = errSpy.mock.calls.filter((c) => String(c[0]).includes("占位流终片失败"))
      expect(errors).toHaveLength(0)
    } finally {
      logSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  test("[PRODUCT_BUG1] deliveredBody 恒等于最后成功帧的全量文本（无重复累计）", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    await s.pushBody(B40)
    await s.pushBody(C40)
    const okList = okShards(calls)
    // replace 语义：每个正文帧都携带当前累计全文
    expect(okList[2].content_raw).toBe(A40)
    expect(okList[3].content_raw).toBe(A40 + B40)
    expect(okList[4].content_raw).toBe(A40 + B40 + C40)
    // 契约（Bug 1 意图，replace 形态）：deliveredBody = 最后一次成功下发的全量文本，
    // 不存在 append 时代「恢复路径重复累计」的状态（旧实现 40007 恢复后 A40+B40+B40）。
    expect(s.deliveredBody).toBe(A40 + B40 + C40)
    expect(s.deliveredBody).toBe(okList[okList.length - 1].content_raw)
    expect(await s.finish(A40 + B40 + C40)).toBe(true)
  })

  test("50002 频控 → 指数退避重试成功，且重试时 index 前进", async () => {
    let failedOnce = false
    const { calls, fetchImpl } = makeRecorder((body) => {
      if (!failedOnce && body.input_mode === "replace" && body.input_state === 1 && body.index >= 1 && body.stream_msg_id) {
        failedOnce = true
        return new Response(JSON.stringify({ code: 50002, message: "rate limited" }), { status: 429 })
      }
      return undefined
    })
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(10_000))))
    await s.start()
    await s.pushBody(A40)
    await s.pushBody(B40) // 首次 50002 → 退避 → 重试成功
    // 正文续帧（state1）：占位流终片同为 replace 形状，按 input_state 区分
    const contFrames = shards(calls).filter((x) => x.input_mode === "replace" && x.input_state === 1 && x.index >= 1 && x.stream_msg_id)
    // 官方语义：重试时 index 前进（首试 index1，重试 index2）
    expect(contFrames.map((x) => x.index)).toEqual([1, 2])
    expect(contFrames[1].content_raw).toBe(A40 + B40)
    expect(contFrames[1].input_mode).toBe("replace")
    expect(s.state).toBe("streaming")
    expect(s.deliveredBody).toBe(A40 + B40)
    expectMsgSeqConstantPerStream(shards(calls))
  })

  test("[PRODUCT_BUG2] 50002 三次重试全失败 → lastAcceptedFull 不推进、finish false → 回退全量", async () => {
    const { calls, fetchImpl } = makeRecorder((body) => {
      // 正文续帧（含终片）持续频控；首片（index0/msg_id）不受影响；占位流终片
      // （新 close 形状同为 replace+index≥1）也会撞频控，失败被 flushBody 捕获忽略后照常开正文流
      if (body.input_mode === "replace" && body.index >= 1 && body.stream_msg_id) {
        return new Response(JSON.stringify({ code: 50002, message: "rate limited" }), { status: 429 })
      }
      return undefined
    })
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(10_000))))
    await s.start()
    await s.pushBody(A40) // 开流成功
    await s.pushBody(B40) // 1+3 次尝试全 50002 → 跳帧
    await s.pushBody(C40) // 再 1+3 次尝试全 50002 → 跳帧
    // 正文续帧（state1）：占位流终片（state10）同为 replace 形状，按 input_state 区分
    const contFrames = shards(calls).filter((x) => x.input_mode === "replace" && x.input_state === 1 && x.index >= 1 && x.stream_msg_id)
    // 每轮 = 首试 + 3 次重试（index 前进），两轮共 8 次
    expect(contFrames.map((x) => x.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // 契约（Bug 2 意图，replace 形态）：频控耗尽后 lastAcceptedFull 不推进——
    // 旧实现静默 return 却把 chunk 计入 bodyDelivered → finish 误报 true → 用户永久丢正文。
    expect(s.deliveredBody).toBe(A40)
    expect(sentText(calls)).not.toContain(B40)
    const ok = await s.finish(A40 + B40 + C40) // 终片同样频控耗尽 → failed
    expect(ok).toBe(false)
    expect(s.state).toBe("failed")
  })

  test("start 首片失败 → state=failed，后续方法零请求", async () => {
    const { calls, fetchImpl } = makeRecorder(
      () => new Response(JSON.stringify({ code: 50001, message: "server error" }), { status: 500 }),
    )
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    expect(s.state).toBe("failed")
    await s.switchScene("TOOL_CALL", { tool: "x" })
    await s.pushBody(A40)
    await s.finish(A40)
    expect(calls).toHaveLength(1) // 仅失败的首片
  })

  test("群聊 ctx 构造抛错（双保险）", () => {
    const { fetchImpl } = makeRecorder()
    expect(
      () =>
        new StreamSession(
          baseOpts(fetchImpl, autoClock(1500), {
            ctx: { type: "group", userId: "U1", groupId: "G1", msgId: "M", content: "x" },
          }),
        ),
    ).toThrow("群聊不支持流式消息")
  })
})

// ---- 收尾 -----------------------------------------------------------------

describe("StreamSession.finish / abort", () => {
  test("deliveredBody 与 finalText 一致 → true，终片 replace+全量+state10", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    const ok = await s.finish(A40)
    expect(ok).toBe(true)
    expect(s.state).toBe("finished")
    const list = okShards(calls)
    expect(list[list.length - 1]).toMatchObject({ content_raw: A40, input_mode: "replace", input_state: 10 })
    expectMsgSeqConstantPerStream(list)
  })

  test("deliveredBody 与 finalText 不一致 → false", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    const ok = await s.finish(A40 + "尾巴")
    expect(ok).toBe(false)
  })

  test("abort 后零请求", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.abort()
    await s.start()
    await s.pushBody(A40)
    expect(calls).toHaveLength(0)
    expect(s.state).toBe("aborted")
  })
})

// ---- sendfile 标记剥离 ----------------------------------------------------

describe("StreamSession sendfile 标记剥离", () => {
  test("完整标记直接剥离：分片与 deliveredBody 均无标记文本", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("前".repeat(20) + "[[sendfile:/tmp/report.pdf]]" + "后".repeat(20))
    const ok = await s.finish("前".repeat(20) + "后".repeat(20))
    expect(ok).toBe(true)
    expect(sentText(calls)).not.toContain("sendfile")
    expect(sentText(calls)).not.toContain("/tmp/report.pdf")
    expect(sentText(calls)).not.toContain("[[")
    expect(s.deliveredBody).toBe("前".repeat(20) + "后".repeat(20))
  })

  test("标记跨 delta 拆分：中途 flush 后残片扣留，补全后整块剥离", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A30 + "[[sendfile:/tmp/a") // 30 字符触发真实中途 flush
    const afterFirst = okShards(calls)
    expect(afterFirst[afterFirst.length - 1].content_raw).toBe(A30) // 正文首片不含残片
    expect(sentText(calls)).not.toContain("sendfile")
    expect(sentText(calls)).not.toContain("/tmp/a")
    await s.pushBody(".txt]]" + B30)
    const ok = await s.finish(A30 + B30)
    expect(ok).toBe(true)
    expect(sentText(calls)).not.toContain("sendfile")
    expect(sentText(calls)).not.toContain("/tmp/a")
    expect(s.deliveredBody).toBe(A30 + B30)
  })

  test("终刷丢弃未闭合的残片（不进终片）", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("C".repeat(30) + "[[sendfile:/tmp/never")
    const ok = await s.finish("C".repeat(30))
    expect(ok).toBe(true)
    expect(sentText(calls)).not.toContain("[[")
    expect(sentText(calls)).not.toContain("never")
    expect(s.deliveredBody).toBe("C".repeat(30))
  })

  test("剥离后不足 24 字符不开正文流，短文本 finish 恒 false（既有设计）", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("短文本")
    const ok = await s.finish("短文本")
    expect(ok).toBe(false)
    const list = shards(calls)
    expect(list).toHaveLength(2) // WAITING open + 占位流终片
    expect(list.every((x) => x.content_raw !== "短文本")).toBe(true)
  })

  test("finish 传原始含标记文本 → false（防 bridge 调用点回归）", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("D".repeat(40))
    const ok = await s.finish("D".repeat(40) + "[[sendfile:/tmp/x.pdf]]")
    expect(ok).toBe(false) // deliveredBody（已剥离）≠ 原始文本 → 必须回退全量回复
  })
})

// ---- 思考标签剥离（官方 sanitize.ts 同款） ----------------------------------

describe("StreamSession 思考标签剥离", () => {
  test("成对思考标签块整块剥离：分片与 deliveredBody 均无标签内容", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody("<thinking>秘密推理</thinking>" + A30)
    const ok = await s.finish(A30)
    expect(ok).toBe(true)
    expect(sentText(calls)).not.toContain("thinking")
    expect(sentText(calls)).not.toContain("秘密推理")
    expect(s.deliveredBody).toBe(A30)
  })

  test("system-reminder / previous_response / deepseek 反引号风格同样剥离", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(
      "<system-reminder>sys</system-reminder><previous_response>prev</previous_response>`think`deep`/think`" + B30,
    )
    const ok = await s.finish(B30)
    expect(ok).toBe(true)
    expect(sentText(calls)).not.toContain("system-reminder")
    expect(sentText(calls)).not.toContain("previous_response")
    expect(sentText(calls)).not.toContain("deep")
    expect(s.deliveredBody).toBe(B30)
  })

  test("未闭合 thinking 残标签吞到文末：不闪现，finish 基准一致", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A30 + "<thinking>未闭合的思考")
    const ok = await s.finish(A30)
    expect(ok).toBe(true)
    expect(sentText(calls)).not.toContain("未闭合")
    expect(s.deliveredBody).toBe(A30)
  })

  test("标签跨 delta 拆分：尾部残片扣留，补全后整块剥离", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A30 + "<thin") // 残片扣留，正文首片不含
    const afterFirst = okShards(calls)
    expect(afterFirst[afterFirst.length - 1].content_raw).toBe(A30)
    await s.pushBody("king>秘密</thinking>" + B30)
    const ok = await s.finish(A30 + B30)
    expect(ok).toBe(true)
    expect(sentText(calls)).not.toContain("秘密")
    expect(s.deliveredBody).toBe(A30 + B30)
  })

  test("孤立闭标签剥离且不破坏前缀延伸", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A30 + "</thinking>" + B30)
    const ok = await s.finish(A30 + B30)
    expect(ok).toBe(true)
    expect(sentText(calls)).not.toContain("thinking")
    expect(s.deliveredBody).toBe(A30 + B30)
  })

  test("终刷放行思考标签残片（与 sendfile 残片丢弃相反）：正文以反引号结尾不误回退", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A30 + "`") // 流式中扣留（疑似 `think` 前缀）
    const afterFirst = okShards(calls)
    expect(afterFirst[afterFirst.length - 1].content_raw).toBe(A30)
    const ok = await s.finish(A30 + "`") // 终刷放行：与官方完整文本 sanitize 口径一致
    expect(ok).toBe(true)
    const list = okShards(calls)
    expect(list[list.length - 1].content_raw).toBe(A30 + "`")
  })
})

// ---- content_type 跟随 MARKDOWN -------------------------------------------

describe("StreamSession content_type 跟随 MARKDOWN", () => {
  test("MARKDOWN=on（默认）→ 全部流式分片 content_type=markdown", async () => {
    const { calls, fetchImpl } = makeRecorder()
    const s = track(new StreamSession(baseOpts(fetchImpl, autoClock(1500))))
    await s.start()
    await s.pushBody(A40)
    await s.finish(A40)
    expect(shards(calls).length).toBeGreaterThanOrEqual(4)
    expect(shards(calls).every((x) => x.content_type === "markdown")).toBe(true)
  })

  test("MARKDOWN=off → 全部分片 content_type=text（模块级 env 读取，query 串独立实例）", async () => {
    process.env.MARKDOWN = "off"
    try {
      const spec: string = "../src/qq/sender.js?markdown=off"
      const mod = (await import(spec)) as typeof import("../src/qq/sender.js")
      const { calls, fetchImpl } = makeRecorder()
      const s = track(new mod.StreamSession(baseOpts(fetchImpl, autoClock(1500))))
      await s.start()
      await s.pushBody(A40)
      await s.finish(A40)
      expect(shards(calls).length).toBeGreaterThanOrEqual(4)
      expect(shards(calls).every((x) => x.content_type === "text")).toBe(true)
    } finally {
      delete process.env.MARKDOWN
    }
  })
})

// ---- sendfile URL 上传分支 ---------------------------------------------------

describe("detectUrlFileType 扩展名推断", () => {
  test("图片扩展 → 1（含大写与查询串）", () => {
    for (const u of [
      "https://a.com/p.png", "https://a.com/p.JPG", "https://a.com/p.Jpeg",
      "https://a.com/p.jpg?w=100", "https://a.com/p.jpeg#frag", "https://a.com/p.gif",
      "https://a.com/p.webp?v=2", "https://a.com/p.bmp",
    ]) {
      expect(detectUrlFileType(u)).toBe(1)
    }
  })
  test("视频 .mp4 → 2（剥查询串/锚点）", () => {
    expect(detectUrlFileType("https://a.com/v.mp4")).toBe(2)
    expect(detectUrlFileType("https://a.com/v.mp4?start=30#t=1")).toBe(2)
  })
  test("语音 .silk/.mp3/.wav/.ogg → 3", () => {
    expect(detectUrlFileType("https://a.com/a.silk")).toBe(3)
    expect(detectUrlFileType("https://a.com/a.mp3?q=1")).toBe(3)
    expect(detectUrlFileType("https://a.com/a.wav")).toBe(3)
    expect(detectUrlFileType("https://a.com/a.ogg")).toBe(3)
  })
  test("未知/无扩展 → 4（文件）", () => {
    expect(detectUrlFileType("https://a.com/doc.pdf")).toBe(4)
    expect(detectUrlFileType("https://a.com/file.tar.gz")).toBe(4)
    expect(detectUrlFileType("https://a.com/download?id=9")).toBe(4)
    expect(detectUrlFileType("https://a.com")).toBe(4)
  })
  test("isHttpUrl 只认 http/https 前缀", () => {
    expect(isHttpUrl("https://a.com/a.png")).toBe(true)
    expect(isHttpUrl("HTTP://a.com/a.png")).toBe(true)
    expect(isHttpUrl("http://a.com/a.png")).toBe(true)
    expect(isHttpUrl("/tmp/a.png")).toBe(false)
    expect(isHttpUrl("file:///tmp/a.png")).toBe(false)
    expect(isHttpUrl("ftp://a.com/a.png")).toBe(false)
  })
})

describe("sendFileToQQ", () => {
  const origLog = console.log
  const origErr = console.error
  const origWarn = console.warn
  beforeEach(() => {
    console.log = () => {}
    console.error = () => {}
    console.warn = () => {}
  })
  afterEach(() => {
    console.log = origLog
    console.error = origErr
    console.warn = origWarn
  })

  function groupCtx(): MessageContext {
    return { type: "group", groupId: "G1", userId: "U1", msgId: "MID1", content: "hi" }
  }

  /** fetch 记录器：/files 上传返回 file_info，其余按消息发送返回 id */
  function mediaRecorder() {
    const calls: Recorded[] = []
    let n = 0
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      n += 1
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body, ok: true })
      const payload = String(url).includes("/files")
        ? { file_uuid: `uuid-${n}`, file_info: "FI::1", ttl: 300 }
        : { id: `mid-${n}`, timestamp: 1 }
      return new Response(JSON.stringify(payload), { status: 200 })
    }) as typeof fetch
    return { calls, fetchImpl }
  }

  test("URL 分支（单聊）：URL 上传 → msg_type=7 媒体发送，跳过体积检查", async () => {
    const { calls, fetchImpl } = mediaRecorder()
    globalThis.fetch = fetchImpl
    // maxBytes=1：URL 分支必须不检查体积（限制由平台侧处理）
    await sendFileToQQ("tok", c2cCtx(), "https://cdn.example.com/pic.png?w=2", 1)
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe("https://api.sgroup.qq.com/v2/users/U1/files")
    expect(calls[0].body).toEqual({
      file_type: 1,
      url: "https://cdn.example.com/pic.png?w=2",
      file_name: "pic.png",
      srv_send_msg: false,
    })
    expect(calls[1].url).toBe("https://api.sgroup.qq.com/v2/users/U1/messages")
    expect(calls[1].body.msg_type).toBe(7)
    expect((calls[1].body.media as Record<string, unknown>).file_info).toBe("FI::1")
    expect(calls[1].body.msg_id).toBe("MID1")
    expect(typeof calls[1].body.msg_seq).toBe("number")
  })

  test("URL 分支（群聊）：/v2/groups/{gid}/files + 群媒体消息", async () => {
    const { calls, fetchImpl } = mediaRecorder()
    globalThis.fetch = fetchImpl
    await sendFileToQQ("tok", groupCtx(), "https://cdn.example.com/v.mp4")
    expect(calls[0].url).toBe("https://api.sgroup.qq.com/v2/groups/G1/files")
    expect(calls[0].body.file_type).toBe(2)
    expect(calls[0].body.url).toBe("https://cdn.example.com/v.mp4")
    expect(calls[1].url).toBe("https://api.sgroup.qq.com/v2/groups/G1/messages")
    expect(calls[1].body.msg_type).toBe(7)
    expect(calls[1].body.msg_id).toBe("MID1")
  })

  test("URL 分支 file_name 推导：中文/空格/查询串 → decode 后的 basename", async () => {
    const { calls, fetchImpl } = mediaRecorder()
    globalThis.fetch = fetchImpl
    await sendFileToQQ("tok", c2cCtx(), "https://a.com/p/图片%20v2.png?x=1", 0)
    expect(calls[0].body.file_name).toBe("图片 v2.png")
    expect(calls[0].body.url).toBe("https://a.com/p/图片%20v2.png?x=1")
  })

  test("URL 分支 file_name 推导：非法百分号编码 → 容错用原值", async () => {
    const { calls, fetchImpl } = mediaRecorder()
    globalThis.fetch = fetchImpl
    await sendFileToQQ("tok", c2cCtx(), "https://a.com/p/%E4%80.png", 0)
    expect(calls[0].body.file_name).toBe("%E4%80.png")
  })

  test("URL 分支 basename 为空（https://a.com/）→ 请求体无 file_name 字段", async () => {
    const { calls, fetchImpl } = mediaRecorder()
    globalThis.fetch = fetchImpl
    await sendFileToQQ("tok", c2cCtx(), "https://a.com/", 0)
    expect(calls[0].body.file_type).toBe(4)
    expect(calls[0].body).not.toHaveProperty("file_name")
  })

  test("本地路径分支回归：仍走 base64 上传 + 体积检查", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sendfile-"))
    try {
      const p = join(dir, "note.txt")
      writeFileSync(p, "hello")
      const { calls, fetchImpl } = mediaRecorder()
      globalThis.fetch = fetchImpl
      await sendFileToQQ("tok", c2cCtx(), p, 0)
      expect(calls).toHaveLength(2)
      expect(calls[0].url).toBe("https://api.sgroup.qq.com/v2/users/U1/files")
      expect(calls[0].body.file_type).toBe(4)
      expect(calls[0].body.file_name).toBe("note.txt")
      expect(calls[0].body.file_data).toBe(Buffer.from("hello").toString("base64"))
      expect(calls[0].body.url).toBeUndefined()
      expect(calls[1].body.msg_type).toBe(7)

      // 体积上限仍生效（本地分支不跳过）
      const big = join(dir, "big.bin")
      writeFileSync(big, "0123456789")
      await expect(sendFileToQQ("tok", c2cCtx(), big, 2)).rejects.toThrow("文件过大")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ---- 分片 / 内联阈值 / 重试 --------------------------------------------

  /** 设置分片相关 env（fileSendSettings 在调用时读取），返回还原函数 */
  function setFileEnv(values: Record<string, string>): () => void {
    const keys = ["SEND_FILE_INLINE_MAX_BYTES", "SEND_FILE_SPLIT", "SEND_FILE_PART_DELAY_MS", "SEND_FILE_MAX_PARTS"]
    const prev: Record<string, string | undefined> = {}
    for (const k of keys) prev[k] = process.env[k]
    for (const k of keys) delete process.env[k]
    Object.assign(process.env, values)
    return () => {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k]
        else process.env[k] = prev[k] as string
      }
    }
  }

  test("阈值内：仍是一次内联上传 + 被动回复，无分片说明", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sendfile-"))
    try {
      const p = join(dir, "small.bin")
      const payload = Buffer.alloc(10, 1)
      writeFileSync(p, payload)
      const { calls, fetchImpl } = mediaRecorder()
      globalThis.fetch = fetchImpl
      const note = await sendFileToQQ("tok", c2cCtx(), p, 0)
      expect(note).toBeUndefined()
      expect(calls).toHaveLength(2)
      expect(calls[0].body.file_name).toBe("small.bin")
      expect(calls[0].body.file_data).toBe(payload.toString("base64"))
      expect(calls[1].body.msg_id).toBe("MID1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("超过阈值：自动分片，首片被动、后续主动，返回合并说明并清理临时分片", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sendfile-"))
    const prevTmp = process.env.TMPDIR
    const restore = setFileEnv({
      SEND_FILE_INLINE_MAX_BYTES: "64",
      SEND_FILE_SPLIT: "on",
      SEND_FILE_PART_DELAY_MS: "0",
    })
    try {
      process.env.TMPDIR = dir // 让分片临时目录落在可观测范围内
      const p = join(dir, "big.bin")
      const payload = Buffer.alloc(200, 7)
      writeFileSync(p, payload)
      const { calls, fetchImpl } = mediaRecorder()
      globalThis.fetch = fetchImpl
      const note = await sendFileToQQ("tok", c2cCtx(), p, 0)

      // 4 片 = 4 次上传 + 4 次发送，交替
      expect(calls).toHaveLength(8)
      expect(calls[0].url).toContain("/v2/users/U1/files")
      expect(calls[1].url).toContain("/v2/users/U1/messages")
      expect(calls.map((c) => c.body.file_name).filter(Boolean)).toEqual([
        "big.bin.001",
        "big.bin.002",
        "big.bin.003",
        "big.bin.004",
      ])
      // 首片带 msg_id（被动回复），其余走主动通道（不占被动预算）
      expect(calls[1].body.msg_id).toBe("MID1")
      expect(calls[3].body).not.toHaveProperty("msg_id")
      expect(calls[5].body).not.toHaveProperty("msg_id")
      expect(calls[7].body).not.toHaveProperty("msg_id")
      // 分片拼回 == 原文件
      const joined = Buffer.concat(
        [0, 2, 4, 6].map((i) => Buffer.from(String(calls[i].body.file_data), "base64")),
      )
      expect(joined.equals(payload)).toBe(true)
      expect(note).toContain("已自动分 4 片")
      expect(note).toContain("cat big.bin.00* > big.bin")
      // 发送完临时分片已删除（目录只剩原文件）
      expect(readdirSync(dir)).toEqual(["big.bin"])
    } finally {
      restore()
      if (prevTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = prevTmp
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("SEND_FILE_SPLIT=off：超阈值直接报错，且一个请求都不发", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sendfile-"))
    const restore = setFileEnv({ SEND_FILE_INLINE_MAX_BYTES: "64", SEND_FILE_SPLIT: "off", SEND_FILE_PART_DELAY_MS: "0" })
    try {
      const p = join(dir, "big.bin")
      writeFileSync(p, Buffer.alloc(200, 7))
      const { calls, fetchImpl } = mediaRecorder()
      globalThis.fetch = fetchImpl
      await expect(sendFileToQQ("tok", c2cCtx(), p, 0)).rejects.toThrow("超过 QQ 内联上传上限")
      expect(calls).toHaveLength(0)
    } finally {
      restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("分片数超过 SEND_FILE_MAX_PARTS：报错且不发送", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sendfile-"))
    const restore = setFileEnv({
      SEND_FILE_INLINE_MAX_BYTES: "64",
      SEND_FILE_SPLIT: "on",
      SEND_FILE_PART_DELAY_MS: "0",
      SEND_FILE_MAX_PARTS: "2",
    })
    try {
      const p = join(dir, "big.bin")
      writeFileSync(p, Buffer.alloc(200, 7))
      const { calls, fetchImpl } = mediaRecorder()
      globalThis.fetch = fetchImpl
      await expect(sendFileToQQ("tok", c2cCtx(), p, 0)).rejects.toThrow("超过 SEND_FILE_MAX_PARTS=2")
      expect(calls).toHaveLength(0)
    } finally {
      restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("上传 5xx 自动重试后成功（对应实测 850012 inner proxy error）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sendfile-"))
    try {
      const p = join(dir, "note.txt")
      writeFileSync(p, "hello")
      const calls: Recorded[] = []
      let uploadTries = 0
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
        calls.push({ url: String(url), headers: {}, body, ok: true })
        if (String(url).includes("/files") && ++uploadTries === 1) {
          return new Response(JSON.stringify({ message: "call inner proxy error", code: 850012 }), { status: 500 })
        }
        const payload = String(url).includes("/files")
          ? { file_uuid: "u", file_info: "FI::1", ttl: 300 }
          : { id: "m", timestamp: 1 }
        return new Response(JSON.stringify(payload), { status: 200 })
      }) as typeof fetch

      await sendFileToQQ("tok", c2cCtx(), p, 0)
      expect(calls).toHaveLength(3) // 失败的上传 + 成功上传 + 发送
      expect(calls[0].url).toContain("/files")
      expect(calls[2].body.msg_type).toBe(7)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("413 网关拒绝：不重试，且错误保留 HTTP 状态码与原文（非 JSON 错误体）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sendfile-"))
    try {
      const p = join(dir, "huge.zip")
      writeFileSync(p, "x")
      const calls: Recorded[] = []
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
        calls.push({ url: String(url), headers: {}, body, ok: false })
        return new Response("<html><center><hr>stgw</center></html>", {
          status: 413,
          statusText: "Request Entity Too Large",
        })
      }) as typeof fetch

      await expect(sendFileToQQ("tok", c2cCtx(), p, 0)).rejects.toThrow("HTTP 413 Request Entity Too Large")
      expect(calls).toHaveLength(1) // 413 不重试
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("splitFileParts：定宽编号、末片更小、顺序即合并顺序", () => {
    const dir = mkdtempSync(join(tmpdir(), "split-"))
    try {
      const p = join(dir, "data.zip")
      const payload = Buffer.alloc(250, 3)
      writeFileSync(p, payload)
      const parts = splitFileParts(p, 100, join(dir, "out"))
      expect(parts.map((x) => x.split("/").pop())).toEqual(["data.zip.001", "data.zip.002", "data.zip.003"])
      const sizes = parts.map((x) => statSync(x).size)
      expect(sizes).toEqual([100, 100, 50])
      const reassembled = Buffer.concat(parts.map((x) => readFileSync(x)))
      expect(reassembled.equals(payload)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
