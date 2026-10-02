// @input:  ./config, ./copy, ./qq/* (types, api, sender), ./opencode/* (client, events, sessions), ./commands
// @output: createBridge
// @pos:    根层 - 核心桥接: QQ 消息 -> OpenCode -> QQ 回复（含流式输出接线）
import type { Config, ProgressConfig } from "./config.js"
import { DEFAULT_PROGRESS } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import { getAccessToken } from "./qq/api.js"
import { replyToQQ, sendProactiveToQQ, sendFileToQQ, stripThinkingTags, StreamSession, isHttpUrl } from "./qq/sender.js"
import { renderCopy, type Scene, type CopyVars } from "./copy.js"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { fileURLToPath } from "url"
import type { OpencodeClient } from "./opencode/client.js"
import { EventRouter } from "./opencode/events.js"
import { SessionManager } from "./opencode/sessions.js"
import type { EventEnvelope } from "./opencode/client.js"
import {
  handleCommand,
  handlePendingSelection,
  isCommand,
  type CommandContext,
  type PendingSelection,
} from "./commands.js"

// 仅当「无任何输出」超过该时长才判定超时（有活动会持续续期）
const RESPONSE_IDLE_TIMEOUT_MS = Number(process.env.RESPONSE_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000)
// 绝对上限，防止极端情况下永久挂起
const RESPONSE_MAX_MS = Number(process.env.RESPONSE_MAX_MS ?? 60 * 60 * 1000)
const STILL_WORKING_POLL_MS = 30 * 1000
const CHECK_INTERVAL_MS = 15 * 1000
// 中间进度开关（PROGRESS_*）已迁入 config.progress，env 名/默认值不变
// 附件（图片/文件）单个体积上限，超过则跳过并提示
const ATTACHMENT_MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES ?? 25 * 1024 * 1024)
// 附件落盘目录（供 AI 用工具读取二进制文件，如 .sqlite）
const ATTACHMENT_DIR = process.env.ATTACHMENT_DIR ?? join(homedir(), ".openqq", "attachments")
// 机器人向用户发送文件的体积上限，以及是否在提示里注入"如何发文件"的说明
const SEND_FILE_MAX_BYTES = Number(process.env.SEND_FILE_MAX_BYTES ?? 100 * 1024 * 1024)
const SEND_FILE_HINT = (process.env.SEND_FILE_HINT ?? "on").toLowerCase() !== "off"
// 一轮结束后继续监视会话（后台任务完成时 AI 会自动继续输出）
const MONITOR_ENABLED = (process.env.MONITOR ?? "on").toLowerCase() !== "off"
const MONITOR_MAX_MS = Number(process.env.MONITOR_MAX_MS ?? 2 * 60 * 60 * 1000)
const QUEUE_NOTIFY_THRESHOLD = 5

interface Bridge {
  handleMessage: (ctx: MessageContext) => Promise<void>
}

interface PromptOptions {
  model?: {
    providerID: string
    modelID: string
  }
  agent?: string
}

interface UserQueue {
  items: MessageContext[]
  processing: boolean
}

