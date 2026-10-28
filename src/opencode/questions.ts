// @input:  (none) 纯函数，不依赖外部资源
// @output: QuestionForm, QuestionField, QuestionOption, QuestionAnswerResult,
//          parseQuestionForm, isQuestionForm, renderQuestionMessage, parseQuestionAnswer, isCancelAnswer
// @pos:    opencode层 - V2 表单（AI 的 question 工具）解析 / 渲染 / 作答解析
//
// V2 里 AI 调 question 工具会挂起并创建一个 pending form，等用户答复后才继续：
//   GET    /api/form                                      → 全局待答表单（Form.Info[]）
//   GET    /api/session/{id}/form                          → 某会话的待答表单
//   POST   /api/session/{id}/form/{fid}/reply  {answer}    → 提交答案（204）
//   DELETE /api/session/{id}/form/{fid}                    → 放弃提问（204）
//   SSE    form.created / form.replied / form.cancelled
// Form.Info 形状：{ id, sessionID, title, metadata:{kind:"question", tool:{messageID,id}}, fields }
// field 形状：{ key:"q0", title, description, type:"string"|"multiselect", options:[{value,label,description}], custom }
// 答案约定：answer 是 { fieldKey: value }，value 取 options[i].value（与 label 同文），
//          多选题 value 为 string[]。这里把 QQ 侧的「序号回复」翻译成该结构。

export interface QuestionOption {
  value: string
  label?: string
  description?: string
}

export interface QuestionField {
  key: string
  title?: string
  description?: string
  type?: string
  options: QuestionOption[]
  /** 允许用户不选预设项、直接回复文字 */
  custom: boolean
}

export interface QuestionForm {
  id: string
  sessionID: string
  title?: string
  fields: QuestionField[]
}

export type QuestionAnswerResult =
  | { kind: "answer"; answer: Record<string, unknown>; summary: string }
  | { kind: "error"; message: string }

/** 选项说明的最大展示长度（QQ 消息里过长的说明只保留开头） */
const OPTION_DESC_MAX = 80

const CANCEL_WORDS = new Set(["/cancel", "/skip", "取消", "cancel", "skip"])

