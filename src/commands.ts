// @input:  ./config, ./qq/types, ./opencode/* (client, sessions)
// @output: isCommand, handleCommand, handlePendingSelection, CommandContext, PendingSelection
// @pos:    根层 - 命令系统: /new /stop /status /sessions /help /model /agent /rename
import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import type { OpencodeClient } from "./opencode/client.js"
import { SessionManager } from "./opencode/sessions.js"

const SELECTION_TTL_MS = 60_000

export interface CommandContext {
  config: Config
  client: OpencodeClient
  sessions: SessionManager
  getAccessToken: () => Promise<string>
  pendingSelections: Map<string, PendingSelection>
  onKill?: (userId: string) => Promise<string | null>
}

export interface PendingSelection {
  type: "session" | "model"
  items: Array<{ id: string; label: string }>
  expiresAt: number
}

interface ParsedCommand {
  name: string
  args: string
}

interface ListedSession {
  id: string
  title: string
}

interface ListedModel {
  id: string
  label: string
}

interface ListedAgent {
  id: string
  label: string
}

export function isCommand(content: string): boolean {
  return content.trim().startsWith("/")
}

export async function handleCommand(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  cmdCtx.pendingSelections.delete(ctx.userId)

  const parsed = parseCommand(ctx.content)
  if (!parsed) {
    return "不是有效命令"
  }

  switch (parsed.name) {
    case "new":
      return handleNew(ctx, cmdCtx)
    case "stop":
      return handleStop(ctx, cmdCtx)
    case "kill":
      return handleKill(ctx, cmdCtx)
    case "status":
      return handleStatus(ctx, cmdCtx)
    case "sessions":
      return handleSessions(ctx, cmdCtx)
    case "help":
      return buildHelpText()
    case "model":
      return handleModel(ctx, parsed.args, cmdCtx)
    case "agent":
      return handleAgent(ctx, parsed.args, cmdCtx)
    case "rename":
      return handleRename(ctx, parsed.args, cmdCtx)
    case "cache":
      return handleCache(ctx, cmdCtx)
    default:
      return handlePassthrough(ctx, parsed.name, parsed.args, cmdCtx)
  }
}

export async function handlePendingSelection(
  userId: string,
  selection: number,
  cmdCtx: CommandContext,
): Promise<string | null> {
  const pending = cmdCtx.pendingSelections.get(userId)
  if (!pending) {
    return null
  }

  if (pending.expiresAt <= Date.now()) {
    cmdCtx.pendingSelections.delete(userId)
    return null
  }

  const item = pending.items[selection - 1]
  if (!item) {
    return `序号无效，请回复 1-${pending.items.length}`
  }

  cmdCtx.pendingSelections.delete(userId)

  if (pending.type === "session") {
    cmdCtx.sessions.switchSession(userId, item.id, item.label)
    const topic = await getSessionLastTopic(cmdCtx.client, item.id, cmdCtx.sessions.getWorkspaceDir())
    return topic
      ? `已切换到会话：${item.label}\n—— 最后话题：${topic}`
      : `已切换到会话：${item.label}`
  }

  const model = splitModelId(item.id)
  if (!model) {
    return `模型项无效：${item.label}`
  }

  await ensureSession(userId, cmdCtx)
  cmdCtx.sessions.setModel(userId, model.providerId, model.modelId)
  return `已切换模型：${item.label}`
}

function parseCommand(content: string): ParsedCommand | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith("/")) {
    return null
  }

  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/)
  const name = rawName?.toLowerCase()
  if (!name) {
    return null
  }

  return {
    name,
    args: rest.join(" ").trim(),
  }
}

async function handleNew(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = await cmdCtx.sessions.createNew(ctx.userId)
  return [
    "已创建新会话",
    `标题：${session.title ?? "未命名会话"}`,
    `ID：${session.sessionId}`,
  ].join("\n")
}

async function handleStop(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话可停止"
  }

  await cmdCtx.client.session.abort({ path: { id: session.sessionId } })
  return `已发送停止请求：${session.title ?? session.sessionId}`
}

