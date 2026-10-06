# AGENTS.md

QQ 机器人 ↔ OpenCode 对话桥（bun + TypeScript，V2 API）。给 AI 协作者的项目约定。

## 常用命令

| 用途 | 命令 | 说明 |
|---|---|---|
| 跑测试 | `bun test` | 5 个文件，基线 `158 pass / 0 fail` |
| 类型检查 | `npx tsc --noEmit` | 即 `bun run typecheck` |
| 本地启动 | `bun run src/index.ts` | `bun run dev` 为 watch 模式 |
| 服务 | `systemctl --user restart openqq.service` | 入口 `bin/openqq.js`，内容仅 `import "../src/index.ts"`，**直接跑源码，无构建步骤** |

`tsconfig.json` 的 `include` 只有 `src/**/*.ts` 与 `bin/**/*.js`，**不含 `test/`**——typecheck 不检查测试文件。

## 结构

- `src/bridge.ts` — 与 opencode 会话对接、注入给模型的系统提示（`sendFileHintText()`）、附件落盘、投递文本/文件
- `src/qq/api.ts` — 传输层：token、`apiRequest`、消息与富媒体端点、分片上传三端点、日志脱敏
- `src/qq/sender.ts` — 策略层：普通回复、流式 `StreamSession`、文件发送（内联 / chunked / legacy split）
- `src/qq/gateway.ts` — WebSocket 网关
- `test/*.test.ts` — bun test

## 测试约定（必须遵守）

- **只替换 `globalThis.fetch`**，不 mock 模块函数，不用 `bun mock()` / `jest.mock`。
  模块级保存 `const realFetch = globalThis.fetch`，`afterEach` 里还原。
- 发文件用 `test/sender.test.ts` 的 `mediaRecorder()` 记录请求（`url` / `headers` / `body`），按 URL 返回 `file_info` 或消息 `id`。
- 断言对象是**网络层的调用序列与请求体**，不是 mock 的返回值——不要把断言改成自证。
- 临时文件用 `mkdtempSync(join(tmpdir(), "..."))` + `finally { rmSync(dir, { recursive: true, force: true }) }`。
- 一次性验证脚本写到 `/tmp`，**不要留在仓库里**。

## 文件发送的关键事实

- ≤`SEND_FILE_INLINE_MAX_BYTES`（默认 4MB）→ `file_data` base64 **内联**单次上传。
- \>4MB → 默认 `SEND_FILE_UPLOAD_MODE=chunked`，走官方分片上传并合并成**单个文件**；
  设为 `split` 回到旧的多文件分片（`.001/.002` + `cat` 合并命令），这是**回滚开关**。
- `SEND_FILE_SPLIT=off` → 超阈值**一个请求都不发**，直接报错。
- 体积上限两层：入口的 `SEND_FILE_MAX_BYTES`（默认 200MB）先拦；`chunked` 内部 200MB 硬校验仅在该值被调大或置 0 时兜底。
- 官方硬上限 200MB（`file_type=4` 软/硬都是 200MB）；`40093002` 是**每日发送文件容量上限**，重试无用。
- 预签名 URL 含签名，**日志与错误信息必须脱敏**（`sanitizePresignedUrl` / `sanitizeResponseBodyLog`），但**实际请求要用完整 URL**。

## 文档同步

改了行为就同步更新三处，否则文档会被当成契约：`README.md`、`PORT-NOTES.md`、`src/bridge.ts` 的 `sendFileHintText()`。
`CHANGELOG.md` 追加 Keep-a-Changelog 条目。

## 边界

- 不提交 git，除非用户明确授权；提交前跑卫生检查（未跟踪噪声进 `.gitignore`，`.env` 凭据永不入库）。
- `.env` 只允许改注释行，`QQ_APP_ID` / `QQ_APP_SECRET` 不得改动。