export function createBridge(
  config: Config,
  client: OpencodeClient,
  router: EventRouter,
  sessions: SessionManager,
): Bridge {
  const userQueues = new Map<string, UserQueue>()
  const pendingSelections = new Map<string, PendingSelection>()
  // 流式会话登记：permission.asked 时按 OpenCode sessionId 找到在途流
  const activeStreams = new Map<string, StreamSession>()
  const commandContext: CommandContext = {
    config,
    client,
    sessions,
    getAccessToken: () => getAccessToken(config.qq.appId, config.qq.clientSecret),
    pendingSelections,
    onKill: async (userId) => {
      const queue = userQueues.get(userId)
      if (!queue || (queue.items.length === 0 && !queue.processing)) {
        return "队列已清空"
      }
      const cleared = queue.items.length
      queue.items.length = 0
      queue.processing = false
      userQueues.delete(userId)
      return `已清空排队消息 ${cleared} 条`
    },
  }

  setupPermissionAutoAck(router, client, config.opencode.workspaceDir, (sessionId) =>
    activeStreams.get(sessionId),
  )

  const handleMessage = async (ctx: MessageContext): Promise<void> => {
    try {
      console.log(`[bridge] handleMessage type=${ctx.type} uid=${ctx.userId} content="${ctx.content.slice(0, 40)}" att=${ctx.attachments?.length ?? 0} msgId=${ctx.msgId.slice(-16)}`)
      if (!isAllowedUser(ctx.userId, config.allowedUsers)) {
        await sendReply(ctx, "你不在允许使用的名单里")
        return
      }

      const content = ctx.content.trim()
      const hasAttachment = (ctx.attachments?.length ?? 0) > 0
      if (!content && !hasAttachment) {
        return
      }

      if (content && isCommand(content)) {
        const reply = await handleCommand(ctx, commandContext)
        await sendReply(ctx, reply)
        return
      }

      const pendingReply = content ? await maybeHandlePendingSelection(ctx, commandContext) : null
      if (pendingReply !== null) {
        await sendReply(ctx, pendingReply)
        return
      }

      const queue = getOrCreateQueue(ctx.userId)
      queue.items.push(ctx)
      if (queue.processing) {
        await sendReply(ctx, `已入队：排第 ${queue.items.length} 位（前面 ${queue.items.length - 1} 条处理中），完成后自动继续`)
        return
      }

      void processQueueLoop(ctx.userId)
    } catch (error) {
      console.error("[bridge] handleMessage failed:", error)
      try {
        await sendReply(ctx, `处理消息失败：${toErrorMessage(error)}`)
      } catch (replyError) {
        console.error("[bridge] failed to send error reply:", replyError)
      }
    }
  }

  function getOrCreateQueue(userId: string): UserQueue {
    let queue = userQueues.get(userId)
    if (!queue) {
      queue = { items: [], processing: false }
      userQueues.set(userId, queue)
    }
    return queue
  }

  async function processQueueLoop(userId: string): Promise<void> {
    const queue = getOrCreateQueue(userId)
    if (queue.processing) {
      return
    }
    queue.processing = true
    try {
      while (queue.items.length > 0) {
        const ctx = queue.items.shift()!
        try {
          await processMessage(ctx)
        } catch (error) {
          console.error("[bridge] processMessage failed:", error)
          try {
            await sendReply(ctx, `处理失败：${toErrorMessage(error)}`)
          } catch (replyError) {
            console.error("[bridge] failed to send error reply:", replyError)
          }
        }
      }
    } finally {
      queue.processing = false
      if (queue.items.length === 0) {
        userQueues.delete(userId)
      }
    }
  }

  async function processMessage(ctx: MessageContext): Promise<void> {
    // 新一轮：先停掉后台监视器，避免与本次等待抢事件
    stopMonitor(ctx.userId)
    const session = await sessions.getOrCreate(ctx.userId)
    const promptOptions = buildPromptOptions(ctx.userId, sessions)
    const startedAt = Date.now()

    // 流式输出（实验性）：仅私聊 + STREAMING=on；群聊不构造（构造函数双保险抛错）
    const stream = config.streaming.enabled && ctx.type === "c2c"
      ? new StreamSession({
          token: () => getAccessToken(config.qq.appId, config.qq.clientSecret),
          ctx,
          render: (scene, vars) => renderCopy(scene, vars, config.texts),
          intervalMs: config.streaming.intervalMs,
          chunkSize: config.streaming.chunkSize,
          proactive: config.streaming.proactive,
        })
      : null

    // 进度走「主动消息」，不占用被动回复次数；串行发送并限制最小间隔，避免刷屏/限频
    // 流式开启时改走 StreamSession 场景切换（场景切换计入 progressUsed，正文 flush 不计入）
    let progressUsed = 0
    let lastProgressAt = 0
    let progressChain: Promise<void> = Promise.resolve()
    const sendProgress = (scene: Scene, vars: CopyVars): Promise<void> => {
      if (!config.progress.enabled) return progressChain
      if (config.progress.max > 0 && progressUsed >= config.progress.max) return progressChain
      progressUsed++
      progressChain = progressChain.then(async () => {
        const wait = config.progress.minIntervalMs - (Date.now() - lastProgressAt)
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        lastProgressAt = Date.now()
        try {
          if (stream && stream.state === "streaming") {
            await stream.switchScene(scene, vars)
          } else {
            await sendProactiveReply(ctx, renderCopy(scene, vars, config.texts))
          }
        } catch (error) {
          console.error("[bridge] 进度消息发送失败（忽略）:", toErrorMessage(error))
        }
      })
      return progressChain
    }

    try {
      if (stream) await stream.start().catch(() => {}) // start 失败→state=failed→后续自动走非流式
      if (stream && stream.state === "streaming") activeStreams.set(session.sessionId, stream)

      const { text: replyText, backgroundShells } = await waitForSessionReply(
        router,
        client,
        session.sessionId,
        () => {
          void startSessionPrompt(client, session.sessionId, ctx.content, promptOptions, ctx.attachments)
        },
        ctx.userId,
        config.opencode.workspaceDir,
        sendProgress,
        startedAt,
        (delta: string) => {
          if (stream) void stream.pushBody(delta)
        },
        config.progress,
      )

      // 等进度消息都发完，再发最终结果，保证顺序
      await progressChain.catch(() => {})
      // 比对基准 = 剥离 [[sendfile:...]] 标记 + 剥思考标签后的文本（与流式缓冲共用同一剥离函数，
      // 两侧口径一致；不用 extractSendFiles().text：其额外的空白收敛会让不含标记的回复也比对失败）
      const streamedOk = stream
        ? await stream.finish(stripThinkingTags(replyText.replace(SEND_FILE_RE, "")))
        : false
      await deliverResult(ctx, replyText, "reply", streamedOk)

      // 本轮结束后继续监视：后台任务完成时 OpenCode 会自动让 AI 继续输出，转发给用户
      if (MONITOR_ENABLED) {
        startMonitor(ctx, session.sessionId, backgroundShells)
      }
    } catch (error) {
      // 等待/投递失败：弃流（不发终片），错误回复走 processQueueLoop 既有路径
      if (stream) await stream.abort()
      throw error
    } finally {
      activeStreams.delete(session.sessionId)
    }
  }

  async function sendReply(ctx: MessageContext, text: string): Promise<void> {
    const accessToken = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    await replyToQQ(accessToken, ctx, text, config.maxReplyLength)
  }

  async function sendProactiveReply(ctx: MessageContext, text: string): Promise<void> {
    const accessToken = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    await sendProactiveToQQ(accessToken, ctx, text, config.maxReplyLength)
  }

  // 把 AI 的文本结果（含 [[sendfile:...]] 标记）投递给用户
  // textAlreadyDelivered=true（流式已完整投递正文）时跳过正文只发文件
  async function deliverResult(
    ctx: MessageContext,
    replyText: string,
    mode: "reply" | "proactive",
    textAlreadyDelivered: boolean = false,
  ): Promise<void> {
    const { text: cleanText, files } = extractSendFiles(replyText)
    const sendFileErrors: string[] = []
    const sendFileNotes: string[] = []
    if (files.length > 0) {
      const accessToken = await getAccessToken(config.qq.appId, config.qq.clientSecret)
      for (const file of files) {
        const filePath = resolveSendPath(file)
        try {
          const note = await sendFileToQQ(accessToken, ctx, filePath, SEND_FILE_MAX_BYTES)
          if (note) sendFileNotes.push(note)
          console.log(`[bridge] 已向用户发送文件: ${filePath}`)
        } catch (error) {
          console.error(`[bridge] 发送文件失败 ${filePath}:`, toErrorMessage(error))
          sendFileErrors.push(`${filePath}: ${toErrorMessage(error)}`)
        }
      }
    }

    const finalParts: string[] = []
    if (!textAlreadyDelivered && cleanText.trim()) finalParts.push(cleanText)
    if (sendFileNotes.length > 0) finalParts.push(sendFileNotes.join("\n"))
    if (sendFileErrors.length > 0) finalParts.push(`⚠ 文件发送失败：\n${sendFileErrors.join("\n")}`)
    const finalText = finalParts.join("\n\n")
    if (!finalText.trim()) return
    if (mode === "reply") {
      await sendReply(ctx, finalText)
    } else {
      await sendProactiveReply(ctx, finalText)
    }
  }

  // 后台监视器：一轮结束后继续盯住会话，把「自动继续」的输出转发给用户
  const monitors = new Map<string, () => void>()

  function stopMonitor(userId: string): void {
    const stop = monitors.get(userId)
    if (stop) {
      try {
        stop()
      } catch {
        // ignore
      }
      monitors.delete(userId)
    }
  }

  function startMonitor(ctx: MessageContext, sessionId: string, initialShells: string[]): void {
    stopMonitor(ctx.userId)
    const shells = new Set(initialShells)
    const toolNames = new Map<string, string>()
    let currentText = ""
    let pendingText = ""
    let executionActive = false
    let lastActivityAt = Date.now()
    let lastHeartbeatAt = 0
    let bgStartAt = Date.now()
    let stopped = false
    let timer: ReturnType<typeof setInterval> | null = null
    const until = Date.now() + MONITOR_MAX_MS

    const send = (text: string): void => {
      void sendProactiveReply(ctx, text).catch((error) =>
        console.error("[bridge] 监视进度发送失败（忽略）:", toErrorMessage(error)),
      )
    }

    const flushIntermediate = (): void => {
      const text = extractSendFiles(pendingText.trim()).text
      if (!text) return
      const snippet = text.length > config.progress.textMax ? `${text.slice(0, config.progress.textMax)}…` : text
      send(`💬 ${snippet}`)
    }

    const stop = (): void => {
      if (stopped) return
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      router.unregister(sessionId)
    }

    timer = setInterval(() => {
      if (stopped) return
      const now = Date.now()
      if (now > until) {
        stop()
        return
      }
      const idle = now - lastActivityAt
      if (now - lastHeartbeatAt >= config.progress.heartbeatMs && idle >= CHECK_INTERVAL_MS) {
        lastHeartbeatAt = now
        const elapsed = now - bgStartAt
        const mins = Math.floor(elapsed / 60000)
        const secs = Math.floor((elapsed % 60000) / 1000)
        if (executionActive) {
          send(`⏳ 仍在处理中（已用 ${mins} 分 ${secs} 秒）…`)
        } else if (shells.size > 0) {
          send(`⏳ 后台任务仍在进行（已用 ${mins} 分 ${secs} 秒）…`)
        }
      }
    }, CHECK_INTERVAL_MS)

    router.register(sessionId, (event: EventEnvelope) => {
      if (stopped) return
      lastActivityAt = Date.now()
      const data = (event.data ?? {}) as Record<string, unknown>
      switch (event.type) {
        case "session.text.started":
          flushIntermediate()
          currentText = ""
          pendingText = ""
          executionActive = true
          return
        case "session.text.delta":
          currentText += typeof data.delta === "string" ? data.delta : ""
          return
        case "session.text.ended":
          pendingText = typeof data.text === "string" ? data.text : currentText
          currentText = pendingText
          return
        case "session.tool.input.started": {
          executionActive = true
          const name = String(data.name ?? data.tool ?? "工具")
          const callId = typeof data.id === "string" ? data.id : ""
          if (callId) toolNames.set(callId, name)
          if (config.progress.toolCall) send(`🔧 调用工具：${name}`)
          return
        }
        case "session.tool.success": {
          const callId = typeof data.id === "string" ? data.id : ""
          const name = toolNames.get(callId) ?? "工具"
          const result = extractToolResultText(data)
          const bg = result.match(/shell ID:\s*(sh_[A-Za-z0-9]+)/i)
          if (bg) {
            shells.add(bg[1])
            bgStartAt = Date.now()
          } else if (config.progress.toolResult && result) {
            const snippet =
              result.length > config.progress.toolResultMax ? `${result.slice(0, config.progress.toolResultMax)}…` : result
            send(`📄 ${name} 返回：${snippet}`)
          }
          return
        }
        case "session.execution.started":
          executionActive = true
          return
        case "session.execution.succeeded":
        case "session.idle": {
          executionActive = false
          const finalText = (pendingText || currentText).trim()
          pendingText = ""
          currentText = ""
          shells.clear()
          if (finalText) {
            void deliverResult(ctx, finalText, "proactive").catch((error) =>
              console.error("[bridge] 监视转发失败（忽略）:", toErrorMessage(error)),
            )
          }
          return
        }
        case "session.execution.failed":
        case "session.execution.interrupted": {
          executionActive = false
          shells.clear()
          const err = data.error ?? data.message ?? event.type
          send(`⚠ 后台处理失败：${toErrorMessage(err)}`)
          return
        }
        case "session.error": {
          send(`⚠ 会话错误：${toErrorMessage(data.error)}`)
          return
        }
        default:
          return
      }
    })

    monitors.set(ctx.userId, stop)
  }

  return { handleMessage }
}

