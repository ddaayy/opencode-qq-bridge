// api.test.ts — sendStreamMessage 请求体/鉴权/路径 + QQApiError + classifyStreamError + apiRequest 回归
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  apiRequest,
  classifyStreamError,
  QQApiError,
  sendStreamMessage,
  uploadC2CFileByUrl,
  uploadGroupFileByUrl,
  uploadC2CFile,
  uploadGroupFile,
  uploadPrepareC2C,
  uploadPrepareGroup,
  uploadPartFinishC2C,
  uploadPartFinishGroup,
  putPresigned,
  type PrepareOptions,
  type StreamShard,
} from "../src/qq/api.js"

// apiRequest 日志量大，测试期静默
const origLog = console.log
const origErr = console.error
beforeEach(() => {
  console.log = () => {}
  console.error = () => {}
})
afterEach(() => {
  console.log = origLog
  console.error = origErr
})

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

let calls: Recorded[] = []
let nextId = 0
const realFetch = globalThis.fetch

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  calls = []
  nextId = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const raw = typeof init?.body === "string" ? init.body : ""
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    })
    nextId += 1
    return jsonResponse({ id: `resp-${nextId}`, timestamp: 1 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const TOKEN = "tok-123"
const OPENID = "OPEN1"

function firstShard(): StreamShard {
  return {
    content: "你好",
    index: 0,
    inputMode: "replace",
    inputState: 1,
    contentType: "markdown",
    msgId: "MID1",
    msgSeq: 42,
  }
}

describe("sendStreamMessage 首片请求体", () => {
  test("路径为 /v2/users/{openid}/stream_messages 且方法 POST", async () => {
    await sendStreamMessage(TOKEN, OPENID, firstShard())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://api.sgroup.qq.com/v2/users/${OPENID}/stream_messages`)
    expect(calls[0].method).toBe("POST")
  })
  test("鉴权头为 QQBot 方案（不是 Bearer）", async () => {
    await sendStreamMessage(TOKEN, OPENID, firstShard())
    expect(calls[0].headers.Authorization).toBe(`QQBot ${TOKEN}`)
    expect(calls[0].headers["Content-Type"]).toBe("application/json")
  })
  test("请求体逐项：content_raw/index/input_mode/input_state/content_type/msg_id/msg_seq", async () => {
    await sendStreamMessage(TOKEN, OPENID, firstShard())
    expect(calls[0].body).toEqual({
      content_raw: "你好",
      index: 0,
      input_mode: "replace",
      input_state: 1,
      content_type: "markdown",
      msg_seq: 42,
      msg_id: "MID1",
    })
  })
  test("返回响应体（id 供后续分片 stream_msg_id 使用）", async () => {
    const res = await sendStreamMessage(TOKEN, OPENID, firstShard())
    expect(res.id).toBe("resp-1")
  })
})

describe("sendStreamMessage 后续分片", () => {
  test("第二片携带 stream_msg_id=首片响应 id 且 index:1，msg_id 每片必带（官方 SDK 语义）", async () => {
    const first = await sendStreamMessage(TOKEN, OPENID, firstShard())
    await sendStreamMessage(TOKEN, OPENID, {
      content: "世界",
      index: 1,
      inputMode: "append",
      inputState: 1,
      streamMsgId: first.id,
      msgId: "MID1",
      msgSeq: 42,
    })
    expect(calls).toHaveLength(2)
    expect(calls[1].body).toEqual({
      content_raw: "世界",
      index: 1,
      input_mode: "append",
      input_state: 1,
      content_type: "text",
      msg_seq: 42,
      msg_id: "MID1",
      stream_msg_id: "resp-1",
    })
  })
  test("终片 input_state:10", async () => {
    await sendStreamMessage(TOKEN, OPENID, {
      content: "",
      index: 2,
      inputMode: "append",
      inputState: 10,
      streamMsgId: "resp-1",
      msgSeq: 42,
    })
    expect(calls[0].body.input_state).toBe(10)
  })
  test("同一流所有分片 msg_seq 恒定（调用方复用同一 msgSeq 时逐字透传）", async () => {
    const first = await sendStreamMessage(TOKEN, OPENID, firstShard())
    await sendStreamMessage(TOKEN, OPENID, { content: "a", index: 1, inputMode: "append", inputState: 1, streamMsgId: first.id, msgSeq: 42 })
    await sendStreamMessage(TOKEN, OPENID, { content: "", index: 2, inputMode: "append", inputState: 10, streamMsgId: first.id, msgSeq: 42 })
    const seqs = calls.map((c) => c.body.msg_seq)
    expect(seqs).toEqual([42, 42, 42])
  })
  test("未传 msgSeq 时缺省为 1", async () => {
    await sendStreamMessage(TOKEN, OPENID, { content: "x", index: 0, inputMode: "replace", inputState: 1 })
    expect(calls[0].body.msg_seq).toBe(1)
  })
})

describe("QQApiError 与 classifyStreamError", () => {
  async function sendWith(status: number, payload: unknown): Promise<void> {
    globalThis.fetch = (async () => jsonResponse(payload, status)) as typeof fetch
    await sendStreamMessage(TOKEN, OPENID, firstShard())
  }

  test("40007 → QQApiError.code=40007，分类 prefix-conflict", async () => {
    let caught: unknown
    await sendWith(400, { code: 40007, message: "prefix conflict" }).catch((e) => { caught = e })
    expect(caught).toBeInstanceOf(QQApiError)
    const err = caught as QQApiError
    expect(err.code).toBe(40007)
    expect(err.status).toBe(400)
    expect(err.path).toBe(`/v2/users/${OPENID}/stream_messages`)
    expect(err.message).toBe(`API Error [/v2/users/${OPENID}/stream_messages]: prefix conflict`)
    expect(classifyStreamError(err)).toBe("prefix-conflict")
  })
  test("50002 → rate-limited", async () => {
    let caught: unknown
    await sendWith(429, { code: 50002, message: "rate limited" }).catch((e) => { caught = e })
    expect((caught as QQApiError).code).toBe(50002)
    expect(classifyStreamError(caught)).toBe("rate-limited")
  })
  test("HTTP 429（无业务码）→ rate-limited（官方频控重试口径）", async () => {
    let caught: unknown
    await sendWith(429, { message: "too many requests" }).catch((e) => { caught = e })
    expect((caught as QQApiError).status).toBe(429)
    expect((caught as QQApiError).code).toBeUndefined()
    expect(classifyStreamError(caught)).toBe("rate-limited")
  })
  test("50001 → server-error", async () => {
    let caught: unknown
    await sendWith(500, { code: 50001, message: "server error" }).catch((e) => { caught = e })
    expect((caught as QQApiError).code).toBe(50001)
    expect(classifyStreamError(caught)).toBe("server-error")
  })
  test("其他业务码 → http", async () => {
    let caught: unknown
    await sendWith(400, { code: 99999, message: "other" }).catch((e) => { caught = e })
    expect(classifyStreamError(caught)).toBe("http")
  })
  test("无 code 字段的 QQApiError → http", async () => {
    let caught: unknown
    await sendWith(404, { message: "not found" }).catch((e) => { caught = e })
    expect((caught as QQApiError).code).toBeUndefined()
    expect(classifyStreamError(caught)).toBe("http")
  })
  test("Network error 前缀 → network", () => {
    expect(classifyStreamError(new Error("Network error [x]: boom"))).toBe("network")
    expect(classifyStreamError(new Error("Request timeout [x]: exceeded 30000ms"))).toBe("network")
  })
  test("普通错误 → unknown；非错误值 → unknown", () => {
    expect(classifyStreamError(new Error("whatever"))).toBe("unknown")
    expect(classifyStreamError(null)).toBe("unknown")
    expect(classifyStreamError("string")).toBe("unknown")
  })
})

describe("apiRequest 默认行为回归", () => {
  test("默认鉴权头仍为 QQBot，成功路径返回解析后的 JSON", async () => {
    const res = await apiRequest<{ id: string }>(TOKEN, "POST", "/v2/users/OPEN1/messages", { content: "hi" })
    expect(res.id).toBe("resp-1")
    expect(calls[0].headers.Authorization).toBe(`QQBot ${TOKEN}`)
    expect(calls[0].body).toEqual({ content: "hi" })
  })
  test("非 2xx 抛 QQApiError，message 保持 API Error [path] 格式", async () => {
    globalThis.fetch = (async () => jsonResponse({ message: "bad" }, 400)) as typeof fetch
    let caught: unknown
    await apiRequest(TOKEN, "POST", "/v2/users/OPEN1/messages", {}).catch((e) => { caught = e })
    expect(caught).toBeInstanceOf(QQApiError)
    expect((caught as QQApiError).message).toBe("API Error [/v2/users/OPEN1/messages]: bad")
  })
  test("fetch 抛错 → Network error [path] 前缀（classifyStreamError 判 network）", async () => {
    globalThis.fetch = (async () => { throw new TypeError("connection reset") }) as typeof fetch
    let caught: unknown
    await apiRequest(TOKEN, "GET", "/gateway").catch((e) => { caught = e })
    expect((caught as Error).message).toBe("Network error [/gateway]: connection reset")
    expect(classifyStreamError(caught)).toBe("network")
  })
})

describe("URL 上传（uploadC2CFileByUrl / uploadGroupFileByUrl）", () => {
  const GROUP = "GRP1"
  let urlCalls: Recorded[] = []
  beforeEach(() => {
    urlCalls = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof init?.body === "string" ? init.body : ""
      urlCalls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      })
      return jsonResponse({ file_uuid: "uuid-1", file_info: "FI::url", ttl: 300 })
    }) as typeof fetch
  })

  test("单聊端点 POST /v2/users/{openid}/files，返回 file_info 字符串", async () => {
    const fi = await uploadC2CFileByUrl(TOKEN, OPENID, { fileType: 1, url: "https://cdn.example.com/a.png" })
    expect(fi).toBe("FI::url")
    expect(urlCalls).toHaveLength(1)
    expect(urlCalls[0].method).toBe("POST")
    expect(urlCalls[0].url).toBe(`https://api.sgroup.qq.com/v2/users/${OPENID}/files`)
  })
  test("群聊端点 POST /v2/groups/{group_openid}/files", async () => {
    const fi = await uploadGroupFileByUrl(TOKEN, GROUP, { fileType: 4, url: "https://cdn.example.com/doc.pdf" })
    expect(fi).toBe("FI::url")
    expect(urlCalls[0].url).toBe(`https://api.sgroup.qq.com/v2/groups/${GROUP}/files`)
  })
  test("请求体逐项：file_type/url/srv_send_msg=false，无 file_data/file_name", async () => {
    await uploadC2CFileByUrl(TOKEN, OPENID, { fileType: 2, url: "https://cdn.example.com/v.mp4" })
    expect(urlCalls[0].body).toEqual({
      file_type: 2,
      url: "https://cdn.example.com/v.mp4",
      srv_send_msg: false,
    })
  })
  test("fileName 存在 → 请求体带 file_name（中文/空格原样透传）", async () => {
    await uploadC2CFileByUrl(TOKEN, OPENID, { fileType: 1, url: "https://cdn.example.com/a.png", fileName: "图片 v2.png" })
    expect(urlCalls[0].body).toEqual({
      file_type: 1,
      url: "https://cdn.example.com/a.png",
      file_name: "图片 v2.png",
      srv_send_msg: false,
    })
  })
  test("fileName 为 undefined → 请求体无 file_name 字段", async () => {
    await uploadGroupFileByUrl(TOKEN, GROUP, { fileType: 4, url: "https://cdn.example.com/doc.pdf", fileName: undefined })
    expect(urlCalls[0].body).not.toHaveProperty("file_name")
  })
  test("响应缺 file_info → 抛上传失败错误", async () => {
    globalThis.fetch = (async () => jsonResponse({ file_uuid: "u" })) as typeof fetch
    let caught: unknown
    await uploadC2CFileByUrl(TOKEN, OPENID, { fileType: 1, url: "https://x/a.png" }).catch((e) => { caught = e })
    expect((caught as Error).message).toContain("文件上传失败")
  })
})

