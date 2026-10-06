// @input:  (none - raw HTTP to QQ Bot REST API)
// @output: getAccessToken, apiRequest, QQApiError, sendStreamMessage, classifyStreamError, sendC2CMessage, sendGroupMessage, getGatewayUrl, startBackgroundTokenRefresh, uploadC2CFile/uploadGroupFile, uploadPrepareC2C/uploadPrepareGroup, uploadPartFinishC2C/uploadPartFinishGroup, putPresigned
// @pos:    qq层 - QQ Bot REST API 鉴权+请求封装 (Token singleflight + 后台刷新)

const API_BASE = "https://api.sgroup.qq.com"
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"

let cachedToken: { token: string; expiresAt: number; appId: string } | null = null
// Singleflight：防止并发获取 Token 时重复请求
let tokenFetchPromise: Promise<string> | null = null

/**
 * 获取 AccessToken，内置缓存与 singleflight 并发保护。
 * 当多个请求同时发现 Token 过期时，只会发起一次真实刷新请求。
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000 && cachedToken.appId === appId) {
    return cachedToken.token
  }

  if (cachedToken && cachedToken.appId !== appId) {
    console.log(`[qqbot-api] appId changed (${cachedToken.appId} → ${appId}), clearing token cache`)
    cachedToken = null
    tokenFetchPromise = null
  }

  if (tokenFetchPromise) {
    console.log("[qqbot-api] Token fetch in progress, waiting for existing request...")
    return tokenFetchPromise
  }

  tokenFetchPromise = (async () => {
    try {
      return await doFetchToken(appId, clientSecret)
    } finally {
      tokenFetchPromise = null
    }
  })()

  return tokenFetchPromise
}

/**
 * 真正执行 Token 获取的内部函数。
 */
async function doFetchToken(appId: string, clientSecret: string): Promise<string> {
  const requestBody = { appId, clientSecret }
  const requestHeaders = { "Content-Type": "application/json" }

  console.log(`[qqbot-api] >>> POST ${TOKEN_URL}`)
  console.log("[qqbot-api] >>> Headers:", JSON.stringify(requestHeaders, null, 2))
  console.log("[qqbot-api] >>> Body:", JSON.stringify({ appId, clientSecret: "***" }, null, 2))

  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
    })
  } catch (err) {
    console.error("[qqbot-api] <<< Network error:", err)
    throw new Error(`Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`)
  }

  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  console.log(`[qqbot-api] <<< Status: ${response.status} ${response.statusText}`)
  console.log("[qqbot-api] <<< Headers:", JSON.stringify(responseHeaders, null, 2))

  let data: { access_token?: string; expires_in?: number }
  let rawBody: string
  try {
    rawBody = await response.text()
    const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"')
    console.log("[qqbot-api] <<< Body:", logBody)
    data = JSON.parse(rawBody) as { access_token?: string; expires_in?: number }
  } catch (err) {
    console.error("[qqbot-api] <<< Parse error:", err)
    throw new Error(`Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!data.access_token) {
    throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`)
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    appId,
  }

  console.log(`[qqbot-api] Token cached for appId=${appId}, expires at: ${new Date(cachedToken.expiresAt).toISOString()}`)
  return cachedToken.token
}

/**
 * 清空当前 Token 缓存。
 * 不会中断已经在进行中的刷新请求。
 */
export function clearTokenCache(): void {
  cachedToken = null
}

/**
 * 获取当前 Token 缓存状态，便于监控或启动阶段打印状态。
 */
export function getTokenStatus(): { status: "valid" | "expired" | "refreshing" | "none"; expiresAt: number | null } {
  if (tokenFetchPromise) {
    return { status: "refreshing", expiresAt: cachedToken?.expiresAt ?? null }
  }
  if (!cachedToken) {
    return { status: "none", expiresAt: null }
  }
  const isValid = Date.now() < cachedToken.expiresAt - 5 * 60 * 1000
  return { status: isValid ? "valid" : "expired", expiresAt: cachedToken.expiresAt }
}