async function maybeHandlePendingSelection(
  ctx: MessageContext,
  commandContext: CommandContext,
): Promise<string | null> {
  const pending = commandContext.pendingSelections.get(ctx.userId)
  if (!pending) {
    return null
  }

  if (pending.expiresAt <= Date.now()) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }

  if (!/^\d+$/.test(ctx.content.trim())) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }

  return handlePendingSelection(ctx.userId, Number(ctx.content.trim()), commandContext)
}

function isAllowedUser(userId: string, allowedUsers: string[]): boolean {
  return allowedUsers.length === 0 || allowedUsers.includes(userId)
}

function buildPromptOptions(userId: string, sessions: SessionManager): PromptOptions {
  const model = sessions.getModel(userId)
  const agent = sessions.getAgent(userId)

  return {
    model: model.providerId && model.modelId
      ? { providerID: model.providerId, modelID: model.modelId }
      : undefined,
    agent,
  }
}

function setupPermissionAutoAck(
  router: EventRouter,
  client: OpencodeClient,
  workspaceDir?: string,
  getActiveStream?: (sessionId: string) => StreamSession | undefined,
): void {  router.registerPermissionCallback((permission) => {
    const { id, sessionID, type, pattern, title } = permission
    let response: "allow" | "reject" = "reject"

    const patterns = Array.isArray(pattern) ? pattern : (pattern ? [pattern] : [])
    const inWorkspace = workspaceDir ? patterns.some((p) => p.startsWith(workspaceDir)) : false

    if (type === "bash") {
      response = "allow"
    } else if (inWorkspace) {
      response = "allow"
    } else {
      response = "reject"
    }

    // 流式会话进行中：向占位流推送权限提示（fire-and-forget）；非流式路径保持静默 auto-ack
    void getActiveStream?.(sessionID)?.switchScene("PERMISSION", { title: title ?? type })

    console.log(`[bridge] auto-ack permission id=${id} type=${type} pattern=${JSON.stringify(pattern)} -> ${response}`)
    const reply = response === "allow" ? "once" : "reject"
    void client.permission.reply({ sessionID, requestID: id, reply }).then(() => {
      console.log(`[bridge] auto-ack replied ${reply} for ${id} (${title ?? type})`)
    }).catch((error: unknown) => {
      console.error(`[bridge] auto-ack reply failed for ${id}:`, toErrorMessage(error))
    })
  })
}

