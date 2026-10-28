# OpenQQ Bridge — OpenCode V2 移植说明

本目录是 `@soulglad/opencode-qq-plugin@0.1.0` 的本地 fork，**已从 V1 SDK 移植到 OpenCode V2 API**，
以便与 OpenCode v2.0.16 协同工作。

## 为什么需要移植

上游依赖 `@opencode-ai/sdk`(V1)，而 V2 变更了 server API：

| | V1（上游） | V2（本 fork） |
|---|---|---|
| API 路径 | `/session`、`/config/providers` | `/api/session`、`/api/model`、`/api/agent` … |
| 鉴权 | 无 | HTTP Basic（`~/.config/opencode/service.json` 的 password） |
| 模型/Agent | `session.prompt` 内联 | `POST /api/session/{id}/model`、`/agent` 单独设置 |
| 消息结构 | `{ info, parts }` | `{ type:"assistant", content:[{type:"text",text}] }` |
| 事件 | `message.part.updated` / `session.idle` | `session.text.delta` / `session.execution.succeeded` 等 |

## 改动一览

- `src/opencode/client.ts`：**重写**为 V2 HTTP 客户端（fetch + Basic 鉴权 + 服务自动发现），
  对外仍暴露近似的 `{ data }` 信封与 `path/query/body` 调用形态。
- `src/opencode/events.ts`：适配 V2 SSE 事件（顶层 `type` + `data`），权限事件改为 `permission.asked`。
- `src/opencode/sessions.ts`：免费读图模型选择改用 `GET /api/model`；`Model.Ref` 使用 `id` 字段。
- `src/bridge.ts`：回复等待改为基于 `session.text.*` + `session.execution.succeeded/failed`；
  权限 auto-ack 改用 `POST /api/session/{id}/permission/{requestID}/reply { decision }`；
  AGENTS.md 检测改用 `/api/fs/list` 的 `path` 字段。
- `src/commands.ts`：模型/Agent 列表、token 统计、会话话题解析改用 V2 结构；`/rename` 会持久化。
- `src/index.ts`：不再自启 V1 server，改为连接本机运行中的 OpenCode 服务。

## 服务发现

启动时按顺序解析要连接的 OpenCode 服务：

1. `OPENCODE_BASE_URL`（可选）与 `OPENCODE_PASSWORD`（可选）环境变量；
2. 否则执行 `opencode service status` 取 URL，从 `~/.config/opencode/service.json` 取 password。

> 注意：OpenCode 后台服务端口是动态的，若执行过 `opencode service restart` 导致端口变化，
> 需重启本桥以重新发现地址。

## 配置

`~/.openqq/.env`：

```
QQ_APP_ID=...
QQ_APP_SECRET=...
QQ_SANDBOX=false
# OPENCODE_BASE_URL=http://127.0.0.1:4096
# OPENCODE_PASSWORD=...
ALLOWED_USERS=
MAX_REPLY_LENGTH=3000
```

## 运行

```bash
openqq                 # 全局命令（~/.bun/bin/openqq 包装脚本）
# 或
cd ~/.openqq && bun run src/index.ts
```

## 依赖

Bun >= 1.0；`ws`（QQ Gateway）。已移除 `@opencode-ai/sdk` 依赖。

## 中间进度与超时（可配置）

默认会在处理过程中向 QQ 输出关键中间信息（走**主动消息**，不占用被动回复次数）：

- `🔧 调用工具：<name>`：模型调用工具时（如 shell / read / edit）
- `📄 <name> 返回：<摘要>`：工具执行完成时的返回摘要（截断）
- `❌ 工具失败：<原因>`：工具执行失败时
- `💬 <说明>`：模型在工具之间的「中间说明文字」（非最终答复）
- `⏳ 仍在处理中（已用 X 分 Y 秒）…`：长时间无输出时的心跳

> 关键节点策略：每个文字段落若后面还有新的文字段落，说明它不是最终答复，就作为 `💬` 中间说明发出；
> 最后一段文字作为最终结果。这样既不刷屏思考过程，又能看到关键节点。