describe("官方分片上传：upload_prepare / upload_part_finish / putPresigned", () => {
  const GROUP = "GRP1"
  const PREPARE: PrepareOptions = {
    fileType: 4,
    fileSize: "10485760",
    fileName: "report.zip",
    md5: "a".repeat(32),
    sha1: "b".repeat(40),
    md5_10m: "c".repeat(32),
  }
  const preparePayload = {
    upload_id: "UP-1",
    block_size: "5242880",
    parts: [
      { index: 0, presigned_url: "https://cos.example.com/part/0", block_size: "5242880" },
      { index: 1, presigned_url: "https://cos.example.com/part/1", block_size: "5242880" },
    ],
    upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
  }
  let chunkCalls: Recorded[] = []
  /** 默认：prepare/part_finish/预签名 PUT 都 200 成功 */
  function stubChunkFetch(
    respond?: (url: string, n: number) => Response | undefined,
  ): void {
    chunkCalls = []
    let n = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const raw = typeof init?.body === "string" ? init.body : ""
      n += 1
      chunkCalls.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      })
      const injected = respond?.(url, n)
      if (injected) return injected
      if (url.includes("upload_prepare")) return jsonResponse(preparePayload)
      if (url.includes("upload_part_finish")) return jsonResponse({ id: "fin-1", timestamp: 1 })
      if (url.includes("cos.example.com")) return new Response("", { status: 200 })
      return jsonResponse({ file_uuid: "uuid-1", file_info: "FI::chunk", ttl: 300 })
    }) as typeof fetch
  }
  beforeEach(() => {
    stubChunkFetch()
  })

  // ---- upload_prepare ------------------------------------------------------

  test("单聊端点 POST /v2/users/{openid}/upload_prepare + QQBot 鉴权", async () => {
    const res = await uploadPrepareC2C(TOKEN, OPENID, PREPARE)
    expect(chunkCalls).toHaveLength(1)
    expect(chunkCalls[0].method).toBe("POST")
    expect(chunkCalls[0].url).toBe(`https://api.sgroup.qq.com/v2/users/${OPENID}/upload_prepare`)
    expect(chunkCalls[0].headers.Authorization).toBe(`QQBot ${TOKEN}`)
    expect(res.upload_id).toBe("UP-1")
    expect(res.parts).toHaveLength(2)
    expect(res.parts[0]).toEqual({
      index: 0,
      presigned_url: "https://cos.example.com/part/0",
      block_size: "5242880",
    })
    expect(res.upload_config).toEqual({ concurrency: 1, retry_timeout: 300, retry_delay: 1 })
  })

  test("群聊端点 POST /v2/groups/{group_openid}/upload_prepare（与单聊端点相互独立）", async () => {
    await uploadPrepareGroup(TOKEN, GROUP, PREPARE)
    expect(chunkCalls[0].url).toBe(`https://api.sgroup.qq.com/v2/groups/${GROUP}/upload_prepare`)
  })

  test("请求体逐项：file_type/file_size/file_name/md5/sha1/md5_10m，且 file_size 是 string 不是 number", async () => {
    await uploadPrepareC2C(TOKEN, OPENID, PREPARE)
    expect(chunkCalls[0].body).toEqual({
      file_type: 4,
      file_size: "10485760",
      file_name: "report.zip",
      md5: "a".repeat(32),
      sha1: "b".repeat(40),
      md5_10m: "c".repeat(32),
    })
    expect(typeof chunkCalls[0].body.file_size).toBe("string")
  })

  test("fileSize 传 number 也按契约序列化成 string", async () => {
    await uploadPrepareC2C(TOKEN, OPENID, { ...PREPARE, fileSize: 12345 as unknown as string })
    expect(chunkCalls[0].body.file_size).toBe("12345")
  })

  test("响应缺 upload_id → 抛错（不进入分片阶段）", async () => {
    globalThis.fetch = (async () => jsonResponse({ parts: [] })) as typeof fetch
    await expect(uploadPrepareC2C(TOKEN, OPENID, PREPARE)).rejects.toThrow("upload_prepare 未返回 upload_id")
  })

  test("apiRequest 响应体日志脱敏：presigned_url 签名不进日志，返回值保持完整签名", async () => {
    const signed = "https://cos.example.com/part/0?sig=SECRETSIGNATURE&x-sign=abc"
    globalThis.fetch = (async () =>
      jsonResponse({
        upload_id: "UP-SEC",
        block_size: "5242880",
        parts: [{ index: 0, presigned_url: signed, block_size: "5242880" }],
      })) as typeof fetch
    const logs: string[] = []
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
    const res = await apiRequest<{ upload_id: string; parts: Array<{ presigned_url: string }> }>(
      TOKEN,
      "POST",
      "/v2/users/OPEN1/upload_prepare",
      {},
    )
    const all = logs.join("\n")
    expect(all).not.toContain("sig=")
    expect(all).not.toContain("SECRETSIGNATURE")
    expect(all).toContain("upload_id")
    expect(all).toContain("block_size")
    expect(all).toContain("?<已省略>")
    expect(res.parts[0].presigned_url).toBe(signed)
  })

  // ---- upload_part_finish --------------------------------------------------

  test("单聊 part_finish 端点与请求体：upload_id/part_index/block_size(string)/md5", async () => {
    await uploadPartFinishC2C(TOKEN, OPENID, {
      uploadId: "UP-1",
      partIndex: 3,
      blockSize: "5242880",
      md5: "d".repeat(32),
    })
    expect(chunkCalls).toHaveLength(1)
    expect(chunkCalls[0].method).toBe("POST")
    expect(chunkCalls[0].url).toBe(`https://api.sgroup.qq.com/v2/users/${OPENID}/upload_part_finish`)
    expect(chunkCalls[0].body).toEqual({
      upload_id: "UP-1",
      part_index: 3,
      block_size: "5242880",
      md5: "d".repeat(32),
    })
    expect(typeof chunkCalls[0].body.block_size).toBe("string")
  })

  test("群聊 part_finish 端点 POST /v2/groups/{group_openid}/upload_part_finish", async () => {
    await uploadPartFinishGroup(TOKEN, GROUP, {
      uploadId: "UP-1",
      partIndex: 0,
      blockSize: "1024",
      md5: "e".repeat(32),
    })
    expect(chunkCalls[0].url).toBe(`https://api.sgroup.qq.com/v2/groups/${GROUP}/upload_part_finish`)
  })

  // ---- putPresigned（直连对象存储，不过网关） ------------------------------

  test("PUT 精确打到 presigned_url，body 为原始 Buffer，且不带 Authorization", async () => {
    const payload = Buffer.from([1, 2, 3, 4])
    let seenBody: unknown
    let seenMethod = ""
    let seenHeaders: Record<string, string> = {}
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenMethod = init?.method ?? ""
      seenBody = init?.body
      seenHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response("", { status: 200 })
    }) as typeof fetch
    await putPresigned("https://cos.example.com/part/0?sig=abc", payload)
    expect(seenMethod).toBe("PUT")
    expect(seenBody).toBe(payload)
    expect(seenHeaders).not.toHaveProperty("Authorization")
  })

  test("PUT 5xx 自动重试后成功（网络抖动/网关错误）", async () => {
    let n = 0
    stubChunkFetch((url) => {
      if (!url.includes("cos.example.com")) return undefined
      n += 1
      return n === 1 ? new Response(JSON.stringify({ message: "slow down", code: 850012 }), { status: 500 }) : undefined
    })
    await putPresigned("https://cos.example.com/part/0", Buffer.from("x"))
    expect(n).toBe(2)
  })

  test("PUT 遇 40093001（BDH 通道异常）也重试", async () => {
    let n = 0
    stubChunkFetch((url) => {
      if (!url.includes("cos.example.com")) return undefined
      n += 1
      return n === 1
        ? new Response(JSON.stringify({ message: "文件上传失败，请重试", code: 40093001 }), { status: 400 })
        : undefined
    })
    await putPresigned("https://cos.example.com/part/0", Buffer.from("x"))
    expect(n).toBe(2)
  })

  test("PUT 其它 4xx 不重试，错误保留状态码与官方 code", async () => {
    let n = 0
    stubChunkFetch((url) => {
      if (!url.includes("cos.example.com")) return undefined
      n += 1
      return new Response(JSON.stringify({ message: "超过今天发送文件容量上限", code: 40093002 }), { status: 400 })
    })
    let caught: unknown
    await putPresigned("https://cos.example.com/part/0", Buffer.from("x")).catch((e) => { caught = e })
    expect(n).toBe(1)
    expect(caught).toBeInstanceOf(QQApiError)
    expect((caught as QQApiError).status).toBe(400)
    expect((caught as QQApiError).code).toBe(40093002)
    expect((caught as Error).message).toContain("40093002")
  })

  test("PUT 非 JSON 错误体（如对象存储 XML）→ 抛 QQApiError 保留原文，不退化成 parse 失败", async () => {
    stubChunkFetch((url) =>
      url.includes("cos.example.com")
        ? new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403, statusText: "Forbidden" })
        : undefined,
    )
    let caught: unknown
    await putPresigned("https://cos.example.com/part/0", Buffer.from("x")).catch((e) => { caught = e })
    expect(caught).toBeInstanceOf(QQApiError)
    expect((caught as Error).message).toContain("HTTP 403")
    expect((caught as Error).message).toContain("AccessDenied")
  })

  // ---- 合并：/files 带 upload_id -------------------------------------------

  test("合并调用：/files 传 upload_id 且不带 url/file_data", async () => {
    const fileInfo = await uploadC2CFile(TOKEN, OPENID, { fileType: 4, fileName: "report.zip", uploadId: "UP-1" })
    expect(fileInfo).toBe("FI::chunk")
    expect(chunkCalls[0].url).toBe(`https://api.sgroup.qq.com/v2/users/${OPENID}/files`)
    expect(chunkCalls[0].body).toEqual({
      file_type: 4,
      file_name: "report.zip",
      srv_send_msg: false,
      upload_id: "UP-1",
    })
    expect(chunkCalls[0].body).not.toHaveProperty("url")
    expect(chunkCalls[0].body).not.toHaveProperty("file_data")
  })

  test("合并调用（群聊）走 /v2/groups/{gid}/files", async () => {
    await uploadGroupFile(TOKEN, GROUP, { fileType: 4, fileName: "report.zip", uploadId: "UP-1" })
    expect(chunkCalls[0].url).toBe(`https://api.sgroup.qq.com/v2/groups/${GROUP}/files`)
    expect(chunkCalls[0].body.upload_id).toBe("UP-1")
  })
})
