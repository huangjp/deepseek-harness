# 00 · 核心架构 / Cordis / 顶层规约

> 仓库根：`D:\coding\deepseek_harness`
> 阅读对象：`AGENTS.md` / `docs/architecture.md` / `docs/cordis-primer.md` / `docs/glossary.md` / `docs/AGENTS.md` / `docs/capability-seams.md` / `docs/agent-lifecycle.md` / `docs/tool-execution-pipeline.md` / `docs/event-producer-consumer.md` / `docs/session-format-status.md` / `docs/rescope.md`

---

## 1. 项目身份与定位

**DeepSeek Harness（dsh）** 是一个全插件（all-plugin）的 Cordis agent harness：模型适配器、工具注册表、会话日志（session log）、agent loop 本身都是 Cordis 插件，每一个都可在配置层被替换。仓库在 vendored Cordis 之上构建，**没有特权核心**，扩展方式是"在其它插件旁边挂载一个新插件"。

与同类（Claude Code / Codex CLI）的差异：

- **可插拔深度不同**：同类产品通常把模型 / 工具 / loop 作为内置固定层；dsh 将它们一并暴露为 `ctx.llm` / `ctx.tools` / `ctx.agentLoop` 等服务键，第三方可通过 `cordis.yml` 替换或叠加。
- **配置即组合**：运行中的 dsh 是 boot 时按 `profile → bundle → patch` 层级组合出来的插件树，而不是单一二进制；任何一行配置都允许被上一层 patch 替换。
- **持久化为事实源**：session log 是模型可见上下文的**唯一来源**（`deriveMessages()` 投影历史），不是缓存层，因此"模型可见 ⟺ 日志可重建"成为强约束。
- **多端共享运行时**：Web、Desktop（Electron）、Headless、SDK JSON-RPC、ACP Automation 都跑同一份生产 runtime，仅 profile 不同。

## 2. Cordis 框架核心概念

**Plugin**：实现 `Service` 的对象，可以是带可选 `inject` 与 `apply(ctx)` 的函数，也可以是 `Service` 子类；其生命周期由 Cordis 挂载到当前 `Context`。

**Context** 是服务仓库，插件通过声明式 `ctx.<key>`（如 `ctx.tools` / `ctx.llm` / `ctx.sessions`）申领服务，其它插件按 key 查找而非导入具体实现。

**Service** 通过 `inject` 字段声明依赖，加载顺序由"服务依赖"决定而非手动启动序列。

**Effect** 指可逆注册：`ctx.effect()` 或 `ctx.on()` 都返回 disposer，插件卸载时按反序撤销。

**Scope** 是 per-agent 注册粒度：全局注册对所有 agent 可见；`agent.ctx` 上的注册只属于该 agent 的 scope 生命周期；scope 之间不继承，子树行为通过 lineage 数据而非 scope 结构表达。

**注册机制**：所有贡献（prompt 段、tool schema、adapter、provider、listener）都走 `ctx.effect()` / `ctx.on()`，registry 的 `register()` 统一返回 disposer；teardown 时按注册逆序撤销。

**事件分发模式（dispatch mode）五种**：
- `emit`（observe，无返回值）
- `waterfall`（around-middleware，按注册序监听，下游**必须 `next()`** 才推进）
- `parallel`（并行，无返回值）
- `serial`（顺序等待，可返回值）
- `bail`（首个 bail 值短路）

`waterfall` 监听器语义为"收到 `(...args, next)`，调用 `next()` 把（可能被改写的）值向下传；不调用就短路"；合作式监听通常先改写共享对象再 `next()`，policy 监听可在"自己就是决策者"时直接返回。

**配置文件层级**：`cordis.yml` 的 entry 中 `config` 字段允许 `!!js`（**永远不是** `!js`）表达式节点，插值在声明注入激活后针对该插件上下文（`ctx.serviceName`）；`disabled` 字段在每次挂载判断时针对 loader 上下文求值；其它元数据保持字面量。Loader 使用 overlay 在环境层面切换插件。

## 3. Architecture 总览

**Profiles（5 个出厂模板）**：

- `web`（浏览器应用）
- `headless`（一次性无服务器运行）
- `sdk`（JSON-RPC SDK 服务）
- `sdk-minimal`（独立完整的 SDK 树，不挂 `dsh-base`）
- `acp`（automation-only ACP）

`plugin` 是管理命令名，名字为 `plugin` 的 profile 必须通过 `--profile plugin` 选择。

**Bundles**：

- `dsh-base` 是 `web` / `headless` / `sdk` / `acp` 共享的第一层（模型适配器、工具、持久化、sandbox、approval、settings、credentials、telemetry）
- `dsh-web-app` 加浏览器应用
- `dsh-headless` 加一次性 runner
- `dsh-sdk-app` 加 SDK JSON-RPC 服务
- `dsh-acp-app` 加 automation-only ACP 服务
- `dsh-sdk-minimal` 单独拥有完整显式 SDK 树

每个 bundle 在自身 `package.json` 的 `dsh.bundle` 字段声明 patch 文件入口；profile 通过 `dsh.profile` 字段列出其堆叠的 bundles。

