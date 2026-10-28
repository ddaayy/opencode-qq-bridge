// @input:  ./client (OpencodeClient)
// @output: EventRouter, EventCallback, PermissionCallback, FormCallback, FormEvent
// @pos:    opencode层 - 全局 SSE 事件订阅 + 按 sessionId 分发（OpenCode V2 事件）
import type { EventEnvelope, OpencodeClient } from "./client.js"

export type EventCallback = (event: EventEnvelope) => void
export type PermissionCallback = (permission: {
  id: string
  sessionID: string
  type: string
  pattern?: string | Array<string>
  title?: string
  metadata: Record<string, unknown>
}) => void

export interface FormEvent {
  type: "created" | "cancelled" | "replied"
  id: string
  sessionID: string
  title?: string
  metadata: Record<string, unknown>
  fields: Array<Record<string, unknown>>
}

export type FormCallback = (event: FormEvent) => void

const FORM_EVENT_TYPES: Record<string, FormEvent["type"]> = {
  "form.created": "created",
  "form.cancelled": "cancelled",
  "form.replied": "replied",
}

/**
 * V2 表单事件的 data 形状不统一（线上抓取，2026-10-09）：
 *   form.created  → { form: { id, sessionID, title, metadata, fields } }   ← 外层包一层
 *   form.cancelled→ { id, sessionID }
 *   form.replied  → { id, sessionID, answer }
 * 这里统一解包成 Form.Info 视图（cancelled/replied 可能没有 fields）。
 */
function normalizeForm(data: Record<string, unknown>): Omit<FormEvent, "type"> | null {
  const source =
    typeof data.form === "object" && data.form !== null
      ? (data.form as Record<string, unknown>)
      : data
  const id = typeof source.id === "string" ? source.id : undefined
  const sessionID = typeof source.sessionID === "string" ? source.sessionID : undefined
  if (!id || !sessionID) return null
  const metadata =
    typeof source.metadata === "object" && source.metadata !== null
      ? (source.metadata as Record<string, unknown>)
      : {}
  const fields = Array.isArray(source.fields)
    ? source.fields.filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
    : []
  return {
    id,
    sessionID,
    title: typeof source.title === "string" && source.title ? source.title : undefined,
    metadata,
    fields,
  }
}

/**
 * V2 权限事件 `permission.asked` 的 data 形如：
 *   { id, sessionID, permission, patterns, metadata, always, tool? }
 * 旧版字段名为 action/resources，这里兼容两种写法。
 */
function normalizePermission(data: Record<string, unknown>): {
  id: string
  sessionID: string
  type: string
  pattern?: string | Array<string>
  metadata: Record<string, unknown>
} | null {
  const id = typeof data.id === "string" ? data.id : undefined
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  if (!id || !sessionID) return null
  const type =
    (typeof data.permission === "string" && data.permission) ||
    (typeof data.action === "string" && data.action) ||
    "unknown"
  const rawPatterns = data.patterns ?? data.resources
  let pattern: string | Array<string> | undefined
  if (Array.isArray(rawPatterns)) pattern = rawPatterns.filter((p): p is string => typeof p === "string")
  else if (typeof rawPatterns === "string") pattern = rawPatterns
  const metadata = (typeof data.metadata === "object" && data.metadata !== null
    ? (data.metadata as Record<string, unknown>)
    : {}) as Record<string, unknown>
  return { id, sessionID, type, pattern, metadata }
}

export class EventRouter {
  private listeners = new Map<string, EventCallback>()
  private permissionCallbacks: PermissionCallback[] = []
  private formCallbacks: FormCallback[] = []
  private running = false
  private abortController: AbortController | null = null
  private client: OpencodeClient
  private workspaceDir?: string

  constructor(client: OpencodeClient, workspaceDir?: string) {
    this.client = client
    this.workspaceDir = workspaceDir
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    void this.consume()
  }

  stop(): void {
    this.running = false
    this.abortController?.abort()
    this.abortController = null
  }

  register(sessionId: string, callback: EventCallback): void {
    this.listeners.set(sessionId, callback)
  }

  unregister(sessionId: string): void {
    this.listeners.delete(sessionId)
  }

  registerPermissionCallback(callback: PermissionCallback): void {
    this.permissionCallbacks.push(callback)
  }

  registerFormCallback(callback: FormCallback): void {
    this.formCallbacks.push(callback)
  }

  /** 是否有会话在等事件（用于判断本轮等待是否还活着） */
  hasListener(sessionId: string): boolean {
    return this.listeners.has(sessionId)
  }

  private async consume(): Promise<void> {
    while (this.running) {
      try {
        this.abortController = new AbortController()
        const { stream } = this.client.event.subscribe({
          query: this.workspaceDir ? { directory: this.workspaceDir } : undefined,
          signal: this.abortController.signal,
        })

        for await (const event of stream) {
          if (!this.running) break
          if (event.type === "permission.asked") {
            const data = (event.data ?? {}) as Record<string, unknown>
            const permission = normalizePermission(data)
            const cb = this.permissionCallbacks[this.permissionCallbacks.length - 1]
            if (permission && cb) cb(permission)
            continue
          }
          const formType = FORM_EVENT_TYPES[event.type]
          let formSessionId: string | undefined
          if (formType) {
            const data = (event.data ?? {}) as Record<string, unknown>
            const form = normalizeForm(data)
            if (form) {
              formSessionId = form.sessionID
              const cb = this.formCallbacks[this.formCallbacks.length - 1]
              if (cb) cb({ type: formType, ...form })
            } else {
              console.log(
                `[events] ${event.type} 缺少 id/sessionID，未分发 dataKeys=${Object.keys(data).join(",") || "(空)"}`,
              )
            }
            // 不 return：继续分发给会话监听者，让等待中的 watchdog 续期
          }
          const sessionId = formSessionId ?? this.extractSessionId(event)
          if (sessionId) {
            const cb = this.listeners.get(sessionId)
            if (cb) cb(event)
          }
        }
      } catch (err) {
        if (!this.running) break
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[events] SSE connection error: ${msg}`)
        // 尝试重新发现服务地址（opencode 服务重启后端口会变）
        if (await this.client.reconnect()) {
          console.log(`[events] 已重新发现 OpenCode 服务: ${this.client.server.baseUrl}`)
        }
        await this.backoff()
      }
    }
  }

  private extractSessionId(event: EventEnvelope): string | undefined {
    const data = event.data
    if (typeof data === "object" && data !== null) {
      const sid = (data as Record<string, unknown>).sessionID
      if (typeof sid === "string") return sid
    }
    const legacy = event.properties
    if (typeof legacy === "object" && legacy !== null) {
      const sid = (legacy as Record<string, unknown>).sessionID
      if (typeof sid === "string") return sid
    }
    return undefined
  }

  private reconnectDelay = 1000
  private async backoff(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.reconnectDelay))
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
  }

  resetBackoff(): void {
    this.reconnectDelay = 1000
  }
}