超时改为**基于"无活动"**：只要有事件（文本/工具/步骤）就会持续续期，
默认连续 **10 分钟无任何输出**才判超时；另有 60 分钟绝对上限兜底。

可通过 `~/.openqq/.env` 调整：

| 变量 | 默认 | 说明 |
|------|------|------|
| `PROGRESS` | `on` | 是否输出中间进度 |
| `PROGRESS_MAX` | `0` | 最多几条进度，`0` = 不限 |
| `PROGRESS_MIN_INTERVAL_MS` | `1200` | 进度消息最小间隔，防刷屏/限频 |
| `PROGRESS_HEARTBEAT_MS` | `60000` | 无输出时的心跳间隔 |
| `PROGRESS_TEXT_MAX` | `600` | 中间说明文字单条截断长度 |
| `PROGRESS_TOOL_RESULT` | `on` | 是否输出工具返回摘要 |
| `PROGRESS_TOOL_RESULT_MAX` | `300` | 工具返回摘要截断长度 |
| `RESPONSE_IDLE_TIMEOUT_MS` | `600000` | 无活动多久判超时 |
| `RESPONSE_MAX_MS` | `3600000` | 单次处理绝对上限 |

> 最终结果仍使用被动回复（与被提问消息关联）；进度用主动消息，二者独立。

## 图片 / 文件附件

支持 QQ 发来的图片和文件：桥会下载附件 → 转成 data URI / 落盘 → 交给 OpenCode。

- **图片**：内联为 data URI，由支持视觉的模型识别。
- **文本类文件**（.txt/.md/.csv/.json/.py/.js/.ts/…）：内联为 data URI，OpenCode 直接把内容作为上下文。
- **二进制文件**（.sqlite/.pdf/.docx/.zip/…）：**保存到磁盘**，并在提示里附带路径，由 AI **用工具**处理。
  - 例：`~/.openqq/attachments/<ts>-<rand>-<name>`
  - `.sqlite`：机器有 `python3`（含 `sqlite3` 模块，`sqlite3` CLI 未安装），AI 可用
    `python3 -c "import sqlite3; ..."` 读取表结构/数据。
- **MIME 推断**：QQ 对文件给的 `content_type` 常是 `"file"`（非法 MIME），桥按扩展名推断正确 MIME。
  `.sqlite/.sqlite3/.db` → `application/vnd.sqlite3`。
- **体积上限**：`ATTACHMENT_MAX_BYTES`（默认 25MB），超过则跳过并提示。
- 每个附件都会在用户消息末尾追加一行 `[附件] <名称>（<mime>）已保存到：<路径>`，便于 AI 按需读取。

> 说明：OpenCode V2 的附件 `uri` 只接受 `data:` 或 `file://`，不接受裸路径；二进制文件走"落盘 + 提示路径"路线。

## 机器人主动发文件给用户

支持把本机文件发回给 QQ 用户（zip / 任意文件 / 图片 / 视频 / 语音）。

**触发约定**：AI 在回复中单独一行写标记
```
[[sendfile:/绝对路径]]
```
桥会：把标记从文本中剔除、上传富媒体（`POST /v2/users|groups/{id}/files`）、
再以 `msg_type=7` 发送给用户（作为被动回复关联原消息）。

- 支持一次多个（多行多个标记）。
- 也接受 `file:///path` 形式。
- 类型按扩展名自动判定：图片=1 / 视频=2 / 语音=3 / 其它=4（文件）。
- 体积上限 `SEND_FILE_MAX_BYTES`（默认 200MB，= QQ 官方硬限制）；≤4MB 内联上传，
  >4MB 走官方分片上传并一次性下发单文件（见下节）；失败会在最终文本里附加 `⚠ 文件发送失败：…`。
- 桥会在用户消息末尾注入一句 `[系统提示] … [[sendfile:/绝对路径]]`，让模型知道该约定（`SEND_FILE_HINT=off` 可关闭）。

> 示例：用户"把当前目录打包成 zip 发我" → AI 执行 `zip -r /tmp/xx.zip .` →
> 回复中写 `[[sendfile:/tmp/xx.zip]]` → 桥把 zip 发给该用户。

### 大文件：官方分片上传（413 根因与修复）

