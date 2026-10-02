# openqq-bridge（OpenCode V2 版 QQ 机器人）

通过 QQ 机器人与 **OpenCode** 对话：群聊 `@机器人` 或私聊均可，支持命令、会话管理、
**图片/文件互通**、**中间进度**、**后台任务跟踪**、**原生 Markdown**、**模型跨会话沿用** 等。

---

## 来源与许可

本仓库是 **OpenCode V2 移植版 fork**：

- 上游一：[gbwssve/opencode-qq-bot](https://github.com/gbwssve/opencode-qq-bot)（MIT）——最初的 QQ ↔ OpenCode 基础桥
- 上游二：`@soulglad/opencode-qq-plugin` 0.1.0（基于上游一改造并发布到 npm，MIT）——本仓库的代码基
- 本仓库：[ddaayy/opencode-qq-bridge](https://github.com/ddaayy/opencode-qq-bridge)

OpenCode 从 V1 到 V2 的 **server API 与 SDK 是破坏性变更**，上游代码无法直接对接 V2，
因此本仓库**重写了 OpenCode 接入层**，并在此基础上新增了大量功能。
具体移植与变更细节见 [`PORT-NOTES.md`](./PORT-NOTES.md)。

许可证：**MIT**（见 [`LICENSE`](./LICENSE)）。

---

## 本仓库主要改动（相对上游）

1. **接入层重写为 OpenCode V2 API**：直接调用 `/api/*`，使用 HTTP Basic 鉴权，并支持**服务地址自动发现**。
2. **事件适配 V2**：基于 `session.text.*` / `session.execution.*` / `permission.asked` 等原生事件。
3. **中间进度**：工具调用、工具返回、中间说明、心跳等关键节点通过**主动消息**推送到 QQ。
4. **超时改为"无活动"判定**：有输出/工具调用就持续续期，不再固定 5 分钟硬超时。
5. **图片/文件双向互通**：QQ ↔ OpenCode 收发图片与文件（二进制落盘交给 AI 用工具处理）。
6. **后台任务监视器**：长命令转后台后，自动心跳并在 AI 续跑时把结果转发给用户。
7. **模型 / Agent 跨会话沿用**：用户不主动切换就不会改变（含重启恢复）。
8. **QQ 原生 Markdown**：agent 生成的格式原样渲染，失败自动回退纯文本。

---

## 功能特性

- **QQ 群聊 + 私聊**：`@机器人` 或私信
- **连接本机 OpenCode**：连接运行中的 OpenCode 服务（无需自启服务）
- **会话管理**：每用户独立会话，支持新建 / 切换 / 重命名
- **消息队列**：同一用户消息排队处理，不丢弃
- **权限自动应答**：`permission.asked` 自动回复（bash/工作区内 → allow，外部 → reject），避免询问悬空
- **图片识图**、**文件解析**、**机器人回传文件**
- **进度可见**：工具调用 / 返回摘要 / 中间说明 / 心跳
- **后台任务跟踪**
- **命令系统 + 透传**：未识别的 `/xxx` 透传给 OpenCode 原生执行

---

## 命令列表

| 命令 | 功能 |
|------|------|
| `/new` | 创建新会话（沿用当前模型/Agent） |
| `/stop` | 停止当前 AI 运行 |
| `/kill` | 终止 AI 处理 + 清空排队消息 |
| `/status` | 查看服务器与当前会话状态 |
| `/sessions` | 列出**本机器人创建的**历史会话，回复序号切换 |
| `/help` | 查看帮助 |
| `/model` | 列出可用模型，回复序号切换 |
| `/model <provider/model>` | 直接切换到指定模型 |
| `/agent` | 列出可用 Agent |
| `/agent <name>` | 切换 Agent |
| `/rename <name>` | 重命名当前会话 |
| `/cache` | 查看 token / 上下文统计 |
| `/compact` | 压缩会话 |
| 其他 `/命令` | **透传**给 OpenCode 原生执行（如 `/init`、`/review`） |

---

## 前置条件

- [Bun](https://bun.sh) >= 1.0
- [OpenCode](https://opencode.ai)（**V2**）已安装并正在运行
- QQ 机器人的 AppID 与 AppSecret（[q.qq.com](https://q.qq.com)）

## 安装与运行

```bash
bun install
bun run src/index.ts
```

首次运行会引导填写 QQ 凭证，保存到 `~/.openqq/.env`。

### 连接 OpenCode（自动发现）

默认自动发现本机运行中的 OpenCode 服务：

1. `OPENCODE_BASE_URL`（可选）；
2. 否则执行 `opencode service status` 取地址，并从 `~/.config/opencode/service.json` 读取密码。

也可显式指定：

```bash
# ~/.openqq/.env
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_PASSWORD=xxxxx
```

> OpenCode 后台服务端口是动态的。桥在启动时发现地址，SSE 断线时会**重新发现**；
> 若地址发生变化且连接未断，重启桥即可。

### systemd user 服务（可选，开机自启 + 崩溃重启）

`~/.config/systemd/user/openqq.service`：

```ini
[Unit]
Description=OpenQQ Bridge (OpenCode QQ Bot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=%h
WorkingDirectory=%h
ExecStart=%h/.bun/bin/openqq
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now openqq.service
```

---

## 配置说明

配置通过环境变量或 `~/.openqq/.env` 管理。

### 基础

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `QQ_APP_ID` | 是 | - | QQ 机器人 AppID |
| `QQ_APP_SECRET` | 是 | - | QQ 机器人 AppSecret |
| `QQ_SANDBOX` | 否 | `false` | 沙箱环境 |
| `ALLOWED_USERS` | 否 | 不限制 | 允许使用的 QQ 用户 ID，逗号分隔 |
| `MAX_REPLY_LENGTH` | 否 | `3000` | 单条回复最大字符数 |

### OpenCode

| 变量 | 默认 | 说明 |
|------|------|------|
| `OPENCODE_BASE_URL` | 自动发现 | OpenCode 服务地址 |
| `OPENCODE_PASSWORD` | 自动发现 | OpenCode 服务密码 |
| `OPENCODE_BIN` | 自动探测 | `opencode` 可执行文件路径（用于 `service status`） |
| `OPENCODE_WORKSPACE` | 服务端 cwd | 工作区目录（按 directory 过滤事件/会话） |

### 进度 / 超时

| 变量 | 默认 | 说明 |
|------|------|------|
| `PROGRESS` | `on` | 是否输出中间进度 |
| `PROGRESS_MAX` | `0` | 最多几条进度，`0` = 不限 |
| `PROGRESS_MIN_INTERVAL_MS` | `1200` | 进度消息最小间隔 |
| `PROGRESS_HEARTBEAT_MS` | `60000` | 无输出时心跳间隔 |
| `PROGRESS_TEXT_MAX` | `600` | 中间说明单条截断长度 |
| `PROGRESS_TOOL_CALL` | `on` | 是否输出「🔧 调用工具」进度 |
| `PROGRESS_TOOL_RESULT` | `on` | 是否输出工具返回摘要 |
| `PROGRESS_TOOL_RESULT_MAX` | `300` | 工具返回摘要截断长度 |
| `RESPONSE_IDLE_TIMEOUT_MS` | `600000` | 多久**无任何输出**判超时（有活动会续期） |
| `RESPONSE_MAX_MS` | `3600000` | 单次处理绝对上限 |

### 流式输出（实验性）

| 变量 | 默认 | 说明 |
|------|------|------|
| `STREAMING` | `off` | 流式输出开关（`on`/`off`），仅私聊生效 |
| `STREAMING_PROACTIVE` | `off` | 流式开流走主动消息通道（`on`/`off`）：不占被动回复预算，需用户在 QQ 客户端开启「允许主动消息」，失败自动回退被动。主动模式当前被 QQ 服务端拒绝（50015001），保留选项待官方放开 |
| `STREAMING_INTERVAL_MS` | `500` | 任意两次流式发送的最小间隔（防频控，对齐官方 SDK 默认节流） |
| `STREAMING_CHUNK_SIZE` | `500` | 兼容保留（replace 全量模式下不再切分正文单片） |

### 分场景文案（可选）

| 变量 | 默认 | 说明 |
|------|------|------|
| `TEXT_WAITING` | `请稍候{dots}` | 等待占位文案（`{dots}` 为动画点） |
| `TEXT_TOOL_CALL` | `🔧 调用工具：{tool}` | 工具调用进度 |
| `TEXT_TOOL_RESULT` | `📄 {tool} 返回：{result}` | 工具返回摘要 |
| `TEXT_TOOL_FAILED` | `❌ 工具失败：{error}` | 工具失败提示 |
| `TEXT_TEXT` | `💬 {snippet}` | 中间说明 |
| `TEXT_HEARTBEAT` | `⏳ 仍在处理中（已用 {min} 分 {sec} 秒）…` | 心跳 |
| `TEXT_PERMISSION` | `🔒 需要授权：{title}` | 权限提示（仅流式开启时显示） |
| `TEXT_BODY` | `{body}` | 正文模板（首片前缀） |

未配置时使用默认值（与现行文案逐字一致）；逐条覆盖，未知占位符原样保留。

### 附件 / 发文件

| 变量 | 默认 | 说明 |
|------|------|------|
| `ATTACHMENT_MAX_BYTES` | `26214400` | QQ 发来的附件体积上限（25MB） |
| `ATTACHMENT_DIR` | `~/.openqq/attachments` | 二进制附件落盘目录 |
| `SEND_FILE_MAX_BYTES` | `104857600` | 机器人发回文件的体积上限（100MB） |
| `SEND_FILE_HINT` | `on` | 是否在提示里注入发文件说明 |
| `SEND_FILE_INLINE_MAX_BYTES` | `4194304` | 单次内联 base64 上传上限（4MB），超过则分片 |
| `SEND_FILE_SPLIT` | `on` | 超过内联上限时自动分片发送 |
| `SEND_FILE_PART_DELAY_MS` | `800` | 分片之间的发送间隔（防频控） |
| `SEND_FILE_MAX_PARTS` | `40` | 分片数上限，超过则报错（避免刷屏） |

### 后台任务 / Markdown

| 变量 | 默认 | 说明 |
|------|------|------|
| `MONITOR` | `on` | 一轮结束后继续监视会话（转发后台任务自动输出） |
| `MONITOR_MAX_MS` | `7200000` | 监视器最长存活（2 小时） |
| `MARKDOWN` | `on` | 文本消息使用 QQ 原生 Markdown（失败回退纯文本） |

### 会话 / 模型绑定持久化（`~/.openqq/state.json`）

静态配置在 `.env`，动态绑定在 `state.json`：记录每个 QQ 用户的
**会话 + 模型 + Agent** 绑定；重启桥自动恢复；`/new` 沿用当前模型/Agent。

### 默认模型自动选择

未绑定模型的用户，启动时自动扫描模型，选择 **免费（cost=0）+ 支持读图** 的模型
（优先 `opencode/*`）。之后可用 `/model` 切换并持久化。

---

## 图片 / 文件

**QQ → AI**

- 图片：内联为 data URI，由支持视觉的模型识别。
- 文本类文件（`.txt/.md/.csv/.json/代码…`）：内联为 data URI，内容直接进入上下文。
- 二进制文件（`.sqlite/.pdf/.docx/.zip/…`）：**保存到磁盘**，并在消息末尾附路径
  （`[附件] xxx（mime）已保存到：/…`），由 AI 用工具处理。
  - 例：`.sqlite` 可用 `python3` 的 `sqlite3` 模块读取。
- QQ 对文件给的 `content_type` 常为 `"file"`（非法 MIME），桥会**按扩展名推断**正确 MIME。

**AI → QQ**

在回复中单独一行写标记：

```
[[sendfile:/绝对路径]]
```

桥会：剔除标记 → 上传富媒体 → 以 `msg_type=7` 发给用户；支持多个标记、`file://` 形式，
类型按扩展名判定（图片/视频/语音/文件）。失败会在文本末尾附 `⚠ 文件发送失败：…`。

标记里也可以直接写 **公网 URL**：

```
[[sendfile:https://example.com/pic.png]]
```

此时走 QQ 官方 **URL 上传**：平台自动下载转存，无需本地落盘；`file_type` 按 URL 扩展名推断
（图片/视频/语音/文件，未知扩展按文件处理），体积限制由平台侧处理（跳过本地 `SEND_FILE_MAX_BYTES` 检查）。

### 大文件：为什么必须分片

QQ 富媒体 `file_data`（base64 内联）通道实测（2026-10，`api.sgroup.qq.com`）：

| 文件大小 | 请求体 | 实测结果 |
|---|---|---|
| ≤ 4.5MB | ≤ 6.0MB | `200 OK`（稳定） |
| 5 ~ 14MB | 6.7 ~ 18.7MB | 频繁 `500 call inner proxy error`（`850012`） |
| ≥ 20MB | ≥ 26.7MB | `413 Request Entity Too Large`（`stgw` 网关硬拒绝，无重试机会） |

所以默认 `SEND_FILE_INLINE_MAX_BYTES=4MB`，超过就**自动分片**：首片作为被动回复关联原消息，
其余片走**主动通道**（不占单 `msg_id` 4 次被动回复预算），片间隔 `SEND_FILE_PART_DELAY_MS`，
分片临时文件用完即删。发送后会在最终文本里附说明与合并命令，例如：

```
📦 report.zip（48.3MB）超过单次上传上限 4.0MB，已自动分 13 片：report.zip.001 ~ report.zip.013。
合并：cat report.zip.00* > report.zip
```

分片数超过 `SEND_FILE_MAX_PARTS`（默认 40）时改为报错；`SEND_FILE_SPLIT=off` 则**不发任何请求**
直接报错（干净日志，不白传几十 MB）。

**更大文件的三个建议**（也会写进给模型的系统提示）：

1. 先压缩（如 `zip -9`）；
2. 提供公网 `https://` URL 走 QQ 的 URL 上传（腾讯侧下载，**不受 4MB 限制**）；
3. 关闭分片，由人来决定怎么传。

---

## 进度 / 超时 / 后台任务

- 关键节点（`🔧 调用工具`、`📄 工具返回`、`❌ 工具失败`、`💬 中间说明`、`⏳ 心跳`）走**主动消息**，
  不占用被动回复次数。
- 一轮结束后，若 OpenCode 把长命令**移到后台**，桥会：
  - 持续发送 `⏳ 后台任务仍在进行…` 心跳；
  - 后台命令完成、AI **自动续跑**时，把工具调用与结果转发给用户。
- 超时只看"**是否长时间完全无输出**"，有活动会持续续期。

---

## 流式输出（实验性）

`STREAMING=on` 后，私聊回复改为 QQ 官方**流式消息**：先发「请稍候…」占位气泡（点号动画），
随后按场景切换文案（工具调用 / 返回摘要 / 心跳等），AI 正文产出时每帧以
`input_mode=replace` 携带**当前累计全文**更新正文气泡（官方 SDK 同款语义）。

- **仅私聊生效**：群聊消息不支持流式参数，自动走原有发送逻辑。
- **错误自动回退**：任何流式接口失败（频控 / 前缀冲突 / 网络）都会自动降级为
  普通主动消息 + 最终全文被动回复，用户始终能收到完整结果。
- **频控重试**：50002 / HTTP 429 按官方策略最多重试 3 次（指数退避），重试时 `index` 前进；
  重试耗尽则跳帧不推进已下发基准，收尾比对失败自动回退全文。
- **思考标签剥离**：正文下发前剥离 `<thinking>`、`<system-reminder>`、`<previous_response>`
  及 deepseek 反引号风格等模型思考标签（官方 sanitize 同款）。
- **被动回复预算**：QQ 限制单条消息最多被动回复 4 次。`STREAMING_PROACTIVE=on` 时
  开流走主动消息通道（不带 `msg_id`），不占被动预算（开流上限放宽为 10，受主动消息
  20 条/分钟频控约束），兜底被动回复恒有名额；`STREAMING_PROACTIVE=off` 时开流名额
  只留给占位与正文：占位 + 正文 + 一次正文重置 ≤ 3（预留 1 次兜底），场景消息
  （工具调用/返回/心跳等）一律走主动消息，零开流消耗。
- **需真机验证**：流式接口的分片协议（终片形状、`msg_seq` 复用、40007 前缀约束）
  依据官方文档实现，沙箱/文档未覆盖的行为均已按可回退分支设计，建议先在小范围验证。

---

## Markdown

所有文本消息（回复 / 进度 / 命令 / 心跳 / 后台转发）默认使用 QQ **原生 Markdown**
（`msg_type: 2` + `markdown.content`），agent 生成的标题、粗体、列表、代码块等会原样渲染；
发送失败自动回退纯文本。`MARKDOWN=off` 可关闭。

---

## 工作原理

```
QQ 用户消息
   │
   ▼
QQ Gateway (WebSocket)
   │
   ▼
Bridge
   ├─ /命令 ──────────────► 命令处理 ──► 回复
   └─ 普通消息 ─► 队列 ─► OpenCode V2 API（prompt）
                          │        ▲
                          │        └─ HTTP Basic + 服务自动发现
                          ▼
                    SSE /api/event（session.text.* / execution.* / permission.asked）
                          │
             ┌────────────┴─────────────┐
             ▼                          ▼
       进度（主动消息）            最终结果（被动回复）
```

- 全局一个 SSE 连接，`EventRouter` 按 `sessionId` 分发
- 事件 + 轮询双通道：SSE 丢失时轮询兜底拉回结果
- 权限 `permission.asked` 自动应答

---

## 注意

- **QQ 被动回复次数有限**：最终结果用被动回复关联原消息；进度用主动消息，二者独立。
- **主动消息额度**由 QQ 侧限制；进度发送失败只记日志，不影响主流程。
- OpenCode 后台服务端口动态；桥会重新发现，必要时重启桥。
- 二进制附件会落盘到 `ATTACHMENT_DIR`，注意磁盘占用与清理。

---

## 致谢

- [OpenCode](https://opencode.ai) — AI 编程助手
- [gbwssve/opencode-qq-bot](https://github.com/gbwssve/opencode-qq-bot) — 最初上游（MIT）
- `@soulglad/opencode-qq-plugin`（marcusjiang）— 本仓库的代码基（MIT）
- [sliverp/qqbot](https://github.com/sliverp/qqbot) — QQ Bot API 封装参考
- [grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot) — 架构参考

## License

MIT