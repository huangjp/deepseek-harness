# 03 · Packages Group 概览（54 个 group）

> 仓库根：`D:\coding\deepseek_harness\packages\`

---

## 1. acp/ — Agent Client Protocol automation
- **定位**：自动化的 JSON-RPC stdio 服务端，外部程序以 Agent Client Protocol 驱动持久 Harness agent。
- **关键概念**：automation-only 协议、多路复用 session、MCP 接入、权限交互。
- **子 package**：`acp`（服务端）。
- **对外接口**：与 `subagent/subagent-acp`（harness 内 ACP 客户端）配对。
- **典型依赖**：session / agent-loop / mcp。

## 2. api/ — Remote API layers
- **定位**：Client → Host 的 typed 远程调用层（Remotes + Gateway）。
- **关键概念**：typed method calls、流式 stream、Gateway mux、Client uplink。
- **子 package**：`remotes`、`gateway`、`job-controller`、`session-controller`、`settings-controller`、`workspace-controller`、`terminal-controller`、`workspace-files`。
- **对外接口**：`ctx.typertGateway` / `ctx.remote.*`（session / job / settings / credentials / workspace / terminal / workspaceFiles）。
- **典型依赖**：typert（wire 描述符）、connection、session、subprocess、storage。

## 3. attachment/ — durable attachment capability family
- **定位**：模型提示词 / 命令的持久图片附件能力族。
- **关键概念**：durable image、Session 历史回放、DSH_HOME 本地存储。
- **子 package**：`attachment`（契约）、`attachment-local`（本地存储 backend）。
- **对外接口**：`ctx.attachments`。
- **典型依赖**：storage / session-log。

## 4. boot/ — shared app-bin boot glue
- **定位**：`dsh` app bin 启动通用胶水（env / profile 加载、cmdline、HMR）。
- **关键概念**：`cordis.yml` 配置、profile + patch 叠加、plugin-manager、cmdline flag 透传。
- **子 package**：`app-boot`、`cmdline`、`hmr`、`config-editor`、`plugin-manager`。
- **对外接口**：`cmdlineArgs` / `appExit` / `hmr` / `configEditor` / `pluginManager`。
- **典型依赖**：loader / home-paths / bundle。

## 5. browser-use/ — browser-use capability
- **定位**：浏览器使用 provider 独占注册（Playwright / Chrome DevTools / Stagehand 等实验 provider 在 experimental）。
- **关键概念**：exclusive named provider registration、Session-owned browser resources。
- **子 package**：`browser-use`。
- **对外接口**：`ctx.browserUse`。
- **典型依赖**：browser-use-runtime（experimental）。

## 6. bundle/ — profile plugin bundles
- **定位**：`dsh --profile` 的可安装 patch 装配层。
- **关键概念**：`dsh.bundle.patch` 声明、profile stacking。
- **子 package**：`base`、`acp-app`、`web-app`、`headless`、`sdk-app`、`sdk-minimal`。
- **对外接口**：patch 文档 + `headless-runner` 服务键。
- **典型依赖**：app-boot / 全部已发布产品包。

## 7. client/ — web-GUI browser half
- **定位**：浏览器侧 dsh Web GUI（shell boot、UI feature、连接、本地化）。
- **关键概念**：modules / connection / store / locale / ui-slots / ui-session 等共享底座 + 大量 `ui-*` 功能包。
- **子 package**（精选）：`web`、`modules`、`connection`、`file-upload`、`shortcuts`、`ui-shortcuts`、`store`、`hmr`、`locale`、`test-runtime`（→ `test-support/client-runtime`）、`ui-renderer`、`ui-slots`、`ui-session`、`ui-theme`、`ui-primitives`、`ui-attachment`、`ui-layout`、`ui-dockkit`、`ui-sidebar*`（5 个）、`resources`、`ui-workspace`、`ui-conversation`、`ui-chat`、`ui-approval`、`ui-tool`、`ui-workflow-run`、`ui-goal`、`ui-trajectory`、`ui-commands`、`ui-input-trigger`、`ui-skill`、`ui-reference`、`ui-subagent`、`ui-jobs`、`ui-schedule`、`ui-model-selection`、`ui-permission-presets`、`ui-plan`、`ui-settings*`（9 个）、`ui-plugin-manager`、`ui-deliverables`、`ui-message-feedback`、`ui-directory-picker-browse`、`ui-directory-picker-native`、`ui-open-in-app`、`ui-brand-official`、`ui-agent-preset`、`ui-user-questions`。
- **对外接口**：`ctx.clientModules`、`ctx.connection`、`ctx.fileUpload`、`ctx.shortcuts`、`ctx.locale`、`ctx.uiRenderer`、`ctx.sidebarRight/Tabs`、`ctx.documentPreviews`、`ctx.resources`、`ctx.feedbackUi` 等。
- **典型依赖**：host/* 服务、api/* Remote、session-controller。

## 8. compaction/ — compaction capability family
- **定位**：长对话压缩族（自动压缩 + `/compact` 命令 + tool output 裁剪 + image 占位）。
- **关键概念**：token 压力触发、queue manual compaction、image-offload。
- **子 package**：`compaction`、`compaction-basic`、`compaction-tool-result-pruner`、`compaction-image-offload`、`command-compact`。
- **对外接口**：`ctx.compaction`、`ctx.toolResultPruner`；监听 `agent/request-error`。
- **典型依赖**：session / llm（token-meter）。

## 9. computer-use/ — computer-use capability
- **定位**：桌面操作 provider 独占注册（Cua Driver MCP / native 等实验 provider 在 experimental）。
- **关键概念**：exclusive named provider registration。
- **子 package**：`computer-use`。
- **对外接口**：`ctx.computerUse`。
- **典型依赖**：computer-use-cua-driver-*（experimental）。

## 10. context/ — Request-context plugins
- **定位**：仅添加 durable、模型可见 context（不定义工具）的请求上下文插件。
- **关键概念**：AGENTS.md 注入、`@file` mention、session 快照引用、tmux 位置。
- **子 package**：`agent-instructions`、`session-reference`、`file-reference`、`file-reference-local`、`time-context`、`tmux-context`。
- **对外接口**：`ctx.sessionReferenceResolver`、`ctx.fileReferences`。
- **典型依赖**：session / fs / subagent。

## 11. core/ — product API spine
- **定位**：构建 / 扩展 agent 的核心骨架（session log、system-prompt、tool registry、agent vocabulary、默认 loop）。
- **关键概念**：`Agent` handle、`scope` scoping primitive、可替换 driver。
- **子 package**：`scope`、`session`、`system-prompt`、`tools`、`agent-tool-presentation`、`agent`、`agent-default-model`、`agent-loop`。
- **对外接口**：`ctx.sessions`、`ctx.systemPrompt`、`ctx.tools`、`ctx.agents`、`ctx.agentDefaultModel`、`ctx.agentLoop`。
- **典型依赖**：多数能力包（llm / fs / shell / sandbox …）。

## 12. credentials/ — credentials and authorization
- **定位**：让配置仅引用 secret 名而不嵌入值的凭据能力族。
- **关键概念**：credential-reference seam、私有 YAML 本地存储、authorization flow。
- **子 package**：`credentials`、`credentials-local`、`authorization`。
- **对外接口**：`ctx.credentials`、`ctx.authorization`。
- **典型依赖**：storage / settings。

## 13. deliverables/ — durable deliverables
- **定位**：记录一次 turn 交付给用户的文件 / 改动（durable Session event，client-only read）。
- **关键概念**：`present` 工具声明交付、git snapshot 抓 changed-files summary。
- **子 package**：`tool-present`、`workspace-changes`。
- **对外接口**：`ctx.workspaceChanges`；监听 `session/event`，追加 `workspace/changes`。
- **典型依赖**：`ctx.tools`、`ctx.fs`、`ctx.subprocess`、git 可执行文件。

## 14. experimental/ — 实验性 prototype 集合
- **定位**：公开发布但合约可变、无支持承诺的 prototype 能力。
- **关键概念**：Agent Teams、Auto review、Cua Driver、browser-use backend、CPython PTC、浏览器 worker preview；Agent Teams / 语音输入 / Auto review / Schedule 作为可选 bundle 由 Web Plugins page 启用。
- **子 package**：`speech-to-text`、`speech-to-text-sensevoice`、`api-speech-to-text`、`client-ui-voice-input`、`voice-input-bundle`、`agent-team-profile`、`agent-team`、`client-ui-agent-team`、`auto-review`、`schedule-bundle`、`ptc-runtime-python`、`computer-use-cua-driver-mcp`、`computer-use-cua-driver-native`、`browser-use-playwright-mcp`、`browser-use-chrome-devtools-mcp`、`browser-use-stagehand-native`、`browser-use-runtime`、`inspector`、`tool-agent-team`、`webworker-packer`、`webworker-runtime`。
- **对外接口**：`ctx.speechToText`、`ctx.speechController`、`ctx.agentTeams`、`ctx.ptcRuntime`、`ctx.computerUse`、`ctx.browserUse`、`ctx.inspector`；scoped tools on `ctx.tools`。
- **典型依赖**：core / llm / session / tools；**产品包不得依赖 experimental**。

## 15. extensions/ — 运行时 API 发现 + 进程内 / 浏览器内 runner
- **定位**：运行时 API 只读查询 + 进程内 + 浏览器侧的 runner + 历史 Cordis 卡片。
- **关键概念**：`tool-cordis` 两个只读工具、`cordis-host-runner` / `cordis-client-runner` 双半、`ui-cordis` 面板；持久化插件通过 `plugin-manager` 安装。
- **子 package**：`tool-cordis`、`cordis-host-runner`、`cordis-client-runner`、`ui-cordis`。
- **对外接口**：`ctx.dynamicCordisRunner`、`ctx.cordisInspect`；registers on `ctx.tools`。
- **典型依赖**：plugin-manager / loader。

## 16. feedback/ — recorded human feedback
- **定位**：对 harness 产出的人类反馈（session 级 remark、message 级 rating），不进入模型输入。
- **关键概念**：`/feedback` 命令、`messageFeedback` service、固定分类法、sharing policy 闸口。
- **子 package**：`command-feedback`、`message-feedback`。
- **对外接口**：`sessionFeedback` Remote、`messageFeedback` service。
- **典型依赖**：session / identity / telemetry。

## 17. fs/ — filesystem capability family
- **定位**：agent 的策略化持久文件访问（contract + 后端 + read-before-edit policy + 模型工具）。
- **关键概念**：`ctx.fs` 契约、`fs-local` / `fs-sandbox` 后端、`fs-observation-policy`（plugin 不是 service）、模型工具 `read/read_image/write/edit` + `glob/grep` + 独立 `str_replace_editor`；搜索走 ripgrep 子进程而非扩展 provider。
- **子 package**：`fs`、`fs-local`、`fs-sandbox`、`fs-observation-policy`、`tool-fs`、`tool-fs-search`、`tool-str-replace-editor`。
- **对外接口**：`ctx.fs`、监听 `fs/*` events、registers on `ctx.tools`。
- **典型依赖**：session / sandbox / subprocess。

## 18. goal/ — 持久 session 目标
- **定位**：每个 session 一个 durable 目标 + 模型工具 + `/goal` 命令 + 自动续跑驱动。
- **关键概念**：单 active goal、`goal/change` events、`goal-round-driver` 顺序 Round 续跑。
- **子 package**：`goal`、`tool-goal`、`command-goal`、`goal-round-driver`。
- **对外接口**：`ctx.goals`、registers on `ctx.tools` / `ctx.commands`。
- **典型依赖**：session / agent-loop。

## 19. guard/ — loop-hygiene guard family
- **定位**：环卫生护插件（同 tool 重复提醒 + tool-call 超时策略）。
- **关键概念**：`repeat-tool-reminder`（advisory）+ `timeout-policy`（声明 timeout 时启用）；`dsh-base` 默认启用。
- **子 package**：`repeat-tool-reminder`、`timeout-policy`。
- **对外接口**：监听 tool 执行链。
- **典型依赖**：tools / timeout。

## 20. hooks/ — Claude Code / Codex hook 兼容
- **定位**：复用 Claude Code 和 Codex 的 `hooks.json` shell hook（session start / prompt / tool / stop）。
- **关键概念**：共享 hook-protocol 引擎、command-hook 子集、typed Decision 拦截扩展点。
- **子 package**：`hook-protocol`（共享库）、`hooks-claude-code`、`hooks-codex`。
- **对外接口**：拦截决策面。
- **典型依赖**：agent-loop / tools。

## 21. host/ — web-GUI host half
- **定位**：web GUI 的 HTTP server、SPA 服务、目录选择、应用启动、插件清单、产品遥测。
- **关键概念**：`ctx.webServer` named routes、directory-picker seam（native / browse / auto）、open-in-app launch、product telemetry OTLP / HTTP。
- **子 package**：`webserver`、`frontend-static`、`directory-picker`、`directory-picker-native`、`directory-picker-browse`、`directory-picker-auto`、`open-in-app`、`plugin-inventory`、`product-telemetry-otel`。
- **对外接口**：`ctx.webServer`、`ctx.directoryPicker`、`ctx.productTelemetry`、`pluginInventory/list` Remote。
- **典型依赖**：client/* / webserver。

## 22. identity/ — shared identity
- **定位**：每个 harness home 一个匿名 id，被 telemetry / feedback / DeepSeek 请求共用。
- **关键概念**：自动持久 id、首次使用生成、删除文件失效。
- **子 package**：`anonymous-user-id`。
- **对外接口**：（无 ctx key，被业务包读取）。
- **典型依赖**：home-paths。

## 23. interaction/ — human-collaboration plane
- **定位**：人引导 agent 的方式（slash 命令、一次性审批、permission 预设、问答）。
- **关键概念**：`commands`、`user-approval`（fail-closed answerers）、`permission-presets` 绑定 sandbox + approval、`user-questions` schema + scoped answerer waterfall、`ask_user_question` 模型工具。
- **子 package**：`commands`、`user-approval`、`permission-presets`、`user-questions`、`tool-ask-user`。
- **对外接口**：`ctx.commands`、`ctx.approval`、`ctx.permissionPresets`、`ctx.userQuestions`；registers on `ctx.tools`。
- **典型依赖**：acp（自动化处理审批）/ approval flow。

## 24. jobs/ — background-job capability family
- **定位**：后台作业能力（注册 / 读取 / 等待 / 取消，owner-fenced 完成通知入内会话）。
- **关键概念**：`ctx.jobs` 契约、`jobs-local` 进程内存储、`tool-jobs` 模型工具（list / read / kill + 完成推送）。
- **子 package**：`jobs`、`jobs-local`、`tool-jobs`。
- **对外接口**：`ctx.jobs`、registers on `ctx.tools`。
- **典型依赖**：subprocess / session。

## 25. llm/ — LLM capability family
- **定位**：模型调用能力族（provider 中立 service + DeepSeek / pi-ai 适配器 + 重试 + token 测量）。
- **关键概念**：messages / blocks / chunks 共享词汇、DeepSeek 双 adapter（api-key / account）、pi-ai 多 provider 目录、`llm-retry` 在 durable step 边界重试、`token-meter` 固定启发式。
- **子 package**：`llm`、`llm-deepseek`、`llm-deepseek-api-key`、`llm-deepseek-account`、`llm-pi-ai`、`deepseek-llm-api-extensions`、`plugin-package-inventory-deepseek`、`llm-retry`、`token-meter`。
- **对外接口**：`ctx.llm`、`ctx.agentDefaultModel`、`ctx.deepseekLlmApiExtensions`、`ctx.tokenMeter`；监听 `agent/request-error`。
- **典型依赖**：credentials / session。

## 26. lsp/ — language-server code navigation
- **定位**：通过配置好的 language server 做 go-to-def / refs / implementations / hover。
- **关键概念**：四类只读归一化操作、`lsp-stdio` 起 stdio LSP provider、`tool-lsp` 单一模型工具（provider 注册能力而非工具）。
- **子 package**：`lsp`、`lsp-stdio`、`tool-lsp`。
- **对外接口**：`ctx.lsp`、registers on `ctx.tools`。
- **典型依赖**：`ctx.fs`、`ctx.subprocess`。

## 27. mcp/ — Model Context Protocol
- **定位**：让模型调用外部 MCP 工具 + 读 server 资源。
- **关键概念**：`mcp-client` 单连接、`mcp-resources` 跨连接资源工具 + 显式 server 选择；server instructions 也下发。
- **子 package**：`mcp-client`、`mcp-resources`。
- **对外接口**：registers on `ctx.tools`。
- **典型依赖**：tools / subagent。

## 28. plan/ — plan collaboration state
- **定位**：plan mode（让 agent 先探索 / 设计再执行）。
- **关键概念**：`/plan` 进入退出、`exit_plan_mode` 提请审批；仅指导不限制工具。
- **子 package**：`plan-mode`。
- **对外接口**：`ctx.planMode`。
- **典型依赖**：agent / system-prompt。

## 29. preset/ — Agent 能力声明与选择
- **定位**：通过 Cordis 配置声明 Agent 能力 + 选择 + 运行时修订。
- **关键概念**：Agent 共享 loop、按选中 revision 看到 tools / prompts / skills。
- **子 package**：`agent-preset-registry`、`agent-preset`、`persona`。
- **对外接口**：`ctx.agentPresets`。
- **典型依赖**：scope / loader。

## 30. ptc-runtime/ — 程序执行能力族
- **定位**：让模型写一个程序调用宿主函数并仅返回 stdout + return value。
- **关键概念**：`ctx.ptcRuntime` 契约、`ptc-runtime-node` 沙盒内新 Node 进程、`ptc-runtime-python`（experimental）CPython 后端 + fd-3 协议。
- **子 package**：`ptc-runtime`、`ptc-runtime-node`、`experimental/ptc-runtime-python`。
- **对外接口**：`ctx.ptcRuntime`。
- **典型依赖**：sandbox / fs。

## 31. runtime-diagnostics/ — runtime invariants
- **定位**：运行时自检（验证各包持久事件 / 数据关系的 package-owned checks）。
- **关键概念**：违规归因到 owning package、全局开关 + 包名过滤、`./invariant` companion 强制。
- **子 package**：`invariants`。
- **对外接口**：registers on `ctx.invariants`。
- **典型依赖**：session / loader。

## 32. sandbox/ — process-sandbox
- **定位**：子进程文件级策略（read-only / workspace-write / danger-full-access），同内核同 FS 模式。
- **关键概念**：`ctx.sandbox` 契约、`sandbox-local` 平台 backend（Linux bwrap→Landlock / macOS Seatbelt / Windows restricted token）、`sandbox-policy` 共享策略、`sandbox-windows-acl` Windows ACL rung；被拒可一次升级。
- **子 package**：`sandbox`、`sandbox-local`、`sandbox-policy`、`sandbox-windows-acl`。
- **对外接口**：`ctx.sandbox`、`ctx.sandboxPolicy`。
- **典型依赖**：subprocess / fs。

## 33. schedule/ — Host-owned reminders
- **定位**：Host 拥有的计划提醒（一次性 / fixed / daily / weekly / cron）+ 跨 Host 重启持久。
- **关键概念**：到期提醒以普通跟进消息回到原 session；可选 Tasks 页面跨 session 管理。
- **子 package**：`schedule`。
- **对外接口**：registers on `ctx.tools`。
- **典型依赖**：session / subagent / storage。

## 34. sdk/ — JSON-RPC SDK
- **定位**：另一进程通过 newline-delimited JSON-RPC 驱动完整 Harness 运行时。
- **关键概念**：`protocol` 公共消息、`client` 启动 `dsh` + 高低层 API、`server` stdio JSON-RPC；与 Python SDK 同协议，不生成开发项目。
- **子 package**：`protocol`、`client`、`server`。
- **对外接口**：JSON-RPC 协议面。
- **典型依赖**：bundle/sdk-app / session。

## 35. session-query/ — session retrieval
- **定位**：跨活 / 持久 session history 的检索（独立于 compaction）。
- **关键概念**：`sessionQuery` 统一服务、SQLite FTS5 全文、`session-log-export` Web `/export` 下载 ZIP、`tool-session-query` 五个 workspace-授权模型工具。
- **子 package**：`session-query`、`session-query-sqlite`、`session-log-export`、`tool-session-query`。
- **对外接口**：`ctx.sessionQuery`、`ctx.sessionLogDownload`（browser）；registers on `ctx.tools`。
- **典型依赖**：session / workspace。

## 36. session/ — durable session data plane
- **定位**：会话持久、格式迁移、投影、标题、遥测。
- **关键概念**：四组 — Persistence（JSONL backend + checkpoint policy + format v0→v4 编解码链）、Projection（stats / turn-outline units）、Titles（first / all prompts LLM 标题）、Telemetry（OTel FEEDBACK_ONLY / DISABLED）。
- **子 package**：`session-format`、`session-format-v0-to-v1`、`session-format-v1-to-v2`、`session-format-v2-to-v3`、`session-format-v3-to-v4`、`session-format-catalog`、`session-persistence`、`session-persistence-jsonl`、`session-checkpoint-policy`、`session-log-deepseek`、`session-projection`、`session-projection-cache`、`session-stats`、`session-turn-outline`、`session-title`、`session-title-llm`、`session-title-first-prompt-llm`、`session-title-all-prompts-llm`、`session-telemetry`、`session-telemetry-otel`。
- **对外接口**：`ctx.sessionPersistence`、`ctx.sessionProjections`、`ctx.sessionProjectionCache`、`ctx.sessionTitle`、`ctx.sessionTelemetry`；wraps `ctx.llm` / `ctx.tools`；contributes `dsh_session_log`。
- **典型依赖**：storage / telemetry / identity。

## 37. settings/ — plugin configuration forms
- **定位**：由每个插件 Config schema 派生的实时配置表单（form）。
- **关键概念**：profile patch 存编辑、Loader 应用、volatile 配置不重挂。
- **子 package**：`settings`。
- **对外接口**：`ctx.settings`。
- **典型依赖**：config-editor / loader。

## 38. shell/ — bash capability family
- **定位**：命令执行（POSIX Bash / Windows PowerShell，前台 + 后台）。
- **关键概念**：`ctx.shell` 契约、`bash-local` / `bash-sandbox`、`pwsh-local` / `pwsh-sandbox` 互斥挂载、`tool-bash` / `tool-bash-persistent` / `tool-pwsh` / `tool-pwsh-persistent` 模型工具、`shell-env` 提供 `DSH_*` 环境。
- **子 package**：`shell`、`bash-local`、`bash-sandbox`、`pwsh-local`、`pwsh-sandbox`、`shell-env`、`tool-bash`、`tool-bash-persistent`、`tool-pwsh`、`tool-pwsh-persistent`。
- **对外接口**：`ctx.shell`、`ctx.shellEnv`；registers on `ctx.tools`。
- **典型依赖**：sandbox / sandbox-policy / subprocess。

## 39. skill/ — skill capability family
- **定位**：按需发现 / 加载的可复用任务指令。
- **关键概念**：registry 合并多源 catalog、按名 resolve；sources（filesystem / badge / office）+ `tool-skill`（catalog + `skill` 工具 + `/name`）+ `tool-workspace-dependencies`（Office 解释器路径）。
- **子 package**：`skill`、`skill-filesystem`、`skill-badge`、`skill-office`、`tool-skill`、`tool-workspace-dependencies`。
- **对外接口**：`ctx.skills`；registers on `ctx.tools`。
- **典型依赖**：fs / session。

## 40. spill/ — text spill capability
- **定位**：把超量文本外存并返回 locator + 取回提示。
- **关键概念**：`maxInlineTokens` 触发、存储失败保留原文；session-reference 也直接消费 storage。
- **子 package**：`spill`、`spill-local`、`spill-policy`。
- **对外接口**：`ctx.spillStore`；listens on `ctx.tools`。
- **典型依赖**：storage / fs。

## 41. ssh/ — POSIX 远程执行 provider
- **定位**：在远端 POSIX SSH 主机执行（FS / 子进程 / 终端 / 沙箱），harness 仍在本地。
- **关键概念**：共享 OpenSSH 连接 + helper、注册 fs / subprocess / sandbox provider；不得从远端路径推断本地路径。
- **子 package**：`ssh`、`fs-ssh`、`subprocess-ssh`、`sandbox-ssh`。
- **对外接口**：`ctx.ssh`、`ctx.fs`、`ctx.subprocess`、`ctx.sandbox`。
- **典型依赖**：fs / subprocess / sandbox。

## 42. storage/ — durable non-session data
- **定位**：跨重启的非 session 应用数据（workspace 记录、session sidecars）。
- **关键概念**：`storage` selector + `storage-json`（每 unit 一 JSON 文件）+ `storage-sqlite`（单库 JSON 文档）+ `storage-domain`（schema 校验 + change events）；不暴露工具 / 事件。
- **子 package**：`storage`、`storage-json`、`storage-sqlite`、`storage-domain`。
- **对外接口**：`ctx.storage`、`ctx.storageDomain`；backends `json` / `sqlite`。
- **典型依赖**：workspace。
- **备注**：design Agent Note 仍标 `proposed`；`log` facet / session-backend 复用 / 跨进程变更推送属延后工作。

## 43. subagent/ — subagent capability family
- **定位**：让 agent 把任务委派给 child + 续谈 + 列表。
- **关键概念**：6 个 provider（in-process spawn / fork、ACP、Codex、Claude Code、dsh SDK）+ 2 套模型工具（`tool-subagent` 委派 / `tool-subagent-control` 通信 / 中断 / 列表）。
- **子 package**：`subagent`、`subagent-in-process-driver`、`subagent-spawn-in-process`、`subagent-fork-in-process`、`subagent-acp`、`subagent-codex`、`subagent-claude-code`、`subagent-dsh-sdk`、`tool-subagent`、`tool-subagent-control`。
- **对外接口**：`ctx.subagents`；registers on `ctx.tools`。
- **典型依赖**：session / acp / sdk。

## 44. subprocess/ — subprocess capability family
- **定位**：统一子进程 + 终端会话服务（bash / LSP / persistent shell / subagent backend 全部走这里）。
- **关键概念**：`ctx.subprocess` 契约 + `subprocess-local`（managed process ranges + 显式较弱降级）+ `win32-process` 共享 Win32 绑定；进程 lifetime 跨 consumer reload。
- **子 package**：`subprocess`、`subprocess-local`、`win32-process`。
- **对外接口**：`ctx.subprocess`。
- **典型依赖**：shell / sandbox / fs。

## 45. telemetry/ — shared reporting transport
- **定位**：业务消费者的共享遥测传输插件。
- **关键概念**：业务包选事件 / identity / auth / redaction，传输包管编码投递。
- **子 package**：`otel`。
- **对外接口**：`ctx.otel`（普通事件 + 字节限 session-log 双通道）。
- **典型依赖**：session-telemetry / product-telemetry。

## 46. terminal/ — persistent PTY
- **定位**：跨 tool call 保活交互 shell / REPL 会话。
- **关键概念**：`ctx.terminals` owner-isolated 会话、`terminal-bash` 沙盒交互 bash / pwsh、`tool-terminal` 6 个模型工具（带 owner 隔离 + 后台 send）；会话不跨重启。
- **子 package**：`terminal`、`terminal-bash`、`tool-terminal`。
- **对外接口**：`ctx.terminals`；registers on `ctx.tools`。
- **典型依赖**：shell / sandbox。

## 47. test-support/ — repository test harnesses
- **定位**：仓库测试的 deterministic + keyless 工具（Loader harness、session snapshot、replay LLM、故障 server）。
- **关键概念**：包拿到产品合约即迁出该组。
- **子 package**：`session-snapshot`、`agent-loop-testkit`、`client-runtime`、`remote-mock`、`loader-smoke`、`llm-mock-server`、`llm-replay`。
- **对外接口**：测试 API。
- **典型依赖**：connection / loader / session / llm。

## 48. todo/ — session task list
- **定位**：让 agent 维护一个 session 级 task list（todo_write 工具，整列表替换式更新）。
- **关键概念**：跨 turn / reopen 持久，无 UI。
- **子 package**：`tool-todo`。
- **对外接口**：registers on `ctx.tools`；触发 `todo/write`。
- **典型依赖**：session。

## 49. typert/ — Remote 类型图与协议
- **定位**：让 Client 调用 Host typed 方法 + 共享生成的 schemas / 反射，免手写 wire 代码。
- **关键概念**：4 包 — `generator`（构建期源类型 → 模型 + artifacts）、`registry`（运行时反射 + Zod + Context provider registries）、`protocol`（Remote decorators / wire descriptors / codecs / provider contracts）、`loader`（Loader 自动注册）。
- **子 package**：`generator`、`loader`、`protocol`、`registry`。
- **对外接口**：`ctx.typert`；consumes `ctx.loader`。
- **典型依赖**：api/gateway。

## 50. util/ — shared utilities
- **定位**：跨能力包共享机械原语库（不注册业务服务 / 事件）。
- **关键概念**：17 个根条目 — brand / package-manifest / crypto / deque / chunked-list / values / home-paths / http-proxy / launch-environment / atomic-write / lazy-require / native-command / workspace-path / code-language / output-retention / time / timeout。
- **子 package**：`brand`、`package-manifest`、`crypto`、`deque`、`chunked-list`、`values`、`home-paths`、`http-proxy`、`launch-environment`、`atomic-write`、`lazy-require`、`native-command`、`workspace-path`、`code-language`、`output-retention`、`time`、`timeout`。
- **对外接口**：均为 library。
- **典型依赖**：全部能力包。

## 51. web/ — web access capability
- **定位**：模型通过 `web_search` / `web_fetch` 工具访问公网。
- **关键概念**：单 `ctx.web` service + 3 search provider（Exa / Perplexity / DeepSeek）+ `web-fetch-http` 匿名 fetch + `tool-web` 统一模型工具。
- **子 package**：`web`、`web-search-exa`、`web-search-perplexity`、`web-search-deepseek`、`web-fetch-http`、`tool-web`。
- **对外接口**：`ctx.web`；registers on `ctx.tools`。
- **典型依赖**：credentials。

## 52. webhook/ — verified external events
- **定位**：认证过的外部 provider 事件 + 可信规则 + fire-and-forget 创建 root Session。
- **关键概念**：进程内分派、无队列 / 重试 / 去重 / Agent-completion 状态。
- **子 package**：`webhook`（runtime + 规则注册）、`webhook-github`（签名 adapter）。
- **对外接口**：`ctx.webhookRuntime`；consumes `ctx.webServer`。
- **典型依赖**：workspace / session。

## 53. workflow/ — 模型编排脚本
- **定位**：让 agent 跑编排脚本委派 subagents 并返回终值。
- **关键概念**：`workflow` tool 脚本 fan-out + 可选 `ralph` tool 固定顺序 fresh agents；脚本走共享 PTC Node 进程 runtime，遵守调用 session 文件策略。
- **子 package**：`workflow`、`workflow-ptc`、`tool-ralph`、`tool-workflow`。
- **对外接口**：`ctx.workflowEngine`；registers on `ctx.tools`。
- **典型依赖**：subagent / ptc-runtime / sandbox / fs。

## 54. workspace/ — 持久项目实体
- **定位**：让 Host 维持有序命名项目并按目录分组 session。
- **关键概念**：隐藏 / 移除项目不删文件夹或历史；需 session 存储 + 持久 backend；不暴露工具 / 事件。
- **子 package**：`workspace`。
- **对外接口**：`ctx.workspaceRegistry`。
- **典型依赖**：session / storage。