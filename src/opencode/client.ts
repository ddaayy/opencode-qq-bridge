// @input:  process.env, ~/.config/opencode/service.json, opencode CLI (service status)
// @output: createClient, getClient, healthCheck, discoverServer, OpencodeClient
// @pos:    opencode层 - OpenCode V2 HTTP API 客户端 + 服务发现 + 健康检查
//
// 说明：上游为 V1 SDK (@opencode-ai/sdk) 编写，V2 的 server API 与 SDK 均已变更。
// 本文件改为直接调用 V2 HTTP API（/api/*，HTTP Basic 鉴权），并暴露与上游近似的
// 调用形态（{ data } 信封、path/query/body 参数），以便其余模块改动最小。
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { execFileSync } from "child_process"

export interface ServerInfo {
  baseUrl: string
  password: string
}

export class OpencodeError extends Error {
  status: number
  body: string
  constructor(status: number, body: string, message?: string) {
    super(message ?? `OpenCode API ${status}: ${body.slice(0, 300)}`)
    this.name = "OpencodeError"
    this.status = status
    this.body = body
  }
}

export interface EventEnvelope {
  id?: string
  type: string
  data?: unknown
  location?: { directory?: string }
  created?: number
  durable?: unknown
  [key: string]: unknown
}

export interface V2ClientOptions {
  /** 默认 directory（作为 query/header 传入），缺省时由服务端使用自身 cwd */
  directory?: string
}

type Query = Record<string, string | number | boolean | undefined>

function readServicePassword(): string | undefined {
  const candidates = [
    join(homedir(), ".config", "opencode", "service.json"),
    join(process.env.XDG_CONFIG_HOME ?? "", "opencode", "service.json"),
  ]
  for (const path of candidates) {
    if (!path || !existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { password?: string }
      if (parsed.password) return parsed.password
    } catch {
      // ignore
    }
  }
  return undefined
}

function getServiceUrlFromCli(): string | undefined {
  const candidates = [
    process.env.OPENCODE_BIN,
    join(homedir(), ".opencode", "bin", "opencode"),
    "opencode",
  ].filter((v): v is string => !!v)
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ["service", "status"], { encoding: "utf-8", timeout: 15_000 })
      for (const line of out.split("\n")) {
        const m = line.trim().match(/^(https?:\/\/[^\s]+)$/)
        if (m) return m[1]
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined
}

/** 解析要连接的 OpenCode 服务地址与密码（V2 服务需要 HTTP Basic 鉴权） */
export async function discoverServer(): Promise<ServerInfo> {
  const envUrl = process.env.OPENCODE_BASE_URL?.trim()
  const envPassword = process.env.OPENCODE_PASSWORD?.trim()
  const baseUrl = envUrl || getServiceUrlFromCli()
  if (!baseUrl) {
    throw new Error(
      "无法定位 OpenCode 服务：请设置 OPENCODE_BASE_URL，或确保 `opencode service status` 可用",
    )
  }
  const password = envPassword || readServicePassword()
  if (!password) {
    throw new Error(
      "缺少 OpenCode 服务密码：请设置 OPENCODE_PASSWORD，或确认 ~/.config/opencode/service.json 存在",
    )
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), password }
}

export class OpencodeClient {
  readonly directory?: string
  server: ServerInfo
  private readonly authHeader: string

  constructor(server: ServerInfo, options: V2ClientOptions = {}) {
    this.server = server
    this.directory = options.directory
    this.authHeader = "Basic " + Buffer.from(`opencode:${server.password}`).toString("base64")
  }

  /** 重新发现服务地址（例如 opencode 服务重启后端口变化） */
  async reconnect(): Promise<boolean> {
    try {
      const server = await discoverServer()
      this.server = server
      return true
    } catch {
      return false
    }
  }