**现象**：发 40+MB 的 zip，`file_data` base64 达 48MB → 网关
`<<< Status: 413 Request Entity Too Large  server: stgw`，请求体原样被拒。

**实测边界**（`POST /v2/users/{openid}/files`，`srv_send_msg=false` 只上传不发消息，用户无感知）：

| 文件 | 请求体 | 结果 |
|---|---|---|
| 1 / 2 / 4 / 4.5MB | 1.3 ~ 6.0MB | `200 OK`，稳定 |
| 6MB | 8.0MB | 一次 200、一次 500（抖动） |
| 8 / 10 / 12 / 14MB | 10.7 ~ 18.7MB | `500 call inner proxy error (850012)` |
| 20 / 30 / 36 / 40MB | 26.7 ~ 48MB | `413`（<1s，网关硬拒绝） |

⇒ **可靠内联上限 ≈ 4MB**；19~27MB 请求体之间是 413 的硬边界。
这条 `file_data` 内联通道**仍是 ≤4MB 的默认路径**（原行为不变）；>4MB 改走官方分片上传，
分片 PUT 直连对象存储、不过 api 网关，因此**结构上不会**再撞这个 413。

**实现**（`src/qq/api.ts` 传输层 + `src/qq/sender.ts` 策略层）：

- 阈值内（`SEND_FILE_INLINE_MAX_BYTES`，默认 4MB）→ 原单次内联上传，行为不变。
- 超阈值且 `SEND_FILE_SPLIT=on`（默认）→ 按 `SEND_FILE_UPLOAD_MODE` 分派（默认 `chunked`）：
  - `upload_prepare`（`file_type`/`file_size` 是 **string**/`file_name`/整文件 `md5`/`sha1`/`md5_10m`
    = 前 10002432 字节的 MD5，三个哈希**一次流式**产出，1MB 步进，200MB 文件也不进内存两遍）；
  - 逐片 `HTTP PUT presigned_url`（**不带 Authorization**，不过网关），再 `upload_part_finish`
    （`upload_id`/`part_index`（**沿用响应 `parts[].index`**：文档写从 0 起、实测单分片返回 1）/`block_size`(str)/本片 `md5`）；
  - `POST /files` 带 `upload_id` 触发**服务端合并** → `file_info` → 只发一条 `msg_type=7` 消息。
  - **收件人收到单个完整文件**：没有 `.001/.002` 多片，也不再有 `cat … > …` 合并命令文案
    （`sendFileToQQ` 在该模式下返回 `undefined`）。
- 单聊 / 群聊三个端点同场景（官方规定预上传、分片、合并端点相互独立）。
- **节流**：`upload_prepare` / `upload_part_finish` 官方限 10 QPS，分片间按
  `SEND_FILE_PART_DELAY_MS`（默认 800ms ≥ 100ms）节流；`upload_config.concurrency` 默认 1，串行实现。
- **重试**：网络错误 / 429 / 5xx / `40093001`（BDH 通道异常，官方明确让重试）最多 3 次退避
  （1s、2s）；其它 4xx、`850031`、`40093002` 不重试。
- **体积上限分两层**：默认由 `SEND_FILE_MAX_BYTES`（默认 200MB）在入口拦截，超限报「文件过大 XMB（上限 YMB）」；
  `chunked` 内部另有 200MB 硬校验**仅兜底**——只有当 `SEND_FILE_MAX_BYTES` 被调大或设为 0 时才会触发，
  届时按官方 `850031` 口径报错。官方硬上限就是 200MB（`file_type=4` 软/硬限制都是 200MB），再大也没用。
- **每日容量**：`40093002` 透传成用户可见文案「超过今天发送文件容量上限，请明天再试或减少文件大小」。
- **孤儿 `upload_id`**：官方**没有** abort/delete 分片任务的端点（`upload*` 只有 prepare/part_finish），
  中途失败不做本地清理，只 `console.error` 记 `upload_id` + 已完成分片序号，等平台 TTL 过期。