/**
 * 生成消息序号，范围固定为 0~65535。
 * 用时间戳低位与随机数混合，避免进程内碰撞。
 */
export function getNextMsgSeq(_msgId: string): number {
  const timePart = Date.now() % 100000000
  const random = Math.floor(Math.random() * 65536)
  return (timePart ^ random) % 65536
}

const DEFAULT_API_TIMEOUT = 30000
const FILE_UPLOAD_TIMEOUT = 120000

/**
 * 结构化 API 错误：携带 HTTP 状态码与 QQ 业务码（响应体 code 字段，如 40007/50001/50002），
 * 供流式回退决策。message 格式与原 plain Error 完全一致，现有 catch 只读 message，零回归。
 */
export class QQApiError extends Error {
  readonly status: number
  readonly code?: number
  readonly path: string
  readonly body: unknown

  constructor(status: number, path: string, body: unknown, message: string) {
    super(message)
    this.name = "QQApiError"
    this.status = status
    this.path = path
    this.body = body
    const rawCode = (typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).code
      : undefined)
    this.code = typeof rawCode === "number" ? rawCode : undefined
  }
}

/**
 * 统一封装 QQ Bot REST 请求。
 * 保留源实现的超时、日志、错误处理和 JSON 解析行为。
 * fetchImpl 仅供测试注入（StreamSession 透传），缺省用全局 fetch。
 */
export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
  fetchImpl?: typeof fetch,
): Promise<T> {
  const url = `${API_BASE}${path}`
  const headers: Record<string, string> = {
    Authorization: `QQBot ${accessToken}`,
    "Content-Type": "application/json",
  }

  const isFileUpload = path.includes("/files")
  const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, timeout)

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  console.log(`[qqbot-api] >>> ${method} ${url} (timeout: ${timeout}ms)`)
  console.log("[qqbot-api] >>> Headers:", JSON.stringify(headers, null, 2))
  if (body) {
    const logBody = { ...(body as Record<string, unknown>) }
    if (typeof logBody.file_data === "string") {
      logBody.file_data = `<base64 ${logBody.file_data.length} chars>`
    }
    console.log("[qqbot-api] >>> Body:", JSON.stringify(logBody, null, 2))
  }

  let res: Response
  try {
    res = await (fetchImpl ?? fetch)(url, options)
  } catch (err) {
    clearTimeout(timeoutId)
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[qqbot-api] <<< Request timeout after ${timeout}ms`)
      throw new Error(`Request timeout [${path}]: exceeded ${timeout}ms`)
    }
    console.error("[qqbot-api] <<< Network error:", err)
    throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timeoutId)
  }

  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  console.log(`[qqbot-api] <<< Status: ${res.status} ${res.statusText}`)
  console.log("[qqbot-api] <<< Headers:", JSON.stringify(responseHeaders, null, 2))

  let data: T
  let rawBody = ""
  try {
    rawBody = await res.text()
    console.log("[qqbot-api] <<< Body:", sanitizeResponseBodyLog(rawBody))
    data = JSON.parse(rawBody) as T
  } catch (err) {
    // 非 JSON 错误体（如网关 413 的 HTML）：保留状态码与原文，别退化成 "parse failed" 把根因藏掉
    if (!res.ok) {
      console.error(`[qqbot-api] <<< Non-JSON error body, status=${res.status}`)
      throw new QQApiError(
        res.status,
        path,
        rawBody,
        `API Error [${path}]: HTTP ${res.status} ${res.statusText}: ${rawBody.slice(0, 300)}`,
      )
    }
    console.error("[qqbot-api] <<< Parse error:", err)
    throw new Error(`Failed to parse response [${path}]: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!res.ok) {
    const error = data as { message?: string; code?: number }
    throw new QQApiError(res.status, path, data, `API Error [${path}]: ${error.message ?? JSON.stringify(data)}`)
  }

  return data
}