async function waitForSessionReply(
  router: EventRouter,
  client: OpencodeClient,
  sessionId: string,
  startPrompt: () => void,
  userId: string,
  workspaceDir?: string,
  notify?: (scene: Scene, vars: CopyVars) => Promise<void>,
  startedAt: number = Date.now(),
  onDelta?: (delta: string) => void,
  progress: ProgressConfig = DEFAULT_PROGRESS,
): Promise<{ text: string; backgroundShells: string[] }> {
  let settled = false
  let currentText = ""
  let pendingText = ""
  const toolNames = new Map<string, string>()
  const backgroundShells = new Set<string>()
  let lastActivityAt = Date.now()
  let lastHeartbeatAt = 0
  let checkTimer: ReturnType<typeof setInterval> | null = null
  // 只接受「本次提问之后」生成的助手消息，避免把上一轮的回复当成结果
  const sinceCreated = startedAt
  const deadline = startedAt + RESPONSE_MAX_MS
  const sendProgress = (scene: Scene, vars: CopyVars): void => {
    if (!notify) return
    void notify(scene, vars).catch((error) => console.error("[bridge] 进度回调失败（忽略）:", toErrorMessage(error)))
  }

  return new Promise<{ text: string; backgroundShells: string[] }>((resolve, reject) => {
    const cleanup = (): void => {
      if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
      }
      router.unregister(sessionId)
    }

    const finish = (done: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      done()
    }

    // V2: assistant 消息的文本在 content 数组里（type=text 的项）
    const extractAssistantText = (message: Record<string, unknown>): string => {
      const content = extractArray(extractProperty(message, "content"))
      let text = ""
      for (const part of content) {
        if (getString(part, "type") === "text") {
          text += getString(part, "text") ?? ""
        }
      }
      return text
    }

    // 把「已完成但不是最终答复」的说明文字作为关键节点发出
    const flushIntermediateText = (): void => {
      const raw = pendingText.trim()
      if (!raw) return
      // 去掉可能的发文件标记，避免中间消息里泄漏 [[sendfile:...]]
      const text = extractSendFiles(raw).text
      if (!text) return
      const snippet = text.length > progress.textMax ? `${text.slice(0, progress.textMax)}…` : text
      sendProgress("TEXT", { snippet })
    }

    // 工具返回摘要（拼接文本内容并压缩空白）
    const checkServerMessages = async (): Promise<string | null> => {
      try {
        const result = await client.session.messages({
          path: { id: sessionId },
          query: workspaceDir ? { directory: workspaceDir, limit: 20 } : { limit: 20 },
        })
        const messages = extractArray(result)
        const resolved = messages.length > 0 ? messages : extractArray(extractProperty(result, "data"))
        for (let i = resolved.length - 1; i >= 0; i--) {
          const message = resolved[i]
          if (getString(message, "type") !== "assistant") continue
          const time = extractProperty(message, "time") as { created?: number } | undefined
          const created = typeof time?.created === "number" ? time.created : 0
          if (created < sinceCreated) continue
          const finishState = getString(message, "finish")
          const text = extractAssistantText(message)
          if (!text) continue
          if (finishState === "stop" || finishState === "error") {
            return text
          }
        }
        return null
      } catch {
        return null
      }
    }

    const watchdog = async (): Promise<void> => {
      if (settled) return
      const now = Date.now()
      const idleMs = now - lastActivityAt

      // 中间进度心跳：长时间无输出时告知仍在处理
      if (now - lastHeartbeatAt >= progress.heartbeatMs && idleMs >= CHECK_INTERVAL_MS) {
        lastHeartbeatAt = now
        const elapsed = Math.max(0, now - startedAt)
        const mins = Math.floor(elapsed / 60000)
        const secs = Math.floor((elapsed % 60000) / 1000)
        sendProgress("HEARTBEAT", { min: mins, sec: secs })
      }

      // 兜底拉取已完成的结果（SSE 丢失时）
      if (idleMs >= STILL_WORKING_POLL_MS) {
        const text = await checkServerMessages()
        if (text) {
          finish(() => resolve({ text, backgroundShells: Array.from(backgroundShells) }))
          return
        }
      }

      // 仅当长时间「完全无活动」才判超时（有输出/工具调用会持续续期）
      if (idleMs >= RESPONSE_IDLE_TIMEOUT_MS) {
        finish(() =>
          reject(new Error(`AI 长时间无响应（${Math.round(RESPONSE_IDLE_TIMEOUT_MS / 60000)} 分钟无输出）`)),
        )
        return
      }
      if (now >= deadline) {
        finish(() => reject(new Error("AI 处理超时（超过最大处理时长）")))
      }
    }

    router.unregister(sessionId)
    router.register(sessionId, (event: EventEnvelope) => {
      const data = (event.data ?? {}) as Record<string, unknown>
      switch (event.type) {
        case "session.text.started":
          // 新一段文字开始 → 上一段属于「中间说明」，作为关键节点发出
          flushIntermediateText()
          currentText = ""
          pendingText = ""
          lastActivityAt = Date.now()
          return
        case "session.text.delta": {
          const delta = typeof data.delta === "string" ? data.delta : ""
          currentText += delta
          lastActivityAt = Date.now()
          onDelta?.(delta)
          return
        }
        case "session.text.ended": {
          pendingText = typeof data.text === "string" ? data.text : currentText
          currentText = pendingText
          lastActivityAt = Date.now()
          return
        }
        case "session.tool.input.started": {
          lastActivityAt = Date.now()
          const name = String(data.name ?? data.tool ?? "工具")
          const callId = typeof data.id === "string" ? data.id : ""
          if (callId) toolNames.set(callId, name)
          if (progress.toolCall) sendProgress("TOOL_CALL", { tool: name })
          return
        }
        case "session.tool.failed": {
          lastActivityAt = Date.now()
          const message = typeof data.error === "string" ? data.error : "工具执行失败"
          sendProgress("TOOL_FAILED", { error: message.slice(0, 120) })
          return
        }
        case "session.tool.success": {
          lastActivityAt = Date.now()
          const callId = typeof data.id === "string" ? data.id : ""
          const name = toolNames.get(callId) ?? "工具"
          const result = extractToolResultText(data)
          // 命令被移到后台执行 → 记录 shell ID，用于后续对用户保持心跳/跟踪
          const bg = result.match(/shell ID:\s*(sh_[A-Za-z0-9]+)/i)
          if (bg) backgroundShells.add(bg[1])
          if (progress.toolResult && result) {
            const snippet =
              result.length > progress.toolResultMax ? `${result.slice(0, progress.toolResultMax)}…` : result
            sendProgress("TOOL_RESULT", { tool: name, result: snippet })
          }
          return
        }
        case "session.tool.called":
        case "session.tool.input.ended":
        case "session.tool.progress":
        case "session.reasoning.delta":
        case "session.step.ended":
        case "session.step.started":
          lastActivityAt = Date.now()
          return
        case "session.execution.succeeded":
        case "session.idle":
          console.log(`[bridge] ${event.type} received session=${sessionId}`)
          finish(() =>
            resolve({
              text: (pendingText || currentText).trim() || "(AI 未返回内容)",
              backgroundShells: Array.from(backgroundShells),
            }),
          )
          return
        case "session.execution.failed":
        case "session.execution.interrupted": {
          const err = data.error ?? data.message ?? event.type
          console.error(`[bridge] ${event.type} session=${sessionId} err=${JSON.stringify(err)}`)
          finish(() => reject(new Error(toErrorMessage(err) || "AI 执行失败")))
          return
        }
        case "session.error": {
          const err = data.error
          console.error(`[bridge] session.error session=${sessionId} err=${JSON.stringify(err)}`)
          finish(() => reject(new Error(toErrorMessage(err) || "未知错误")))
          return
        }
        default:
          return
      }
    })

    checkTimer = setInterval(() => {
      void watchdog()
    }, CHECK_INTERVAL_MS)

    try {
      startPrompt()
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    }
  })
}