async function handleKill(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  const lines: string[] = []
  if (session) {
    try {
      await cmdCtx.client.session.abort({ path: { id: session.sessionId } })
      lines.push(`已终止 AI 处理：${session.title ?? session.sessionId}`)
    } catch (error) {
      lines.push(`终止 AI 处理失败：${toErrorMessage(error)}`)
    }
  } else {
    lines.push("当前没有正在处理的会话")
  }

  if (cmdCtx.onKill) {
    const queueInfo = await cmdCtx.onKill(ctx.userId)
    if (queueInfo) {
      lines.push(queueInfo)
    }
  }

  return lines.join("\n")
}

async function handleStatus(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  const { providerId, modelId } = cmdCtx.sessions.getModel(ctx.userId)
  const agentId = cmdCtx.sessions.getAgent(ctx.userId)

  const openCodeStatus = await getOpenCodeStatus(cmdCtx.client)
  const qqStatus = await getQQStatus(cmdCtx)

  return [
    "OpenCode 状态",
    `服务器：${openCodeStatus}`,
    `QQ 鉴权：${qqStatus}`,
    `会话：${session ? `${session.title ?? "未命名会话"} (${session.sessionId})` : "未创建"}`,
    `模型：${providerId && modelId ? `${providerId} / ${modelId}` : "默认"}`,
    `Agent：${agentId ?? "默认"}`,
  ].join("\n")
}

async function handleSessions(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const sessions = await listSessions(cmdCtx.client, ctx.userId, cmdCtx.sessions.getWorkspaceDir())
  if (sessions.length === 0) {
    return "当前没有可切换的历史会话（仅显示本机器人创建的会话）"
  }

  const currentSessionId = cmdCtx.sessions.getSession(ctx.userId)?.sessionId
  cmdCtx.pendingSelections.set(ctx.userId, {
    type: "session",
    items: sessions.map((session) => ({ id: session.id, label: session.title })),
    expiresAt: Date.now() + SELECTION_TTL_MS,
  })

  const lines = sessions.map((session, index) => {
    const prefix = session.id === currentSessionId ? "[当前] " : ""
    return `${index + 1}. ${prefix}${session.title}`
  })

  return ["会话列表：", ...lines, "回复序号切换会话（60 秒内有效）"].join("\n")
}

async function handleModel(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  if (!args) {
    const models = await listModels(cmdCtx.client)
    if (models.length === 0) {
      return "当前没有可用模型"
    }

    const current = cmdCtx.sessions.getModel(ctx.userId)
    cmdCtx.pendingSelections.set(ctx.userId, {
      type: "model",
      items: models.map((model) => ({ id: model.id, label: model.label })),
      expiresAt: Date.now() + SELECTION_TTL_MS,
    })

    const lines = models.map((model, index) => {
      const isCurrent = current.providerId && current.modelId && `${current.providerId}/${current.modelId}` === model.id
      return `${index + 1}. ${isCurrent ? "[当前] " : ""}${model.label}`
    })

    return ["可用模型：", ...lines, "回复序号或 /model <provider/model> 切换（60 秒内有效）"].join("\n")
  }

  if (/^\d+$/.test(args)) {
    const result = await handlePendingSelection(ctx.userId, Number(args), cmdCtx)
    return result ?? "没有待选择的模型列表，请先发送 /model"
  }

  const model = splitModelId(args)
  if (!model) {
    return "模型格式不对，请使用 /model <provider/model>"
  }

  await ensureSession(ctx.userId, cmdCtx)
  cmdCtx.sessions.setModel(ctx.userId, model.providerId, model.modelId)
  return `已切换模型：${model.providerId} / ${model.modelId}`
}

async function handleAgent(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const agents = await listAgents(cmdCtx.client)
  if (!args) {
    if (agents.length === 0) {
      return "当前没有可用 Agent"
    }

    const currentAgent = cmdCtx.sessions.getAgent(ctx.userId)
    const lines = agents.map((agent, index) => {
      const isCurrent = currentAgent === agent.id
      return `${index + 1}. ${isCurrent ? "[当前] " : ""}${agent.label}`
    })

    return ["可用 Agent：", ...lines, "回复 /agent <name> 切换"].join("\n")
  }

  const normalized = args.trim().toLowerCase()
  const matched = agents.find((agent) => agent.id.toLowerCase() === normalized)
  if (!matched) {
    return `未找到 Agent：${args}`
  }

  await ensureSession(ctx.userId, cmdCtx)
  cmdCtx.sessions.setAgent(ctx.userId, matched.id)
  return `已切换 Agent：${matched.id}`
}

