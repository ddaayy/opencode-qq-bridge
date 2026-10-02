// @input:  ./api (sendC2CMessage, sendGroupMessage, getNextMsgSeq, upload*/send*Media*, sendStreamMessage, classifyStreamError, QQApiError), ./types (MessageContext), ../copy (Scene, CopyVars)
// @output: replyToQQ, formatForQQ, splitMessage, sendProactiveToQQ, stripThinkingTags, sendFileToQQ, splitFileParts, StreamSession
// @pos:    qq层 - 消息发送 (Markdown格式化 + 分割 + 被动回复 + 流式会话状态机)
import {
  sendC2CMessage,
  sendGroupMessage,
  getNextMsgSeq,
  uploadC2CFile,
  uploadGroupFile,
  uploadC2CFileByUrl,
  uploadGroupFileByUrl,
  sendC2CMediaMessage,
  sendGroupMediaMessage,
  sendStreamMessage,
  classifyStreamError,
  QQApiError,
  type StreamShard,
  type StreamShardResponse,
} from "./api.js"
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { basename, join } from "path"
import type { MessageContext } from "./types.js"
import type { Scene, CopyVars } from "../copy.js"

const DEFAULT_MAX_LENGTH = 3000

// QQ 原生 markdown（msg_type=2）；关闭则回退纯文本
const MARKDOWN_ENABLED = (process.env.MARKDOWN ?? "on").toLowerCase() !== "off"

// 流式分片 content_type 跟随 MARKDOWN 开关（上游普通路径 on→原生 markdown，流式同款；模块级 env 读取，不新增 env 键）
const STREAM_CONTENT_TYPE: "markdown" | "text" = MARKDOWN_ENABLED ? "markdown" : "text"

// Markdown -> QQ 纯文本: 保留代码块，去除其他标记
export function formatForQQ(text: string): string {
  const codeBlocks: string[] = []

  // 保护代码块，用占位符替换
  let processed = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match)
    return `\x00CB${codeBlocks.length - 1}\x00`
  })

  // 去除 markdown 标记
  processed = processed
    .replace(/\*\*(.+?)\*\*/g, "$1")       // **bold** -> bold
    .replace(/\*(.+?)\*/g, "$1")           // *italic* -> italic
    .replace(/__(.+?)__/g, "$1")           // __underline__ -> underline
    .replace(/~~(.+?)~~/g, "$1")           // ~~strike~~ -> strike
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")  // [text](url) -> text (url)
    .replace(/^#{1,6}\s+/gm, "")           // ### heading -> heading
    .replace(/^>\s?/gm, "")                // > quote -> quote
    .replace(/^---$/gm, "----------")      // --- -> ----------

  // 还原代码块
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`\x00CB${i}\x00`, codeBlocks[i])
  }

  return processed.trim()
}

// 按段落/代码块边界分割长消息
export function splitMessage(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    // 优先在双换行处截断 (段落边界)
    let splitAt = remaining.lastIndexOf("\n\n", maxLength)
    if (splitAt < maxLength * 0.3) {
      // 次选单换行
      splitAt = remaining.lastIndexOf("\n", maxLength)
    }
    if (splitAt < maxLength * 0.3) {
      // 最后才硬截
      splitAt = maxLength
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n+/, "")
  }

  return chunks
}

export async function replyToQQ(
  accessToken: string,
  ctx: MessageContext,
  text: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): Promise<void> {
  if (MARKDOWN_ENABLED) {
    try {
      await sendReplyChunks(accessToken, ctx, text, maxLength, true)
      return
    } catch (error) {
      console.error("[sender] markdown 发送失败，回退纯文本:", error instanceof Error ? error.message : String(error))
    }
  }
  await sendReplyChunks(accessToken, ctx, text, maxLength, false)
}

async function sendReplyChunks(
  accessToken: string,
  ctx: MessageContext,
  text: string,
  maxLength: number,
  markdown: boolean,
): Promise<void> {
  const formatted = markdown ? text.trim() : formatForQQ(text)
  const chunks = splitMessage(formatted, maxLength)

  for (const chunk of chunks) {
    const msgSeq = getNextMsgSeq(ctx.msgId)
    if (ctx.type === "group" && ctx.groupId) {
      await sendGroupMessage(accessToken, ctx.groupId, chunk, ctx.msgId, msgSeq, markdown)
    } else {
      await sendC2CMessage(accessToken, ctx.userId, chunk, ctx.msgId, msgSeq, markdown)
    }
  }
}

/**
 * 主动消息（不带 msg_id）：不受被动回复次数限制，用于中间进度推送。
 */
export async function sendProactiveToQQ(
  accessToken: string,
  ctx: MessageContext,
  text: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): Promise<void> {
  const send = async (markdown: boolean): Promise<void> => {
    const formatted = markdown ? text.trim() : formatForQQ(text)
    const chunks = splitMessage(formatted, maxLength)
    for (const chunk of chunks) {
      if (ctx.type === "group" && ctx.groupId) {
        await sendGroupMessage(accessToken, ctx.groupId, chunk, undefined, undefined, markdown)
      } else {
        await sendC2CMessage(accessToken, ctx.userId, chunk, undefined, undefined, markdown)
      }
    }
  }

  if (MARKDOWN_ENABLED) {
    try {
      await send(true)
      return
    } catch (error) {
      console.error("[sender] markdown 发送失败，回退纯文本:", error instanceof Error ? error.message : String(error))
    }
  }
  await send(false)
}

/** 根据扩展名判断 QQ 富媒体类型：1=图片 2=视频 3=语音 4=文件 */
export function detectOutboundFileType(name: string): number {
  const ext = name.toLowerCase().split(".").pop() ?? ""
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"].includes(ext)) return 1
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return 2
  if (["mp3", "wav", "silk", "flac", "amr", "ogg"].includes(ext)) return 3
  return 4
}