async function startSessionPrompt(
  client: OpencodeClient,
  sessionId: string,
  text: string,
  options: PromptOptions,
  attachments?: Array<{ url: string; content_type?: string; filename?: string }>,
): Promise<void> {
  const parts: Array<Record<string, unknown>> = []

  const notes: string[] = []
  const attachmentErrors: string[] = []
  for (const att of attachments ?? []) {
    if (!att.url) continue
    try {
      const mime = mimeFromAttachment(att)
      const buffer = await downloadBytes(att.url, ATTACHMENT_MAX_BYTES)
      const savedPath = saveAttachmentBuffer(buffer, att.filename)
      // 文本/图片内联给模型；二进制（如 sqlite/pdf）落盘并在提示里给出路径，让 AI 用工具处理
      if (isInlinable(mime)) {
        parts.push({
          type: "file",
          mime,
          filename: att.filename,
          url: `data:${mime};base64,${buffer.toString("base64")}`,
        })
      }
      notes.push(`[附件] ${att.filename ?? "file"}（${mime}）已保存到：${savedPath}`)
    } catch (error) {
      const name = att.filename || att.url.slice(0, 60)
      attachmentErrors.push(`${name}: ${toErrorMessage(error)}`)
      console.error(`[bridge] 附件处理失败（跳过）${name}:`, toErrorMessage(error))
    }
  }

  if (attachmentErrors.length > 0 && parts.length === 0 && notes.length === 0) {
    throw new Error(`附件处理失败：${attachmentErrors.join("；")}`)
  }

  let promptText = notes.length > 0 ? (text ? `${text}\n\n${notes.join("\n")}` : notes.join("\n")) : text

  if (SEND_FILE_HINT) {
    const hint =
      "[系统提示] 需要把本地文件发给用户时，请在回复中单独一行写：[[sendfile:/绝对路径]]（多个文件用多行）。\n" +
      "文件大小：QQ 单次内联上传上限约 4MB，超过时桥会自动分片发送（会刷很多条、用户需手动合并）。" +
      "大文件优先考虑：① 先压缩（如 zip -9）；② 提供公网 https URL（[[sendfile:https://...]]，由腾讯侧下载，不受 4MB 限制）；" +
      "③ 确需原样发送才用本地路径。"
    promptText = promptText ? `${promptText}\n\n${hint}` : hint
  }

  if (promptText) {
    parts.push({ type: "text", text: promptText })
  }

  const body: {
    parts: Array<Record<string, unknown>>
    model?: { providerID: string; modelID: string }
    agent?: string
  } = { parts }

  if (options.model) {
    body.model = options.model
  }
  if (options.agent) {
    body.agent = options.agent
  }

  const sessionApi = client.session
  const promptMethod = Reflect.get(sessionApi, "prompt")
  if (typeof promptMethod === "function") {
    console.log(`[bridge] startSessionPrompt session=${sessionId} parts=${parts.map((p) => `${p.type}:${String(p.url).startsWith("data:") ? "data-uri" : "url"}`).join(",")}`)
    const res = await Promise.resolve(promptMethod.call(sessionApi, {
      path: { id: sessionId },
      body,
    })) as { error?: unknown }
    if (res?.error) {
      console.error(`[bridge] startSessionPrompt ERROR session=${sessionId} err=${JSON.stringify(res.error)}`)
      throw new Error(`opencode 拒绝消息: ${JSON.stringify(res.error)}`)
    }
    console.log(`[bridge] startSessionPrompt ok session=${sessionId}`)
    return
  }

  const chatMethod = Reflect.get(sessionApi, "chat")
  if (typeof chatMethod === "function") {
    const res = await Promise.resolve(chatMethod.call(sessionApi, {
      path: { id: sessionId },
      body,
    })) as { error?: unknown }
    if (res?.error) {
      throw new Error(`opencode 拒绝消息: ${JSON.stringify(res.error)}`)
    }
    return
  }

  throw new Error("OpenCode SDK 不支持 session.prompt/chat")
}