/** 流式消息分片（C2C stream_messages） */
export interface StreamShard {
  content: string // content_raw
  index: number // 从 0 递增（每条流独立计数）
  inputMode: "append" | "replace"
  inputState: 1 | 10 // 1=生成中 10=结束
  contentType?: "text" | "markdown" // 缺省 "text"；调用方（sender）按 MARKDOWN 开关传 markdown/text
  streamMsgId?: string // index>0 时必填（=首片响应 id）
  msgId?: string // 首片被动锚定
  eventId?: string
  msgSeq?: number // 去重；缺省由 api 层 getNextMsgSeq(msgId) 生成
}

export interface StreamShardResponse {
  id: string // 即后续分片的 stream_msg_id
  timestamp: number | string
  ext_info?: Record<string, unknown>
  remain_msg_len?: number
}

/**
 * 发送 C2C 流式消息分片：POST /v2/users/{openid}/stream_messages。
 * 鉴权沿用现有 apiRequest 的 QQBot 方案；失败抛 QQApiError（与 api.ts 全体抛错风格一致）。
 */
export async function sendStreamMessage(
  accessToken: string,
  openid: string,
  shard: StreamShard,
  fetchImpl?: typeof fetch,
): Promise<StreamShardResponse> {
  const body: Record<string, unknown> = {
    content_raw: shard.content,
    input_mode: shard.inputMode,
    input_state: shard.inputState,
    index: shard.index,
    content_type: shard.contentType ?? "text",
    msg_seq: shard.msgSeq ?? 1,
  }
  if (shard.streamMsgId) body.stream_msg_id = shard.streamMsgId
  if (shard.msgId) body.msg_id = shard.msgId
  if (shard.eventId) body.event_id = shard.eventId
  return apiRequest<StreamShardResponse>(accessToken, "POST", `/v2/users/${openid}/stream_messages`, body, undefined, fetchImpl)
}

/** 流式错误分类：40007→前缀冲突；50002/HTTP 429→频控；50001→服务端错误；其他 QQApiError→http；网络/超时→network */
export type StreamErrorKind =
  | "prefix-conflict"
  | "rate-limited"
  | "server-error"
  | "http"
  | "network"
  | "unknown"

export function classifyStreamError(err: unknown): StreamErrorKind {
  if (err instanceof QQApiError) {
    if (err.code === 40007) return "prefix-conflict"
    if (err.code === 50002 || err.status === 429) return "rate-limited"
    if (err.code === 50001) return "server-error"
    return "http"
  }
  if (err instanceof Error) {
    if (err.message.startsWith("Network error") || err.message.startsWith("Request timeout")) {
      return "network"
    }
  }
  return "unknown"
}

/**
 * 获取 WebSocket Gateway 地址。
 */
export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, "GET", "/gateway")
  return data.url
}

/**
 * QQ 发消息成功后的通用响应结构。
 */
export interface MessageResponse {
  id: string
  timestamp: number | string
}

/**
 * 构建普通文本消息体。
 * 这里固定使用纯文本消息，不再保留 markdown 模式切换。
 */
function buildMessageBody(
  content: string,
  msgId: string | undefined,
  msgSeq: number,
  markdown: boolean = false,
): Record<string, unknown> {
  const body: Record<string, unknown> = markdown
    ? { msg_type: 2, markdown: { content }, msg_seq: msgSeq }
    : { content, msg_type: 0, msg_seq: msgSeq }

  if (msgId) {
    body.msg_id = msgId
  }

  return body
}

/**
 * 发送 C2C 单聊文本消息。
 * msgSeq 可选，传入时优先使用，便于上层做分片发送。
 * markdown=true 时使用 QQ 原生 markdown（msg_type=2）。
 */
export async function sendC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string,
  msgSeq?: number,
  markdown: boolean = false,
): Promise<MessageResponse> {
  const resolvedMsgSeq = msgSeq ?? (msgId ? getNextMsgSeq(msgId) : 1)
  const body = buildMessageBody(content, msgId, resolvedMsgSeq, markdown)
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body)
}

/**
 * 发送 C2C 输入状态提示，告诉用户机器人正在输入。
 * msgId 可选：省略时不占被动回复预算（带上 msg_id 会按被动回复计费，挤占流式开流额度）。
 */