async function handleRename(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const title = args.trim()
  if (!title) {
    return "用法：/rename <新名称>"
  }

  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话可重命名"
  }

  try {
    await cmdCtx.client.session.update({ path: { id: session.sessionId }, body: { title } })
  } catch (error) {
    return `重命名失败：${toErrorMessage(error)}`
  }
  cmdCtx.sessions.switchSession(ctx.userId, session.sessionId, title)
  return `已重命名当前会话：${title}`
}

async function handlePassthrough(ctx: MessageContext, name: string, args: string, cmdCtx: CommandContext): Promise<string> {
  const session = await cmdCtx.sessions.getOrCreate(ctx.userId)

  if (name === "compact") {
    return handleCompact(ctx, cmdCtx, session.sessionId)
  }

  const sessionApi = cmdCtx.client.session
  const commandFn = Reflect.get(sessionApi, "command")
  if (typeof commandFn !== "function") {
    return `命令 /${name} 无法透传：opencode 不支持`
  }

  try {
    const current = cmdCtx.sessions.getModel(ctx.userId)
    const modelId = current.providerId && current.modelId
      ? `${current.providerId}/${current.modelId}`
      : "opencode/deepseek-v4-flash-free"
    const result = await Promise.resolve(commandFn.call(sessionApi, {
      path: { id: session.sessionId },
      query: cmdCtx.sessions.getWorkspaceDir()
        ? { directory: cmdCtx.sessions.getWorkspaceDir() }
        : undefined,
      body: { command: name, arguments: args, model: modelId },
    }))
    const info = extractProperty(result, "data") ?? result
    const error = extractProperty(info, "error") ?? extractProperty(extractProperty(info, "info"), "error")
    if (error) {
      const errData = extractProperty(error, "data")
      const msg = getString(errData, "message") ?? getString(error, "message") ?? "未知错误"
      return `透传 /${name} 失败：${msg}`
    }
    const parts = extractArray(extractProperty(info, "parts"))
    const texts = parts
      .map((p) => getString(p, "text"))
      .filter((t): t is string => !!t)
    const text = texts.join("\n").trim()
    if (text) {
      return `透传 /${name} 执行完成：\n${text.slice(0, 1500)}`
    }
    const title = getString(extractProperty(info, "info"), "title") ?? getString(info, "title")
    return title ? `透传 /${name} 执行完成：${title}` : `透传 /${name} 执行完成`
  } catch (error) {
    return `透传 /${name} 失败：${toErrorMessage(error)}`
  }
}



async function handleCache(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话，先发消息创建会话后再查"
  }
  const stats = await getSessionCacheStats(cmdCtx.client, session.sessionId, cmdCtx.sessions.getWorkspaceDir())
  if (!stats) {
    return "获取 token 统计失败"
  }
  const current = cmdCtx.sessions.getModel(ctx.userId)
  const providerId = current.providerId ?? "opencode"
  const modelId = current.modelId ?? "deepseek-v4-flash-free"
  const contextLimit = await getModelContext(cmdCtx.client, providerId, modelId)

  const { input, output, cacheRead, cacheWrite } = stats
  const total = (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  const hitRate = total > 0 ? (cacheRead / total * 100).toFixed(1) : "0.0"
  const warnLines: string[] = []
  if (contextLimit) {
    const usage = cacheRead + input
    const pct = (usage / contextLimit * 100).toFixed(1)
    if (usage / contextLimit > 0.8) {
      warnLines.push(`⚠ 上下文已用 ${pct}%，接近上限，建议 /compact 或 /new`)
    } else if (usage / contextLimit > 0.6) {
      warnLines.push(`⚠ 上下文已用 ${pct}%，建议留意`)
    }
  }
  if (total > 0 && cacheRead / total < 0.5) {
    warnLines.push("⚠ 缓存命中率偏低，上下文利用率差，建议 /compact 或 /new 整理会话")
  }
  if (cacheRead > 5_000_000) {
    warnLines.push("⚠ 缓存读取超过 500 万 token，上下文可能被反复重放，建议 /compact")
  }
  const lines = [
    `Token 统计（最后一条回复）`,
    `模型：${providerId}/${modelId}`,
    ...(contextLimit
      ? [`上下文窗口：${formatTokens(contextLimit)}`, `上下文占用：${formatTokens((cacheRead ?? 0) + (input ?? 0))}（${((((cacheRead ?? 0) + (input ?? 0)) / contextLimit) * 100).toFixed(1)}%）`]
      : []),
    `输入：${formatTokens(input)}`,
    `输出：${formatTokens(output)}`,
    `缓存读取：${formatTokens(cacheRead)}（命中率 ${hitRate}%）`,
    `缓存写入：${formatTokens(cacheWrite)}`,
    `总计：${formatTokens(total)}`,
    ...warnLines,
  ]
  return lines.join("\n")
}

