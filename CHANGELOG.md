# Changelog

本项目所有值得记录的变化都写在这个文件里。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **QQ 官方分片上传（>4MB 一次性下发单文件）**：超过 `SEND_FILE_INLINE_MAX_BYTES`（默认 4MB）的本地文件改走官方四步流程
  `upload_prepare` → 逐片 `PUT` 预签名 URL → `upload_part_finish` → `files(upload_id)` 合并，
  收件人拿到**一个完整文件**，不再产生 `.001/.002` 多片与 `cat 原名.00* > 原名` 手动合并命令。
  - 新增 `src/qq/api.ts` 端点：`uploadPrepareC2C/Group`、`uploadPartFinishC2C/Group`、`putPresigned`；`uploadFile` 支持 `upload_id` 合并入参。
  - 新增配置 `SEND_FILE_UPLOAD_MODE`（默认 `chunked`；`split` = 旧的多文件分片行为，作为**回滚开关**）。
  - 分片间隔复用 `SEND_FILE_PART_DELAY_MS`（默认 800ms，满足官方 `upload_prepare`/`upload_part_finish` 的 10 QPS 限制）。
  - 可重试集合为：网络错误 / 429 / 5xx / `40093001`（BDH 通道异常，官方明确要求重试），各 3 次退避；`850031`、`40093002` 不重试。
  - 官方**无 abort/delete 分片任务端点**，中途失败不做本地清理，仅 `console.error` 记录 `upload_id` 与已完成分片序号，等平台 TTL 过期。
  - 单聊与群聊端点严格同场景，不跨场景复用文件。

### Changed

- `SEND_FILE_MAX_BYTES` 默认值 **100MB → 200MB**，对齐官方 `file_type=4` 的硬限制（软/硬均为 200MB）。
- 体积上限改为**两层口径**并同步到 `README.md` / `PORT-NOTES.md` / 注入给模型的系统提示：
  默认由 `SEND_FILE_MAX_BYTES` 在入口拦截并报「文件过大 XMB（上限 YMB）」；
  `chunked` 内部的 200MB 硬校验仅兜底，只有 `SEND_FILE_MAX_BYTES` 被调大或设为 0 时才触发，届时按官方 `850031` 口径报错。
- 注入给模型的系统提示不再声称「超过 4MB 会自动分片、用户需手动合并」，改为「一次性下发单个完整文件」。

### Fixed

- **分片预签名 URL 签名外泄**：`upload_prepare` 的响应体日志原样打印 `presigned_url`（签名在 query 里）。
  新增 `sanitizePresignedUrl` / `sanitizeResponseBodyLog`（`src/qq/api.ts`），日志只保留 `pathname`、query/hash 换成 `?<已省略>`；
  错误 message 同样净化并附带「分片 #N（文件名）」上下文；**实际请求仍使用完整带签名 URL**，`apiRequest` 返回值不受污染。
- **分片覆盖不足无收口检查**：`parts` 声明的总字节小于文件 `size` 时会静默进入合并，可能产出截断文件。
  现在分片循环后校验 `offset < size` 即抛错中止，且**不调用 `/files` 合并接口**。

### Security

- 分片上传相关日志与错误信息不再包含预签名 URL 的签名参数（详见 Fixed 第一条）。

### Docs

- `README.md`、`PORT-NOTES.md` 的「大文件」章节改写为官方分片上传口径，保留 `file_data` base64 内联通道的 413 实测表作为历史依据
  （该通道仍是 ≤4MB 的默认路径；实测：请求体 19~27MB 起被 `stgw` 网关 `413 Request Entity Too Large` 硬拒绝）。
- 新增本文件与 `AGENTS.md`。

### Verification

- `bun test` → `158 pass / 0 fail / 526 expect()`（5 个文件）。
- `npx tsc --noEmit` → 退出码 0。
- **端到端已验证（2026-10-06）**：真实 token 发送 6MB（6291456 字节）文件，收件人确认收到**单个**完整文件；
  日志 `upload_prepare 200 → PUT 6291456 bytes 200 → upload_part_finish 200 → /files(upload_id) 200 → messages 200`。
  实测平台返回 `block_size=10485760`（10MB）且 `parts[].index=1`，与文档所称「默认 5MB / 从 0 起」不符，
  实现因一律以响应为准而不受影响；`>1` 分片的真实循环仍只有契约级单测（需发 >10MB 文件才会走到）。

[Unreleased]: https://github.com/（本地仓库，暂无远端）