/** sendfile 标记内容是否为公网 URL（走平台 URL 上传，不落本地） */
export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

/** URL 形式 sendfile 的 file_type 推断：剥掉查询串/锚点后按扩展名判定（1=图片 2=视频 3=语音 4=文件） */
export function detectUrlFileType(url: string): number {
  const path = url.split(/[?#]/, 1)[0]
  const ext = path.toLowerCase().split(".").pop() ?? ""
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return 1
  if (ext === "mp4") return 2
  if (["silk", "mp3", "wav", "ogg"].includes(ext)) return 3
  return 4
}

/** URL 形式 sendfile 的 file_name 推导：取 pathname 的 basename（剥查询串/锚点），decode 失败用原值；basename 为空返回 undefined */
export function urlFileName(rawUrl: string): string | undefined {
  let name: string
  try {
    name = new URL(rawUrl).pathname.split("/").pop() ?? ""
  } catch {
    name = rawUrl.split(/[?#]/, 1)[0].split("/").pop() ?? ""
  }
  if (!name) return undefined
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

// ---------------------------------------------------------------------------
// 本地文件发送：内联 base64 上限 + 超限自动分片
// ---------------------------------------------------------------------------

/**
 * QQ 富媒体 `file_data`（base64 内联）通道实测（2026-10，api.sgroup.qq.com）：
 * - ≤4.5MB 文件（≈6MB 请求体）稳定 200；
 * - 5~14MB 频繁 `500 call inner proxy error (850012)`（上传慢/网关超时）；
 * - 请求体 ≥约 19~27MB 被网关 `stgw` 直接 `413 Request Entity Too Large`，无重试机会。
 * 因此把安全阈值定为 4MB：超过就分片，绝不撞 500/413。
 */
const DEFAULT_INLINE_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_PART_DELAY_MS = 800
const DEFAULT_MAX_PARTS = 40
const UPLOAD_RETRY_ATTEMPTS = 3

/** 分片/阈值参数（调用时读 env，便于测试与热改） */
function fileSendSettings(): {
  inlineMaxBytes: number
  split: boolean
  partDelayMs: number
  maxParts: number
} {
  const inlineMaxBytes = Number(process.env.SEND_FILE_INLINE_MAX_BYTES ?? DEFAULT_INLINE_MAX_BYTES)
  return {
    inlineMaxBytes: Number.isFinite(inlineMaxBytes) && inlineMaxBytes > 0 ? inlineMaxBytes : DEFAULT_INLINE_MAX_BYTES,
    split: (process.env.SEND_FILE_SPLIT ?? "on").toLowerCase() !== "off",
    partDelayMs: Number(process.env.SEND_FILE_PART_DELAY_MS ?? DEFAULT_PART_DELAY_MS),
    maxParts: Number(process.env.SEND_FILE_MAX_PARTS ?? DEFAULT_MAX_PARTS),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 上传/发送的有限重试：仅对网络错误、429、5xx 重试；4xx（含 413）与业务错误直接抛出 */
async function withSendRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const status = error instanceof QQApiError ? error.status : 0
      const retryable = status === 0 || status === 429 || status >= 500
      if (!retryable || attempt === UPLOAD_RETRY_ATTEMPTS) break
      console.warn(`[sender] ${label} 失败（状态 ${status}），${attempt}/${UPLOAD_RETRY_ATTEMPTS - 1} 次重试…`)
      await sleep(1000 * attempt)
    }
  }
  throw lastError
}

/** 上传单个本地文件并发富媒体消息；passive=false 走主动通道（不带 msg_id，不占被动回复预算） */
async function uploadAndSendLocalFile(
  accessToken: string,
  ctx: MessageContext,
  path: string,
  fileName: string,
  passive: boolean,
): Promise<void> {
  const fileData = readFileSync(path).toString("base64")
  const fileType = detectOutboundFileType(fileName)
  const msgId = passive ? ctx.msgId : undefined
  const msgSeq = passive ? getNextMsgSeq(ctx.msgId) : undefined

  const doUpload = async (): Promise<void> => {
    if (ctx.type === "group" && ctx.groupId) {
      const fileInfo = await uploadGroupFile(accessToken, ctx.groupId, { fileType, fileData, fileName })
      await sendGroupMediaMessage(accessToken, ctx.groupId, fileInfo, msgId, msgSeq)
    } else {
      const fileInfo = await uploadC2CFile(accessToken, ctx.userId, { fileType, fileData, fileName })
      await sendC2CMediaMessage(accessToken, ctx.userId, fileInfo, msgId, msgSeq)
    }
  }
  await withSendRetry(fileName, doUpload)
}

/**
 * 按 partSize 把 src 切成若干分片写入临时目录（outDir 缺省自建），分片名 = 原名 + `.001`/`.002`…
 * 定宽编号保证 `cat 原名.00* > 原名` 的字典序即正确顺序。
 */
export function splitFileParts(src: string, partSize: number, outDir?: string): string[] {
  const stat = statSync(src)
  const total = Math.max(1, Math.ceil(stat.size / partSize))
  const dir = outDir ?? mkdtempSync(join(tmpdir(), "openqq-parts-"))
  mkdirSync(dir, { recursive: true })
  const base = basename(src)
  const digits = Math.max(3, String(total).length)
  const parts: string[] = []
  const fd = openSync(src, "r")
  try {
    const buf = Buffer.alloc(partSize)
    for (let i = 0; i < total; i++) {
      const read = readSync(fd, buf, 0, partSize, i * partSize)
      const partPath = join(dir, `${base}.${String(i + 1).padStart(digits, "0")}`)
      writeFileSync(partPath, read > 0 ? buf.subarray(0, read) : buf.subarray(0, 0))
      parts.push(partPath)
    }
  } finally {
    closeSync(fd)
  }
  return parts
}

/**
 * 把本机文件或公网 URL 发送给 QQ 用户/群（先上传富媒体，再发 msg_type=7 消息，作为被动回复关联原消息）。
 * http(s) URL 走官方 URL 上传：平台自动下载转存，跳过本地读取与 SEND_FILE_MAX_BYTES 体积检查（大小限制由平台侧处理）。
 *
 * 本地文件超过 SEND_FILE_INLINE_MAX_BYTES（默认 4MB）时按 SEND_FILE_SPLIT 自动分片：
 * 首片作为被动回复，其余走主动通道（绕开单 msg_id 4 次被动预算），分片文件用完即删。
 * 返回非空字符串 = 需要展示给用户的分片说明（合并命令等）。
 */
export async function sendFileToQQ(
  accessToken: string,
  ctx: MessageContext,
  filePath: string,
  maxBytes: number = 0,
): Promise<string | undefined> {
  if (isHttpUrl(filePath)) {
    const fileType = detectUrlFileType(filePath)
    const fileName = urlFileName(filePath)
    const msgSeq = getNextMsgSeq(ctx.msgId)
    if (ctx.type === "group" && ctx.groupId) {
      const fileInfo = await uploadGroupFileByUrl(accessToken, ctx.groupId, { fileType, url: filePath, fileName })
      await sendGroupMediaMessage(accessToken, ctx.groupId, fileInfo, ctx.msgId, msgSeq)
    } else {
      const fileInfo = await uploadC2CFileByUrl(accessToken, ctx.userId, { fileType, url: filePath, fileName })
      await sendC2CMediaMessage(accessToken, ctx.userId, fileInfo, ctx.msgId, msgSeq)
    }
    return undefined
  }

  const stat = statSync(filePath)
  if (!stat.isFile()) {
    throw new Error(`不是文件：${filePath}`)
  }
  if (maxBytes > 0 && stat.size > maxBytes) {
    throw new Error(`文件过大 ${(stat.size / 1048576).toFixed(1)}MB（上限 ${Math.round(maxBytes / 1048576)}MB）`)
  }

  const name = basename(filePath)
  const { inlineMaxBytes, split, partDelayMs, maxParts } = fileSendSettings()
  const passive = Boolean(ctx.msgId)

  // 阈值内：一次内联上传（原行为）
  if (stat.size <= inlineMaxBytes) {
    await uploadAndSendLocalFile(accessToken, ctx, filePath, name, passive)
    return undefined
  }

  const sizeMb = (stat.size / 1048576).toFixed(1)
  const inlineMb = (inlineMaxBytes / 1048576).toFixed(1)
  const total = Math.ceil(stat.size / inlineMaxBytes)

  if (!split) {
    throw new Error(
      `${sizeMb}MB 超过 QQ 内联上传上限 ${inlineMb}MB（超过会 413/500），已禁用分片（SEND_FILE_SPLIT=off）。` +
        `请压缩后重试、改用公网 URL，或开启分片。`,
    )
  }
  if (total > maxParts) {
    throw new Error(
      `${sizeMb}MB 需分 ${total} 片，超过 SEND_FILE_MAX_PARTS=${maxParts}。请压缩后重试或调高该值。`,
    )
  }

  // 超限：分片发送
  let parts: string[] = []
  let outDir = ""
  try {
    outDir = mkdtempSync(join(tmpdir(), "openqq-parts-"))
    parts = splitFileParts(filePath, inlineMaxBytes, outDir)
    for (let i = 0; i < parts.length; i++) {
      // 首片作为被动回复关联原消息；后续片走主动通道，避免撞单 msg_id 4 次被动预算
      await uploadAndSendLocalFile(accessToken, ctx, parts[i], basename(parts[i]), i === 0 && passive)
      if (i < parts.length - 1 && partDelayMs > 0) await sleep(partDelayMs)
    }
  } finally {
    if (outDir) {
      try {
        rmSync(outDir, { recursive: true, force: true })
      } catch {
        // 分片残留不影响主流程
      }
    }
  }

  const digits = Math.max(3, String(parts.length).length)
  const glob = `${name}.${"0".repeat(digits - 1)}*`
  return (
    `📦 ${name}（${sizeMb}MB）超过单次上传上限 ${inlineMb}MB，已自动分 ${parts.length} 片：` +
    `${name}.${String(1).padStart(digits, "0")} ~ ${name}.${String(parts.length).padStart(digits, "0")}。` +
    `合并：cat ${glob} > ${name}`
  )
}

// ---------------------------------------------------------------------------
// 流式会话（实验性，仅 C2C）
// ---------------------------------------------------------------------------

/** 正文累计达到该长度才开正文流（短回复不开流直接走普通回复；内部常量，不设 env） */
const MIN_FLUSH_CHARS = 24

/** 频控重试上限与指数退避基数（官方 streaming.ts：50002/HTTP 429 最多 3 次重试，1000/2000/4000ms） */
const RATE_LIMIT_RETRIES = 3
const RATE_LIMIT_BACKOFF_BASE_MS = 1000

/**
 * 开流总次数上限，按通道取值：
 * - 被动（默认回归路径）：QQ 单聊被动回复每个 msg_id 最多 4 次；每个分片都带 msg_id（官方
 *   SDK 语义，真机实测缺 msg_id 的续片报 50015001），但去重锚定为 msg_id+msg_seq——openStream
 *   换新 msg_seq 才消耗名额，流内后续分片共享同 msg_seq 不消耗。fallbackToReply 的全量兜底
 *   同为该 msg_id 的被动回复，保守预留 1 个名额 ⇒ 总开流次数 ≤ 4 - 1 = 3。
 *   3 = 占位①（start 的 WAITING）+ 正文②（首段正文流）+ 重置③（TEXT 重置后再开一段正文流）；
 *   场景消息一律走主动消息、零开流消耗（真机教训：工具密集回合里场景流抢光正文流名额，
 *   第二段正文 TEXT 重置时预算已尽）。
 * - 主动（proactive）：开流不带 msg_id，不占被动回复预算，改受主动消息频控约束——QQ 单关系
 *   主动消息上限 20 条/分钟（20/qpm），取 10 留一半余量给场景主动消息与普通进度推送。
 * 用尽后：正文只缓冲不发送，finish 比对失败 → bridge 全量兜底，内容不丢、预算不超。
 */
const MAX_STREAM_OPENS_PASSIVE = 3
const MAX_STREAM_OPENS_PROACTIVE = 10

/** 等待动画帧序列：前缀单调递增，满足 40007「已下发前缀不可修改」约束 */
const DOTS_FRAMES = ["", ".", "..", "..."] as const

// 与 bridge.ts 的 SEND_FILE_RE 保持一致语义（[[sendfile:路径]]，路径不含 ] 和换行）；
// 两处需同步修改。流式缓冲用它剥离标记，避免标记原文随正文露给用户。
const SEND_FILE_MARKER_RE = /\[\[\s*sendfile\s*:\s*([^\]\n]+?)\s*\]\]/gi
const SEND_FILE_KEYWORD = "sendfile"

/**
 * text 尾部若是「疑似未闭合的 [[sendfile:...]] 标记前缀」片段（如 [[、[[sendf、
 * [[sendfile:/tmp/a、或只差一个 ] 的 [[sendfile:/tmp/a]），返回该片段；否则返回 ""。
 * 从最早的候选 [[ 起算，嵌在路径区里的 [[ 也一并扣留。
 */
function trailingSendFileFragment(text: string): string {
  for (let i = text.indexOf("[["); i !== -1; i = text.indexOf("[[", i + 1)) {
    if (isSendFilePrefix(text.slice(i))) return text.slice(i)
  }
  return ""
}

/** s（以 [[ 开头）是否仍可能被后续 delta 补全成一个完整标记（SEND_FILE_MARKER_RE 的前缀语言） */
function isSendFilePrefix(s: string): boolean {
  let i = 2
  while (i < s.length && /\s/.test(s[i])) i++
  for (let k = 0; k < SEND_FILE_KEYWORD.length; k++) {
    if (i >= s.length) return true // 关键字未输完（含 s 恰为 "[[" 或 "[["+空白）
    if (s[i] !== SEND_FILE_KEYWORD[k]) return false
    i++
  }
  while (i < s.length && /\s/.test(s[i])) i++
  if (i >= s.length) return true
  if (s[i] !== ":") return false
  i++
  // 冒号后是路径区（[^\]\n]*）；末尾至多一个 ]（闭合 ]] 的前半，且其前至少 1 个路径字符）
  let end = s.length
  let closable = false
  if (end > i && s[end - 1] === "]") {
    end--
    closable = true
  }
  let pathChars = 0
  for (let k = i; k < end; k++) {
    const ch = s[k]
    if (ch === "]" || ch === "\n") return false
    pathChars++
  }
  return !closable || pathChars > 0
}

// ---- 思考标签剥离（官方 sanitize.ts 同款） -----------------------------------

/** 成对思考标签块：<system-reminder>/<previous_response>/<thinking> 与 deepseek 反引号风格 `think`...`/think` */
const THINK_BLOCK_RE =
  /<system-reminder>[\s\S]*?<\/system-reminder>|<previous_response>[\s\S]*?<\/previous_response>|<thinking>[\s\S]*?<\/thinking>|`think`[\s\S]*?`\/think`/g
/** 残标签：未闭合的开标签（吞到文末）与孤立的闭标签 */
const THINK_RESIDUAL_RE = /<system-reminder>[\s\S]*$|<previous_response>[\s\S]*$|<thinking>[\s\S]*$|`think`[\s\S]*$/g
const THINK_ORPHAN_CLOSE_RE = /<\/(?:system-reminder|previous_response|thinking)>|`\/think`/g

/**
 * 剥离模型思考标签（成对块 + 残标签）。
 * 单一剥离函数两处共用：StreamSession 流式正文（本文件）与 finish 比对基准（bridge.ts），
 * 保证两侧对同一段文本产出一致，finish 比对不因剥离口径漂移而误判。
 */
export function stripThinkingTags(text: string): string {
  return text
    .replace(THINK_BLOCK_RE, "")
    .replace(THINK_RESIDUAL_RE, "")
    .replace(THINK_ORPHAN_CLOSE_RE, "")
}

/** 思考标签开/闭串全集（含反引号风格）；流式尾部疑似未闭合片段按其前缀语言扣留 */
const THINK_TAG_STRINGS = [
  "<system-reminder>",
  "</system-reminder>",
  "<previous_response>",
  "</previous_response>",
  "<thinking>",
  "</thinking>",
  "`think`",
  "`/think`",
] as const

/**
 * text 尾部若是「疑似未闭合的思考标签前缀」片段（如 <thi、`/thi），返回该片段；否则返回 ""。
 * 与 trailingSendFileFragment 同款语义：扣留给后续 delta 补全，避免半截标签闪现。
 */
function trailingThinkingFragment(text: string): string {
  const maxLen = Math.min(text.length, THINK_TAG_STRINGS.reduce((m, s) => Math.max(m, s.length), 0))
  for (let len = maxLen; len >= 1; len--) {
    const tail = text.slice(text.length - len)
    if (THINK_TAG_STRINGS.some((tag) => tail.length < tag.length && tag.startsWith(tail))) return tail
  }
  return ""
}

/**
 * 终片 404「已经提交」= 平台已自动终局该流（终片迟到）：良性。
 * 真机实测占位流终片报 404 {"message":"已经提交的消息内容不可修改"}；流程本就忽略
 * 终片失败，这里只把日志从 error 降级为 log，避免真机日志误报。
 */
function isAlreadySubmittedError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  return status === 404 && err instanceof Error && err.message.includes("已经提交")
}

/** 终片失败日志：404「已经提交」良性降级为 console.log，其余保持 console.error */
function logCloseFailure(label: string, err: unknown): void {
  if (isAlreadySubmittedError(err)) {
    console.log(`[stream] ${label}：流已被平台自动终局（404 已经提交），忽略`)
    return
  }
  console.error(`[stream] ${label}:`, err instanceof Error ? err.message : String(err))
}

export interface StreamSessionOptions {
  token: () => Promise<string> // 惰性取 token（复用 getAccessToken 缓存），勿存字符串
  ctx: MessageContext // 仅 C2C；构造时校验，群聊抛错（双保险，bridge 侧已按 ctx.type 过滤）
  render: (scene: Scene, vars: CopyVars) => string // bridge 传入绑定 config.texts 的 renderCopy
  intervalMs: number // 任意两次 HTTP 发送的最小间隔
  chunkSize: number // 兼容保留（append 时代的正文单片上限；replace 全量模式下不再切分，配置键不动）
  proactive?: boolean // 开流走主动消息通道：整条流省略 msg_id，不占被动预算（缺省 false = 被动锚定，回归兼容）
  fetchImpl?: typeof fetch // 测试注入，缺省 globalThis.fetch
  now?: () => number // 测试注入假时钟，缺省 Date.now
}

export type StreamSessionState = "idle" | "streaming" | "finished" | "aborted" | "failed"

/**
 * 一条 QQ 消息的流式输出会话。
 *
 * 核心语义（对齐官方 SDK @tencent-connect/qqbot-nodejs 的 streaming.ts）：
 * 正文每帧发送「当前累计全文」（input_mode=replace，index 每帧递增），不做 append 增量——
 * deliveredBody 的唯一真理源 = 最后一次成功下发的全量文本（lastAcceptedFull），不存在「部分消费」状态。
 * 40007 前缀约束 ⇒ 场景文案无法原地改写 ⇒ switchScene = 旧流终片(state10) + 另起新流首片；
 * dots 动画因帧序列前缀单调可用 replace。
 * 所有发送经 sendChain 串行并按 intervalMs 节流；任何方法失败不抛给 bridge（内部 catch + 置 state）。
 */
export class StreamSession {
  private readonly opts: StreamSessionOptions
  private readonly now: () => number
  private readonly fetchImpl?: typeof fetch

  private _state: StreamSessionState = "idle"
  private streamMsgId: string | null = null // 当前流的 id（最近一次分片响应 id）
  private nextIndex = 0 // 当前流下一片 index（每条新流重置 0）
  private msgSeq = 0 // 每条新流首片取一次 getNextMsgSeq 并在同流内复用（官方示例同流 msg_seq 恒定）
  private readonly maxStreamOpens: number // 总开流预算：被动 3 / 主动 10（算术见 MAX_STREAM_OPENS_*）
  private streamOpens = 0 // 已开启的流条数（占位 + 正文，openStream 成功时递增；场景消息零开流消耗）
  private bodyBudgetLogged = false // 开流预算用尽的降级日志只打一次（避免逐 delta 刷屏）
  private bodyStreamActive = false
  private rawBody = "" // 当前段正文全量累计（未剥离；剥离在 flush 时对全量重算，无「部分消费」状态）
  private lastAcceptedFull = "" // 最后一次成功下发的全量正文（剥离后基准；deliveredBody 的唯一真理源）
  private lastSentContent = "" // 当前流最后成功下发的全量内容（占位文案或 renderBody 全量；终片 replace 用）
  private activeScene: Scene | null = null
  private dotsFrame = 0
  private dotsTimer: ReturnType<typeof setInterval> | null = null
  private lastSendAt = Number.NEGATIVE_INFINITY // 节流时间戳（首片不等待）
  private finishResult = false
  private sendChain: Promise<void> = Promise.resolve()

  constructor(options: StreamSessionOptions) {
    if (options.ctx.type !== "c2c") {
      throw new Error("群聊不支持流式消息")
    }
    this.opts = options
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetchImpl
    this.maxStreamOpens = options.proactive ? MAX_STREAM_OPENS_PROACTIVE : MAX_STREAM_OPENS_PASSIVE
  }

  /**
   * 本会话分片是否携带 msg_id：主动模式整条流省略（首片无 msg_id 即为主动开流，续片再带
   * msg_id 会让 (msg_id, msg_seq) 对重新出现在线上、可能重新占用被动名额，预算解耦失效），
   * 被动模式保持每片带 msg_id 被动锚定（官方 SDK 语义）。msg_seq 两种模式都保留（官方 SDK
   * 无条件携带）。
   */
  private get shardMsgId(): string | undefined {
    return this.opts.proactive ? undefined : this.opts.ctx.msgId
  }

  get state(): StreamSessionState {
    return this._state
  }

  /** 已成功下发的正文（= 最后一次成功下发的全量文本，剥离标记/思考标签后） */
  get deliveredBody(): string {
    return this.lastAcceptedFull
  }

  /** WAITING 首片：index0/replace/state1（被动模式 msg_id 锚定，主动模式省略）；失败置 state=failed */
  async start(): Promise<void> {
    if (this._state !== "idle") return
    try {
      await this.enqueue(async () => {
        if (this._state !== "idle") return
        const content = this.opts.render("WAITING", { dots: DOTS_FRAMES[0] })
        await this.openStream(content)
        this._state = "streaming"
        this.activeScene = "WAITING"
        this.dotsFrame = 0
        this.startDotsTimer()
      })
    } catch (err) {
      console.error("[stream] 流式首片发送失败，本轮回退非流式:", err instanceof Error ? err.message : String(err))
      this.markFailed()
    }
  }

  /**
   * 场景切换：场景消息一律走主动消息（sendSceneProactive），永不开流。
   * - 开流名额只留给 WAITING 占位（start() 开的那条）与正文流（含 TEXT 重置再开），
   *   预算算术 = 占位① + 正文② + 重置③ = 3（真机教训：工具密集回合里场景流抢光
   *   正文流名额，第二段正文 TEXT 重置时预算已尽，收尾被迫走全量兜底）。
   * - 正文流进行中：TEXT 场景 = 新一段正文（关闭当前正文流，下段另起，不重复发摘要）；
   *   其余场景走主动消息，不打断正文流。
   * - WAITING 理论上只在 start() 出现；防御性同样走主动消息（不重开占位流——
   *   dots 动画仍属 start() 的流，重开反而多耗一个开流名额）。
   * - 场景消息受主动消息 20/qpm 频控与 bridge 侧 PROGRESS_* 门控约束。
   */
  async switchScene(scene: Scene, vars: CopyVars): Promise<void> {
    if (this._state !== "streaming") return
    this.stopDotsTimer()
    await this.enqueue(async () => {
      if (this._state !== "streaming") return

      if (this.bodyStreamActive) {
        if (scene === "TEXT") {
          // 上一段正文已流式展示：以终片（全量+state10）关闭，下一段 pushBody 另起新正文流
          await this.flushBody(true)
          if (this._state !== "streaming") return
          this.bodyStreamActive = false
          this.lastAcceptedFull = ""
          this.rawBody = ""
          this.streamMsgId = null // 正文流已以终片关闭，避免对已关闭的流再发终片
          this.nextIndex = 0
          return
        }
        await this.sendSceneProactive(scene, vars)
        return
      }

      // 无论 bodyStreamActive 与否、无论预算：非正文场景零开流消耗，直接走主动消息
      await this.sendSceneProactive(scene, vars)
    })
  }

  /**
   * 正文增量：累计进全量缓冲，节流窗口到了且文本有变化就以 replace+全量分片下发
   * （官方语义，无增量字符门槛；开流仍需满 MIN_FLUSH_CHARS）。
   * [[sendfile:...]] 标记与思考标签在 flush 时对全量文本统一剥离：完整标记/标签块直接删掉；
   * 尾部疑似未闭合的片段扣留给后续 delta 补全，避免半截标记/标签闪现（文件由 bridge 的
   * deliverResult 单独发送，不走流式正文）。
   */
  async pushBody(delta: string): Promise<void> {
    if (this._state !== "streaming") return
    if (!delta) return
    this.stopDotsTimer()
    this.rawBody += delta
    await this.enqueue(() => this.flushBody(false))
  }

  /**
   * 收尾：冲刷剩余正文并以终片(state10)结束。
   * 返回 deliveredBody 与 finalText（trim 后）是否一致；不一致时 bridge 走全量回退。
   */
  async finish(finalText: string): Promise<boolean> {
    if (this._state === "finished") return this.finishResult
    if (this._state !== "streaming") return false
    this.stopDotsTimer()
    await this.enqueue(async () => {
      if (this._state === "finished") return
      if (this._state !== "streaming") {
        this._state = "finished"
        this.finishResult = false
        return
      }
      if (this.bodyStreamActive) {
        await this.flushBody(true)
        this.finishResult =
          this._state === "streaming" && this.lastAcceptedFull.trim() === finalText.trim()
      } else {
        // 正文流从未开启：关闭占位流；仅当最终文本为空才算已投递
        if (this.streamMsgId) {
          try {
            await this.closeStream()
          } catch (err) {
            logCloseFailure("占位流终片失败（忽略）", err)
          }
        }
        this.finishResult = finalText.trim() === ""
      }
      if (this._state === "streaming") this._state = "finished"
    })
    return this.finishResult
  }

  /** 停发一切请求（在途请求自然完成），不发终片 */
  async abort(): Promise<void> {
    this.stopDotsTimer()
    this._state = "aborted"
    await this.sendChain
  }

  /** 弃流 → replyToQQ 全量回退（被动回复） */
  async fallbackToReply(text: string): Promise<void> {
    this.stopDotsTimer()
    this._state = "aborted"
    const token = await this.opts.token()
    await replyToQQ(token, this.opts.ctx, text)
  }

  // ---- 内部：发送管道 ----------------------------------------------------

  /** 串行化所有发送；链上任务失败不传染 */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.sendChain.then(task)
    this.sendChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /** 任意两次 HTTP 发送的最小间隔（用注入时钟计算等待时长） */
  private async throttle(): Promise<void> {
    const wait = this.opts.intervalMs - (this.now() - this.lastSendAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastSendAt = this.now()
  }

  /**
   * 频控指数退避（官方基数 1000ms：1000/2000/4000）。
   * 从上一次发送起算补足等待时长（注入时钟步进 ≥ 4000 可在测试中归零真实等待）。
   */
  private async backoff(retry: number): Promise<void> {
    const delay = RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (retry - 1)
    const wait = delay - (this.now() - this.lastSendAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }

  private async sendShard(shard: StreamShard): Promise<StreamShardResponse> {
    if (this._state === "finished" || this._state === "aborted" || this._state === "failed") {
      throw new Error(`[stream] session ${this._state}，拒绝发送分片`)
    }
    await this.throttle()
    const token = await this.opts.token()
    return sendStreamMessage(token, this.opts.ctx.userId, shard, this.fetchImpl)
  }

  /** 总开流预算是否已用尽（占位+正文合并核算，算术见 MAX_STREAM_OPENS_*） */
  private streamOpensExhausted(): boolean {
    return this.streamOpens >= this.maxStreamOpens
  }

  /**
   * 另起新流：首片 replace/state1/index0；被动模式带 msg_id 被动锚定，主动模式省略 msg_id
   * （走主动消息通道，不占被动预算）；msg_seq 两种模式都携带且本流内复用。
   * 频控（50002/HTTP 429）按官方策略重试：最多 3 次、指数退避。首片重试保持 index0
   * （msg_id+msg_seq 去重锚定；index>0 需要 stream_msg_id，而失败响应不携带）。
   */
  private async openStream(content: string): Promise<void> {
    this.msgSeq = getNextMsgSeq(this.opts.ctx.msgId)
    this.nextIndex = 0
    for (let retry = 0; ; retry++) {
      try {
        const res = await this.sendShard({
          content,
          index: 0,
          inputMode: "replace",
          inputState: 1,
          contentType: STREAM_CONTENT_TYPE,
          msgId: this.shardMsgId,
          msgSeq: this.msgSeq,
        })
        this.streamMsgId = res.id
        this.nextIndex = 1
        this.lastSentContent = content
        this.streamOpens++ // 开流名额在此统一核算（占位/正文共用；场景消息不经此路径）
        return
      } catch (err) {
        if (classifyStreamError(err) === "rate-limited" && retry < RATE_LIMIT_RETRIES) {
          await this.backoff(retry + 1)
          continue
        }
        throw err
      }
    }
  }

  /**
   * 旧流终片：官方 streaming.ts 的 close 形状 = replace + 该流最后成功下发的全量内容 + state10
   * （真机实测 append+空内容报 404「已经提交的消息内容不可修改」）。内容与已下发一致，幂等不改写。
   */
  private async closeStream(): Promise<void> {
    if (!this.streamMsgId) return
    await this.sendShard({
      content: this.lastSentContent,
      index: this.nextIndex,
      inputMode: "replace",
      inputState: 10,
      contentType: STREAM_CONTENT_TYPE,
      streamMsgId: this.streamMsgId,
      msgId: this.shardMsgId,
      msgSeq: this.msgSeq,
    })
    this.streamMsgId = null
    this.nextIndex = 0
  }

  /**
   * 正文分片：replace + 当前累计全文（官方语义：update() 携带全文而非增量）。
   * 频控重试对齐官方：最多 3 次、指数退避，且重试时 index 前进
   * （官方注释：Advance index for the retry to avoid stale index conflict）。
   * 重试全部失败向上抛，由 flushBody 决定跳帧或终局。
   */
  private async sendBodyFrame(sendable: string, state: 1 | 10): Promise<void> {
    if (!this.streamMsgId) throw new Error("[stream] 正文分片无活动流")
    const rendered = this.renderBody(sendable)
    for (let retry = 0; ; retry++) {
      const index = this.nextIndex
      try {
        const res = await this.sendShard({
          content: rendered,
          index,
          inputMode: "replace",
          inputState: state,
          contentType: STREAM_CONTENT_TYPE,
          streamMsgId: this.streamMsgId,
          msgId: this.shardMsgId,
          msgSeq: this.msgSeq,
        })
        this.streamMsgId = res.id
        this.nextIndex = index + 1
        this.lastAcceptedFull = sendable
        this.lastSentContent = rendered
        return
      } catch (err) {
        const kind = classifyStreamError(err)
        if (kind === "prefix-conflict") throw err // 由 flushBody 统一走冲突终局
        if (kind === "rate-limited") {
          // 官方注释：Advance index for the retry to avoid stale index conflict
          // （含耗尽的最后一次失败也推进，下一帧绝不复用已尝试过的 index）
          this.nextIndex = index + 1
          if (retry < RATE_LIMIT_RETRIES) {
            await this.backoff(retry + 1)
            continue
          }
          throw err
        }
        throw err
      }
    }
  }

  /**
   * 前缀冲突终局（官方 streaming-controller 的 prefixMatches 检查 + transition('failed') 同款）：
   * 新全量文本不是已下发文本的前缀延伸（模型改写了已下发内容，或服务端 40007）——
   * 以不改写内容的安全终片结束当前流并置 state=failed，交由 bridge 全量兜底（finish 返回 false）。
   */
  private async endStreamAsFailed(): Promise<void> {
    if (this.streamMsgId) {
      try {
        await this.closeStream()
      } catch (err) {
        logCloseFailure("冲突终片失败（忽略）", err)
      }
    }
    this.markFailed()
  }

  private renderBody(text: string): string {
    return this.opts.render("BODY", { body: text })
  }

  /** 场景文案一律走普通主动消息（零开流消耗；受主动消息 20/qpm 与 PROGRESS_* 门控约束） */
  private async sendSceneProactive(scene: Scene, vars: CopyVars): Promise<void> {
    try {
      await this.throttle()
      const token = await this.opts.token()
      await sendProactiveToQQ(token, this.opts.ctx, this.opts.render(scene, vars))
    } catch (err) {
      console.error("[stream] 场景文案主动发送失败（忽略）:", err instanceof Error ? err.message : String(err))
    }
  }

  private markFailed(): void {
    this.stopDotsTimer()
    this._state = "failed"
  }

  // ---- 内部：正文冲刷 ----------------------------------------------------

  /**
   * 冲刷正文：对全量累计重算「可下发文本」，按需发 replace+全量帧。
   * 可下发文本 = 剥完整 sendfile 标记 → 剥思考标签（成对块+残标签）→ 扣留尾部疑似未闭合片段
   * （sendfile 残片终刷时丢弃；思考标签残片终刷时放行——与官方完整文本 sanitize 口径一致，
   * 避免正文以反引号/`<` 结尾时无谓回退）。
   */
  private async flushBody(final: boolean): Promise<void> {
    if (this._state !== "streaming") return
    const stripped = stripThinkingTags(this.rawBody.replace(SEND_FILE_MARKER_RE, ""))
    let sendable = stripped
    const markerTail = trailingSendFileFragment(stripped)
    if (markerTail) sendable = sendable.slice(0, sendable.length - markerTail.length)
    if (!final) {
      const tagTail = trailingThinkingFragment(sendable)
      if (tagTail) sendable = sendable.slice(0, sendable.length - tagTail.length)
    }

    if (!this.bodyStreamActive) {
      // 开流门槛：仅非终刷且满 MIN_FLUSH_CHARS 才开正文流（终刷从不开流——未开流的收尾走占位流关闭+空比对）
      if (final || !sendable || sendable.length < MIN_FLUSH_CHARS) return
      if (this.streamOpensExhausted()) {
        // 总开流预算用尽：不再开新正文流（占位流保持原样，由 finish 收尾关闭），正文只缓冲；
        // finish 比对必然失败 → bridge 走 fallbackToReply 全量兜底（被动名额已预留），内容不丢
        if (!this.bodyBudgetLogged) {
          this.bodyBudgetLogged = true
          console.error(`[stream] 开流预算用尽（占位+正文 ≥ ${this.maxStreamOpens}），正文仅缓冲，收尾走全量兜底`)
        }
        return
      }
      if (this.streamMsgId) {
        try {
          await this.closeStream()
        } catch (err) {
          logCloseFailure("占位流终片失败（忽略）", err)
        }
      }
      try {
        await this.openStream(this.renderBody(sendable))
      } catch (err) {
        if (classifyStreamError(err) === "rate-limited") {
          // 开流频控重试耗尽：本轮跳过（占位流已关，下轮 flush 重新开流），会话保持
          console.error("[stream] 正文流首片频控重试耗尽，本轮跳过（finish 比对失败将回退全量）")
          return
        }
        console.error("[stream] 正文流首片失败:", err instanceof Error ? err.message : String(err))
        this.markFailed()
        return
      }
      this.bodyStreamActive = true
      this.activeScene = "BODY"
      this.lastAcceptedFull = sendable
      return
    }

    if (sendable === this.lastAcceptedFull) {
      if (!final) return
      // 无新增内容也要补 DONE 帧（replace+全量+state10，内容幂等）
      try {
        await this.sendBodyFrame(sendable, 10)
      } catch (err) {
        console.error("[stream] 终片失败:", err instanceof Error ? err.message : String(err))
        this.markFailed()
      }
      return
    }

    if (!sendable.startsWith(this.lastAcceptedFull)) {
      // 官方 prefixMatches 检查：模型改写了已下发文本 → 冲突终局
      console.error("[stream] 新全量文本不是已下发文本的前缀延伸，结束流并回退全量")
      await this.endStreamAsFailed()
      return
    }

    try {
      await this.sendBodyFrame(sendable, final ? 10 : 1)
    } catch (err) {
      if (classifyStreamError(err) === "prefix-conflict") {
        await this.endStreamAsFailed()
        return
      }
      if (final || classifyStreamError(err) !== "rate-limited") {
        console.error("[stream] 正文分片失败:", err instanceof Error ? err.message : String(err))
        this.markFailed()
        return
      }
      // 频控重试耗尽：跳过该帧，lastAcceptedFull 不推进（不丢内容：finish 比对失败 → 回退全量；
      // replace 全量语义下后续任一成功帧即自愈补齐全部欠账）
      console.error("[stream] 正文分片频控重试耗尽，跳过该帧（内容不丢：finish 比对失败将回退全量）")
    }
  }

  // ---- 内部：等待动画 ----------------------------------------------------

  private startDotsTimer(): void {
    this.stopDotsTimer()
    this.dotsTimer = setInterval(() => {
      if (
        this._state !== "streaming" ||
        this.activeScene !== "WAITING" ||
        this.bodyStreamActive ||
        this.rawBody !== ""
      ) {
        return
      }
      this.dotsFrame = Math.min(this.dotsFrame + 1, DOTS_FRAMES.length - 1)
      const frame = DOTS_FRAMES[this.dotsFrame]
      void this.enqueue(async () => {
        if (
          this._state !== "streaming" ||
          this.activeScene !== "WAITING" ||
          this.bodyStreamActive ||
          this.rawBody !== "" ||
          !this.streamMsgId
        ) {
          return
        }
        try {
          const frameContent = this.opts.render("WAITING", { dots: frame })
          const res = await this.sendShard({
            content: frameContent,
            index: this.nextIndex,
            inputMode: "replace",
            inputState: 1,
            contentType: STREAM_CONTENT_TYPE,
            streamMsgId: this.streamMsgId,
            msgId: this.shardMsgId,
            msgSeq: this.msgSeq,
          })
          this.streamMsgId = res.id
          this.nextIndex++
          this.lastSentContent = frameContent
        } catch (err) {
          console.error("[stream] 等待动画帧发送失败（忽略）:", err instanceof Error ? err.message : String(err))
        }
      })
    }, this.opts.intervalMs)
    this.dotsTimer.unref?.()
  }

  private stopDotsTimer(): void {
    if (this.dotsTimer) {
      clearInterval(this.dotsTimer)
      this.dotsTimer = null
    }
  }
}