// QQ 附件 content_type 对文件常为 "file"，需要按扩展名推断真正的 MIME，
// 否则 data URI 的 MIME 非法，OpenCode 无法识别。
const TEXT_MIME = "text/plain"
const MIME_BY_EXT: Record<string, string> = {
  txt: TEXT_MIME, text: TEXT_MIME, md: TEXT_MIME, markdown: TEXT_MIME, log: TEXT_MIME,
  csv: TEXT_MIME, tsv: TEXT_MIME, json: TEXT_MIME, jsonc: TEXT_MIME, yaml: TEXT_MIME, yml: TEXT_MIME,
  toml: TEXT_MIME, ini: TEXT_MIME, conf: TEXT_MIME, env: TEXT_MIME, xml: TEXT_MIME, html: TEXT_MIME,
  htm: TEXT_MIME, css: TEXT_MIME, scss: TEXT_MIME, less: TEXT_MIME, js: TEXT_MIME, mjs: TEXT_MIME,
  cjs: TEXT_MIME, ts: TEXT_MIME, tsx: TEXT_MIME, jsx: TEXT_MIME, vue: TEXT_MIME, svelte: TEXT_MIME,
  py: TEXT_MIME, rb: TEXT_MIME, go: TEXT_MIME, rs: TEXT_MIME, java: TEXT_MIME, kt: TEXT_MIME,
  c: TEXT_MIME, h: TEXT_MIME, cpp: TEXT_MIME, hpp: TEXT_MIME, cs: TEXT_MIME, php: TEXT_MIME,
  sh: TEXT_MIME, bash: TEXT_MIME, zsh: TEXT_MIME, fish: TEXT_MIME, ps1: TEXT_MIME, bat: TEXT_MIME,
  sql: TEXT_MIME, graphql: TEXT_MIME, gql: TEXT_MIME, diff: TEXT_MIME, patch: TEXT_MIME, lock: TEXT_MIME,
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
  pdf: "application/pdf",
  sqlite: "application/vnd.sqlite3", sqlite3: "application/vnd.sqlite3", db: "application/vnd.sqlite3",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4",
}

