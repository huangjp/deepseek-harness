# 01 · 子系统结构化摘要（53 个 subsystem）

> 仓库根：`D:\coding\deepseek_harness\docs\subsystems\`

按子系统类别分组，每条包含：**职责 / 关键概念 / 扩展方式 / 依赖的服务**。

---

## 1. 核心 spine

**core** — Agent 句柄的创建 / 所有权 / 取消 / 截获契约；agent-loop 驱动器实现 `Agent` 契约。`AgentHandle`（agent + disposer）；`Agent`（`send` / `followup` / `steer` / `inject` / `cancel` / `whenIdle` / `runMaintenance`）；`Inbox` 两列表（next-turn / next-step）；`AgentStatus` / `AssistantStreamFrame` / `AgentCancelCause`。扩展：`ctx.agents.setFactory()`。依赖：scope / session / systemPrompt / tools / agent-loop。

**session** — 内存事件溯源模型；`SessionEventMap` 是 append-only 日志，LLM 历史从日志 derive 而非独立存储。`SessionEvent<T>` 判别联合；`SurfaceEventType`（system / user / assistant / tool / developer）；`SurfaceOp`（append / replace `{startSeq, endSeq}`）；`AssistantStreamRecord[]` 紧凑嵌入流；`SessionHeader` 与日志分离的存储元数据（含 `cwd` / `parentSession` / `isSeeded` / `delegationDepth` / `agentPreset`）。扩展：`declare module '@deepseek-ai/dsh-session/types'` 合并事件类型。依赖：下游 derive 系统。

**session-projection** — host-side capability seam；domain 插件贡献纯 fold 单元，registry 统一驱动推送给 client carriers。`ProjectionDefinition`（key + stateSchema + init + apply + 可选 wire view）；`ProjectionSnapshot`（一致 cut，`asOfSeq` + values）；`ProjectionChangeListener`（`Object.is` 比较）；`sessionProjectionCache`（持久化 cache）。扩展：`ctx.sessionProjections.register(definition)`。依赖：session（日志订阅）、persistence（`hydratePrepared`）。

**session-telemetry** — 事件捕获 → redaction → 后端分发；OTel 后端授权 Session prefix 并配独立队列和 4MB 上限。`SessionTelemetryRecord`（`channel: 'ledger' | 'ops'` + 严重度 + 属性 + 不可变 body）；`SessionTelemetrySink.emit` 同步入队；`sharing: 'full' | 'feedback-only' | 'disabled'`；`session-telemetry/record` waterfall。扩展：`ctx.sessionTelemetry` 注册 backend。依赖：session（订阅 `session/event`）。

**session-title** — 日志持久化的 latest-wins 标题 + 异步 provider 注册。`SessionTitleEventData`（title + 来源 seqs + source kind fallback / provider / user）；`SessionTitleProvider`（id + `first-prompt` / `all-prompts` 模式 + `generate`）；`rename()` 写入钉住标题。扩展：`ctx.sessionTitle.register(provider)`；disposal 时 abort 进行中的辅助请求。依赖：session / llm-streaming。

**system-prompt** — 每次请求前装配 prompt 段 + tool schema + 变量；rendered 后落 `system/message` 表面节点 0。`AssembleContext`（scope + 可选 signal）；`PromptSection`（name + order + text / provider + 可选 complete）；`system-prompt/assemble` waterfall（scope-filtered）。扩展：`ctx.systemPrompt.section() / context() / tools() / variable()`。依赖：scope / tools / llm-streaming。

**tools** — 作用域工具注册 + 守卫执行管道 + UI 卡片渲染。`ToolDefinition`（schema + 必填 `output` + `execute` + 可选 `presentCall` / `presentResult` / `timeoutMs` / `isConcurrencySafe`）；`ToolOutputDefinition`（schema + `render` + `presentationMeta`）；`ValueSchemaSpec` DSL；`ToolGuard`（单调守卫，no-allow）；`tools/pre-execute` → monotonic guards → `tools/execute` → `projectContent` → `tools/post-execute` → `finalizeContent` → `tools/result`；`ToolFailure` / `ToolExecutionSuccess` / `ToolExecutionFailure`（正交结果）；`ToolRestriction`（per-scope allow / deny）。扩展：`defineTool()` + `ctx.tools.register()`。依赖：scope / system-prompt / ptc-runtime。

**scope** — per-agent 可见性 + 共享生命周期所有权的库原语（不是 Cordis 服务）。`ScopeKey`（opaque object identity）；`Scoped<T>`；`Scope`（ctx + rawDispose + dispose）；`ScopeLayer` / `ScopedLayers<L>`。扩展：`createScope / scopeOf / scopeTarget` API。依赖：无。

**typert** — Remote 调用描述符（本地反射，非线消息）；Host Gateway / Client API 边界类型。`TypertLookupMap` / `TypertContextMap`（声明合并）；`InvocationDescriptor`；`TypertCodec`（strict / src-json）；`PeerScope`（per-connection Cordis ctx）；`TypertGateway`；`TypertClientRemote.$mount` / `$on`。扩展：`ctx.typert.register(contribution)`。依赖：cordis / transport。

**conversation** — target-neutral 会话事件 → 浏览器视图的装配层；每个 Session 一个 `ConversationNodeAssembler`。`SessionEventLikeEntry`（durable event 或 transient `assistant/live-chunk`）；Definition（kind + `match(event)` + `start` + `update` + `buildViewNode` + publication 节奏）；Context（ordered Matches + 当前 State）；Location（Session / Turn / Step 坐标）；View Definition / Group Definition；`predecessor` 依赖（`reader.previous<State>(kind)`）；O(D) 匹配 + O(1) Context 查表约束。依赖：SessionBinding / Slots / UI（Chat / Trajectory target 包）。

## 2. 模型与适配

**llm-streaming** — 对话 + 流词汇 + adapter seam；shared `ContentBlockMap` + 装配请求 + `StreamChunk` 协议 + adapter 契约。`Message` 角色 / 源 / 内容；`ContentBlockMap`（text / reasoning / image / file / tool-call / tool-addition / tool-removal，merge-extensible）；`MessageSourceMap`（kind = who；`ContextForm` = what；6 语义值：instructions / catalog / snapshot / notice / relay / recall）；`StreamChunk` 闭联合并；`AssistantStreamAccumulator`；`LlmFailure`（provider-neutral code）；`LlmAdapter` 契约（usage-before-finish、raw-JSON args、2 路错误、`streamIdleTimeoutMs`）；`ResolvedRetryPolicy`（normal / always + backoff）；`AppIdentity`。扩展：`ctx.llm.adapterRegistry.register(adapter)`。依赖：session / pty-runtime / tokens。

**mcp** — 外部 MCP server 接入；MCP 工具作为普通 harness tool；option 作为公开 resource tool；server instructions 进入系统提示。`McpResourceProvider.request()`；共享 `ctx.mcpResources` 三个 tool（按需 mount）。扩展：每个 server 一个 `dsh-mcp-client` Cordis 入口。依赖：tools / system-prompt / attachments。

**otel** — 共享 transport provider；mount 后**不**创建 provider / 队列 / 连接；consumer 注入并拥有 channel shutdown。`createEventReporter`（count-based batching）；`createSessionLogReporter`（byte-bounded）。扩展：`ctx.otel.createXxxReporter(options)`。依赖：product-telemetry / session-telemetry。

## 3. 执行能力

**shell** — 抽象 bash 执行 seam；`ctx.shell` 一个实现 / 上下文（duplicate throw）；foreground `run` vs background `start` 是 caller-await 视角。`ShellExecRequest` → `ShellExecSpec`（`resolve()` 拆分，required-on-spec）；`ShellRunResult`（exitCode + signal + timedOut + aborted + 互斥 first-cause）；`ShellSandboxInfo`；`ShellProcess`（无 id 无 owner — jobs 适配）；`DSH_*` 命名空间由 subprocess 拥有；`stdoutMaxBytes` 仅 trusted in-process plugin；`scrubbedParentEnv`。扩展：`ctx.shell.resolve / execute` 抽象类加载。依赖：subprocess / sandbox / pty-runtime。

**subprocess** — 抽象进程 seam；Service Definition provider。`SubprocessSpawnSpec`（argv + cwd + stdio + graceMs + signal + env — **无默认**）；`SubprocessStdio`；`SubprocessHandle`（stdin / stdout / stderr + control + collected + done + terminate + waitForExit）；`SubprocessOutputReader.readFrom(fromByte)`（offset-based 非消耗）；`SubprocessOutcome`（exitCode + signal，**无 cause 分类**）；`spawnTerminal`（非 pipe 原语：终端 I/O + 前台进程组 + 整体 quiescence）。扩展：`ctx.subprocess.spawn()` 抽象加载。依赖：shell / terminal / subagent-acp。

**ssh** — 部署拥有的 OpenSSH 远程端；filesystem / subprocess / sandbox 同一 provider，**不**引入新 model tool。`SshConnection`（非重连 session）；`Config`（host + node + helper + helperHash + workspace + bootstrapPath / Pair + requestTimeoutMs + maxFrameBytes + maxPending + leaseMs）；`processPath()` 走同 subprocess；process-reservation；terminate + waitForExit 共享受管 range；cancellation 永不**回放模糊 mutation**。扩展：deployed `Config` 即可，模型不携带。依赖：filesystem / subprocess / sandbox / pty-runtime。

**terminal** — 持久 PTY 会话；`ctx.terminals` 注册 backend + 服务 owner-scoped sessions。`TerminalBackend` + `TerminalBackendSession`；`TerminalSessionService.spawn(owner=Agent, request)`；`TerminalSendOperation`；`TerminalSessionStatus` 与 `TerminalWaitReason` 独立；cleanup owner-scoped；PTY 状态 process-local。扩展：`ctx.terminals.registerBackend(backend)`。依赖：subprocess（spawnTerminal） / session。

**ptc-runtime** — PTC 执行 capability seam；提供程序作为绑定 globals（`tools`）；失败以结果字段而非异常表达。`PtcRunRequest` → `PtcRunSpec`（provider `resolve` 校验 + cap）；`PtcRunResult`（sandbox + value + logs + error）；`PtcRunSandbox`；`PtcBindingNamespace`（global 标识符匹配语言无关子集）；`PtcBindingErrorClass`；`PtcRunFailure` 8 正交 kind（exception / timeout / abort / worker-exit / invalid-output / output-limit / protocol / sandbox-unavailable）；`PtcJsonValue`（lossless JSON）。扩展：`ctx.ptcRuntime.resolve / run` 抽象加载。依赖：sandbox / session / filesystems。

**sandbox** — 进程 sandbox seam；同世界进程 argv 包文件策略；本地实现 bwrap（Linux） / Landlock / Seatbelt / Windows-ACL；SSH 后端走远程。`SandboxMode`（read-only / workspace-write / danger-full-access — 仅前两个送给 provider）；`SandboxEnforcement`（full / partial）；`SandboxExecutionPolicy`（per-call）；`SandboxPolicy.resolve()`（按 prior-layer 优先级：approved override > session `sandbox/mode` > 配置默认）；`ConfinedArgv`；fail-closed `SANDBOX_UNAVAILABLE`。扩展：`ctx.sandbox.confine(argv, policy, signal)` 抽象加载。依赖：shell / persistence。

## 4. 文件 / 数据

**filesystem** — 可选文件 capability；`ctx.fs` 抽象 + 原生本地实现 + `dsh-fs-observation-policy` 事件门 + `dsh-tool-fs` 消费者。`FsTarget`（opaque targetKey + displayPath — **不可解析**）；`FsInfo` / `FsPathInfo`；`FsWriteIntent`（`createIfAbsent` / `replaceIfVersion`）；`FsWriteOutcome` / `FsEditOutcome`（before / after LF-normalized）；`fs/write-intent` / `fs/edit-intent` 单槽决策瀑布（first-wins by 注册顺序）；`fs/observed` fire-and-forget；`FsErrorCode` 13 类。**无 timeoutMs**（本地 syscall best-effort-abortable）。扩展：mount policy 插件 + 提供 provider 实现。依赖：tools / persistence / subprocess。

**lsp** — 语义代码导航 capability seam；4 个查询闭联合并；无协议转义。`LspOperation`（goToDefinition / findReferences / goToImplementation / hover）；`LspPosition` / `LspRange`（zero-based UTF-16）；`LspQueryRequest` 全部 required；`LspQueryResult` 闭联合并；`LspProvider` 注册原子保留 id + 扩展映射；`findReferences` 始终含 declarations；`LspError` 6 stable code。扩展：`ctx.lsp.registerProvider(provider)`。依赖：lsp-stdio。

**storage** — session 日志之外的存储结构；hub + backend 注册 + domain form 装配。`StorageBackend`（kv facet 可选）；`KvUnitDescriptor`（name + format version + table names + singleton slot）；`DomainSpec`（name + version + layout + compatibleVersions + invalidRecords 'backup-and-skip' + tables）；`DomainFacility.open(spec)` 严格序列；`domain/changed` 事件。扩展：`ctx.storage.backend.register(name, backend)` + `ctx.storage.mount(form, facility)`。依赖：dsh-storage-json / dsh-storage-sqlite。

**persistence** — 事件日志的耐久性 seam；`SessionPersistence` 抽象 + JSONL provider；**无并行持久化事件类型**。`SessionHandle`（单 owner `read` / `append` / `flush` / `close`）；`SessionHandleReadResult`；`append`（批续接，best-effort by resolution）；`flush`（耐久性屏障 = materialize-if-needed）；`session/event` 同步通知触发 bounded write-behind；`session/flush` / `session/disposed` 同 drain；crash recovery 不裁断 — agent-loop 算 `interruptedTurnClosers` 并 append；`SessionHeader` 与日志分离。扩展：`ctx.sessionPersistence` 服务加载。依赖：session / session-projection。

**spill** — spill 存储 capability seam；持久化调用方文本，返回 model-facing locator。`SaveTextSpill`（owner sessionId + source tool / session-reference + suggestedName hint）；`SpillRef`（locator + bytes + retrievalHint）；`SpillLocator` branded opaque；`ctx.spillStore.saveText()` 是唯一方法。扩展：`ctx.spillStore` 抽象加载。依赖：persistence / session-reference / spill-policy。

**attachment** — 图像 / 文件二进制耐久身份；事件入日志前**先持久化**。`AttachmentId` branded opaque（local 为 `sha256:<digest>`）；`ImageAttachmentRef`（verified mediaType + bytes + width + height）；`ImageAttachmentLimits`（默认 20 张 / 200 MiB、源 20 MiB）；`SaveImageAttachment` / `StoredImageAttachment`；`PromptContentPart` / `AdmittedPromptContentPart`；`FileAttachmentRef`（verbatim byte-for-byte）；`ctx.attachments.saveImages()` 批验证后全成功；`imageHostPath()` 暴露 host 路径而非可读承诺；`ctx.fileUploads`。扩展：`ctx.attachments` 抽象加载。依赖：persistence / llm-streaming。

**workspace** — 用户工作目录的持久记录；不可见（无 tool / prompt / session event）。`WorkspaceId` branded uuid（永不路径）；`realpathNormalize`；`Workspace.path` 解析后**永不重写**；`Workspace.sessionIds` 手动序；`Workspace.status()` 实时目录检查；pending-mutation marker（启动解决）；archive admission 通过 `workspace/session-activity` waterfall + `workspace/session-stop` parallel；活动 Session 拒归档。扩展：`ctx.workspaceRegistry.create / get / list / resolveByPath / delete`。依赖：storage + persistence。

## 5. 协作 / 工作流

**subagent** — 子 agent 委托 capability；**多 provider 共存**（命名注册）。`SubagentCapabilities`（start-time flags：agentOptions / outputSchema / depthLimit / toolFilter / persona — fail loud `UNSUPPORTED_CAPABILITY`）；`SubagentStartRequest`；`Activation`（一个 durable Session 至多一个 process-local，durable child Session + AgentHandle + Inbox FIFO + 0..N owned children）；`Agent.inbox` 唯一队列；`sendMessage` 仅 direct parent / child；Authority = exact live sender；`SubagentInterruptAuthority`（user / ancestor）；`continuable` cold resume 不走 provider。扩展：`ctx.subagents.registerProvider(create)`。依赖：session / agent-loop。

**agent-team** — 实验性隐式根 Team 域；Lead Session 背书邮箱 + 任务 DAG。`TeamId` = root SessionId 品牌；`TeamMemberSnapshot`（provisioning → active / failed）+ `TeamMessageSnapshot`（durable queued-minus-delivered）+ `TeamMessageSource`（dedup key）；`TeamTaskSnapshot`（id + revision CAS + blockedBy + writeScopes 路径前缀非锁）；状态机 `pending / in_progress / completed / deleted`；`agentTeam` Session projection。扩展：`ctx.agentTeams` Lead Session-owned service。依赖：session-projection / session。

**workflow** — 工作流 seam；agent 跑模型写的编排 SCRIPT 启动子 agent；**单 engine 实现 / 上下文**（不像 subagent 命名注册）。`WorkflowStartRequest`（script + meta + args + 可选 subagentProvider + maxTotalAgents + parent 必填）；`WorkflowMeta`（name / description / whenToUse / phases 匹配 `phase()` 调用）；`WorkflowResult`（value + `stopReason` 闭联合并）；`WorkflowRun`（result 永不 reject + cancel + dispose）；`WorkflowError.fatal: true`；`workflow/*` events；`tool-workflow` 写入 4 个会话事件 + invariant 验证；`ralph` 是可选 opt-in。扩展：`ctx.workflowEngine.start()` 抽象加载。依赖：pty-runtime / subagent。

**jobs** — 后台任务 runtime；身份 / 访问 / 生命周期 / 输出 ring 由 runtime 拥有；producer 拥有执行资源。`JobId` branded `<kind>-N`（非密 secret，靠 owner 授权）；`JobKindMap` merge-extensible；`JobSpec`；`JobHandle`（append + updateProgress — settlement 后写入 log-and-drop）；`JobHooks.cancel` + `done` Promise；`JobOutputSource.read(fromByte)` 非消耗；`JobChannel`（stdout / stderr / log — log 仅 observers）；`JobEventFilter`；`maxConcurrentJobsPerOwner` 默认 10。扩展：`ctx.jobs.start(spec)` 抽象加载。依赖：subprocess / shell。

**webhook** — 已验证外部投递 → 普通根 Session（fire-and-forget）；**不**保存 delivery / completion 状态。`VerifiedWebhookDelivery`（kind + source + provider deliveryId + event + receivedAt）；`WebhookRule.run()` 返回 `null` 或 `WebhookSessionRequest`；`dispatch()` 异步调度、含 per-rule 抛出容器；无 queue / retry / dedup / execution status / crash replay。扩展：`ctx.webhookRuntime.register(rule)` + `dispatch(delivery)`。依赖：session / agent / credentials。

## 6. 用户协作

**approval** — 一次性用户审批 seam；audit 仅日志（不入模型）。`ApprovalOutcome` 闭联合并（`allowed-once` / `rejected` / `cancelled` / `unavailable`，**后者 fail-closed**）；`ApprovalPolicy`（`'ask'` 默认委托 / `'never'` 全部 `rejected` 无需 dispatch）；`ApprovalRequest`（agent + toolName + 可选 callId + reason + signal — **不带 tool args**，避免重复渲染）；`approval/request` waterfall（scope-filtered agent-scoped listeners）。扩展：`ctx.approval.request(req)`。依赖：tools / shell / session / agent。

**permission-presets** — 把 sandbox mode + approval policy 两个独立旋钮打包成命名 preset。`PresetSpec`（sandbox + approval + name + description）；默认 `workspace-write` + `danger-full-access`；`custom` / `auto` 保留；`registerAuto(admit)` 一次性 effect-lived；`current(session)` derive（仍匹配的 selection 优先 → 配置表首匹配 → `CUSTOM_PRESET`）。扩展：`ctx.permissionPresets.register`（部署表）+ `registerAuto(admit)`。依赖：sandbox / approval / session-projection。

**commands** — 人类命令注册表服务；UI 适配器发现并直接执行而不创建 model message。`CommandInputDescriptor`（hint + attachments）；`CommandDefinition`（definitionId + name + description + input + handler）；`CommandInvocation`；`CommandResult`（`success` 可选 text + 可选 sourceEventSeq / `error`）；`commands/change` emit。扩展：`ctx.commands.register()` 全局 / agent-scoped。依赖：attachment / agent。

**user-questions** — 跨包 human 问题 / 答案词汇；tool 或权限插件需要人类回答时调用。`AskUserQuestionItem`（id + question + 可选 detail / header / options + 可选 intent + multiSelect）；`AskUserQuestionIntent`（tagged，`'plan-review'`：`detail` 是 plan markdown）；`AskUserQuestionOption`（label 同时是 user-facing + model-facing selected value）；`AskUserQuestionAnswerItem`；`UserQuestionError` 4 code；只能由 live runtime root 调用（被 owned 子 agent 拒）。扩展：`ctx.userQuestions.ask()` + `user-questions/request` waterfall。依赖：agent / plan-mode。

**feedback** — 每条 assistant 消息可编辑反馈；Session 反馈为 `feedback/message-put` + `feedback/message-delete`；Session 级备注为 `feedback/record`。`MessageFeedbackVersion` optimistic CAS token；`MessageFeedbackRating`（positive / negative）；`MessageFeedbackItem`（messageId + rating + note + category + version + createdAt + updatedAt）；`MessageFeedbackFailure` 5 code；`FeedbackCategory` 7 固定分类；冷路径持 write handle；fork seed 不继承 current 反馈。扩展：`ctx.messageFeedback.list / put / delete`（Remote）；`ctx.sessionFeedback.record`（live Session）。依赖：session / credentials / session-telemetry-otel。

**deliverables** — 交付物层：`tool-present` 模型声明 + `workspace-changes` git 快照变更摘要。`PresentedFile`；`WorkspaceChangedFile`；`WorkspaceChangesSummary`（turn + cwd + files capped + total + added / deleted + 可选 snapshot）；`WorkspaceFileDiff`（text / binary / oversized）；`deliverables/presented` + `workspace/changes` 日志事件（log-only，不入模型）。扩展：tool-present 注册；workspace-changes 注册。依赖：tools / session。

## 7. UI / Web

**web-client** — 浏览器侧 Cordis 应用 4 大基础 + Client models + 数据通路 + 重连。`WebBootGraph` 写入 `window.__DSH_BOOT__` + lazy CommonJS；API Gateway 类型化 Host 通信；Slots 类型化 React UI；Conversation 转 Session 历史为目标视图；Layers（Host 应用 → transport → Client models → UI adapters → Conversation 数据 → 组合渲染）；`$events` logical stream；Client 模型（`ClientSessions → SessionManager → Session`）；`SessionEventLikeEntry` 含 `event` / `chunks` 判别；Reconnection（物理恢复由 Gateway mux，逻辑 stream 重开）。依赖：web-server / client-modules / slots / conversation / typert。

**web-server** — 浏览器 HTTP 载体；**不**是 capability seam（不知 harness 概念）。`WebRouteKind`（exact / prefix）；`WebRoute`（path + handler）；match 顺序（exact table → longest prefix → fallback）；`Config`（host loopback / all-interfaces + port 0 随机 + compression none / gzip）；`collectIndexInjections` / `renderIndex` / `tapIndex`。扩展：`ctx.webServer.register / registerUpgrade / registerFallback / tapIndex`。依赖：client-modules / connection。

**web** — web 访问 capability seam（search + fetch 同 ctx.web）。`WebSearchRequest` / `WebSearchResult` / `WebSearchSource`；`WebFetchRequest` / `WebFetchResult` / `WebFetchBody` 闭联合并（html / text）；`available()` 廉价本地检查（**不**网络）；选择语义（configured id 命中 / unconfigured 单可用 / unconfigured 0/多 → `WEB_PROVIDER_*`）；`WebError` 开放 code 字符串。扩展：`ctx.web.registerSearchProvider / registerFetchProvider`。依赖：tools / security。

**browser-use** — 浏览器自动化 capability；**单 provider 注册**（exclusive）；DSH 拥有 task loop；provider 提供操作。`BrowserUseProviderName` branded；`register(name)` 独占 slot；Session-owned browser；MCP provider 每个 live Agent 一个 client；Session log 走普通 DSH pipeline。扩展：`ctx.browserUse.register(name)`。依赖：mcp / session。

**computer-use** — 桌面自动化 capability；**单 provider 注册**。`ComputerUseProviderName` branded；`register(name)` 独占；MCP provider 启动期间保持注册（重连不丢）；启动失败释放注册尝试；不预订桌面给 Session；cancel 不撤回桌面已接收的 input；image-capable 路由接收 durable screenshots。扩展：`ctx.computerUse.register(name)`。依赖：mcp / attachments。

**slots** — Web Client 类型化 React 组合系统。`SlotMap` declaration-merged 注册表；`root` 唯一内置 + 唯一 Cordis 服务渲染；cardinality（single / list / keyed / chain）+ scope（root / session-maybe / session）；priority（低值先）；component inputs（owner props + `renderSlot` props + store actions + inject + locale namespace + chain matched）；`SessionProvider` 继承外层 binding；shipped hierarchy（root → sidebar / main / rightbar / shell）；framework hooks（`useSessions` / `useSessionStatus` / `useSessionRetainInfo` / `useWorkspaces` / `usePanelInfo` / `sessionId` / `useSession` / `useProjection` / `useConversation` / `useInput` / `inputActions` / `useChat` / `useTrajectory`）。扩展：`ctx.slots.register` / `inject`。依赖：ui-renderer / client-modules。

**sidebar-right** — 每 Session 右侧 docking 表面；面板 + tab + 资源 + Workspace Files。`dsh-resource://<type>/…` + `sidebar://<kind>`；tab identity = (kind, address)；`ctx.sidebarRightTabs.register({id, kind, patterns, priority, canOpen, title, keepMounted, guide})`；routing 按 band → 匹配长度 → 注册顺序；`ctx.sidebarRight.openResource / openTab`；`useTabInfo`；document renderer registry。扩展：`ctx.sidebarRightTabs.register` + `ctx.slots.inject('sidebar.right.pane.tab', ...)`。依赖：client-resources / workspace-files / office-to-pdf。

**client-modules** — web 插件表；scan packages 声明 `dsh.client` + 组合 `WebBootGraph` + 服务 `/plugins` bundle route + 答 `webserver/index-inject`。`WebBootEntry`（id + url + rev + inject + immediately + external）+ `WebBootBatch`（phase bootstrap / application + url + rev + entries）+ `WebBootGraph`（rev + entries + batches）；rev 来自 mtime / ctime / size；3 KiB URL 上限；HMR map 以 `??...map&rev=...` 形式。扩展：`dsh.client` package.json 字段 + `./client` exports。依赖：web-server / client-resources。

**client-resources** — 客户端资源模型；address → live data。`dsh-resource://<type>/…`（host = protocol key of `ResourceProtocolMap`）；`open(address, {signal})` 返回 `RemoteResult` frames（首帧当前状态 + 每变化一帧）；失败为 `{ok:false, error}` 帧非 throw；状态（none / loading / live / failed，failed 保留 last value）；lifecycle（first holder 开 stream、最后释放 abort）。扩展：`ctx.resources.register<'protocol'>(provider)`。依赖：typert / workspace-files。

## 8. 规划与扩展

**goal** — 同 Session 目标（持久化目标身份 + lifecycle + 进程本地 activation）。`GoalRef`（id + revision CAS）；`GoalPhase`（active / paused / blocked / complete）；`GoalBlockReason`（stable lower-kebab-code + message）；`GoalSnapshot` + `GoalView`；`GoalActivation`（process-local）；`GoalActivationChanged` 进程本地 emit；rev monotonically +1 per accepted mutation。扩展：`ctx.goals.get / disarm / create / edit / pause / resume / complete / block / clear`。依赖：session / session-projection / scope。

**todo** — todo 词汇；`dsh-tool-todo` 工具替换 agent session 的整个 list。`TodoItem`（最小 content + status pending / in_progress / completed — 无 id / priority / activeForm）；`todo/write` 日志事件（whole-list snapshot，log-only）；invariant companion。扩展：模型通过 `TodoWrite` 工具调用。依赖：tools / session / invariants。

**schedule** — Host-wide Schedule；reminders 独立于 Session activation；送达原 Session。`ScheduleRecord`（After / At / Every / Daily / Weekly / Cron）；version-1 `schedule` storage domain；canonical UTC `scheduledAt`；one-minute minimum；Host-wide queue；creation selectors；cron 5 字段 Vixie 子集；`ScheduleCatalogEntry` + `ScheduleView`。扩展：`schedule_create / list / delete / update` 工具。依赖：storage / session / agent。

**plan** — plan mode（每个 agent 协作状态）— 软指导；沙箱 + 审批独立。`plan/mode` 日志事件（log-only `{active}`）；`plan` projection 折叠；`ctx.planMode.get / set` — selection 在 turn 边界之间立即 append；`plan:policy` section order 50；`exit_plan_mode` 注册时始终可用；`/plan [off|message]` 命令。扩展：`ctx.planMode` + 注册 section + exit tool + `/plan` 命令。依赖：system-prompt / user-questions / commands。

**extensions** — runtime self-modification；agent 定义版本化 Cordis 包、运行 host / browser halves、查询 approved 元数据。`CordisInspectRegistryService`（注册 Host providers + mirror Client manifest + `query`）；`DynamicCordisRunnerService`（define new Plugin / undefine / run / runHostHalf / getClientCode / resolveRequestRun / settleUserRun / stop / syncInspectManifest / resolveInspectQuery / inventory / snapshot / reference / listPlugins / inspectPlugin / inspectPackage / reportRenderFailure / invoke）；`InspectorService.publish(topic, payload, monotonicMs?)`；events `cordis/dynamic-package` / `cordis/dynamic-retract` / `cordis/inspect-query` / `cordis/inspect-query-resolved` / `cordis/request-run` / `cordis/request-run-resolved`。扩展：`ctx.cordisInspect.register` / `ctx.dynamicCordisRunner.define / run / etc`。依赖：cordis / session。

**compaction** — context compaction seam；token budget / context overflow 触发 + manual region。`compaction/start` / `compaction/summary` / `compaction/end` 三个日志事件（log-only）；`compaction/summary` payload 含 shadowedRange + shadowedSeqs + shadowedTokenCount + provider + model + maxTokens? + usage? + `llmStreamCall?`；lock-bracket 整个操作；`CompactionResult`；`CompactionTrigger`（`pressure` | `context-overflow`）；`compactIfNeeded / compactNow / compactRegion`；`compactCheckpointSource` + `isCompactCheckpointSource`；`ManualCompactionErrorCode` 6 类。扩展：`ctx.compaction` 抽象加载。依赖：session / token-meter / pty-runtime。

**voice-input** — 实验性语音识别（Service Definition + 本地 inference provider + Remote consumer + UI bundle）。`SpeechProviderId` branded；`SpeechProviderInfo` + `SpeechRequest` / `SpeechSpec`（resolve 锁定 provider instance）；no fallback to other provider；canonical base64 PCM16 WAV；`InputActions.insertText(revision-guarded)`；`SpeechPreparationOptions.downloadSource`；Host provider 跨 page / Session 单一准备任务。扩展：`ctx.speechToText.register(provider)` + 选 `dsh-experimental-voice-input-bundle`。依赖：speech-to-text + sensevoice provider + browser-mic。

## 9. 元能力

**boot** — launcher 提供的 profile 访问 + plugin manager。`PluginInfo`；`BundleInfo`；`InstallBundleOptions.enabled` 默认 true + `approvedBuilds` + `registry`；`PluginRegistries`（configured first + fallbacks + resolved）；`ChangeResult`（`applied` / `restart-required` / `overridden` / `failed`）；`ctx.configEditor.entries / configuration / edit`；`ctx.hmr.runExclusive / watchConfig / getLinked`；`ctx.pluginManager.listVersionExemptions / setVersionExemption / listPlugins / listBundles / registries / inspect / setPluginEnabled / setBundleEnabled / installBundle / waitForInstall / cancelInstall / removeBundle`。依赖：persistence / HMR / pnpm。

**credentials** — credential seam；秘密不入配置，仅引用；空 stored 值等同空。`CredentialRef` branded POSIX 环境变量名；`ResolvedCredential`（value + source layer）；`CredentialInfo`（configured / source / writable — **永远无 value slot**）；`ctx.credentials` 抽象（resolve 每次重新解析 → 热更新）；`ctx.authorization` flow 注册表（one flow per key — duplicate `DUPLICATE_FLOW`）；`AuthorizationRequest` 一次仅一个 try per key（`ALREADY_IN_FLIGHT` 拒 second caller）；`authorization/settled` emit；`credentialsController` Remote（**单向**：value 仅 write in，read 无 value）；`ctx.deepseekAccount`（embedded Platform + `PlatformSession` + `AccountDetails.balance` + bonus notifications + `startSignIn / cancelSignIn / signOut / watch / resolveToken / rejectToken / getDeviceIdentity / getPlatformSession`）。依赖：settings / session / product code。

**settings** — plugin configuration forms；从活跃 profile 条目投影 volatile Config 字段。form namespace = 唯一 active entry id；descriptors 含 resolved + inherited + override + optimistic revision；`settings/document-updated` emit；`ctx.settings.configure({auto?})` 实例级 page policy；`ctx.settings.describe / update / replace / mutate`；`ctx.settingsController` Remote（read 强制 `redactSecrets: true`，`role('secret')` 字段不上响应；写暴露 merge / replace / mutate；失败分类 `settings/conflict` / `settings/rejected`）。扩展：插件注册 Config schema + 可选 `configure()`。依赖：config-editor / credentials / session。

**session-query** — live-preferred 逻辑 session corpus 的查询词汇。`SessionRecord`（cloned live-preferred header + live / persisted 标志）；`SessionLogSnapshot`（detached replay-validated 原始日志）；`SessionSurfaceSnapshot`（atomic 模型表面）；`SessionTitleObservation`；`SessionEventRecord`（lightweight）；`SessionResultFilter` / `SessionEventResultFilter`（AND + 列表 OR；range inclusive；text 字面 Unicode regex case-insensitive whitespace-flexible — **不**依赖 provider）；`SessionSearchCursor` branded；`SessionLineageTrace`（ancestors + descendants）；`SessionEventWindow` / `SessionEventTrace`；`SessionQueryErrorCode` 16 类。扩展：`ctx.sessionQuery` 抽象。依赖：persistence / session-query-sqlite。

**session-reference** — Host-backed 文件发现 + 跨 Session 引用 + 准备消息 context。`FileReferenceCandidate`；`SessionReferenceInput`；`SessionReferenceCandidate`；`SessionReferenceMentionCandidate`（canonical `@[label](dsh-session:…)` mention）；`SessionReferenceSource`（recall form + capturedFormatVersion + capturedThroughSeq + compacted + originalMessages / retainedMessages / omittedMessages / omittedBytes + truncated）；`PreparedReferencedMessage`；`SessionReferenceErrorCode` 7 类。扩展：`ctx.fileReferences`（abstract）+ `ctx.sessionReferenceResolver.prepare / listCandidates / remoteExportCandidates`。依赖：session / spill / tools。

**product-telemetry** — 产品分析 OTLP / HTTP 发送；plugin 自选 event 字段；自动不采集 Session。`ProductTelemetryRecord`（name + body + time + 可选 severity + attributes）；enqueue 同步不 ack delivery；`ctx.productTelemetry.emit()`；`ctx.productAnalytics`（Desktop-only）。扩展：装载后 emit。依赖：otel。

**token-meter** — 单服务估算器 + 隔离 per-session folds；提供 detached replay snapshot。`TokenMeasurement`（`logRevision` + `baseline` + signed `surfaceDeltaTokens` + `totalTokens` + `surfaceTokens` + nodes）；`TokenSurfaceNode`（seq + tokens route-priced + `heuristicTokens` 固定 shadow-price protocol）；provider visual tokens 由 adapter 声明 `LlmAdapter.imageRequestPricing`。扩展：`ctx.tokenMeter.measure(session, requestHeader?)` + `estimateMessage(message)`。依赖：session / pty-runtime / llm-streaming。

**invariants** — runtime invariant registry；包拥有 runtime invariant checks。`Config`（enabled 默认 true + `package_allowlist` + `package_blocklist` JavaScript regex 源，空则全包，blocklist 覆盖 allowlist，service lifetime 固定）；`InvariantInstaller(ctx, fail)`（enabler runs in dedicated child fiber，`installer.inject` 声明可用 services）；`InvariantFailure(message)` throws `InvariantError`（`code: 'INVARIANT'` + packageName + 消息前缀）；`ctx.invariants.register(packageName, installer)` 保留 reservation even when filtered；每个 workspace package 拥有 `./invariant` companion（无观察事件 / mutable-data 时返回空 installer + `No runtime invariant:` 注释）。扩展：包发布 companion + 注册到 registry。依赖：每个包的事件 / state 源。