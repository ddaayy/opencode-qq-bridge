// questions.test.ts — V2 表单（AI 的 question 工具）：解析 / 渲染 / 序号作答翻译
import { describe, expect, test } from "bun:test"
import {
  isCancelAnswer,
  isQuestionForm,
  parseQuestionAnswer,
  parseQuestionForm,
  renderQuestionMessage,
} from "../src/opencode/questions.js"

/** 与线上真实 pending form 同构（2026-10-09 casaos 会话抓取，字段名/取值方式不变） */
function realForm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "frm_11f9011f3001yKN1pjSj0sc4vI",
    sessionID: "ses_ee07690f6ffecKfo5HaQeXDjRX",
    title: "Questions",
    metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } },
    fields: [
      {
        key: "q0",
        title: "是否现在装",
        description: "要我现在直接帮你装好 Open WebUI 吗？",
        type: "string",
        options: [
          { value: "装 Open WebUI 并顺便拉个模型 (推荐)", label: "装 Open WebUI 并顺便拉个模型 (推荐)", description: "装完可直接聊" },
          { value: "只装 Open WebUI，模型我自己选", label: "只装 Open WebUI，模型我自己选", description: "只装前端" },
          { value: "先别装，只给我命令", label: "先别装，只给我命令", description: "我自己执行" },
        ],
        custom: true,
      },
      {
        key: "q1",
        title: "拉哪个模型",
        description: "倾向哪种？",
        type: "string",
        options: [
          { value: "qwen2.5:1.5b (推荐)", label: "qwen2.5:1.5b (推荐)", description: "约 1GB" },
          { value: "qwen2.5:0.5b", label: "qwen2.5:0.5b", description: "约 400MB" },
        ],
        custom: true,
      },
    ],
    ...overrides,
  }
}

describe("questions 解析表单", () => {
  test("真实形状：id/sessionID/字段/选项都取到", () => {
    const form = parseQuestionForm(realForm())
    expect(form).not.toBeNull()
    expect(form!.id).toBe("frm_11f9011f3001yKN1pjSj0sc4vI")
    expect(form!.sessionID).toBe("ses_ee07690f6ffecKfo5HaQeXDjRX")
    expect(form!.fields).toHaveLength(2)
    expect(form!.fields[0].key).toBe("q0")
    expect(form!.fields[0].options.map((o) => o.value)).toEqual([
      "装 Open WebUI 并顺便拉个模型 (推荐)",
      "只装 Open WebUI，模型我自己选",
      "先别装，只给我命令",
    ])
    expect(form!.fields[0].custom).toBe(true)
  })

  test("缺 id / sessionID / fields 一律拒绝", () => {
    expect(parseQuestionForm(realForm({ id: undefined }))).toBeNull()
    expect(parseQuestionForm(realForm({ sessionID: "" }))).toBeNull()
    expect(parseQuestionForm(realForm({ fields: [] }))).toBeNull()
    expect(parseQuestionForm(null)).toBeNull()
    expect(parseQuestionForm("frm_x")).toBeNull()
  })

  test("非 question 来源的表单不接管，无 kind 的放行", () => {
    expect(isQuestionForm(realForm({ metadata: { kind: "app" } }))).toBe(false)
    expect(isQuestionForm(realForm({ metadata: {} }))).toBe(true)
    expect(isQuestionForm(realForm({ metadata: { kind: "question" } }))).toBe(true)
  })

  test("字段缺 key 的被丢弃，全丢则整体拒绝", () => {
    const fields = [{ title: "没有 key", options: [{ value: "a", label: "a" }] }]
    expect(parseQuestionForm(realForm({ fields }))).toBeNull()
  })
})

describe("questions 渲染", () => {
  test("单题：标题 + 编号选项 + 选项说明 + 作答提示", () => {
    const form = parseQuestionForm(realForm({ fields: [realForm().fields![0]] }))!
    const text = renderQuestionMessage(form)
    expect(text).toContain("❓ **是否现在装**")
    expect(text).toContain("要我现在直接帮你装好 Open WebUI 吗？")
    expect(text).toContain("1. 装 Open WebUI 并顺便拉个模型 (推荐)")
    expect(text).toContain("2. 只装 Open WebUI，模型我自己选")
    expect(text).toContain("3. 先别装，只给我命令")
    expect(text).toContain("装完可直接聊")
    expect(text).toContain("回复序号作答")
    expect(text).toContain("也可直接回复文字自定义")
    expect(text).toContain("/cancel")
  })

  test("多题：逐题编号，提示按顺序给序号", () => {
    const text = renderQuestionMessage(parseQuestionForm(realForm())!)
    expect(text).toContain("**第 1 题：是否现在装**")
    expect(text).toContain("**第 2 题：拉哪个模型**")
    expect(text).toContain("按顺序回复每题的序号，例如：1 1")
  })

  test("多选题提示可用 1+3 连接", () => {
    const raw = realForm()
    ;(raw.fields as Array<Record<string, unknown>>)[0].type = "multiselect"
    const text = renderQuestionMessage(parseQuestionForm(raw)!)
    expect(text).toContain("多选题可用 1+3 连接多个序号")
  })

  test("过长的选项说明被截断", () => {
    const raw = realForm()
    ;(raw.fields as Array<Record<string, unknown>>)[0] = {
      key: "q0",
      title: "选一个",
      options: [{ value: "a", label: "a", description: "x".repeat(300) }],
      custom: false,
    }
    const text = renderQuestionMessage(parseQuestionForm(raw)!)
    expect(text).toContain("xxx…")
    expect(text).not.toContain("x".repeat(200))
  })
})