**Patch 叠加顺序**（从空 entry 列表开始）：① profile 列出的每个 bundle 按顺序 ② profile 的 `cordis.patch.yml` ③ home 层级 patch ④ `--patch` overlay。Patch 按 id 命中行后**整行替换**该行 config（不是字段级合并），可插入新行。

**应用启动规约**：只有 `dsh --profile <name>`（或短形式 `dsh <name>`）被允许启动 Node 应用；package bin、demo、公开 SDK argv 直传均被 `verify-application-entrypoints` 显式禁止。TypeScript SDK 在运行时解析同版本 `dsh` 依赖并默认选 `sdk` profile；Python SDK 的 runtime wheel 把 CLI 打包成 `deepseek-harness-sdk-runtime-<platform>-<arch>`，客户端默认 `dsh --profile sdk` + 显式 Harness home。

**Core packages**：

| Package | Owns | `ctx` key |
|---|---|---|
| `core/session` | 追加式 `SessionEvent` 日志 + 内存存储 | `ctx.sessions` |
| `core/system-prompt` | Prompt-section + tool-schema 装配 | `ctx.systemPrompt` |
| `core/tools` | 作用域工具注册 + 守卫执行管道 | `ctx.tools` |
| `core/agent` | `Agent` 接口 + live registry + `agent/*` 事件 | `ctx.agents` |
| `core/agent-loop` | 默认 driver 实现该接口 | `ctx.agentLoop` |
| `core/scope` | per-agent scoped-registration 原语 | 库，无 key |
| `llm/llm` | 消息 / 流词汇 + adapter seam | `ctx.llm` |
| `webhook/webhook` | 已认证投递 + Workspace Session 创建 | `ctx.webhookRuntime` |

## 4. Turn 流程

**step vs turn**：

- **step** = 一次模型请求 + 它引发的所有工具调用
- **turn** = 零或多个 step，开启于首个输入被认领，关闭于"无未偿付输入且无未偿付工具"

轮次计数器（round）是外层 policy 概念（goal round、Ralph 一次新 agent），不计入 session 内每次 turn。

**waterfall vs serial events 区别**：