export function mimeFromAttachment(att: { content_type?: string; filename?: string }): string {
  const ct = att.content_type?.trim()
  // QQ 对普通文件给的是 "file"（不是合法 MIME），需要按扩展名推断
  if (ct && ct.includes("/") && ct.toLowerCase() !== "file") return ct
  const name = att.filename ?? ""
  const dot = name.lastIndexOf(".")
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

export // AI 用 [[sendfile:/绝对路径]] 标记要发给用户的文件（可多个）
const SEND_FILE_RE = /\[\[\s*sendfile\s*:\s*([^\]\n]+?)\s*\]\]/gi

export function extractSendFiles(text: string): { text: string; files: string[] } {
  const files: string[] = []
  const cleaned = text
    .replace(SEND_FILE_RE, (_match, path: string) => {
      const trimmed = String(path).trim()
      if (trimmed) files.push(trimmed)
      return ""
    })
    .replace(/```\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return { text: cleaned, files }
}

export function resolveSendPath(file: string): string {
  // http(s) URL：原样返回，走平台 URL 上传（不拼本地路径、不落盘）
  if (isHttpUrl(file)) return file
  if (file.startsWith("file://")) {
    try {
      return fileURLToPath(file)
    } catch {
      return file.replace(/^file:\/\//, "")
    }
  }
  return file
}

// 工具返回文本摘要（拼接 content 里的文本并压缩空白）
function extractToolResultText(data: Record<string, unknown>): string {
  const content = extractArray(extractProperty(data, "content"))
  let text = ""
  for (const part of content) {
    if (getString(part, "type") === "text") text += getString(part, "text") ?? ""
  }
  return text.replace(/\s+/g, " ").trim()
}

async function downloadBytes(url: string, maxBytes: number = 0): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",")
    const meta = url.slice(5, comma)
    const payload = url.slice(comma + 1)
    const buf = meta.includes(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload))
    if (maxBytes > 0 && buf.byteLength > maxBytes) {
      throw new Error(`附件过大 ${(buf.byteLength / 1048576).toFixed(1)}MB（上限 ${Math.round(maxBytes / 1048576)}MB）`)
    }
    return buf
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) {
    throw new Error(`下载附件失败: HTTP ${res.status}`)
  }
  const lenHeader = Number(res.headers.get("content-length") ?? 0)
  if (maxBytes > 0 && lenHeader > maxBytes) {
    throw new Error(`附件过大 ${(lenHeader / 1048576).toFixed(1)}MB（上限 ${Math.round(maxBytes / 1048576)}MB）`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (maxBytes > 0 && buf.byteLength > maxBytes) {
    throw new Error(`附件过大 ${(buf.byteLength / 1048576).toFixed(1)}MB（上限 ${Math.round(maxBytes / 1048576)}MB）`)
  }
  return buf
}

/** 文本/图片可内联给模型；其它二进制落盘交给 AI 用工具处理 */
function isInlinable(mime: string): boolean {
  const m = mime.toLowerCase()
  return (
    m.startsWith("text/") ||
    m.startsWith("image/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/javascript"
  )
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[/\\\x00-\x1f]/g, "_").replace(/^\.+/, "").trim().slice(0, 120)
  return cleaned || "file"
}

export function saveAttachmentBuffer(buffer: Buffer, filename?: string): string {
  mkdirSync(ATTACHMENT_DIR, { recursive: true })
  const safe = sanitizeFilename(filename ?? "file")
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`
  const full = join(ATTACHMENT_DIR, unique)
  writeFileSync(full, buffer)
  return full
}





function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function extractArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter(isRecord)
}

function extractProperty(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined
  }
  return value[key]
}

function getString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const resolved = value[key]
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
