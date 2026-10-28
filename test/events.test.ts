// events.test.ts — EventRouter 的 V2 表单事件分发（线上真实形状：created 外层包 form）
import { describe, expect, test } from "bun:test"
import { EventRouter, type FormEvent } from "../src/opencode/events.js"
import type { EventEnvelope, OpencodeClient } from "../src/opencode/client.js"

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor 超时")
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** SSE 桩：按顺序吐事件后挂住，避免 EventRouter 走进重连循环 */
function fakeClient(events: EventEnvelope[]): OpencodeClient {
  return {
    event: {
      subscribe: () => ({
        stream: (async function* () {
          for (const e of events) yield e
          await new Promise(() => {})
        })(),
      }),
    },
    reconnect: async () => false,
  } as unknown as OpencodeClient
}

const CREATED_WRAPPED: EventEnvelope = {
  type: "form.created",
  data: {
    // 线上 form.created 的 data 外层包了一层 form（2026-10-09 抓包确认）
    form: {
      id: "frm_1",
      sessionID: "ses_1",
      title: "Questions",
      metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } },
      fields: [{ key: "q0", title: "选哪个", type: "string", options: [{ value: "A", label: "A" }], custom: true }],
    },
  },
}

describe("EventRouter 表单事件", () => {
  test("created 包裹形状被解包，且同一事件仍分发给会话监听者", async () => {
    const router = new EventRouter(
      fakeClient([CREATED_WRAPPED]),
      undefined,
    )
    const forms: FormEvent[] = []
    const seen: string[] = []
    router.registerFormCallback((e) => forms.push(e))
    router.register("ses_1", (e) => seen.push(e.type))
    router.start()
    await waitFor(() => forms.length === 1)
    router.stop()

    expect(forms[0]).toEqual({
      type: "created",
      id: "frm_1",
      sessionID: "ses_1",
      title: "Questions",
      metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } },
      fields: [
        { key: "q0", title: "选哪个", type: "string", options: [{ value: "A", label: "A" }], custom: true },
      ],
    })
    // 解包后的 sessionID 让会话监听者（等待中的 watchdog）也收到该事件
    expect(seen).toEqual(["form.created"])
  })

  test("cancelled / replied 平铺形状：只取 id+sessionID，fields 为空", async () => {
    const router = new EventRouter(
      fakeClient([
        { type: "form.cancelled", data: { id: "frm_1", sessionID: "ses_1" } },
        { type: "form.replied", data: { id: "frm_1", sessionID: "ses_1", answer: { q0: "A" } } },
      ]),
      undefined,
    )
    const forms: FormEvent[] = []
    router.registerFormCallback((e) => forms.push(e))
    router.start()
    await waitFor(() => forms.length === 2)
    router.stop()

    expect(forms.map((f) => f.type)).toEqual(["cancelled", "replied"])
    expect(forms[0]).toMatchObject({ id: "frm_1", sessionID: "ses_1", fields: [] })
    expect(forms[1]).toMatchObject({ id: "frm_1", sessionID: "ses_1", fields: [] })
  })

  test("缺 id/sessionID 的形状不分发（但不抛错）", async () => {
    const router = new EventRouter(fakeClient([{ type: "form.created", data: { foo: 1 } }]), undefined)
    const forms: FormEvent[] = []
    router.registerFormCallback((e) => forms.push(e))
    router.start()
    await new Promise((r) => setTimeout(r, 100))
    router.stop()
    expect(forms).toHaveLength(0)
  })

  test("hasListener 反映注册状态", () => {
    const router = new EventRouter(fakeClient([]), undefined)
    expect(router.hasListener("ses_1")).toBe(false)
    router.register("ses_1", () => {})
    expect(router.hasListener("ses_1")).toBe(true)
    router.unregister("ses_1")
    expect(router.hasListener("ses_1")).toBe(false)
  })
})