- `waterfall` 监听器**必须 `next()`** 才向下委托；不调用即短路。`agent/pre-step`、`agent/request`、`agent/request-error`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`、各 `fs/*`-intent、`approval/request`、`system-prompt/assemble`、`session-telemetry/record`、`connection/request` 都属此类。
- `serial` 监听器按注册序 await 并返回值，无 `next()` 概念；`agent/created`（driver 在排队工作前 await 其初始化）、`agent/turn-stopping`（自然停下时的串行终检点）属此类。
- `emit` 仅做观察，无返回值；`session/event`、`session/created`、`agent/status`、`agent/disposed` 等属此类。

**assistant stream 三种 frame**：`agent/assistant-stream` 是 process-local 的 `emit` 事件，发布 `start` → `chunk*` → `end` 三类帧；`chunk` 是 transient 的，循环在拿到完整 compact stream 后才把单条 `assistant/message`（成功）或 `assistant/attempt`（失败 / 重试 / 取消 / 流错误）作为一次"结算"提交到 session log，再发 committed `end`。Web Session-follow 适配器是 live 事件的唯一远程消费者；硬进程丢失在结算前不会留下任何 durable attempt 流。

**工具执行管道**（三个 waterfall + 定义钩子）：

1. `tools/pre-execute` waterfall：hook、permission、sandbox policy；可能 ask → 走 `ctx.approval` 一次性询问（缺席 / 不可答则 deny）；可抛异常被归一化为 `isError`。
2. 单调 guard 链：deny / abstain；identity 受保护（防止被改名）。
3. `tools/execute` waterfall（around-dispatch）：timeout、retry、metrics 包裹实际 `execute()`。
4. `tool-fs` 在 `execute` 内部发出 `fs/write-intent` 或 `fs/edit-intent` 进行 read-before-edit 校验。
5. 执行体发出 tool-owned 事件（`todo/write`、`fs/observed`、`hook/invoked` / `hook/result`、`tool/ptc-dispatch`）。
6. `ToolDefinition.projectContent` 安装 execution-prepared 内容（文本 + 图片），任何阶段抛异常被归一化。
7. `tools/post-execute` waterfall：accept / block / replace / add context；可添加 active-batch `additionalContexts`（FIFO，注入到 `tool/result` 之后、`user/message` 之前）。
8. 注册器外层归一化 → `ToolDefinition.finalizeContent`（最后的内容不变量）→ `tools/result` 同步通知（frozen authoritative outcome）→ `tool/result` session 事件 → UI completed card。

PTC 模式下 `run_code` 传输和序列化子调用都走同一管线，子调用带父 token、记 `tool/ptc-dispatch`、denial 为 binding rejection、不带 `additionalContexts` 以保持 call/result 相邻。

## 5. Capability Seam 三元组

一个 **seam** 是"可替换能力"，由三角色完整构成：

- **Service Definition**：拥有 `ctx.<key>` 与词汇类型的 Cordis `Service`（抽象类如 `ShellExecutor`、具体 registry 如 `WebRuntime`，**不是 TypeScript `interface`**）。
- **Service Provider**：一个或多个具体实现。
- **Consumer**：注入该服务的使用者，通常是 model-facing tool。

**示例**：`packages/shell` 是 canonical seam：`dsh-shell`（Definition，持有 `ctx.shell`）→ `dsh-bash-local` / `dsh-bash-sandbox`（Providers）→ `dsh-tool-bash`（Consumer）。`dsh-user-approval` 是反例：它把 Service Definition 与具体实现合并在同一包内，因为它属于"一个关切"。

Filesystem + subprocess 共用执行世界，所以指向远程 sandbox 时会一并迁移 Bash、PTY、LSP，无需为每个工具做 fork；subagent providers 在同一接口后跨度极大，从新子 agent 到委托另一产品的 turn。

**拆分原则**：roles 通常在**独立演化**时各占一个包；当它们是同一关切时可合并。seam 永远是"完整能力"，单一角色不构成 seam——不要把"seam"这个词用在 Service Definition、Provider 或 Consumer 任何单独一者上，而要用"service / contract / extension point"等更精确的术语。

## 6. Session 持久化

**版本演进**：当前 checkout writer 是 `SESSION_FORMAT_VERSION`（位于 `packages/core/session/src/types.ts`），是代码中**唯一手工维护的当前写者编号**；catalog 生成器从该常量派生出 codec 顺序并校验 adjacent migration 是否可达。

`session-format-status.md` 维护两个独立记录：

- **Finalization record**：`latestFinalizedVersion: 4`（V4 已具备 accepted compatibility baseline）。
- **Release record**：`latestReleasedVersion: 3`，evidence tag `dsh-v0.1.5-alpha.1`（公开产品 tag 在该版本第一次携带此格式）。

写者版本 > 已发布版本表示新格式尚未"发布"；写者 < 已发布版本表示 checkout 落后。GitHub prerelease flag 不让已持久化用户数据变为可弃；缺失 release record 不等于"未发布"。

**generation 不可变规则**：committed generation 路径**永不被重命名、覆盖或删除**。JSONL v0 使用 `session.jsonl[.zstd]`，v1 起使用小写 `session.vN.jsonl[.zstd]`。JSONL provider 独占物理 framing、压缩、generation 选择与 exclusive publication；每个 adjacent migration 包独占一个 `vN → vN+1` 步骤。ordinary repair（如补回被打断的 `turn/end`）是 handle consumer 的责任，migration 仅在已被后续 `turn/start` 封端的 bounded released restart 上插入缺失的 `turn/end`。Header-only `stat` / `list` 重新扫描目录并选数值最大的 canonical generation，**不发布** successor；read open 解码并合成静态 adjacent migration 链后返回（不发布），write open 先编码 / 校验再独占发布最终 version-named successor。SQLite 单独使用单调 `SCHEMA_VERSION`。

**当前与"下一个相邻版本"**：行为描述通用使用"current format" / "next adjacent version"，具体数字仅在为固定迁移输入 / 输出、wire schemas、历史证据或这些版本的测试中保留。

## 7. 仓库硬规约（根 AGENTS.md 浓缩）

- **Registrations are effects**：所有贡献走 `ctx.effect()` / `ctx.on()`，registry 的 `register()` 返回 disposer。
- **Model-visible ⟺ logged**：到达模型请求的内容必须能从 session log 重建；新模型可见输入必须有 session 事件；运行时不变量会校验模型请求可重建。
- **No hardcoded tunables in plugins**：部署相关的选择是经 schema 校验的 `Config` 字段，可由 `cordis.yml` 调整；`DEFAULT_*` 常量或 test hook 不是"可配置"。协议常量、外部规范、安全不变量保持固定。
- **Branded ids 跨边界**：`Branded<B>`（来自 `dsh-brand`）包裹跨边界的不透明 id，绝不裸 `string`。
- **No `as unknown`**（包括 `<unknown>`）：保持或缩减精确 legacy baseline；用 typed values 或 validation 替代。
- **Capability seam 完整性**：三角色（Definition / Provider / Consumer）缺一不可，只设计一角色不算 seam；只在角色独立演化时拆分。
- **Source plane vs artifact plane 永不混**：静态 gate 与测试通过 tsconfig `paths` 解析 workspace 导入到 `src`，在 clean tree 上通过；依赖已建 `lib/` 的 gate 必须声明该依赖。
- **Both SDKs project the loop**：agent-loop、session-lifecycle、`SessionEventMap` 变更必须同 PR 更新 TypeScript 与 Python SDK 的 expected outputs（`pnpm run test` 都不覆盖）。
- **空 catch 必须命名错误与原因**，且 `try` 保持单条语句。
- **文件末尾恰好一个换行**（`git diff --cached --check` 作为 pre-commit gate）。
- **Misconfiguration fails loud** at load when self-contained, otherwise at the earliest resolvable point；never silently skip a missing referent.
- 其它：`prepend: true` 仅在监听器必须先于普通注册时使用；closed union 末尾用 `assertNever`，merge-extensible union fall through 到有文档的 default；`Waterfall listeners MUST call next()`。