  // ---- 基础请求 ----
  private buildUrl(path: string, query?: Query): string {
    const url = new URL(this.server.baseUrl + path)
    const merged: Query = { ...(query ?? {}) }
    if (this.directory && merged.directory === undefined) merged.directory = this.directory
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
    return url.toString()
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const res = await fetch(this.buildUrl(path, opts.query), {
      method,
      headers: {
        authorization: this.authHeader,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) throw new OpencodeError(res.status, text)
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new OpencodeError(res.status, text, "OpenCode 返回了非 JSON 响应")
    }
  }

  // ---- 会话 ----
  readonly session = {
    list: (params?: { query?: Query }) =>
      this.request<{ data: Array<Record<string, unknown>> }>("GET", "/api/session", {
        query: params?.query,
      }).then((r) => ({ data: r.data ?? [] })),

    create: (params?: { query?: Query; body?: Record<string, unknown> }) =>
      this.request<{ data: Record<string, unknown> }>("POST", "/api/session", {
        query: params?.query,
        body: params?.body ?? {},
      }),

    messages: (params: { path: { id: string }; query?: Query }) =>
      this.request<{ data: Array<Record<string, unknown>> }>(
        "GET",
        `/api/session/${encodeURIComponent(params.path.id)}/message`,
        { query: params.query },
      ).then((r) => ({ data: r.data ?? [] })),

    prompt: async (params: {
      path: { id: string }
      body: {
        text?: string
        files?: Array<Record<string, unknown>>
        parts?: Array<Record<string, unknown>>
        model?: { providerID: string; modelID: string }
        agent?: string
      }
    }) => {
      const { path, body } = params
      const id = encodeURIComponent(path.id)
      // V2: 模型/Agent 通过独立端点设置，prompt 只接收 text + files
      if (body.model) {
        await this.request("POST", `/api/session/${id}/model`, {
          body: { model: { providerID: body.model.providerID, id: body.model.modelID } },
        })
      }
      if (body.agent) {
        await this.request("POST", `/api/session/${id}/agent`, { body: { agent: body.agent } })
      }
      const files = body.files ?? partsToFiles(body.parts)
      const text =
        body.text ?? (body.parts ?? []).filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join("")
      const payload: Record<string, unknown> = { text }
      if (files.length > 0) payload.files = files
      return this.request("POST", `/api/session/${id}/prompt`, { body: payload })
    },

    abort: (params: { path: { id: string } }) =>
      this.request("POST", `/api/session/${encodeURIComponent(params.path.id)}/interrupt`, { body: {} }),

    update: (params: { path: { id: string }; body: Record<string, unknown> }) =>
      this.request("PATCH", `/api/session/${encodeURIComponent(params.path.id)}`, { body: params.body }),

    switchModel: (params: { path: { id: string }; body: { model: { providerID: string; modelID: string } } }) =>
      this.request("POST", `/api/session/${encodeURIComponent(params.path.id)}/model`, {
        body: { model: { providerID: params.body.model.providerID, id: params.body.model.modelID } },
      }),

    switchAgent: (params: { path: { id: string }; body: { agent: string } }) =>
      this.request("POST", `/api/session/${encodeURIComponent(params.path.id)}/agent`, { body: params.body }),

    summarize: (params: { path: { id: string } }) =>
      this.request("POST", `/api/session/${encodeURIComponent(params.path.id)}/compact`, { body: {} }).then(
        () => ({ data: true }),
      ),

    command: (params: { path: { id: string }; body: { command: string; arguments?: string } }) =>
      this.request("POST", `/api/session/${encodeURIComponent(params.path.id)}/command`, {
        body: { name: params.body.command, text: params.body.arguments ?? "" },
      }),
  }

  // ---- 模型/Provider ----
  readonly model = {
    list: () =>
      this.request<{ data: Array<Record<string, unknown>> }>("GET", "/api/model").then((r) => ({
        data: r.data ?? [],
      })),
  }

  readonly config = {
    // 兼容上游调用：合成 { data: { providers: [{ id, models: { [modelID]: model } }] } }
    providers: async () => {
      const [providers, models] = await Promise.all([
        this.request<{ data: Array<Record<string, unknown>> }>("GET", "/api/provider"),
        this.request<{ data: Array<Record<string, unknown>> }>("GET", "/api/model"),
      ])
      const list = providers.data ?? []
      const allModels = models.data ?? []
      return {
        data: {
          providers: list.map((p) => {
            const pid = String(p.id ?? p.providerID ?? "")
            const owned: Record<string, unknown> = {}
            for (const m of allModels) {
              if (String(m.providerID ?? "") !== pid) continue
              const mid = String(m.id ?? m.modelID ?? "")
              if (mid) owned[mid] = m
            }
            return { id: pid, name: p.name, models: owned }
          }),
        },
      }
    },
  }

  // ---- Agent ----
  readonly app = {
    agents: () =>
      this.request<{ data: Array<Record<string, unknown>> }>("GET", "/api/agent").then((r) => ({
        data: r.data ?? [],
      })),
  }

  // ---- 文件系统 ----
  readonly file = {
    list: (params: { query: { directory?: string; path?: string } }) =>
      this.request<{ data: Array<Record<string, unknown>> }>("GET", "/api/fs/list", {
        query: params.query,
      }).then((r) => ({ data: r.data ?? [] })),
  }

  // ---- 表单（AI 的 question 工具挂起后等用户答复） ----
  readonly form = {
    /** 全局待答表单（Form.Info[]，含 sessionID） */
    list: (params?: { query?: Query }) =>
      this.request<{ data: Array<Record<string, unknown>> }>("GET", "/api/form", {
        query: params?.query,
      }).then((r) => ({ data: r.data ?? [] })),

    /** 某会话的待答表单 */
    listBySession: (params: { path: { id: string }; query?: Query }) =>
      this.request<{ data: Array<Record<string, unknown>> }>(
        "GET",
        `/api/session/${encodeURIComponent(params.path.id)}/form`,
        { query: params.query },
      ).then((r) => ({ data: r.data ?? [] })),

    /** 提交答案，body 为 { answer: { fieldKey: value } }，成功返回 204 无 body */
    reply: (params: { sessionID: string; formID: string; answer: Record<string, unknown> }) =>
      this.request(
        "POST",
        `/api/session/${encodeURIComponent(params.sessionID)}/form/${encodeURIComponent(params.formID)}/reply`,
        { body: { answer: params.answer } },
      ),

    /** 放弃提问，成功返回 204 无 body；已答复时服务端回 409 */
    cancel: (params: { sessionID: string; formID: string }) =>
      this.request(
        "DELETE",
        `/api/session/${encodeURIComponent(params.sessionID)}/form/${encodeURIComponent(params.formID)}`,
      ),
  }

  // ---- 权限 ----
  readonly permission = {
    reply: (params: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" }) =>
      this.request(
        "POST",
        `/api/session/${encodeURIComponent(params.sessionID)}/permission/${encodeURIComponent(params.requestID)}/reply`,
        { body: { decision: params.reply } },
      ),
  }

  // ---- 事件流（SSE） ----
  readonly event = {
    subscribe: (params?: { query?: Query; signal?: AbortSignal }): { stream: AsyncGenerator<EventEnvelope> } => {
      const client = this
      const externalSignal = params?.signal
      async function* stream(): AsyncGenerator<EventEnvelope> {
        let retryDelay = 1000
        while (true) {
          if (externalSignal?.aborted) return
          try {
            const url = client.buildUrl("/api/event", params?.query)
            const res = await fetch(url, {
              headers: { authorization: client.authHeader, accept: "text/event-stream" },
              signal: externalSignal,
            })
            if (!res.ok) throw new OpencodeError(res.status, await res.text())
            if (!res.body) throw new Error("SSE 响应无 body")
            retryDelay = 1000
            const reader = (res.body as ReadableStream<Uint8Array>)
              .pipeThrough(new TextDecoderStream())
              .getReader()
            let buffer = ""
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += value
              const chunks = buffer.split("\n\n")
              buffer = chunks.pop() ?? ""
              for (const chunk of chunks) {
                const dataLines: string[] = []
                for (const line of chunk.split("\n")) {
                  if (line.startsWith("data:")) dataLines.push(line.replace(/^data:\s*/, ""))
                }
                if (!dataLines.length) continue
                try {
                  yield JSON.parse(dataLines.join("\n")) as EventEnvelope
                } catch {
                  // 跳过心跳/非 JSON 行
                }
              }
            }
          } catch (err) {
            if (externalSignal?.aborted) return
            await new Promise((r) => setTimeout(r, retryDelay))
            retryDelay = Math.min(retryDelay * 2, 30_000)
          }
        }
      }
      return { stream: stream() }
    },
  }
}

function partsToFiles(parts?: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (!parts) return []
  const files: Array<Record<string, unknown>> = []
  for (const part of parts) {
    if (part.type !== "file") continue
    const uri = typeof part.url === "string" ? part.url : undefined
    if (!uri) continue
    const file: Record<string, unknown> = { uri }
    if (typeof part.filename === "string") file.name = part.filename
    files.push(file)
  }
  return files
}

let client: OpencodeClient | null = null

export function createClient(server: ServerInfo, options?: V2ClientOptions): OpencodeClient {
  client = new OpencodeClient(server, options)
  return client
}

export function getClient(): OpencodeClient {
  if (!client) throw new Error("OpenCode client not initialized")
  return client
}

export async function healthCheck(oc: OpencodeClient): Promise<void> {
  try {
    await oc.session.list()
    console.log("[opencode] health check passed")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`OpenCode server unreachable: ${msg}`)
  }
}

export type { V2ClientOptions as OpencodeClientOptions }