export async function sendC2CInputNotify(
  accessToken: string,
  openid: string,
  msgId?: string,
  inputSecond: number = 60,
): Promise<void> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1
  const body = {
    msg_type: 6,
    input_notify: {
      input_type: 1,
      input_second: inputSecond,
    },
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  }

  await apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body)
}

/**
 * 发送群聊文本消息。
 * msgSeq 可选，传入时优先使用，便于上层做分片发送。
 */
export async function sendGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string,
  msgId?: string,
  msgSeq?: number,
  markdown: boolean = false,
): Promise<MessageResponse> {
  const resolvedMsgSeq = msgSeq ?? (msgId ? getNextMsgSeq(msgId) : 1)
  const body = buildMessageBody(content, msgId, resolvedMsgSeq, markdown)
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body)
}

/** 富媒体文件类型：1=图片 2=视频 3=语音 4=文件 */
export interface MediaUploadOptions {
  fileType: number
  fileData?: string
  url?: string
  fileName?: string
  /** 官方分片上传的合并凭据：传入即走「服务端合并」路径（url 可为空） */
  uploadId?: string
}

export interface MediaUploadResponse {
  file_uuid?: string
  file_info?: string
  ttl?: number
}

async function uploadFile(
  accessToken: string,
  path: string,
  options: MediaUploadOptions,
): Promise<string> {
  const body: Record<string, unknown> = { file_type: options.fileType, srv_send_msg: false }
  if (options.fileName) body.file_name = options.fileName
  if (options.url) body.url = options.url
  if (options.fileData) body.file_data = options.fileData
  if (options.uploadId) body.upload_id = options.uploadId
  const data = await apiRequest<MediaUploadResponse>(accessToken, "POST", path, body)
  if (!data.file_info) {
    throw new Error(`文件上传失败: ${JSON.stringify(data)}`)
  }
  return data.file_info
}

/** 上传富媒体文件（C2C），返回 file_info，用于随后发送 msg_type=7 的消息 */
export function uploadC2CFile(accessToken: string, openid: string, options: MediaUploadOptions): Promise<string> {
  return uploadFile(accessToken, `/v2/users/${openid}/files`, options)
}

/** 上传富媒体文件（群聊），返回 file_info */
export function uploadGroupFile(accessToken: string, groupOpenid: string, options: MediaUploadOptions): Promise<string> {
  return uploadFile(accessToken, `/v2/groups/${groupOpenid}/files`, options)
}

// ---------------------------------------------------------------------------
// 官方分片上传（大文件通道，2026-09 文档「推荐使用分片上传」）
//
// 三步：upload_prepare 换预签名 URL → 逐片 PUT 直传对象存储 → upload_part_finish 登记 →
// POST /files 传 upload_id 让服务端合并。合并后收件人收到**一个**文件，不产生 .001/.002 多片，
// 也不像 base64 内联那样被 api 网关 413（分片 PUT 不过网关）。
// 场景隔离：单聊与群聊的上传/预上传端点互相独立，预上传、分片、合并必须同场景。
// ---------------------------------------------------------------------------

/** 预签名分片描述（官方契约：index 从 0 起；block_size 是**字节数字的字符串**） */
export interface UploadPreparePart {
  index: number
  presigned_url: string
  block_size: string
}

export interface UploadPrepareResponse {
  upload_id: string
  block_size: string
  parts: UploadPreparePart[]
  /** 默认 concurrency=1（串行）、retry_timeout=300s、retry_delay=1s；本实现按串行 + 调用方节流 */
  upload_config?: {
    concurrency?: number
    retry_timeout?: number
    retry_delay?: number
  }
}

/** upload_prepare 请求体（官方契约：file_size 是 string，不是 number） */
export interface PrepareOptions {
  fileType: number
  fileSize: string
  fileName: string
  /** 整文件 MD5 */
  md5: string
  /** 整文件 SHA1 */
  sha1: string
  /** 前 10002432 字节的 MD5（官方 md5_10m 口径） */
  md5_10m: string
}

