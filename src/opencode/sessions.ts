// @input:  ./client (OpencodeClient)
// @output: SessionManager, UserSession
// @pos:    opencode层 - QQ用户<->OpenCode Session 映射管理（含持久化 + 默认模型自动选择）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { homedir } from "os"
import type { OpencodeClient } from "./client.js"

interface UserSession {
  sessionId: string
  title?: string
  modelId?: string
  providerId?: string
  agentId?: string
}

interface PersistedState {
  [userId: string]: UserSession
}

const GREETED_KEY = "_greeted"

export class SessionManager {
  private sessions = new Map<string, UserSession>()
  private client: OpencodeClient
  private workspaceDir?: string
  private resolvedDefaultModel?: { providerId: string; modelId: string } | null
  private stateFile: string

  constructor(client: OpencodeClient, workspaceDir?: string, stateFile?: string) {
    this.client = client
    this.workspaceDir = workspaceDir
    this.stateFile = stateFile ?? join(homedir(), ".openqq", "state.json")
    this.loadState()
  }

  /** 启动时解析默认模型（自动选免费视觉模型），缓存供 getOrCreate 同步使用 */
  async resolveDefaultModel(): Promise<{ providerId: string; modelId: string } | null> {
    if (this.resolvedDefaultModel) return this.resolvedDefaultModel
    try {
      const model = await this.resolveFreeVisionModel()
      this.resolvedDefaultModel = model
      if (model) {
        console.log(`[sessions] 兜底模型已解析: ${model.providerId}/${model.modelId}（仅无绑定用户使用）`)
      } else {
        console.warn("[sessions] 未找到免费且支持读图的模型，将使用 opencode 服务端默认")
      }
      return model
    } catch (error) {
      console.error(`[sessions] 自动选模型失败:`, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  private greetedUsers = new Set<string>()

  private loadState(): void {
    try {
      if (!existsSync(this.stateFile)) return
      const raw = readFileSync(this.stateFile, "utf-8")
      const state = JSON.parse(raw) as PersistedState
      for (const [userId, s] of Object.entries(state)) {
        if (userId === GREETED_KEY) {
          if (Array.isArray(s)) {
            for (const uid of s) this.greetedUsers.add(uid)
          }
          continue
        }
        if (s && s.sessionId) {
          this.sessions.set(userId, s)
          const model = s.providerId && s.modelId ? `${s.providerId}/${s.modelId}` : "未绑定模型"
          console.log(`[sessions] 恢复用户绑定: userId=${userId.slice(0, 8)}… session=${s.sessionId.slice(0, 16)}… model=${model}`)
        }
      }
      console.log(`[sessions] 已从 ${this.stateFile} 恢复 ${this.sessions.size} 个会话绑定 + ${this.greetedUsers.size} 个已打招呼用户`)
    } catch (error) {
      console.error(`[sessions] 加载状态失败（忽略，走新建）:`, error instanceof Error ? error.message : String(error))
    }
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      const state: PersistedState = {}
      for (const [userId, s] of this.sessions) {
        state[userId] = s
      }
      state[GREETED_KEY] = [...this.greetedUsers] as unknown as UserSession
      writeFileSync(this.stateFile, JSON.stringify(state, null, 2))
    } catch (error) {
      console.error(`[sessions] 保存状态失败:`, error instanceof Error ? error.message : String(error))
    }
  }

  isGreeted(userId: string): boolean {
    return this.greetedUsers.has(userId)
  }

  markGreeted(userId: string): void {
    this.greetedUsers.add(userId)
    this.saveState()
  }

  async getOrCreate(userId: string): Promise<UserSession> {
    const existing = this.sessions.get(userId)
    if (existing) return existing

    const session = await this.createSession(userId)
    this.applyDefaultModel(userId)
    this.saveState()
    return session
  }

  async createNew(userId: string): Promise<UserSession> {
    const session = await this.createSession(userId)
    this.applyDefaultModel(userId)
    this.saveState()
    return session
  }

  private async createSession(userId: string): Promise<UserSession> {
    const result = await this.client.session.create({
      ...this.createParams(),
      // 标记为「QQ 机器人所有」，避免 /sessions 误绑到人类正在使用的会话
      body: { metadata: { openqq: { owner: userId } } },
    })
    const data = (result?.data ?? {}) as { id?: string; title?: string }
    if (!data.id) throw new Error("OpenCode 未返回 session id")
    // 模型/Agent 绑定跟随用户，不随新建会话重置（除非用户主动 /model /agent 切换）
    const prev = this.sessions.get(userId)
    const session: UserSession = {
      sessionId: data.id,
      title: data.title,
      providerId: prev?.providerId,
      modelId: prev?.modelId,
      agentId: prev?.agentId,
    }
    this.sessions.set(userId, session)
    return session
  }

  private applyDefaultModel(userId: string): void {
    const s = this.sessions.get(userId)
    if (!s || s.providerId || s.modelId) return
    if (this.resolvedDefaultModel) {
      s.providerId = this.resolvedDefaultModel.providerId
      s.modelId = this.resolvedDefaultModel.modelId
      this.saveState()
      console.log(`[sessions] 用户 ${userId.slice(0, 8)}… 无模型绑定，使用兜底: ${s.providerId}/${s.modelId}`)
    }
  }

  /** 从模型列表扫描 free（cost=0）+ 支持读图 的模型，优先 opencode/*（V2: GET /api/model） */
  private async resolveFreeVisionModel(): Promise<{ providerId: string; modelId: string } | null> {
    const response = await this.client.model.list()
    const models = Array.isArray(response?.data) ? response.data : []

    const candidates: Array<{ providerId: string; modelId: string }> = []
    for (const model of models) {
      const providerId = getString(model, "providerID")
      const modelId = getString(model, "id") ?? getString(model, "modelID")
      if (!providerId || !modelId) continue
      if (model.enabled === false) continue
      if (getString(model, "status") === "deprecated") continue

      const caps = extractProperty(model, "capabilities") as { input?: unknown } | undefined
      const inputs = Array.isArray(caps?.input) ? (caps!.input as unknown[]) : []
      const supportsImage = inputs.includes("image")

      const rawCost = extractProperty(model, "cost")
      const tiers = Array.isArray(rawCost) ? (rawCost as Array<Record<string, unknown>>) : []
      const isFree =
        tiers.length > 0 &&
        tiers.every((t) => Number(t?.input ?? 0) === 0 && Number(t?.output ?? 0) === 0)

      if (supportsImage && isFree) {
        candidates.push({ providerId, modelId })
      }
    }

    // 优先 opencode/* 提供商（避免订阅套餐模型）
    const opencodeCand = candidates.find((c) => c.providerId === "opencode")
    if (opencodeCand) return opencodeCand
    return candidates[0] ?? null
  }

  private createParams(): { query?: { directory?: string } } {
    return this.workspaceDir
      ? { query: { directory: this.workspaceDir } }
      : {}
  }

  getWorkspaceDir(): string | undefined {
    return this.workspaceDir
  }

  switchSession(userId: string, sessionId: string, title?: string): void {
    this.sessions.set(userId, {
      ...this.sessions.get(userId),
      sessionId,
      title,
    })
    this.applyDefaultModel(userId)
    this.saveState()
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId)
  }

  /** 反查：sessionId → userId（把 SSE 里的表单/权限事件路由回对应的 QQ 用户） */
  findUserIdBySessionId(sessionId: string): string | undefined {
    for (const [userId, session] of this.sessions) {
      if (session.sessionId === sessionId) return userId
    }
    return undefined
  }

  setModel(userId: string, providerId: string, modelId: string): void {
    const s = this.sessions.get(userId)
    if (s) {
      s.providerId = providerId
      s.modelId = modelId
      this.saveState()
    }
  }

  setAgent(userId: string, agentId: string): void {
    const s = this.sessions.get(userId)
    if (s) {
      s.agentId = agentId
      this.saveState()
    }
  }

  getModel(userId: string): { providerId?: string; modelId?: string } {
    const s = this.sessions.get(userId)
    return { providerId: s?.providerId, modelId: s?.modelId }
  }

  getAgent(userId: string): string | undefined {
    return this.sessions.get(userId)?.agentId
  }
}

function extractProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

function extractArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
}

function getString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = (value as Record<string, unknown>)[key]
  return typeof v === "string" && v.trim() ? v : undefined
}

function getNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = (value as Record<string, unknown>)[key]
  return typeof v === "number" ? v : undefined
}

export type { UserSession }