- **回滚**：`SEND_FILE_UPLOAD_MODE=split` 立刻回到旧行为（`splitFileParts()` 定宽编号
  `原名.001/.002/…`，首片被动、其余主动，片间隔 `SEND_FILE_PART_DELAY_MS`，临时目录用完 `rmSync` 清理，
  返回「已自动分 N 片…合并：`cat 原名.00* > 原名`」拼进最终文本）；`SEND_FILE_MAX_PARTS`（默认 40）仅该模式检查。
  `SEND_FILE_SPLIT=off` → 超阈值**一个请求都不发**，直接给出含大小与建议的错误。
- `apiRequest` 对**非 JSON 错误体**（413 返回 HTML）改为抛 `QQApiError`，
  保留 `HTTP 413 Request Entity Too Large` 与前 300 字符原文，不再退化成
  `Failed to parse response` 把根因藏掉。`putPresigned()` 对非 JSON 错误体（如对象存储 XML）同理。

**端到端已验证（2026-10-06，真实 token）**：发送 6MB（6291456 字节）本地文件，收件人确认收到**单个**完整文件。
日志链路 `15:56:42 upload_prepare 200 → PUT 6291456 bytes 200 → upload_part_finish 200 →
POST /files(upload_id) 200 → messages 200`，桥日志 `[sender] 分片上传完成 … parts=1 → 服务端合并为 1 个文件`。
同一轮还证实：预签名 URL 在日志里被脱敏成 `part_1?<已省略>`，而实际 `PUT` 仍用完整带签名 URL（否则不会 200）。

**实测与文档的两处出入**（实现按「信响应、不假设」处理，因此**不需要改代码**）：

- 平台实际返回 `block_size = "10485760"`（**10MB**，非文档所称默认 5MB）→ 6MB 文件只出 **1 个分片**。
- 平台返回的 `parts[].index` 是 **1**（文档写「从 0 起」）。实现直接沿用响应里的 `index` 与 `presigned_url`、
  不自行编号，故不受影响；`upload_part_finish` 回传同一 `part_index` 得 200。

**尚未实测**：`>1` 分片的真实循环（多片 PUT + 800ms 节流 + 逐片 finish）目前只有契约级单测
（替换 `globalThis.fetch` 记录调用序列与请求体），真实环境需发一个 **>10MB** 文件才会走到。

**已知替代通道**：`[[sendfile:https://…]]` 走平台 URL 上传，由腾讯侧下载，**不受内联 body 上限**。
本机为 NAT 内网（无公网入站），可用 Tailscale Funnel 临时把本地文件暴露成公网 https URL
（需 tailnet 开启 Funnel：`https://login.tailscale.com/f/funnel?node=…`）。

## AI 提问（`question` 工具 → V2 表单）

上游把「AI 问选择题」当作普通工具调用，桥只看到 `session.tool.input.started`（`name=question`），
既推不出题目也没有回传答案的通道——用户侧表现为**提问石沉大海**，会话卡在 `executed:false, status:"running"`。

V2 把这件事建模成**表单（form）**，桥按下面的契约接：

| 端点 / 事件 | 用途 |
|---|---|
| `GET /api/form` | 全局待答表单（`{location, data: Form.Info[]}`） |
| `GET /api/session/{id}/form` | 某会话的待答表单 |
| `POST /api/session/{id}/form/{fid}/reply` |  body `{answer: {fieldKey: value}}`，成功 **204 无 body** |
| `DELETE /api/session/{id}/form/{fid}` | 放弃提问，204；已答复则 **409 FormAlreadySettled** |
| SSE `form.created` / `form.replied` / `form.cancelled` | 表单新增 / 已答 / 已取消，data 即 `Form.Info`（带 `sessionID`） |

`Form.Info` = `{id, sessionID, title, metadata, fields}`，`metadata.kind === "question"` 时是 `question` 工具创建的；
`fields[i]` = `{key:"q0", title, description, type:"string"|"multiselect", options:[{value,label,description}], custom}`。
答案是 `{q0: options[i].value}`，多选题为 `string[]`（`Form.Value`）。

**实现要点**

- `EventRouter` 新增 `registerFormCallback`（与 `registerPermissionCallback` 同为「最后注册者生效」）
  与 `hasListener(sessionId)`（判断本轮等待是否还活着）。表单事件**不 `continue`**，
  继续分发给会话监听者，让 `waitForSessionReply` 的 watchdog 续期（否则等用户作答会被判「无活动超时」）。