/** upload_part_finish 请求体（md5 为**该分片**内容的 MD5） */
export interface PartFinishOptions {
  uploadId: string
  partIndex: number
  blockSize: string
  md5: string
}

function buildPrepareBody(options: PrepareOptions): Record<string, unknown> {
  return {
    file_type: options.fileType,
    file_size: String(options.fileSize),
    file_name: options.fileName,
    md5: options.md5,
    sha1: options.sha1,
    md5_10m: options.md5_10m,
  }
}

async function uploadPrepare(
  accessToken: string,
  path: string,
  options: PrepareOptions,
): Promise<UploadPrepareResponse> {
  const data = await apiRequest<UploadPrepareResponse>(accessToken, "POST", path, buildPrepareBody(options))
  if (!data.upload_id) {
    throw new Error(`upload_prepare 未返回 upload_id: ${JSON.stringify(data)}`)
  }
  return data
}

/** 预上传分片（C2C）：POST /v2/users/{openid}/upload_prepare，限 10 QPS */
export function uploadPrepareC2C(
  accessToken: string,
  openid: string,
  options: PrepareOptions,
): Promise<UploadPrepareResponse> {
  return uploadPrepare(accessToken, `/v2/users/${openid}/upload_prepare`, options)
}

/** 预上传分片（群聊）：POST /v2/groups/{group_openid}/upload_prepare，限 10 QPS */
export function uploadPrepareGroup(
  accessToken: string,
  groupOpenid: string,
  options: PrepareOptions,
): Promise<UploadPrepareResponse> {
  return uploadPrepare(accessToken, `/v2/groups/${groupOpenid}/upload_prepare`, options)
}

async function uploadPartFinish(
  accessToken: string,
  path: string,
  options: PartFinishOptions,
): Promise<void> {
  await apiRequest(accessToken, "POST", path, {
    upload_id: options.uploadId,
    part_index: options.partIndex,
    block_size: String(options.blockSize),
    md5: options.md5,
  })
}

/** 登记单个分片已上传（C2C）：POST /v2/users/{openid}/upload_part_finish，限 10 QPS */
export function uploadPartFinishC2C(accessToken: string, openid: string, options: PartFinishOptions): Promise<void> {
  return uploadPartFinish(accessToken, `/v2/users/${openid}/upload_part_finish`, options)
}

/** 登记单个分片已上传（群聊）：POST /v2/groups/{group_openid}/upload_part_finish，限 10 QPS */
export function uploadPartFinishGroup(
  accessToken: string,
  groupOpenid: string,
  options: PartFinishOptions,
): Promise<void> {
  return uploadPartFinish(accessToken, `/v2/groups/${groupOpenid}/upload_part_finish`, options)
}

/** 官方「文件上传失败，请重试」：大文件分片上传中 BDH 通道异常，属于可重试 */
const RETRYABLE_UPLOAD_CODE = 40093001
/** 分片直传的宽松超时（单片默认 5MB，慢网络也要留余量） */
const PRESIGNED_UPLOAD_TIMEOUT = 120000
const PRESIGNED_RETRY_ATTEMPTS = 3

/**
 * 预签名 URL 的展示净化：只保留 pathname，丢弃 query/fragment（签名在 query 里，TTL 内等于
 * 「可重复 PUT 该分片」的能力令牌，不得写进错误与日志）；pathname 保留分片标识，仍能看出是哪一片。
 * 仅用于展示/日志，实际请求仍用完整 URL。
 */
export function sanitizePresignedUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname + (u.search || u.hash ? "?<已省略>" : "")
  } catch {
    return url
  }
}

/**
 * 响应体日志净化：递归把 presigned_url 字段替换为 sanitizePresignedUrl 的展示值
 * （保留 pathname 与 upload_id/block_size/parts 等排障字段，丢弃 query 里的签名）。
 * 仅作用于日志字符串，绝不改动返回给调用方的 data。
 */
