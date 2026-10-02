// @input:  process.env, ~/.openqq/.env
// @output: Config, ProgressConfig, StreamingConfig, DEFAULT_PROGRESS, loadConfig, ensureConfig
// @pos:    根层 - 环境变量加载 + 首次运行交互式引导
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { createInterface } from "readline"
import type { Scene } from "./copy.js"

/** 中间进度开关（env 名/默认值 = 原 bridge.ts 模块常量逐字迁移） */
export interface ProgressConfig {
  enabled: boolean // PROGRESS，默认 true
  max: number // PROGRESS_MAX，默认 0（不限）
  minIntervalMs: number // PROGRESS_MIN_INTERVAL_MS，默认 1200
  heartbeatMs: number // PROGRESS_HEARTBEAT_MS，默认 60000
  textMax: number // PROGRESS_TEXT_MAX，默认 600
  toolCall: boolean // PROGRESS_TOOL_CALL，默认 true
  toolResult: boolean // PROGRESS_TOOL_RESULT，默认 true
  toolResultMax: number // PROGRESS_TOOL_RESULT_MAX，默认 300
}

/** 流式输出（实验性，仅私聊生效） */
export interface StreamingConfig {
  enabled: boolean // STREAMING，默认 off
  proactive: boolean // STREAMING_PROACTIVE，默认 off（开流走主动消息通道：不带 msg_id，不占被动回复预算；主动模式当前被 QQ 服务端拒绝 50015001，待官方放开后可切回 on）
  intervalMs: number // STREAMING_INTERVAL_MS，默认 500（对齐官方 SDK DEFAULT_THROTTLE_MS；任意两次 HTTP 发送最小间隔）
  chunkSize: number // STREAMING_CHUNK_SIZE，默认 500（正文单片最大字符数）
}

export interface Config {
  qq: {
    appId: string
    clientSecret: string
    sandbox: boolean
  }
  opencode: {
    baseUrl: string
    externalUrl: boolean
    workspaceDir?: string
  }
  allowedUsers: string[]
  maxReplyLength: number
  streaming: StreamingConfig
  progress: ProgressConfig
  texts: Partial<Record<Scene, string>>
}

/** progress 参数缺省兜底（waitForSessionReply 尾参默认值），与 env 默认一致 */
export const DEFAULT_PROGRESS: ProgressConfig = {
  enabled: true,
  max: 0,
  minIntervalMs: 1200,
  heartbeatMs: 60 * 1000,
  textMax: 600,
  toolCall: true,
  toolResult: true,
  toolResultMax: 300,
}

const CONFIG_DIR = join(homedir(), ".openqq")
const ENV_FILE = join(CONFIG_DIR, ".env")

function askTwo(q1: string, q2: string): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    let done = false
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on("close", () => { if (!done) reject(new Error("输入被中断")) })
    rl.question(q1, (a1) => {
      rl.question(q2, (a2) => {
        done = true
        rl.close()
        resolve([a1.trim(), a2.trim()])
      })
    })
  })
}

export async function ensureConfig(): Promise<void> {
  if (process.env.QQ_APP_ID && process.env.QQ_APP_SECRET) return

  if (existsSync(ENV_FILE)) {
    loadEnvFile(ENV_FILE)
    if (process.env.QQ_APP_ID && process.env.QQ_APP_SECRET) return
  }

  const localEnv = join(process.cwd(), ".env")
  if (existsSync(localEnv)) {
    loadEnvFile(localEnv)
    if (process.env.QQ_APP_ID && process.env.QQ_APP_SECRET) return
  }

  console.log("首次运行，需要配置 QQ 机器人凭证")
  console.log("(从 https://q.qq.com 机器人管理 -> 开发设置 获取)\n")

  const [appId, appSecret] = await askTwo("QQ App ID: ", "QQ App Secret: ")

  if (!appId || !appSecret) {
    throw new Error("App ID 和 App Secret 不能为空")
  }

  mkdirSync(CONFIG_DIR, { recursive: true })
  const envContent = [
    `QQ_APP_ID=${appId}`,
    `QQ_APP_SECRET=${appSecret}`,
    `QQ_SANDBOX=false`,
    `# OPENCODE_BASE_URL=http://localhost:4096`,
    `ALLOWED_USERS=`,
    `MAX_REPLY_LENGTH=3000`,
    `# STREAMING=off`,
    `# STREAMING_PROACTIVE=off`,
    `# STREAMING_INTERVAL_MS=500`,
    `# STREAMING_CHUNK_SIZE=500`,
    `# PROGRESS_TOOL_CALL=on`,
    `# TEXT_WAITING=请稍候{dots}`,
    `# TEXT_TOOL_CALL=🔧 调用工具：{tool}`,
    `# TEXT_TOOL_RESULT=📄 {tool} 返回：{result}`,
    `# TEXT_TOOL_FAILED=❌ 工具失败：{error}`,
    `# TEXT_TEXT=💬 {snippet}`,
    `# TEXT_HEARTBEAT=⏳ 仍在处理中（已用 {min} 分 {sec} 秒）…`,
    `# TEXT_PERMISSION=🔒 需要授权：{title}`,
    `# TEXT_BODY={body}`,
  ].join("\n") + "\n"

  writeFileSync(ENV_FILE, envContent)
  console.log(`\n配置已保存到 ${ENV_FILE}`)

  process.env.QQ_APP_ID = appId
  process.env.QQ_APP_SECRET = appSecret
}