function formatTokens(value: number | undefined): string {
  const n = typeof value === "number" ? value : 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

async function getModelContext(client: OpencodeClient, providerId: string, modelId: string): Promise<number | null> {
  try {
    const response = await client.model.list()
    const models = extractArray(response).length > 0 ? extractArray(response) : extractArray(extractProperty(response, "data"))
    for (const model of models) {
      const pid = getString(model, "providerID")
      const mid = getString(model, "id") ?? getString(model, "modelID")
      if (pid !== providerId || mid !== modelId) continue
      const limit = extractProperty(model, "limit") as { context?: number } | undefined
      const context = typeof limit?.context === "number" ? limit.context : undefined
      return context ?? null
    }
    return null
  } catch {
    return null
  }
}



async function getSessionCacheStats(client: OpencodeClient, sessionId: string, workspaceDir?: string): Promise<{ input: number; output: number; cacheRead: number; cacheWrite: number } | null> {
  try {
    const result = await client.session.messages({
      path: { id: sessionId },
      query: workspaceDir ? { directory: workspaceDir, limit: 5000 } : { limit: 5000 },
    })
    const messages = extractArray(result)
    const resolved = messages.length > 0 ? messages : extractArray(extractProperty(result, "data"))

    for (let i = resolved.length - 1; i >= 0; i--) {
      const info = resolved[i]
      if (getString(info, "type") !== "assistant") continue
      const tokens = extractProperty(info, "tokens") as Record<string, unknown> | undefined
      if (!tokens) continue
      const cache = extractProperty(tokens, "cache") as Record<string, unknown> | undefined
      const input = typeof tokens.input === "number" ? tokens.input : 0
      const output = typeof tokens.output === "number" ? tokens.output : 0
      const cacheRead = cache && typeof cache.read === "number" ? cache.read : 0
      const cacheWrite = cache && typeof cache.write === "number" ? cache.write : 0
      if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue
      return { input, output, cacheRead, cacheWrite }
    }
    return null
  } catch {
    return null
  }
}



async function handleCompact(ctx: MessageContext, cmdCtx: CommandContext, sessionId: string): Promise<string> {
  const sessionApi = cmdCtx.client.session
  const summarizeFn = Reflect.get(sessionApi, "summarize")
  if (typeof summarizeFn !== "function") {
    return "compact 不可用：opencode 不支持 summarize"
  }

  const current = cmdCtx.sessions.getModel(ctx.userId)
  const model = current.providerId && current.modelId
    ? { providerID: current.providerId, modelID: current.modelId }
    : { providerID: "opencode", modelID: "deepseek-v4-flash-free" }

  try {
    const result = await Promise.resolve(summarizeFn.call(sessionApi, {
      path: { id: sessionId },
      query: cmdCtx.sessions.getWorkspaceDir()
        ? { directory: cmdCtx.sessions.getWorkspaceDir() }
        : undefined,
      body: model,
    })) as { data?: unknown } | boolean
    const ok = result === true || (result as { data?: unknown })?.data === true
    return ok
      ? `compact 完成：会话已压缩（模型 ${model.providerID}/${model.modelID}）`
      : `compact 返回异常：${JSON.stringify(result)?.slice(0, 200)}`
  } catch (error) {
    return `compact 失败：${toErrorMessage(error)}`
  }
}


async function ensureSession(userId: string, cmdCtx: CommandContext): Promise<void> {
  await cmdCtx.sessions.getOrCreate(userId)
}

async function getOpenCodeStatus(client: OpencodeClient): Promise<string> {
  try {
    await client.session.list()
    return "运行中"
  } catch (error) {
    return `异常（${toErrorMessage(error)}）`
  }
}

async function getQQStatus(cmdCtx: CommandContext): Promise<string> {
  try {
    await cmdCtx.getAccessToken()
    return "正常"
  } catch (error) {
    return `异常（${toErrorMessage(error)}）`
  }
}

async function listSessions(client: OpencodeClient, ownerId: string, workspaceDir?: string): Promise<ListedSession[]> {
  const result = await client.session.list(
    workspaceDir ? { query: { directory: workspaceDir } } : undefined,
  )
  const rawItems = extractArray(result)
  const items = rawItems.length > 0 ? rawItems : extractArray(extractProperty(result, "data"))

  return items
    .filter((item) => {
      // 只列出本机器人为该用户创建的会话，避免误绑到人类正在使用的会话
      const openqq = extractProperty(extractProperty(item, "metadata"), "openqq")
      return getString(openqq, "owner") === ownerId
    })
    .map((item) => {
      const id = getString(item, "id")
      if (!id) {
        return null
      }

      return {
        id,
        title: getString(item, "title") ?? id,
      }
    })
    .filter((item): item is ListedSession => item !== null)
}

async function getSessionLastTopic(client: OpencodeClient, sessionId: string, workspaceDir?: string): Promise<string | null> {
  try {
    const result = await client.session.messages({
      path: { id: sessionId },
      query: workspaceDir ? { directory: workspaceDir, limit: 20 } : { limit: 20 },
    })
    const messages = extractArray(result)
    const resolved = messages.length > 0 ? messages : extractArray(extractProperty(result, "data"))

    for (let i = resolved.length - 1; i >= 0; i--) {
      const msg = resolved[i]
      if (getString(msg, "type") !== "user") continue
      const text = getString(msg, "text")
      if (text) return text
    }
    return null
  } catch {
    return null
  }
}

async function listModels(client: OpencodeClient): Promise<ListedModel[]> {
  const response = await client.model.list()
  const models = extractArray(response).length > 0 ? extractArray(response) : extractArray(extractProperty(response, "data"))

  const listed: ListedModel[] = []
  for (const model of models) {
    const providerId = getString(model, "providerID")
    const modelId = getString(model, "id") ?? getString(model, "modelID")
    if (!providerId || !modelId) continue
    if (model.enabled === false) continue
    listed.push({
      id: `${providerId}/${modelId}`,
      label: `${providerId} / ${modelId}`,
    })
  }

  return listed
}

function extractDictValues(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return []
  }
  return Object.values(value).filter(isRecord)
}