describe("questions 序号作答", () => {
  const two = parseQuestionForm(realForm())!
  const one = parseQuestionForm(realForm({ fields: [realForm().fields![0]] }))!

  test("单选：序号翻译成 option.value，摘要带 label", () => {
    const result = parseQuestionAnswer(one, "2")
    expect(result).toEqual({
      kind: "answer",
      answer: { q0: "只装 Open WebUI，模型我自己选" },
      summary: "是否现在装=只装 Open WebUI，模型我自己选",
    })
  })

  test("多题：按顺序给两个序号", () => {
    const result = parseQuestionAnswer(two, "1 2")
    expect(result).toEqual({
      kind: "answer",
      answer: { q0: "装 Open WebUI 并顺便拉个模型 (推荐)", q1: "qwen2.5:0.5b" },
      summary: "是否现在装=装 Open WebUI 并顺便拉个模型 (推荐)；拉哪个模型=qwen2.5:0.5b",
    })
  })

  test("逗号/顿号/分号都是分隔符", () => {
    expect(parseQuestionAnswer(two, "1,2")).toEqual(parseQuestionAnswer(two, "1 2"))
    expect(parseQuestionAnswer(two, "1、2")).toEqual(parseQuestionAnswer(two, "1 2"))
    expect(parseQuestionAnswer(two, "1；2")).toEqual(parseQuestionAnswer(two, "1 2"))
  })

  test("序号越界 / 单选题给两个序号 都报错", () => {
    const outOfRange = parseQuestionAnswer(one, "9")
    expect(outOfRange?.kind).toBe("error")
    expect((outOfRange as { message: string }).message).toContain("序号超出范围")
    const tooMany = parseQuestionAnswer(one, "1 2")
    expect(tooMany?.kind).toBe("error")
    expect((tooMany as { message: string }).message).toContain("单选题")
  })

  test("多题却只给一个序号 → 报错提示格式（不静默吞掉）", () => {
    const result = parseQuestionAnswer(two, "1")
    expect(result?.kind).toBe("error")
    expect((result as { message: string }).message).toContain("共 2 个问题")
  })

  test("custom=true 时非序号输入按自定义文字提交", () => {
    const result = parseQuestionAnswer(one, "我自己决定")
    expect(result).toEqual({
      kind: "answer",
      answer: { q0: "我自己决定" },
      summary: "是否现在装=我自己决定",
    })
  })

  test("custom=false 时非序号输入报错并给出序号范围", () => {
    const raw = realForm({ fields: [realForm().fields![0]] })
    ;(raw.fields as Array<Record<string, unknown>>)[0].custom = false
    const result = parseQuestionAnswer(parseQuestionForm(raw)!, "随便")
    expect(result?.kind).toBe("error")
    expect((result as { message: string }).message).toContain("只支持回复序号（1-3）")
  })

  test("多选题：单题多个序号 → string[]", () => {
    const raw = realForm({
      fields: [
        {
          key: "q0",
          title: "要哪些",
          type: "multiselect",
          options: [
            { value: "A", label: "A" },
            { value: "B", label: "B" },
            { value: "C", label: "C" },
          ],
          custom: false,
        },
      ],
    })
    const form = parseQuestionForm(raw)!
    expect(parseQuestionAnswer(form, "1 3")).toEqual({
      kind: "answer",
      answer: { q0: ["A", "C"] },
      summary: "要哪些=A / C",
    })
    // 多题场景下用 1+3 表达同一题的多个选项
    const multi = parseQuestionForm(
      realForm({
        fields: [
          {
            key: "q0",
            title: "要哪些",
            type: "multiselect",
            options: [
              { value: "A", label: "A" },
              { value: "B", label: "B" },
              { value: "C", label: "C" },
            ],
            custom: false,
          },
          {
            key: "q1",
            title: "再来一个",
            type: "string",
            options: [
              { value: "X", label: "X" },
              { value: "Y", label: "Y" },
            ],
            custom: false,
          },
        ],
      }),
    )!
    expect(parseQuestionAnswer(multi, "1+3 2")).toEqual({
      kind: "answer",
      answer: { q0: ["A", "C"], q1: "Y" },
      summary: "要哪些=A / C；再来一个=Y",
    })
  })

  test("没有预设选项的题目：序号/文字都直接作为值", () => {
    const form = parseQuestionForm(
      realForm({
        fields: [{ key: "q0", title: "随便写点", type: "string", options: [], custom: true }],
      }),
    )!
    expect(parseQuestionAnswer(form, "hello world")).toEqual({
      kind: "answer",
      answer: { q0: "hello world" },
      summary: "随便写点=hello world",
    })
  })

  test("空消息 / 取消词返回 null（交回常规消息流程）", () => {
    expect(parseQuestionAnswer(two, "   ")).toBeNull()
    for (const word of ["/cancel", "/skip", "取消", "Cancel", "SKIP"]) {
      expect(isCancelAnswer(word)).toBe(true)
      expect(parseQuestionAnswer(two, word)).toBeNull()
    }
    expect(isCancelAnswer("1")).toBe(false)
  })
})