function loadEnvFile(path: string): void {
  const content = readFileSync(path, "utf-8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) {
      process.env[key] = val
    }
  }
}

export function loadConfig(): Config {
  const appId = process.env.QQ_APP_ID
  const clientSecret = process.env.QQ_APP_SECRET

  if (!appId) throw new Error("缺少 QQ_APP_ID，运行 openqq 重新配置")
  if (!clientSecret) throw new Error("缺少 QQ_APP_SECRET，运行 openqq 重新配置")

  const allowedRaw = process.env.ALLOWED_USERS?.trim() ?? ""
  const allowedUsers = allowedRaw
    ? allowedRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
    : []

  // 分场景文案：键名 = TEXT_ + Scene 名，机械映射；留空/未配置 = 用 DEFAULT_COPY
  const sceneKeys: Scene[] = [
    "WAITING", "TOOL_CALL", "TOOL_RESULT", "TOOL_FAILED",
    "TEXT", "HEARTBEAT", "PERMISSION", "BODY",
  ]
  const texts: Partial<Record<Scene, string>> = {}
  for (const key of sceneKeys) {
    const value = process.env[`TEXT_${key}`]?.trim()
    if (value) texts[key] = value
  }

  return {
    qq: {
      appId,
      clientSecret,
      sandbox: process.env.QQ_SANDBOX === "true",
    },
    opencode: {
      baseUrl: process.env.OPENCODE_BASE_URL?.trim() || "",
      externalUrl: !!process.env.OPENCODE_BASE_URL?.trim(),
      workspaceDir: process.env.OPENCODE_WORKSPACE?.trim() || undefined,
    },
    allowedUsers,
    maxReplyLength: parseInt(process.env.MAX_REPLY_LENGTH ?? "3000", 10),
    streaming: {
      enabled: (process.env.STREAMING ?? "off").toLowerCase() === "on",
      proactive: (process.env.STREAMING_PROACTIVE ?? "off").toLowerCase() === "on",
      intervalMs: parseInt(process.env.STREAMING_INTERVAL_MS ?? "500", 10),
      chunkSize: parseInt(process.env.STREAMING_CHUNK_SIZE ?? "500", 10),
    },
    progress: {
      enabled: (process.env.PROGRESS ?? "on").toLowerCase() !== "off",
      max: parseInt(process.env.PROGRESS_MAX ?? "0", 10),
      minIntervalMs: parseInt(process.env.PROGRESS_MIN_INTERVAL_MS ?? "1200", 10),
      heartbeatMs: parseInt(process.env.PROGRESS_HEARTBEAT_MS ?? String(60 * 1000), 10),
      textMax: parseInt(process.env.PROGRESS_TEXT_MAX ?? "600", 10),
      toolCall: (process.env.PROGRESS_TOOL_CALL ?? "on").toLowerCase() !== "off",
      toolResult: (process.env.PROGRESS_TOOL_RESULT ?? "on").toLowerCase() !== "off",
      toolResultMax: parseInt(process.env.PROGRESS_TOOL_RESULT_MAX ?? "300", 10),
    },
    texts,
  }
}
