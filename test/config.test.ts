// config.test.ts — env → Config 映射（streaming/progress/texts）
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { loadConfig } from "../src/config.js"

const ENV_KEYS = [
  "QQ_APP_ID", "QQ_APP_SECRET", "QQ_SANDBOX",
  "ALLOWED_USERS", "MAX_REPLY_LENGTH",
  "OPENCODE_BASE_URL", "OPENCODE_WORKSPACE",
  "STREAMING", "STREAMING_PROACTIVE", "STREAMING_INTERVAL_MS", "STREAMING_CHUNK_SIZE",
  "PROGRESS", "PROGRESS_MAX", "PROGRESS_MIN_INTERVAL_MS", "PROGRESS_HEARTBEAT_MS",
  "PROGRESS_TEXT_MAX", "PROGRESS_TOOL_CALL", "PROGRESS_TOOL_RESULT", "PROGRESS_TOOL_RESULT_MAX",
  "TEXT_WAITING", "TEXT_TOOL_CALL", "TEXT_TOOL_RESULT", "TEXT_TOOL_FAILED",
  "TEXT_TEXT", "TEXT_HEARTBEAT", "TEXT_PERMISSION", "TEXT_BODY",
] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  process.env.QQ_APP_ID = "app123"
  process.env.QQ_APP_SECRET = "secret456"
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const v = saved[key]
    if (v === undefined) delete process.env[key]
    else process.env[key] = v
  }
})

describe("loadConfig streaming 默认值", () => {
  test("STREAMING 默认 off，proactive 默认 off，intervalMs 500 / chunkSize 500", () => {
    const c = loadConfig()
    expect(c.streaming.enabled).toBe(false)
    expect(c.streaming.proactive).toBe(false)
    expect(c.streaming.intervalMs).toBe(500)
    expect(c.streaming.chunkSize).toBe(500)
  })
  test("STREAMING=on 开启（大小写不敏感）", () => {
    process.env.STREAMING = "ON"
    expect(loadConfig().streaming.enabled).toBe(true)
  })
  test("STREAMING=off 保持关闭", () => {
    process.env.STREAMING = "off"
    expect(loadConfig().streaming.enabled).toBe(false)
  })
  test("STREAMING_PROACTIVE=off 关闭主动开流（大小写不敏感），=on 显式开启", () => {
    process.env.STREAMING_PROACTIVE = "OFF"
    expect(loadConfig().streaming.proactive).toBe(false)
    process.env.STREAMING_PROACTIVE = "on"
    expect(loadConfig().streaming.proactive).toBe(true)
  })
  test("STREAMING_INTERVAL_MS / CHUNK_SIZE 覆盖", () => {
    process.env.STREAMING_INTERVAL_MS = "250"
    process.env.STREAMING_CHUNK_SIZE = "99"
    const s = loadConfig().streaming
    expect(s.intervalMs).toBe(250)
    expect(s.chunkSize).toBe(99)
  })
})

describe("loadConfig progress 默认值与覆盖", () => {
  test("PROGRESS_TOOL_CALL 默认 on，PROGRESS_TOOL_RESULT 默认 on", () => {
    const p = loadConfig().progress
    expect(p.toolCall).toBe(true)
    expect(p.toolResult).toBe(true)
    expect(p.enabled).toBe(true)
    expect(p.max).toBe(0)
    expect(p.minIntervalMs).toBe(1200)
    expect(p.heartbeatMs).toBe(60000)
    expect(p.textMax).toBe(600)
    expect(p.toolResultMax).toBe(300)
  })
  test("PROGRESS_TOOL_CALL=off 关闭", () => {
    process.env.PROGRESS_TOOL_CALL = "off"
    expect(loadConfig().progress.toolCall).toBe(false)
  })
  test("PROGRESS_TOOL_RESULT=off 关闭", () => {
    process.env.PROGRESS_TOOL_RESULT = "off"
    expect(loadConfig().progress.toolResult).toBe(false)
  })
  test("PROGRESS=off 关闭整体进度", () => {
    process.env.PROGRESS = "off"
    expect(loadConfig().progress.enabled).toBe(false)
  })
})

describe("loadConfig texts 覆盖", () => {
  test("TEXT_TOOL_CALL / TEXT_WAITING 覆盖生效", () => {
    process.env.TEXT_TOOL_CALL = "工具 {tool}"
    process.env.TEXT_WAITING = "等{dots}"
    const t = loadConfig().texts
    expect(t.TOOL_CALL).toBe("工具 {tool}")
    expect(t.WAITING).toBe("等{dots}")
  })
  test("未配置的场景不在 texts 中（回落 DEFAULT_COPY）", () => {
    process.env.TEXT_TOOL_CALL = "工具 {tool}"
    const t = loadConfig().texts
    expect(t.TOOL_RESULT).toBeUndefined()
    expect(t.HEARTBEAT).toBeUndefined()
  })
  test("留空的 TEXT_* 不生效（trim 后为空）", () => {
    process.env.TEXT_TEXT = "   "
    expect(loadConfig().texts.TEXT).toBeUndefined()
  })
})

describe("loadConfig 基础字段", () => {
  test("缺少 QQ_APP_ID 抛错", () => {
    delete process.env.QQ_APP_ID
    expect(() => loadConfig()).toThrow("QQ_APP_ID")
  })
  test("ALLOWED_USERS 逗号分隔", () => {
    process.env.ALLOWED_USERS = "u1, u2 ,u3"
    expect(loadConfig().allowedUsers).toEqual(["u1", "u2", "u3"])
  })
})