export function sanitizeResponseBodyLog(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw // 非 JSON 体（如网关 HTML）：原样展示，签名不会出现在这类响应里
  }
  return JSON.stringify(sanitizeLogBody(parsed))
}

function sanitizeLogBody(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeLogBody)
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === "presigned_url" && typeof val === "string" ? sanitizePresignedUrl(val) : sanitizeLogBody(val)
    }
    return out
  }
  return value
}

/**
 * 直连预签名 URL 的分片 PUT：**不带 Authorization**（签名在 URL 里），也不走 apiRequest
 * （既不过 api 网关 → 不再撞 413，也不限 10 QPS 的预上传端点）。
 * 仅对网络错误 / 429 / 5xx / 40093001 重试（退避 1s、2s）；其它 4xx（含 850031、40093002）直接抛。
 */
export async function putPresigned(url: string, data: Buffer): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= PRESIGNED_RETRY_ATTEMPTS; attempt++) {
    try {
      await putPresignedOnce(url, data)
      return
    } catch (error) {
      lastError = error
      const status = error instanceof QQApiError ? error.status : 0
      const code = error instanceof QQApiError ? error.code : undefined
      const retryable = status === 0 || status === 429 || status >= 500 || code === RETRYABLE_UPLOAD_CODE
      if (!retryable || attempt === PRESIGNED_RETRY_ATTEMPTS) break
      console.warn(
        `[qqbot-api] 分片 PUT 失败（状态 ${status}${code !== undefined ? ` code=${code}` : ""}），` +
        `${attempt}/${PRESIGNED_RETRY_ATTEMPTS - 1} 次重试…`,
      )
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
  throw lastError
}

async function putPresignedOnce(url: string, data: Buffer): Promise<void> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), PRESIGNED_UPLOAD_TIMEOUT)
  const displayUrl = sanitizePresignedUrl(url)
  console.log(`[qqbot-api] >>> PUT ${displayUrl} (${data.length} bytes, timeout: ${PRESIGNED_UPLOAD_TIMEOUT}ms)`)
  let res: Response
  try {
    res = await globalThis.fetch(url, { method: "PUT", body: data, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`分片 PUT 超时 [${displayUrl}]: 超过 ${PRESIGNED_UPLOAD_TIMEOUT}ms`)
    }
    throw new Error(`分片 PUT 网络错误 [${displayUrl}]: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timeoutId)
  }

  if (res.ok) {
    console.log(`[qqbot-api] <<< PUT ${res.status} ${displayUrl}`)
    return
  }
  // 失败体可能是 JSON（带官方 code），也可能不是（如 COS 的 XML）——两种都保留原文与状态码
  const raw = await res.text().catch(() => "")
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 非 JSON 错误体：保留原文
  }
  const asRecord = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>
  const code = typeof asRecord.code === "number" ? asRecord.code : undefined
  const message = typeof asRecord.message === "string" ? asRecord.message : raw.slice(0, 300)
  throw new QQApiError(
    res.status,
    displayUrl,
    parsed,
    `分片 PUT 失败: HTTP ${res.status}${code !== undefined ? ` code=${code}` : ""}: ${message}`,
  )
}

/** 通过公网 URL 上传富媒体文件（C2C）：平台自动下载转存，无需本地下载，返回 file_info */
export function uploadC2CFileByUrl(
  accessToken: string,
  openid: string,
  options: { fileType: number; url: string; fileName?: string },
): Promise<string> {
  return uploadFile(accessToken, `/v2/users/${openid}/files`, options)
}

/** 通过公网 URL 上传富媒体文件（群聊）：平台自动下载转存，返回 file_info */
export function uploadGroupFileByUrl(
  accessToken: string,
  groupOpenid: string,
  options: { fileType: number; url: string; fileName?: string },
): Promise<string> {
  return uploadFile(accessToken, `/v2/groups/${groupOpenid}/files`, options)
}

/** 发送富媒体消息（C2C），msg_type=7 */
export async function sendC2CMediaMessage(
  accessToken: string,
  openid: string,
  fileInfo: string,
  msgId?: string,
  msgSeq?: number,
): Promise<MessageResponse> {
  const resolvedMsgSeq = msgSeq ?? (msgId ? getNextMsgSeq(msgId) : 1)
  const body: Record<string, unknown> = {
    msg_type: 7,
    media: { file_info: fileInfo },
    content: "",
    msg_seq: resolvedMsgSeq,
  }
  if (msgId) body.msg_id = msgId
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body)
}

/** 发送富媒体消息（群聊），msg_type=7 */
export async function sendGroupMediaMessage(
  accessToken: string,
  groupOpenid: string,
  fileInfo: string,
  msgId?: string,
  msgSeq?: number,
): Promise<MessageResponse> {
  const resolvedMsgSeq = msgSeq ?? (msgId ? getNextMsgSeq(msgId) : 1)
  const body: Record<string, unknown> = {
    msg_type: 7,
    media: { file_info: fileInfo },
    content: "",
    msg_seq: resolvedMsgSeq,
  }
  if (msgId) body.msg_id = msgId
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body)
}

interface BackgroundTokenRefreshOptions {
  refreshAheadMs?: number
  randomOffsetMs?: number
  minRefreshIntervalMs?: number
  retryDelayMs?: number
  log?: {
    info: (msg: string) => void
    error: (msg: string) => void
    debug?: (msg: string) => void
  }
}

let backgroundRefreshRunning = false
let backgroundRefreshAbortController: AbortController | null = null

/**
 * 启动后台 Token 刷新循环。
 * 它会在 Token 过期前提前刷新，避免真正发消息时才发现 Token 已失效。
 */
export function startBackgroundTokenRefresh(
  appId: string,
  clientSecret: string,
  options?: BackgroundTokenRefreshOptions,
): void {
  if (backgroundRefreshRunning) {
    console.log("[qqbot-api] Background token refresh already running")
    return
  }

  const {
    refreshAheadMs = 5 * 60 * 1000,
    randomOffsetMs = 30 * 1000,
    minRefreshIntervalMs = 60 * 1000,
    retryDelayMs = 5 * 1000,
    log,
  } = options ?? {}

  backgroundRefreshRunning = true
  backgroundRefreshAbortController = new AbortController()
  const signal = backgroundRefreshAbortController.signal

  const refreshLoop = async () => {
    log?.info?.("[qqbot-api] Background token refresh started")

    while (!signal.aborted) {
      try {
        await getAccessToken(appId, clientSecret)

        if (cachedToken) {
          const expiresIn = cachedToken.expiresAt - Date.now()
          const randomOffset = Math.random() * randomOffsetMs
          const refreshIn = Math.max(
            expiresIn - refreshAheadMs - randomOffset,
            minRefreshIntervalMs,
          )

          log?.debug?.(`[qqbot-api] Token valid, next refresh in ${Math.round(refreshIn / 1000)}s`)
          await sleep(refreshIn, signal)
        } else {
          log?.debug?.("[qqbot-api] No cached token, retrying soon")
          await sleep(minRefreshIntervalMs, signal)
        }
      } catch (err) {
        if (signal.aborted) break

        log?.error?.(`[qqbot-api] Background token refresh failed: ${err}`)
        await sleep(retryDelayMs, signal)
      }
    }

    backgroundRefreshRunning = false
    log?.info?.("[qqbot-api] Background token refresh stopped")
  }

  refreshLoop().catch((err) => {
    backgroundRefreshRunning = false
    log?.error?.(`[qqbot-api] Background token refresh crashed: ${err}`)
  })
}

/**
 * 停止后台 Token 刷新循环。
 */
export function stopBackgroundTokenRefresh(): void {
  if (backgroundRefreshAbortController) {
    backgroundRefreshAbortController.abort()
    backgroundRefreshAbortController = null
  }
  backgroundRefreshRunning = false
}

/**
 * 可被 AbortSignal 中断的 sleep，供后台刷新循环复用。
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve()
    }, ms)

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error("Aborted"))
        return
      }

      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error("Aborted"))
      }

      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}