export function isCancelAnswer(text: string): boolean {
  return CANCEL_WORDS.has(text.trim().toLowerCase())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** 判断原始表单是否是本桥能处理的「提问」（其他来源的表单不接管） */
export function isQuestionForm(data: unknown): boolean {
  if (!isRecord(data)) return false
  if (!asNonEmptyString(data.id) || !asNonEmptyString(data.sessionID)) return false
  if (!Array.isArray(data.fields) || data.fields.length === 0) return false
  const kind = asNonEmptyString((data.metadata as Record<string, unknown> | undefined)?.kind)
  // 只认 question 工具创建的表单；无 kind 的一并放行（字段结构一致）
  return kind === undefined || kind === "question"
}

/** 把服务端的 Form.Info 解析成本桥的 QuestionForm；结构不符返回 null */
export function parseQuestionForm(data: unknown): QuestionForm | null {
  if (!isQuestionForm(data)) return null
  const record = data as Record<string, unknown>
  const fields: QuestionField[] = []
  for (const raw of extractArray(record.fields)) {
    const key = asNonEmptyString(raw.key)
    if (!key) continue
    const options: QuestionOption[] = []
    for (const opt of extractArray(raw.options)) {
      const value = asNonEmptyString(opt.value) ?? (typeof opt.value === "number" ? String(opt.value) : undefined)
      if (!value) continue
      options.push({
        value,
        label: asNonEmptyString(opt.label),
        description: asNonEmptyString(opt.description),
      })
    }
    fields.push({
      key,
      title: asNonEmptyString(raw.title),
      description: asNonEmptyString(raw.description),
      type: asNonEmptyString(raw.type),
      options,
      custom: raw.custom === true,
    })
  }
  if (fields.length === 0) return null
  return {
    id: String(record.id),
    sessionID: String(record.sessionID),
    title: asNonEmptyString(record.title),
    fields,
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 渲染成 QQ markdown：题目 + 编号选项 + 作答提示 */
export function renderQuestionMessage(form: QuestionForm): string {
  const lines: string[] = []
  const multi = form.fields.length > 1

  form.fields.forEach((field, index) => {
    if (index > 0) lines.push("")
    if (multi) {
      lines.push(`**第 ${index + 1} 题：${field.title ?? "请选择"}**`)
    } else {
      lines.push(`❓ **${field.title ?? form.title ?? "请选择"}**`)
    }
    if (field.description) lines.push(field.description)
    field.options.forEach((option, i) => {
      lines.push(`${i + 1}. ${option.label ?? option.value}`)
      if (option.description) lines.push(`   ${truncate(option.description, OPTION_DESC_MAX)}`)
    })
    if (field.options.length === 0) lines.push("（本题没有预设选项，直接回复文字即可）")
  })

  lines.push("")
  lines.push(`（${buildReplyHint(form)}）`)
  return lines.join("\n")
}

function buildReplyHint(form: QuestionForm): string {
  const parts: string[] = []
  const multi = form.fields.length > 1
  if (multi) {
    parts.push(`按顺序回复每题的序号，例如：${form.fields.map(() => "1").join(" ")}（用空格或逗号分隔）`)
    if (form.fields.some((field) => field.type === "multiselect")) {
      parts.push("多选题可用 1+3 连接多个序号")
    }
    if (form.fields.every((field) => field.custom)) {
      parts.push("每题也可直接回复文字自定义")
    }
  } else {
    const field = form.fields[0]
    if (field.options.length === 0) {
      parts.push("直接回复文字作答")
    } else {
      parts.push(field.type === "multiselect" ? "回复序号作答，可给多个（如 1 3）" : "回复序号作答")
      if (field.custom) parts.push("也可直接回复文字自定义")
    }
  }
  parts.push("回复 /cancel 放弃提问")
  return parts.join("；")
}

const SEPARATOR_RE = /[\s,，;；、]+/

/**
 * 把用户的回复翻译成表单答案。
 * 返回 null 表示「不像在作答」（空消息 / 取消词），交给常规消息流程处理。
 * 规则：
 *   - 序号数量 == 题数 → 每题一个序号（多选题可写 1+3）
 *   - 只有一题 → 单选题只能一个序号；多选题可给多个
 *   - 其他情况 → 报错并提示格式（避免用户的新话题被静默吞掉）
 */
export function parseQuestionAnswer(form: QuestionForm, text: string): QuestionAnswerResult | null {
  const trimmed = text.trim()
  if (!trimmed || isCancelAnswer(trimmed)) return null
  const fields = form.fields
  const tokens = trimmed.split(SEPARATOR_RE).filter(Boolean)
  if (tokens.length === 0) return null

  const answer: Record<string, unknown> = {}
  const summary: string[] = []

  const assign = (field: QuestionField, tokensForField: string[]): QuestionAnswerResult | null => {
    const resolved = resolveField(field, tokensForField)
    if (typeof resolved === "string") return { kind: "error", message: resolved }
    answer[field.key] = resolved.value
    summary.push(`${field.title ?? field.key}=${resolved.label}`)
    return null
  }

  if (tokens.length === fields.length) {
    for (let i = 0; i < fields.length; i++) {
      const failure = assign(fields[i], [tokens[i]])
      if (failure) return failure
    }
  } else if (fields.length === 1) {
    const failure = assign(fields[0], tokens)
    if (failure) return failure
  } else {
    return {
      kind: "error",
      message: `本题共 ${fields.length} 个问题，请按顺序给出 ${fields.length} 个序号（如 ${fields
        .map(() => "1")
        .join(" ")}），或回复 /cancel 放弃`,
    }
  }

  return { kind: "answer", answer, summary: summary.join("；") }
}

/** 把一题的输入解析成答案值；返回字符串表示错误说明 */
function resolveField(
  field: QuestionField,
  tokens: string[],
): { value: string | string[]; label: string } | string {
  const isMulti = field.type === "multiselect"
  // 多选题在「多题」场景下用 1+3 表达多个选项（逗号已被当作题间分隔符）
  const parts = isMulti && tokens.length === 1 ? tokens[0].split("+").filter(Boolean) : tokens
  const label = field.title ?? field.key

  if (parts.length > 0 && parts.every((token) => /^\d+$/.test(token))) {
    if (field.options.length === 0) {
      return isMulti
        ? { value: parts, label: parts.join("/") }
        : { value: parts[0], label: parts[0] }
    }
    const values: string[] = []
    const labels: string[] = []
    for (const part of parts) {
      const option = field.options[Number(part) - 1]
      if (!option) {
        return `序号超出范围：「${label}」只有 ${field.options.length} 个选项（1-${field.options.length}）`
      }
      values.push(option.value)
      labels.push(option.label ?? option.value)
    }
    if (!isMulti && values.length > 1) {
      return `「${label}」是单选题，只能回复一个序号`
    }
    return isMulti
      ? { value: values, label: labels.join(" / ") }
      : { value: values[0], label: labels[0] }
  }

  // 非序号输入：按自定义文字处理
  const custom = parts.join(" ").trim()
  if (field.options.length > 0 && !field.custom) {
    return `「${label}」只支持回复序号（1-${field.options.length}）`
  }
  if (!custom) return `「${label}」的回答是空的`
  return { value: custom, label: custom }
}

function extractArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}
