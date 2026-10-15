# 04 · 关键 Packages 内部结构化摘要

> 仓库根：`D:\coding\deepseek_harness\packages\`

按 group 整理，仅覆盖包内 README 的核心信息。专有名词保留英文。

---

## core/ — Agent 运行时核心

### core/agent
- **职责**：Agent 句柄、注册表、进程内 initiator scope、`agent/*` 事件词汇。
- **关键接口**：`ctx.agents`（create / resume / get / list / roots / isOwnedBy）、`Agent.followup / steer / inject / cancel / whenIdle`；事件 `agent/pre-step`、`agent/request-error`、`agent/turn-stopping`、`agent/assistant-stream`、`agent/status`、`agent/created`、`agent/disposed`、`agent/inbox/{inserted,claimed,discarded}`。
- **依赖/被依赖**：依赖 `dsh-agent-loop` 作为 driver；被 loop / sessions / tool-presence 回调用。
- **重要约定**：initiator scope 是 process-local，跨 worker / 进程 / 重启必须显式传递；`cancel()` 默认清空 inbox（可 `keepInbox`）；每个 `UserMessage` 仅有一个 `MessageSource`。

### core/agent-loop
- **职责**：默认 driver；创建 / 恢复 Agent、驱动 turn（模型请求、流式响应、工具执行、session 历史写入）。
- **关键接口**：声明式 `agents[]` 配置；`maxParallelToolCalls`（默认 10）；每步冻结请求；保证每个 `agent/message` 或 `agent/attempt` 在达成 settlement 时才 commit。
- **依赖/被依赖**：被 `dsh-agent` 通过 `AgentFactory` 注册；消费 session、LLM、tools 服务。
- **重要约定**：并发安全调用上限 10（1=serial）；parallel 分类基于 sibling / 资源对比；已关闭 inconsistent history 不重写；非 built-in provider 分类 unary。

### core/agent-default-model
- **职责**：为新建 Agent 提供默认 provider / model / reasoning effort（live Config 字段）。
- **关键接口**：`ctx.agentDefaultModel`；`currentSelection()`、`saveSelection({ provider, model, reasoningEffort? })`。
- **依赖/被依赖**：被 `core/agent-loop` 在缺省时读取。
- **重要约定**：未挂 `config-editor` 时 `saveSelection` 是 no-op；catalog 成员不验证，仅作 advisory。

### core/agent-tool-presentation
- **职责**：preset 内声明本 agent 的工具展示模式（native / ptc / both）。
- **关键接口**：单一必填 `mode`；`ctx.tools.presentAs(mode)`。
- **依赖/被依赖**：被 preset registry 加载；选 `ptc` / `both` 时强依赖 `ctx.ptcRuntime`。
- **重要约定**：第二声明同 id 失败（一个进程一个 tool 展示）；未挂 ptc runtime 时 preset 加载失败。

### core/scope
- **职责**：Cordis 无关的作用域注册隔离库；每个 Agent / 组独立贡献，祖先可见后代。
- **关键接口**：`createScope(ctx, key)`、`scopeTarget(base, key)`、`ScopedLayers / NamedEntries / AnonymousEntries`。
- **依赖/被依赖**：被 core 组各 registry 复用；plugin 作者分发。
- **重要约定**：仅 scope-aware API 隔离；分发上下文携带 minting plugin 的 service-resolution API；一个 context 一个最近 scope key。

### core/session
- **职责**：事件溯源的 session 日志（append-only）、model history 派生、fork、flush。
- **关键接口**：`ctx.sessions`（create / get / list / fork / flush）；`session.append(type, data, opts?)`、`deriveMessages()`、`session.snapshotEvents()`；事件 `system/developer/user/assistant/tool-result` 表面事件 + `assistant/attempt` / `tool/call` 等日志事件。
- **依赖/被依赖**：被 agent-loop、tool-pipeline、persistence 全部消费。
- **重要约定**：`model-visible ⟺ logged`；`header.system` 拒绝；`sourceEventSeqs` 描述 derivation；reload 后 seq 从 0 重计。

### core/system-prompt
- **职责**：系统提示组装 + 可用工具 schema 列表。
- **关键接口**：`ctx.systemPrompt`；`section({...})`、`variable(name, resolver)`、`suppressRuntimeContext()`；配置 `includeHarnessIdentity`、`includeRuntimeContext`、`personaPrefix`、`personaSuffix`、`toolOrder`。
- **依赖/被依赖**：被 tools、persona、sandbox-policy 等所有 prompt contributor 消费。
- **重要约定**：无效完整 prompt 组合组装失败；`toolOrder` 错配在配置 load 时失败；唯一 `complete: true` section 才能独占。

### core/tools
- **职责**：工具注册表 + 执行流水线（native / PTC 模式）。
- **关键接口**：`ctx.tools`（`register / guard / restrict / schemas / get`）；事件 `tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result`；`defineTool` DSL。
- **依赖/被依赖**：被 agent-loop 调度；消费 plugins（MCP / 自定义）；产出 schema 给 system-prompt。
- **重要约定**：非 native 模式需 `ctx.ptcRuntime`；`timeoutMs` 仅声明需 `timeout-policy` 强制；`tools/pre-execute` 不能重写 `exec.arguments`。

---

## session/ — Session 存储与衍生（最关键）

### session/session-format
- **职责**：纯库；规划相邻迁移、lossless JSON 校验、header-only 迁移、物理 codec 调度。
- **关键接口**：`createSessionFormatCatalog({ currentVersion, codecs, currentEncoder, migrations, restoreCurrent, restoreTransformedCurrent, restoreCurrentHeader })`；`readHeader`、`createRestore`、`decodeRow`、`finish`、`encodeCurrentHeader / Event`。
- **被依赖**：被 `session-persistence-jsonl`、`session-format-catalog` 使用。
- **重要约定**：物理 framing、压缩、生成命名、独占 publication、Cordis 生命周期外；无运行时 invariant companion。

### session/session-format-catalog
- **职责**：构建时静态 first-party codec 与相邻迁移装配。
- **关键接口**：`sessionFormatCatalog`（含 V0–V4 所有 codec）；`createSessionFormatCatalogWithChildren(childFacts)`。
- **重要约定**：catalog 不能被 plugin 增删；profile 不能添加或重排 edge；需 `dsh-session` peer 提供当前 vocabulary。

### session/session-format-v0-to-v1 / v1-to-v2 / v2-to-v3 / v3-to-v4
- **v0→v1**：frozen 历史 codec + 身份转换 + bounded legacy normalizations（steering→user、compact / compaction rename 等）。
- **v1→v2**：cardinality-changing 迁移，将 `assistant/chunk` 嵌入 `assistant/message`，failed attempt 落入 `assistant/attempt`；dense 序列重映射。
- **v2→V3**：promote 系统提示为 surface 节点；remap 局部引用；PTC tag 改名（`tool/code-dispatch-*`→`tool/ptc-dispatch-*`），plugin 名 `tools-code-mode` / `tools-ptc` → `ptc-mode`；canonical envelope 标准化；delivery markers 校验。
- **V3→V4**：tool result 提级为 role `tool`；message source 重命名（`compact`→`compact-checkpoint`、`@deepseek-ai/dsh-system-prompt`→`system-prompt` / `runtime-context`）；unknwon content 命名空间化为 `plugin:<name>`；parent catalog prerequisites；interrupted turn 收尾。
- **被依赖**：被 `session-format-catalog` 链式装配。
- **重要约定**：迁移拒绝模式化拒绝；released-current validation 仅跑 released-current rules。

### session/session-persistence
- **职责**：后端无关的持久化 seam：`create / open('write')` 取独写权、`open('read')`、`stat`、`list`、`flush`。
- **关键接口**：`ctx.sessionPersistence`；`SessionHandle.read / append / flush / close`、`handle.flush` 是 durability barrier。
- **重要约定**：append best-effort，flush 是 barrier；torn tail 不外露 reader；`commit` 句柄未读 prefix 即可见；single writer per backend。

### session/session-persistence-jsonl
- **职责**：每 session 一个 JSONL log（默认 Zstandard frames）；immutable 历史 generation 保留。
- **关键接口**：`root`（必填）、`compression`（`zstd` 默认）；`session.vN.jsonl.zstd` 文件命名。
- **被依赖**：base bundle 默认挂载。
- **重要约定**：format migration 保留编码；硬链接支持需求；POSIX 用 `flock`、Windows 用 ACL 命名内核 semaphore；flush 后 torn tail 不外露。

### session/session-projection
- **职责**：注册 projections（todo、stats、title、turnOutline），每事件 eager apply，`snapshot(session)` 给 client 一致快照。
- **关键接口**：`ctx.sessionProjections`；`register(definition)`；`ProjectionDefinition { key, stateSchema, stateVersion, init, apply, wire? }`；`snapshot(session)` 返回 `{ asOfSeq, values }`。
- **重要约定**：wire.view 必须返回 stable reference（Object.is gate）；whole-value rule；不能 remove state-version 校验；observability 由 persisted checkpoint cache 加速。

### session/session-projection-cache
- **职责**：将 projection checkpoints 持久化为 per-record domain（`session_projcache/sessions/<id>.json`），让 history lists 不重放整段 log。
- **关键接口**：`writeEveryEvents` + `writeIntervalMs`（必填）；`cachedSnapshot` / `coldSnapshot`；`cachedPredecessorTitle`。
- **重要约定**：log leads、cache follows；records 须 match live unit schema + lifecycle identity；schema 变更有 `tests/fixtures.spec.ts` 升级验证。

### session/session-log-deepseek
- **职责**：默认开启，将 canonical session event 通过 `dsh_session_log` 字段追加到 DeepSeek 官方 API 请求。
- **关键接口**：配置 `enabled`（默认 true）、`maxBytes`（8 MiB）、`sessionFormatVersion`、`afterSeq` / `throughSeq`。
- **重要约定**：通过 `request/context` event 仅识别 deepseek-account 凭据；并发交付按 max(throughSeq) 折叠；2xx 后才 accept，crash 后会 at-least-once 重发。

### session/session-checkpoint-policy
- **职责**：在模型请求前、top-level 工具 dispatch 前、`agent/pre-step` 边界做 checkpoint。
- **关键接口**：监听 `llm/stream`、`tools/execute`、`agent/pre-step`；调用 `ctx.sessionPersistence.flush`。
- **重要约定**：fail-closed（adapter / 工具拒绝则不进入）；Assistant transient stream 不持久；interrupted tool 标记 `TOOL_OUTCOME_UNKNOWN`。

### session/session-stats
- **职责**：提供 `sessionStats` projection — turns / steps / llmMs / toolMs / ttftMs / decodeMs / decodeTokens。
- **关键接口**：依赖 `sessionProjections`；提供统计字段（whole-log 范围）。
- **重要约定**：步骤计数包含 cancelled / max-tokens 步；token 计数 log-scoped 非 surface-scoped；compiled projection 不发 `fs/observed`。

### session/session-telemetry
- **职责**：capture 服务 seam；选定后端（OTel）按 `session.logging` (full / feedback-only / disabled) 投递。
- **关键接口**：`ctx.sessionTelemetry`；`emit / flush / shutdown` 三件套；`sessionTelemetry/record` waterfall；`sharing` disclosure。
- **重要约定**：非 blocking enqueue；best-effort delivery；crash 丢队列；不带任何内置 redaction rules。

### session/session-telemetry-otel
- **职责**：OTel JS SDK 适配器，独立 Session-log channel；mode = `FEEDBACK_ONLY` / `DISABLED`。
- **关键接口**：`mode`、`exporter.url`、`exporter.headers`、`processor`、`shutdownTimeoutMillis`、`maxRequestBytes`。
- **重要约定**：feedback authorization 是 trigger；inherited parent feedback 不清；每次仅 export 当前 feedback batch 已授权的 prefix。

### session/session-title
- **职责**：log-only `session/title` 事件，newest wins；可选 LLM provider；fallback 来自第一条 human `user/message`。
- **关键接口**：`ctx.sessionTitle.register(provider)`；`get(session)`、`foldSessionTitle(events)`、`refresh(session)`。
- **重要约定**：所有 3 个 limit（`fallbackMaxWords / fallbackMaxBytes / maxTitleBytes`）必填；最多 1 个 provider；explicit user rename pinning。

### session/session-turn-outline
- **职责**：提供 `turnOutline` projection — `{ turn, seq, prompt, response }`，便于 history 页跳转。
- **关键接口**：注册到 `sessionProjections`；whole-value rule。
- **重要约定**：prompt 仅来自 human `user/message`（`user` source）；response 在 `turn/end` 提交；open turn 仅显示 prompt preview；工具结果不污染 outline。

---

## llm/ — LLM 服务与适配器

### llm/llm
- **职责**：provider-neutral LLM 服务：stream、`listModels`、resolve model capability、`prepareCall()`。
- **关键接口**：`ctx.llm.stream(options)`；`listProviders / listModels / resolveModelInfo / prepareCall`；事件 `assistant/stream`（process-local）；错误码 `NO_ADAPTER / MISSING_CREDENTIAL / AUTH / RATE_LIMIT / CONTEXT_WINDOW_EXCEEDED` 等。
- **重要约定**：loop-built 请求深冻结不可改；文件 / FileBlock 永不送 provider，按 deterministic handle 文本替换；image-capable route 预算超限抛 `IMAGE_OFFLOAD_REQUIRED`。

### llm/llm-deepseek
- **职责**：DeepSeek Messages API 直连；twin adapter 之一。
- **关键接口**：`baseURL`、`apiKey`、`reasoningEffort`、`maxTokens`、`maxRequestFilesBytes`、`maxInlineRequestImageBytes`、`maxImagesPerRequest`、`filesApiTimeoutMs` 等。
- **重要约定**：文件 IDs scope by endpoint + credential；thinking 模式下 `temperature` 被忽略；不支持 SOCKS；`mid-conversation-tool-changes-2026-07-01` beta header 按需发送。

### llm/llm-deepseek-api-key
- **职责**：`deepseek-official` 路由注册 + API-key 凭据解析 + 模型目录。
- **关键接口**：`apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）。
- **依赖**：复用 `dsh-llm-deepseek` 的 transport。

### llm/llm-deepseek-account
- **职责**：`deepseek-account` 路由注册 + 账户 token 解析（`x-dsh-auth-token`）。
- **关键接口**：从 `ctx.deepseekAccount` 解析 token。
- **重要约定**：`QUOTA` 在本路由重写为 `ACCOUNT_QUOTA`；HTTP 401 映射 `ACCOUNT_TOKEN_INVALID` 且只在 token 仍匹配时清除登录。

### llm/llm-pi-ai
- **职责**：pi-ai 适配的多 provider / OpenAI-compatible 网关 / 自托管 server 路由。
- **关键接口**：`providers.<id>` 字典配置（apiKeyEnv / baseURL / api / compat / models / modelOverrides / reasoningEfforts / defaultContextWindow / requestImagePixelBudget 等）。
- **重要约定**：未配置路由时 dormant；OAuth / 交互式 key 登录通过授权 seam；discovery 不动 configured models；保存 selection 须 validation 通过。

> 注：`llm-replay` 与 `llm-mock-server` 不存在于此目录；实际 keyless replay 由 `test-support/llm-replay` 提供；fault server 由 `test-support/llm-mock-server` 提供。

---

## shell/ — Shell 执行器与工具

### shell/shell
- **职责**：shell 执行器 seam（Service Definition）；`resolve(request)` → `execute(spec)`。
- **关键接口**：`ctx.shell.execute(ctx.shell.resolve({ command }))`；`execution.result() / readOutput() / kill() / done`；`SHELL_SETTINGS_NAMESPACE`。
- **重要约定**：每组合一 provider（local / sandbox）；timeout policy 见 timeout-policy；机器执行单元用户测试。

### shell/bash-local
- **职责**：POSIX Bash executor；每次 `bash -c` 新进程，no rc files。
- **关键接口**：`cwd`、`timeoutMs`（默认 120000）、`maxTimeoutMs`（600000）、`maxOutputBytes`（64000）、`maxSpillBytes`（67MB）、`graceMs`（3000）。
- **重要约定**：无沙箱（unconfined）；`NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat`；process group 终止。

### shell/bash-sandbox
- **职责**：沙箱版 Bash executor（消费 `ctx.sandbox.confine()`）。
- **关键接口**：配置继承 bash-local；`sandbox_permissions`（enum）+ `justification` 由 tool 暴露。
- **重要约定**：fail-closed（无可用 runner 时 `SANDBOX_UNAVAILABLE`）；denied 命令 reports `sandbox: { mode, denied: true }`；网络不受限。

### shell/pwsh-local / pwsh-sandbox
- **pwsh-local**：PowerShell executor，Windows counterpart；`pwshPath` / `pwshArgs` 解析；UTF-8 输出 pin。
- **pwsh-sandbox**：ACL restricted-token 后端；Windows 上语言模式 + named-pipe 受限；`sandbox_permissions` + `justification`。

### shell/tool-bash
- **职责**：模型 `bash` tool；job 注册（`dsh-jobs-local`）后台；沙箱拒绝可升级一次。
- **关键接口**：`command`、`description`、`workdir`、`timeoutMs`、`run_in_background`；配置 `enableRunInBackground`、`promoteOnTimeout`。
- **重要约定**：非零 exit 报告 `[exit code: N]`；cancellation 也清空 inbox；`sandbox_permissions` 须在沙箱 executor 下。

### shell/tool-bash-persistent / tool-pwsh-persistent
- **职责**：每 agent 一个 PTY shell（bash / pwsh）；状态跨 call 保留。
- **关键接口**：`backendType`、`timeoutMs`（300000）、`maxOutputChars`（16000）、`description`。
- **重要约定**：reset / timeout / 取消丢弃状态；PSReadLine echo 仍可见（pwsh 包会话读包含）。

### shell/shell-env
- **职责**：managed `DSH_*` 环境（`DSH_HOME`、`DSH_SHELL=1`、`DSH_SESSION_ID`、`DSH_PROFILE`、`DSH_PROFILE_DIR`）；插件通过 `ctx.shellEnv.register({ name, variables, resolve })` 贡献。
- **重要约定**：重复 key 或 reserved 名（`DSH_HOME` 等）失败 loud；变量名必须 `DSH_*` 全大写下划线。

---

## terminal/ — Persistent PTY

### terminal/terminal
- **职责**：`ctx.terminals` 服务；mint session id、路由 backend 创建、清理 owner。
- **关键接口**：`open / send / read / signal / kill / list`；失败码 `NO_BACKEND / NO_SESSION / FOREIGN_SESSION / SEND_ACTIVE / OWNER_NOT_LIVE`。
- **重要约定**：单 owner、Agent fencing；`ShellProcess.observed` 是非消费 offset 读。

### terminal/terminal-bash
- **职责**：shipped `shell` backend（bash / pwsh via `shellDialect`）；同步 sandbox policy；line-oriented。
- **关键接口**：`backendType`、`shellDialect`、`maxReadBytes`（262144）、`timeoutMs`（30000）、`disposeGraceMs`（3000）。
- **重要约定**：readiness 三层（exact stdin wait / prompt marker / silence）；`shellActivity` 仅可被支持的 linux 进程立即证据。

### terminal/tool-terminal
- **职责**：六个模型 terminal 工具（`terminal_open / send / read / signal / close / list`）。
- **关键接口**：`enableRunInBackground`、`maxResultBytes`（262144）。
- **重要约定**：owner-scoped；background mode 需 jobs 运行时。

---

## ssh/ — SSH 远端宿主

### ssh/ssh
- **职责**：OpenSSH 连接配置 + helper 生命周期。
- **关键接口**：`host`（必填 OpenSSH alias）、`node`、`helper`、`workspace`、`helperHash`（SHA-256）、`bootstrapPath / Hash`、`requestTimeoutMs`、`maxFrameBytes`、`maxPending`、`leaseMs`。
- **重要约定**：两端 Linux / macOS；每 stream 独立 forwarded Unix socket + TLS pre-shared key；无 reconnect；helper 启 `--disable-sigusr1` 阻断 Node debugger。

### ssh/fs-ssh / subprocess-ssh / sandbox-ssh
- **fs-ssh**：SSH 上的 `ctx.fs`；与 fs-local / fs-sandbox 复用；`processPathFromHostPath` 返回 undefined。
- **subprocess-ssh**：SSH 上的 `ctx.subprocess`；fd 7 独立 channel；remote-native ownership；`waitForExit` 独立证明 quiescence。
- **sandbox-ssh**：SSH 上的 `ctx.sandbox`；复用 SSH helper 的本地 sandbox backend；workspace 必须在 remote canonicalize。
- **重要约定**：TLS stream keys 不能防御 remote 进程内存扫描；SSH host + helper 是 trusted 基础设施。

---

## subprocess/ — 进程管理

### subprocess/subprocess
- **职责**：`ctx.subprocess` Service Definition；`resolveExecutable`、`spawn`（完整 spec）、`waitForExit`、`spawnTerminal`；`scrubbedParentEnv()`。
- **重要约定**：argv 永不 shell-interpret；环境 scrub 凭证 + `DSH_*`；SDK-managed spawn 例外；终端 spec signal 与 handle 生命周期分离。

### subprocess/subprocess-local
- **职责**：本地 provider；Linux 用 user-systemd scope、Windows 用 kill-on-close Job、macOS / 旧 Linux 用 PGID / taskkill fallback；`node-pty` PTY。
- **关键接口**：无配置（依赖请求 spec）；`terminalEnvironment()` 读 `SHELL` / `ComSpec`。
- **重要约定**：`graceMs` 须 positive + finite 且 ≤ `MAX_TIMER_DELAY_MS`；credential scrub 是 name heuristic；spill 文件 0600 + 0700 目录防 symlink planting。

### subprocess/win32-process
- **职责**：低层 Win32 过程原语（Koffi binding）。
- **重要约定**：仅 Windows ABI（header-verified）；`CreateProcessAsUserW` 用 null env（Koffi bug）；8 KiB 起步的 `STARTUPINFOW` / `PROCESS_INFORMATION` 校验；claim Job 之间的窄间隔可能留 suspended target。

---

## sandbox/ — 沙箱执行

### sandbox/sandbox
- **职责**：进程沙箱 seam；`confine(argv, policy, signal)`；`SANDBOX_UNAVAILABLE` 失败 closed。
- **关键接口**：`ctx.sandbox`；模式 `read-only / workspace-write / danger-full-access`；enforcement 报告 `full / partial`；`approveEscalation` 单一 ladder。
- **重要约定**：仅文件效果；same-world confinement only；denial reporting 通过 stderr dialect 推断。

### sandbox/sandbox-local
- **职责**：本地 per-platform runner（Linux bwrap / Landlock、macOS Seatbelt、Windows ACL restricted-token）。
- **关键接口**：`runnerCommand`、`runnerFailureSignatures`、`probeTimeoutMs`（5000）。
- **重要约定**：runner 选择按平台链 + 功能 probe 缓存；runnerCommand 是 operator assertion（跳过 probe）；Windows `partial`（NTFS hard link / 读 unconfined / AppContainer ACL）。

### sandbox/sandbox-policy
- **职责**：每 session / per-call 沙箱政策解析器（`mode` + `workspaceRoot`）；runtime-context `sandbox:policy` 提供给 model。
- **关键接口**：`ctx.sandboxPolicy.resolve({ session, mode })`；事件 `sandbox/mode`（log-only，session-local）。
- **重要约定**：默认 `read-only`；session choices 重启后通过 replay 存活；workspace = `SessionHeader.cwd`。

### sandbox/sandbox-windows-acl
- **职责**：Windows 写限制沙箱后端（ACL restricted-token）。
- **关键接口**：`AclSandbox`、`workspaceWriteSid`、`tempWriteSid`；`init()` 失败即 throw；bundled `diagnose-windows-sandbox-acl` skill。
- **重要约定**：写授权是 intersection（Windows 双重检查）；`FILE_DELETE_CHILD` 必须对 world 拒绝；NUL 写 ambient；keep-alive group（logon + Everyone）保留防 `0xC0000142`。

---

## web/ — Web 访问

### web/web
- **职责**：web 访问 seam（搜索 + fetch）；执行时选定 usable provider。
- **关键接口**：`ctx.web.search({ query, maxResults })`、`ctx.web.fetch({ url })`；`searchProvider / fetchProvider`；错误码 `WEB_PROVIDER_*`。
- **重要约定**：`maxResults` 在 seam 处裁剪；非 2xx 是 result 非 error；provider availability 廉价本地检查；closed union `WebFetchBody`。

### web/tool-web
- **职责**：模型 `web_search` / `web_fetch` tool。
- **关键接口**：`queries[]`、`url`、`searchMaxQueries`、`fetchTimeoutMs`、`fetchMaxOutputChars`、`search/fetch` enabled。
- **重要约定**：results 标注 "external untrusted data"；HTML → markdown（turndown）；公共 fetch 不需审批（仅通过 `WEB_BLOCKED_URL` 防非公共目的地）。

### web/web-fetch-http
- **职责**：anonymous public HTTP(S) fetch backend。
- **关键接口**：`maxResponseBytes`（5MB）、`maxBodyChars`（100000）、`timeoutMs`（30000）、`maxRedirects`（5）、`userAgent`。
- **重要约定**：URL ≤ 2048 字符；non-public 地址拒绝；connection pinning；仅 html / text + JSON + XML；charset 来自 Content-Type。

### web/web-search-deepseek
- **职责**：DeepSeek 官方搜索 backend（一次 = 一次 model turn）。
- **关键接口**：`apiKeyEnv`、`baseURL`（默认 `https://api.deepseek.com/anthropic/v1`）、`model`、`apiVersion`、`maxTokens`、`maxUses`。
- **重要约定**：从结构化 `web_search_tool_result` 块 parse；提供商 prose 不被信任；`maxResults` post-hoc truncate。

### web/web-search-exa / web-search-perplexity
- **exa**：Exa 适配；`apiKey` 默认 `$EXA_API_KEY`、`baseURL`、`searchType`、`numResults`、`highlightsPerResult`；无 snippet 即 drop。
- **perplexity**：OpenAI-compatible `/chat/completions`；`apiKey`、`baseURL`、`model`、`maxTokens`、`searchRecency`；generated answer 作为 `content`；fallback `citations[]` URL-only。

---

## fs/ — 文件系统

### fs/fs
- **职责**：`ctx.fs` seam：resolve / stat / read / list / write / edit / watch；事件 `fs/write-intent`、`fs/edit-intent`、`fs/observed`。
- **关键接口**：`resolve(path, { cwd })`、`readText / streamText / readBytes / readByteRange`、`listDir`、`writeText / editText`；`watch(target, changed, signal)`；错误 `FS_NOT_FOUND / FS_NOT_TEXT / FS_STALE_VERSION / FS_AMBIGUOUS_EDIT`。
- **重要约定**：binary content 拒绝；`readBytes` 必须 `maxBytes` 失败 `FS_TOO_LARGE`；`editText` 单 critical section。

### fs/fs-local
- **职责**：host filesystem backend；realpath identity；per-target mutation lock；atomic write via hard-link 替代。
- **关键接口**：`cwd`、`diffBasisMaxBytes`（10 MiB）。
- **重要约定**：`config.cwd` 仅解析默认，非 containment；POSIX `symlink/..` 走文件系统语义。

### fs/fs-sandbox
- **职责**：在每次 mutate 前 check sandbox mode；reads 始终 unconfined。
- **关键接口**：配置同 fs-local。
- **重要约定**：`read-only` 拒绝所有 mutate；`workspace-write` 仅 workspace + temp；denied mutate 返回 `FS_SANDBOX_DENIED`。

### fs/fs-observation-policy
- **职责**：read-before-edit gate（通过 `fs/*` events，不注册 service）。
- **关键接口**：无配置；注入到 `fs/*` events。
- **重要约定**：决策 slot single-wins；observation 状态 HMR-safe、不持久化跨 session；无 agent 的调用永远 `FS_NOT_OBSERVED`。

### fs/tool-fs
- **职责**：模型 `read / read_image / write / edit` 工具。
- **关键接口**：`file_path`、`offset / limit`、`old_string / new_string / replace_all`；配置 `readLimit / readMaxLineLength / readMaxBytes / readStreamMinSize`。
- **重要约定**：`read_image` 仅 durable attachment store + image-capable model；snake_case 参数名；`__proto__` 不脱敏。

### fs/tool-fs-search
- **职责**：模型 `glob` / `grep` 工具；自带 ripgrep；不需要 host `rg`。
- **关键接口**：`sampleOverCapGlobResults`（必填）；`globMaxResults / grepMaxMatches / grepMaxLineBytes / rawOutputMaxBytes / timeoutMs / graceMs / stderrMaxBytes / searchMetaMaxBytes`。
- **重要约定**：VCS metadata 排除；hidden + ignored 包含；错误码 `SEARCH_INVALID_PATTERN / SEARCH_FAILED / SEARCH_RAW_OUTPUT_OVERFLOW / SEARCH_ABORTED`。

---

## browser-use / computer-use

### browser-use/browser-use
- **职责**：浏览器 provider 注册服务（`ctx.browserUse`）；一个进程最多一个 provider。
- **关键接口**：`ctx.browserUse.register(BrowserUseProviderName(name))`；`providerName` 读取。
- **重要约定**：重复加载失败；不参与 model-visible。

### computer-use/computer-use
- **职责**：桌面 provider 注册服务（`ctx.computerUse`）；同一机制。
- **重要约定**：shared desktop 桌面，无跨 session 协调。

---

## subagent/ — 子代理委派

### subagent/subagent
- **职责**：委派 seam；`ctx.subagents`；命名 provider 注册表。
- **关键接口**：`start()`（one-shot）+ `startContinuable()`；`sendMessage()`、`interrupt()`、`listChildren()`；provider capabilities：`agentOptions / outputSchema / depthLimit / toolFilter / persona / prepareContinuable / inheritsParentContext`。
- **重要约定**：`maxActiveSubagents` 默认 8（continuable 池共享）；`ACTIVATION_LIMIT_REACHED` 拒绝新启；描述符是 log-only event；持续 child 可 cold-resume。

### subagent/subagent-fork-in-process
- **职责**：in-process fork backend；child seed = 父的平衡 completed-turn prefix。
- **关键接口**：`providerName`（默认 `fork`）；`agentOptions` advertised。
- **重要约定**：seed 一次性快照；base bundle + ACP / headless 配 one-shot；CLI presets 配 continuable。

### subagent/subagent-spawn-in-process
- **职责**：in-process spawn backend；fresh empty conversation。
- **关键接口**：`providerName`（默认 `spawn`）；advertise `agentOptions`。
- **重要约定**：child 继承 cwd、lineage、provider、model、reasoning effort、output-token cap；不复制父 conversation。

### subagent/subagent-acp
- **职责**：out-of-process ACP backend；每个 run 新进程 + 新 remote session。
- **关键接口**：`command`（必填）、`args`、`cwd`、`permission`（`reject / allow`）、`env`、`disposeEofGraceMs`、`disposeGraceMs`。
- **重要约定**：完全进程隔离；不支持 `agentOptions / outputSchema / depthLimit / toolFilter / persona`；safe diagnostic 限制 4096 字节。

### subagent/subagent-claude-code / subagent-codex
- **claude-code**：Claude Code Agent SDK 适配；one-shot 一进程；permissionMode `dontAsk / acceptEdits / auto / plan / bypassPermissions`；host settings 权威；无 host-CLI fallback。
- **codex**：Codex app-server JSON-RPC；permissionMode `never / approve-for-me / dangerously-bypass-approvals-and-sandbox`；pinned `@openai/codex@0.153.4`；ephemeral thread。

### subagent/subagent-dsh-sdk
- **职责**：out-of-process DSH subprocess；完整 harness peer。
- **关键接口**：`profile`（默认 `sdk`）、`patches`、`dshHome`（必填）、`provider / model / maxTokens`、`shutdownTimeoutMs`、`disposeEofGraceMs`、`disposeGraceMs`。
- **重要约定**：advertise `agentOptions: true`，`outputSchema / depthLimit / toolFilter / persona: false`；不支持 structured output 等本地 cap。

### subagent/subagent-in-process-driver
- **职责**：shared one-shot 驱动库；spawn / fork 调用 `startInProcessRun()`。
- **重要约定**：使用 agent factory 的 unpublished setup window；`structured_output` tool + 后置 order-9900 段落。

### subagent/tool-subagent
- **职责**：模型委派工具；`provider` + `toolName` + `modelSelectionSettings / enableRunInBackground / backgroundMode / agentOptions / persona / toolFilter / maxDepth`。
- **重要约定**：mirror provider 生命周期；`maxDepth: 'provider-managed'` 让 out-of-process provider 管；`list_subagent_models` 全局唯一。

### subagent/tool-subagent-control
- **职责**：`send_message`、`interrupt_agent`、`list_agents` 三个控制工具。
- **重要约定**：精确 live agent 间通信；`interrupt_agent` 只停当前 turn；`list_agents` scope `children` / `descendants`。

---

## workflow/ — 工作流编排

### workflow/workflow
- **职责**：工作流 seam；`ctx.workflowEngine`；model-written JavaScript 脚本 + `agent() / parallel() / pipeline() / phase() / log()` hooks。
- **关键接口**：`start({ script, meta, args?, parent, signal? })`；事件 `workflow/start`、`workflow/end`、`workflow/phase`、`workflow/log`、`workflow/agent-start`、`workflow/agent-end`。
- **重要约定**：result 不 reject；`WorkflowError` fatal；foreground only；runs holder-owned。

### workflow/workflow-ptc
- **职责**：PTC Node 进程执行引擎；子进程 under sandbox policy。
- **关键接口**：`provider`、`maxConcurrentAgents`、`maxTotalAgents`、`maxItemsPerCall`、`syncTimeoutMs`。
- **重要约定**：`timeoutMs: null`；无 elapsed 计时；caps 是 cooperative；failure fails 整个 run。

### workflow/tool-ralph
- **职责**：模型 `ralph` 工具；fixed foreground fresh-child loop 走向 immutable objective。
- **关键接口**：`objective`、`maxRounds?`；配置 `subagentProvider`、`maxRounds`、`maxHandoffChars`、`maxResultChars`。
- **重要约定**：provider 须支持 structured output + `inheritsParentContext: false`；终端 `complete / blocked / budget-limited`；workspace 是 cross-round 长期记忆。

### workflow/tool-workflow
- **职责**：模型 `workflow` 工具；`meta` + `script` + `args` + `run_in_background`。
- **关键接口**：`toolName`、`maxResultChars`（50000）、`enableRunInBackground`。
- **重要约定**：foreground 等待；cancellation / 失败返回 error；`maxResultChars` 截断 model 投影（canonical JSON 完整保留）。

---

## mcp/ — Model Context Protocol

### mcp/mcp-client
- **职责**：外部 MCP server 桥（stdio 或 streamable-http）；tool 注册到 `ctx.tools`，名字 `mcp__<server>__<tool>`。
- **关键接口**：`transport`、`serverName`、`command / args / env / cwd`、`url / headers`、`toolCallTimeoutMs`、`failOnStartupError`、`reconnect.*`。
- **重要约定**：stable identity `(serverName, rawName)` 含 SHA-256 suffix；session history 与 permission 规则跨重启稳定；image 是唯一 durable rich result。

### mcp/mcp-resources
- **职责**：shipped profile 默认挂载；`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` 三个共享 tool。
- **关键接口**：依赖 `ctx.mcp` 注册表；`serverName` 参数必填。
- **重要约定**：资源按需；订阅 / 通知 / MCP prompt templates 不支持；binary 资源保留 base64 给程序性调用方。

> 注：`mcp/mcp` 顶层 package 不存在；hook-protocol 同理（`hooks/hook-protocol` 才是真包）。

---

## hooks/ — Claude Code / Codex hooks 桥

### hooks/hook-protocol
- **职责**：shared rules for both bridges — matcher、runner、codec、merge、events、detached、invariant。
- **关键接口**：不直接安装；被两个桥加载；`createDetachedRuns`。
- **重要约定**：exit 2 = block；`deny > ask > allow` 折叠；`hook/*` 是 log-only event。

### hooks/hooks-codex
- **职责**：Codex `hooks.json` bridge；支持 5 个 hook 点（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop）。
- **关键接口**：`configPath`、`model`、`defaultTimeoutMs`、`stderrSummaryMaxChars`。
- **重要约定**：unsupported events（PermissionRequest / PreCompact / PostCompact / SubagentStart / SubagentStop）静默 drop；`tool_input` 仅含 `command`。

### hooks/hooks-claude-code
- **职责**：Claude Code `hooks.json` bridge；7 个 hook 点（含 SubagentStart / SubagentStop）。
- **关键接口**：`configPath`、`pluginRoot`、`projectDir`、`defaultTimeoutMs`、`stderrSummaryMaxChars`。
- **重要约定**：23 个 unsupported events 静默忽略；`PreToolUse` 支持 `deny / ask`；`Stop` 强制继续但 `stop_hook_active` 永远 false。

---

## webhook/ — Webhook

### webhook/webhook
- **职责**：`ctx.webhookRuntime` 服务；trusted 编程式 webhook 规则注册 + 内建动作（创建 root session）。
- **关键接口**：`WebhookRule<K>.run(delivery, signal)`；`WebhookSessionRequest { workspacePath, title, prompt, agentPreset, permissionPreset, model? }`。
- **重要约定**：fire-and-forget process-local；不重放；no completion result；`Agent.followup()` 是 commit point。

### webhook/webhook-github
- **职责**：GitHub webhook 适配器；注册到 `ctx.webServer`；HMAC-SHA256 验签。
- **关键接口**：`source`、`path`、`secretEnv`、`maxBodyBytes`。
- **重要约定**：仅 `POST application/json`；不打印 secret / signature / payload；`202` 不保证规则 / Session 创建成功。

---

## bundle/ — Profile bundles

### bundle/base
- **职责**：所有 base-backed profile 的核心（model、tools、sessions、safety）。
- **重要约定**：静态 `cordis.patch.yml`；platform-gating shell stack；mount MCP resources；OTel 默认 `FEEDBACK_ONLY`；`session-log-deepseek` 默认开启。

### bundle/web-app
- **职责**：`dsh --profile web` 浏览器交互界面；`web-startup` 命令参数 + `web-app` glue（dist serving、LAN trust sampling、URL line、browser handoff）。
- **关键接口**：`openBrowser`、`printUrl`、`surfaceContext`、`trustedHosts`。
- **重要约定**：启动后 URL line 含 process token；`--no-open` 禁用自动打开；`--host 0.0.0.0` 拒绝（默认 loopback only）。

### bundle/headless
- **职责**：`dsh --profile headless` 一次性 CLI runner。
- **关键接口**：`task`（位置参数或 stdin）、`sessionId`、`json`（JSON event stream）。
- **重要约定**：exit code 0=completed、1=error / aborted；reasoning 走 stderr 默认；cwd / ownership / preset-scoped adoption。

### bundle/sdk-app / bundle/sdk-minimal
- **sdk-app**：`dsh --profile sdk`；基于 dsh-base；编码代理 persona；JSON-RPC server；stdout 仅协议。
- **sdk-minimal**：standalone；只有 1 个 persistent shell；`danger-full-access`；uncompressed JSONL；适用于隔离 workspace。

### bundle/acp-app
- **职责**：`dsh --profile acp`；基于 dsh-base；启动 ACP server；stdout 仅协议。

---

## sdk/ — SDK 客户端 / 服务端

### sdk/client（`@deepseek-ai/dsh-sdk-client`）
- **职责**：TypeScript SDK client；spawns `dsh` subprocess over stdio JSON-RPC。
- **关键接口**：`DeepSeekHarness`（owned runs）、`HarnessClient`（protocol-level）、`run(input, { sessionId?, onNotification? })`、`subscribe()`、`prompt()`、`request()`。
- **重要约定**：subprocess 由 client 拥有；`maxTokens` 继承 by in-process descendants；无 mid-turn cancel（关闭 runtime）；错误类 `JsonRpcResponseError / RequestTimeoutError / SdkProtocolError / TransportClosedError`。

### sdk/server（`@deepseek-ai/dsh-sdk-jsonrpc-server`）
- **职责**：stdio JSON-RPC 服务插件；stdout 仅 JSON-RPC 帧。
- **关键接口**：`initialize`（返回 `serverInfo.name: 'deepseek-harness-sdk-runtime'`）、`session/prompt`、`shutdown`；通知 `session.event`、`session.status`、`subagent.started`、`subagent.finished`。
- **重要约定**：请求可并发但 `session/prompt` 在 `initialize` 成功前拒绝；stdout 纯净。

### sdk/protocol（`@deepseek-ai/dsh-sdk-protocol`）
- **职责**：共享 wire library（`JsonRpcLineTransport` + named types）。
- **重要约定**：no protocol-version negotiation；无 cancel / session-close 方法；server → client requests 是 dead capability（等待 future approval flows）。

---

## acp/ — Agent Client Protocol

### acp/acp
- **职责**：automation-only ACP stdio server；持久 root session。
- **关键接口**：完整 ACP v1 surface + `session/list`、`session/resume`、`session/close`；image prompts（仅 PNG / JPEG / WebP / GIF）。
- **重要约定**：每个 connection 多 session；MCP stdio / HTTP entries 由 client 授权；不支持 deletion / fork / modes / commands / plans / terminals / elicitation；admission 失败 → prompt 不 enqueue。

---

## boot/ — 启动与配置

### boot/app-boot
- **职责**：`dsh` launcher 共享 boot 库；环境层、profile bundles、patch 加载、boot 每个插件。
- **关键接口**：`installFailLoud('dsh')`、`boot('dsh', resolveConfigPath(...))`；profile 路径 `$DSH_HOME/profiles/<name>`；`loadProfileDirectory`、`sanitizeProfile`、`readPluginMeta`、`generateConfigSchema`。
- **重要约定**：required-list 全局覆盖 `agent-loop / webserver / modules / connection / headless-runner / acp / sdk-jsonrpc-server`；版本 peer 检查；`--dump-config` 报告实际配置；peer-aware ancestor lookup。

### boot/cmdline
- **职责**：app-owned 命令行（`ctx.cmdlineArgs`、`ctx.appExit`、`ctx.appReady`）。
- **关键接口**：`provideCmdline`、`parseCmdline`、`exitOnStdinEnd`；基于 commander。
- **重要约定**：launcher flags 必须先于 app arguments；`--` literal 保留。

### boot/config-editor
- **职责**：保存插件配置到 active profile 的 `cordis.patch.yml`；atomic replacement。
- **关键接口**：`ctx.configEditor.edit()`。
- **重要约定**：home 和 invocation patches 不写；保留 YAML 注释与 `!!js` 表达式。

### boot/hmr
- **职责**：reload 插件代码和配置（共享队列）；`ctx.hmr`。
- **关键接口**：`base`、`root`、`ignored`、`debounce`（100 ms）、`awaitWriteFinish`。
- **重要约定**：package 安装独立运行；watched paths 通过 Node ESM `realpathSync()`。

### boot/plugin-manager
- **职责**：Web sidebar / agent `plugin_manager` tool；bundle 安装 / 移除 / 启用。
- **关键接口**：`pnpmCommand`、`inspectTimeoutMs`、`githubConnectionTimeoutMs`、`registry`、`fallbackRegistries`、`outputBytes`、`lockWaitMs`、`idleTimeoutMs`；方法 `listBundles / enable / disable / install / inspect / cancelInstall / set_version_exemption`。
- **重要约定**：版本兼容性通过 `compatibility.json`（exact `pkg@version`→runtime）；registry fallback chain；GitHub 仓库预检 `git ls-remote`。

---

## preset/ — Agent preset

### preset/agent-preset
- **职责**：在普通 Cordis YAML 中声明 Agent 子插件。
- **关键接口**：`id`、`plugins[]`、`name?`、`description?`、`order?`。
- **重要约定**：需要 `agentPresets` service；duplicate ID 失败；附带 `skills/` directory（agent-experience、cordis-plugin-development、editing-cordis-compositions、cordis-composition-reference）。

### preset/agent-preset-registry
- **职责**：preset 目录；声明每个 preset 的 Loader tree；`default`。
- **关键接口**：`ctx.agentPresets`；`read` Remote 渲染 child list YAML。
- **重要约定**：每个 declaration 急切创建 registry-owned scope；activation auditing 拒绝 import 失败 / 全局 leak；revisions 保留到释放。

### preset/persona
- **职责**：preset 内 composable persona row；shadow deployment-wide persona。
- **关键接口**：`prefix`（必填）、`suffix`、`complete`、`includeRuntimeContext`。
- **重要约定**：mount 在 agent scope 内（否则与 prompt registry global persona 冲突）；`complete: true` 时独占 system prompt。

---

## experimental/ — Pre-stable prototypes

### experimental/
- **职责**：group map；公开可装 pre-stable 包，contracts 可变、no support promise。
- **重要约定**：所有 `@deepseek-ai/dsh-experimental-*` 命名；已 ship 的 Agent Teams、voice input、Auto review、Schedule 作为可选 bundle（Web sidebar 开启）；稳定产品**不得依赖 experimental**。

---

## test-support/ — 测试工具

### test-support/agent-loop-testkit
- **职责**：AgentLoop 测试标准前置 + 生产 loop driver。
- **关键接口**：`mountAgentLoopTestDependencies(ctx)`、`mountAgentLoopTestHarness(ctx)`、`createInboxStub()`、`unsupportedInbox()`。
- **重要约定**：不挂 LLM adapter；adapters 须 caller 注册；mutation stub 仅 process-local。

### test-support/client-runtime
- **职责**：jsdom 浏览器测试 runtime；`SlotTestRuntime`、`createClientTest`、`webApp` roster。
- **关键接口**：`mount / declare / renderSlot / dispose`；`TestClient.start`；`reload(name)`。
- **重要约定**：未 stub Remote 调用失败 loud；`remote.<ns>` proxies 不经过 `invoke` / `invokeStream`；slot-tier / whole-client tier 两级。

### test-support/llm-mock-server
- **职责**：脚本化 Messages-compatible HTTP / SSE 故障 server；`pnpm run mock:llm`。
- **关键接口**：`--sequence / --port / --api-key / --seed / --random-weights / --partial-text / ...`。
- **重要约定**：每 accepted request FIFO；`random` seeded；exhaustion → HTTP 500；`connection_refused` 是 CLI-only first entry。

### test-support/llm-replay
- **职责**：keyless LLM replay plugin；replay recorded session JSONL 不用 API key。
- **关键接口**：`file`、`overrideFile`、`childFiles`、`providers[]`、`paceMs`。
- **重要约定**：每个 parent / subagent 各自 first-call-order 绑定；`replay.override.json` 处理 throw / cancel / hang；`assertConsumed()` 检测未消耗。

### test-support/loader-smoke
- **职责**：subprocess + direct-agent harness；keyless example smoke。
- **关键接口**：`runLoaderSmoke({ label, tempDirPrefix, binScript, configPath, tsconfigPath, sourceImport, expectedExitCode })`、`runFixtureTurn(ctx, options)`。
- **重要约定**：`DSH_EXAMPLE_MODE=src|lib`；`lib` 模式须先 `pnpm run build`；deadline 通过 execa 默认 100MB `maxBuffer`。

### test-support/remote-mock
- **职责**：Host Remote 端点 mock；`mock.remote.<ns>.<method>` native Vitest spy。
- **关键接口**：`RemoteMock.create()`、`load(table)`、`mock.streams`、`dispatch/open`；`mock.rpc`（Connection carrier）。
- **重要约定**：endpoint = Gateway wire name；unary / stream declarations；missing rule 失败 + `assertNoUnmatched()`。

### test-support/session-snapshot
- **职责**：keyless recorded-session snapshot tests；closed manifests、identity redaction、workspace 比较。
- **关键接口**：`defineAcpSnapshotSuite({ agent, snapshotsDir, scenarios, mode })`；`Scenario[]`；`replay / record / refresh` mode。
- **重要约定**：snapshot 需要 raw JSONL（`compression: 'none'`）；manifest closed schema；`writer.expected.jsonl` 是 output oracle 而非 replay generation。

---

## runtime-diagnostics/ — 运行时自检

### runtime-diagnostics/invariants
- **职责**：`ctx.invariants` registry；运行 package-owned companion 的 self-checks。
- **关键接口**：`enabled`、`package_allowlist[]`、`package_blocklist[]`（regex sources）；`register(packageName, installer)`。
- **重要约定**：companion 只检查自有 event stream / mutable data 关系；shipped 17+ 跨核心包 companions；filter startup-fixed；fail = `InvariantError{ code: 'INVARIANT', packageName }`。

---

## util/ — 共享基础工具

### util/brand
- **职责**：nominal 类型 brand；`brandString<T>()`、`brandNumber<T>()`。
- **重要约定**：仅静态类型变化；JSON / 序列化 / wire 与原值同；算术后 unbranded。

### util/home-paths
- **职责**：DSH home 解析与子路径生成。
- **关键接口**：`resolveDshHome()`（配置 > `$DSH_HOME` > `~/.dsh`）、`dshHomePath / dshCachePath`、`dshHomeDisplay`、`expandHomePath`、`canonicalizeWatchPath`。
- **重要约定**：空白 `$DSH_HOME` 视作未设；display 永远用符号标签（`~/.dsh` / `$DSH_HOME`）；canonicalization 仅读不写。

### util/atomic-write
- **职责**：atomic file replacement（不暴露 partial content、不跟随 symlinked temp）；cross-process writer lock。
- **关键接口**：`writeFileAtomic(path, text, { mode })`、`withFileLock(path, fn, { waitMs? })`。
- **重要约定**：同 fs 上 rename；Linux `link()`、`wx` 防 symlink planting；Windows 退避重试 `EPERM`；lock record 包含 PID，takeover 仅对 exited holder。

### util/timeout
- **职责**：shared timeout arithmetic；`clampTimeout`、`deadline`、`idleWatchdog`、`timeoutOf`。
- **重要约定**：`timeoutMs <= 0` 是 internal sentinel（never public）；`deadline` fuses upstream cancel with timer via `AbortSignal.any`；`idleWatchdog` 仅在 outstanding `next()` 时计时。

### util/http-proxy
- **职责**：outbound HTTP proxy policy（一个全局 undici dispatcher）；`proxyRouteFor`、`proxyEnvironmentForChild`、`clearedProxyEnv`。
- **重要约定**：loopback 总 bypass；不支持 SOCKS / PAC / OS 系统代理；`verify-no-bare-dispatcher` 解析 src 防裸 dispatcher；telemetry 默认直连。

### util/lazy-require
- **职责**：caller-relative lazy loading；`createLazyRequire<T>(specifier, import.meta.url)`。
- **重要约定**：CommonJS 兼容依赖 only；first-call 缓存；WebWorker packaging 需 explicit `lazy-require` 调用点（paker 当前不 discover）。

---

## 备注

- `session/session` 顶层 package 不存在（路径实际为 `packages/core/session`），已通过 `core/session` 覆盖；用户特别点名的 `session/` group 其他包均已涵盖。
- `mcp/mcp`、`hooks/hooks`、`preset/preset`、`sdk/sdk` 等顶层聚合 README 不存在，已跳过并使用实际子包（`mcp-client / mcp-resources`、`hooks-codex / hooks-claude-code / hook-protocol`、`agent-preset / agent-preset-registry / persona`、`sdk-client / sdk-server / sdk-protocol`）。
- `llm/llm-replay` 与 `llm/llm-mock-server` 实际位于 `test-support/`，已在新位置覆盖。