- `SessionManager.findUserIdBySessionId()` 反查 userId，把表单事件路由回对应的 QQ 用户。
- 渲染 / 序号翻译是纯函数 `src/opencode/questions.ts`，不碰网络，便于单测。
- 作答后若**没有在途等待**（超时过 / 桥重启过），用 `waitForSessionReply(startPrompt = 空)` 重新挂一个
  监听把 AI 后续输出接回来（`collectContinuation`），结果走**主动消息**。
- 待答表单 = 会话被阻塞，所以查到就拦下用户消息（补发题目 + 提示先作答），不向已阻塞会话转发新 prompt。
- 表单没有时间戳，无法判「新旧」；但表单只在答复/取消后删除，所以「查到即阻塞」成立。
  用户切走会话（`/new`、`/sessions`）时按 `sessionID` 不匹配丢弃旧提问。

## 后台任务（长命令自动转后台）

OpenCode 会把耗时较长的 shell 命令**移到后台**（工具返回 `Command moved to the background (shell ID: sh_…)`），
本轮随即结束；当后台命令完成时，OpenCode 会自动让 AI **继续输出**（新的一轮执行）。

**修复**：一轮结束后，桥会为该会话启动一个**后台监视器**：

- 识别到后台 shell 时，持续发送心跳 `⏳ 后台任务仍在进行（已用 X 分 Y 秒）…`（每 60 秒）；
- 自动继续执行时发送 `🔧 调用工具` / `💬` 等关键节点；
- 该轮结束时，把结果作为**主动消息**转发给用户；
- 用户下次发消息时自动停止旧监视器；监视器最长存活 `MONITOR_MAX_MS`（默认 2 小时）。

| 变量 | 默认 | 说明 |
|------|------|------|
| `MONITOR` | `on` | 是否启用后台监视器 |
| `MONITOR_MAX_MS` | `7200000` | 监视器最长存活时长 |

## 模型 / Agent 跨会话沿用

模型与 Agent 的绑定**跟随用户**，不随新建会话重置：

- 用户 `/model` 或 `/agent` 切换后，再 `/new` 建新会话，仍沿用上一次的模型/Agent。
- **只有用户主动切换才会改变**；不主动切换则始终不变（含机器人重启后从 `state.json` 恢复）。
- 从未绑定过的新用户，才使用兜底模型（免费读图模型，`resolveFreeVisionModel`）。

## Markdown 渲染

所有**文本消息**（最终回复、进度、命令回复、心跳、后台转发）都走 QQ **原生 markdown**（`msg_type: 2` + `markdown.content`），
agent 生成的标题/粗体/列表/代码块/引用等格式会原样呈现。

- 不再把 markdown 降级为纯文本（原 `formatForQQ` 仅在回退时使用）。
- 发送 markdown 失败时（如权限/格式问题）**自动回退为纯文本**重发，不会丢消息。
- 文件/图片（富媒体，`msg_type: 7`）不受影响。
- 开关：`MARKDOWN=off` 可关闭。

| 变量 | 默认 | 说明 |
|------|------|------|
| `MARKDOWN` | `on` | 文本消息是否使用原生 markdown |

## 已知问题修复（会话误绑）

**现象**：`/sessions` 会列出项目内**所有**会话（包括人类在 TUI 里正在用的会话）。
若选中了人类会话，机器人会把消息注入其中，并因为轮询兜底返回该会话「上一轮的助手回复」，
看起来像答非所问；首次回复后还会自动推送一次 help 菜单。

**修复**：
1. 机器人创建会话时写入 `metadata.openqq.owner = <QQ用户ID>` 作为归属标记。
2. `/sessions` 只列出 `owner` 等于当前用户的本机器人会话，杜绝误绑人类会话。
3. 轮询兜底只接受 `time.created >= 本次提问时刻` 的助手消息，不再把旧回复当结果。
4. 移除首次回复后自动推送的 help 菜单（需要帮助用 `/help`）。
5. 若曾误绑，删除 `~/.openqq/state.json` 并重启服务即可重新生成归属会话。