async function listAgents(client: OpencodeClient): Promise<ListedAgent[]> {
  const response = await client.app.agents()
  const rawAgents = extractArray(response)
  const agents = rawAgents.length > 0 ? rawAgents : extractArray(extractProperty(response, "data"))

  return agents
    .map((agent) => {
      const id = getString(agent, "id") ?? getString(agent, "name")
      if (!id) {
        return null
      }

      const description = getString(agent, "description")
      return {
        id,
        label: description ? `${id} - ${description}` : id,
      }
    })
    .filter((agent): agent is ListedAgent => agent !== null)
}

function splitModelId(value: string): { providerId: string; modelId: string } | null {
  const trimmed = value.trim()
  const slashIndex = trimmed.indexOf("/")
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null
  }

  const providerId = trimmed.slice(0, slashIndex).trim()
  const modelId = trimmed.slice(slashIndex + 1).trim()
  if (!providerId || !modelId) {
    return null
  }

  return { providerId, modelId }
}

export function buildHelpText(): string {
  return [
    "可用命令：",
    "/new - 创建新会话",
    "/stop - 停止当前 AI 运行",
    "/kill - 终止 AI 处理并清空排队消息",
    "/status - 查看服务器和当前会话状态",
    "/sessions - 列出历史会话并回复序号切换",
    "/help - 查看帮助",
    "/model - 列出可用模型",
    "/model <provider/model> - 切换模型",
    "/agent - 列出可用 Agent",
    "/agent <name> - 切换 Agent",
    "/rename <name> - 重命名当前会话",
    "/cache - 查看当前会话 token/cache 统计",
    "AI 出选择题时：直接回复序号作答（多题如 1 2），/cancel 放弃提问",
    "其他 /命令 - 透传给 opencode（如 /init /review）",
  ].join("\n")
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
