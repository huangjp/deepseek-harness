# 02 · Cookbook + 开发 / 测试 / 防御性模式

> 仓库根：`D:\coding\deepseek_harness`

---

## 1. 添加 Package 流程

**目录布局**：所有 package 落在 `packages/<group>/<pkg>/` 下，group 只起容器作用（无 `package.json`、无源码、包仍仅位于其下一层）。group 候选：`core` / `llm` / `shell` / `compaction` / `subagent` / `todo` / `session` / `client|host` / `util` / `test-support`。新 group 仅在无候选时引入。

**package.json 不变量**（由 `pnpm run constraints` 强制）：

- `private: true`
- `version` 对齐根 `package.json`
- `type: module`
- `main` / `types` / `exports` 指向 `lib/index.js` 与 `lib/types/index.d.ts`
- `@deepseek-ai/cordis` 同时进入 `peerDependencies` 与 `devDependencies`（区间相同），每个 dsh peer dep 都镜像进 devDeps
- `@deepseek-ai/schemastery` 属于 `dependencies`（运行时校验器）
- `files` 仅含 `lib/index.js` + `lib/types/**/*.d.ts`（如导出 `./invariant` 加 `lib/invariant.js`；runtime 导出指向 emitted tree 的加 `lib/types/**/*.js`；CLI 含 `bin` 的把 `lib/bin.js` 紧跟其后）
- 源内相对路径必须用显式 `.ts` specifier

**README 必带字段**：`kind` 选 group / reference / library / bundle 之一；末尾模板固定为 `## Model Experience`（含 `What the model sees` / `Token effect` / `KV Cache effect`）以及 `## Known Limitations and Deferred Work`。无上下文效应或消费者拥有的路径可用审计过的 `None, as …` 或 `Indirectly, through …` 单句；带 model experience 的包必须填三段。

**验证脚本**：`pnpm install` → `pnpm run doc-sync` → `pnpm run constraints && pnpm run typecheck && pnpm run lint` → `pnpm run build && pnpm run hygiene`。注册到根配置：`tsconfig.host.json`（Host 包）或 `tsconfig.client.json`（Client 包）添加 `references`；Client 包另需 `dsh.client` 字段、`exports["./client"]`，使用 `tsdown.client` 预设。

## 2. 添加 Model-Facing 工具

**最小三件套**：`name` + `inject: ['tools']` + `apply(ctx)` 里 `ctx.tools.register(defineTool(...))`。注册是 effect-based，dispose 插件 fiber 即注销工具；schema 自动进入 system prompt 装配。

**execute() 契约要点**：

- args 由 `defineTool` 按 `ParameterSchemaSpec` 校验后传入 `execute`，类型化为 `InferArgs`
- 注册后只读，schema / 回调不能修改；`exec.token` 不透明，args 视作只读
- `output.schema` 用 `ValueSchemaSpec`，execute 返回推断值，registry 负责冻结 + 校验 + 传给 `output.render(args, value)`
- 抛出 / 返回非法值 = `isError`：仅基础设施异常应 throw，业务结果放回 canonical value
- 必须响应 `exec.signal` 取消
- 可选 `output.presentationMeta(args, value)` 派生可回放的卡片 JSON（用于 `write` / `edit` 等 result-time facts）

**长任务（`run_in_background`）**：以 producer config 为闸门，通过 `ctx.jobs.start({ kind, label, owner, run })` 注册。registry 拒绝预中止调用，runtime 验证所有权；返回 `{ kind: 'background', jobId }` 形态的 canonical handle，PTC 模式禁止从 prose 解析 id。已发布的 id 应用任务自身的 cancel signal，不复用 `exec.signal`。

**Pure presenter 原则**：`presentCall(args)` / `presentResult(args, ...)` 必须纯函数（无 I/O、无 session 状态读、无时钟 / 随机）—— 既要跑在实时流上，也要跑在 session log REPLAY 上。返回 `card`-tagged 渲染意图：`generic` / `terminal` / `diff`（写）、`read`（来自 `result.meta`）、`search`（`shape: 'matches' | 'paths'`，含 `truncated` / `total`）、`web`（`kind: 'search' | 'fetch'`）。`defineTool` 对 display path 做软校验（畸形 / 旧 logged args 返回 `undefined` 而非抛错，保证 replay 不崩溃）。

**派生 web card 规则**：内置 Web Client **不**消费 `presentCall` / `presentResult`；Client 插件在 `tool.call.toolview` keyed slot 注册，从 `ToolCallBlock` 参数 + 内容 + 错误 + metadata + PTC `parentCallId` + session 路径 fact 派生组件 props，本地校验后无效输入回退 generic row。需要 result-time 结构化事实时用 `output.presentationMeta`，不要把 React props / 选中的卡片塞进 metadata，也不要把 Host 工具实现导入浏览器包。

**model-visible input / output 强制要求**：schema 既是契约也是协议面；`output.schema` 应同时作为有意义的程序化 API（直返 handles / fields，允许 scalar / array / null 根），人类说明留给 `output.render`。

## 3. 添加 LLM Adapter

**注册位置**：adapter 子类 `extends LlmAdapter` 提供 `async * stream(options): AsyncIterable<StreamChunk>`。插件 `inject: ['llm']`，`apply` 中 `ctx.llm.registerAdapter(['my-provider'], new MyAdapter(...))`。注册 effect-based、duplicate 抛错、多路由注册全或全无。`options.provider` 选 adapter、`options.model` 是 provider 模型 id，secret 用 cordis-native Config + 环境变量回退（`cordis.yml` 的 `!!js process.env.MY_KEY`），不要自读 key 文件。

**message / stream vocabulary 强制**：先发 `usage` 再发 `finish`，之后任何字节都不准发出；tool-call `arguments` 全程保持 **原始 JSON 字符串**，流片段以 `argumentsDelta` 形式发出，块在 `block-end` 时再 stringify 解析对象；`index` 按流内首次出现顺序分配，块内所有 delta 复用同 index。

**错误两条路径**：`stream()` 抛出 `LlmError`（transport / protocol），或以 `finish {kind: 'error' | 'aborted'}` 收尾（provider in-band）；不可同时使用。对 `options.signal` 必响应；不能 honor 的字段抛 `LlmError(..., 'UNSUPPORTED_OPTION')` 而非悄悄丢弃。需要时通过 `finish.replayState` 投射最小 lossless-JSON 元信息，`LlmRuntime` 只在历史 provider 路由与目标路由同 adapter 实例时回传。思考模式开关留在 adapter Config；模型元数据走 `resolveModel()`；reasoning efforts 是 ordered opaque id，adapter 自行映射到 provider 请求。

**实现结构**：wire types / 请求序列化 / transport 解析 / 块翻译 / adapter class 五职责分离，参考 `packages/llm/llm-deepseek` 布局。

## 4. 添加 Settings Card

**声明 live 字段**：Config schema 用 `z.object({...}).volatile()`，TS 接口用 `Volatile<T>`；`apply` 中监听 `loader/volatile-update`。读 `.get()` 时取一致 snapshot；跨字段校验用 `.check()`（Host 端在持久化前运行，不进序列化 form schema）。`role('secret')` 把字段从 form 响应中剔除；credential-reference 字段交给 credentials 域管理。

**settings seam 注册**：基 bundle 自动挂载 settings 与 config-editor；自定义 profile 须先读其 README 再挂同一服务。profile patch / plugin instance identity / restart 后恢复 / 非法值拒绝（既不写盘也不改 live 值）四项必验证。

**provider pattern**：第三方包要在不拥有的 bundle / row / 官方插件页上添加 UI 时，注入 `plugins.detail.actions`（页头控制）、`plugins.detail.badge`（标题旁 tag）、`plugins.detail.section`（页下小节）。每条用页面的 `subject`（`bundle` / `row` / `item`）渲染，不相关的 subject 返回 `null`。

**浏览器半边挂载**：浏览器侧由 client module system 服务，扫到声明 `dsh.client` 的 Loader entry 后服务其 `./client` 出口；半边绑到裸包名 Loader row，子路径 row 不挂半边。`./client` 必须用 lazy-CJS factory 格式（由 `packages/client/tsdown.client.ts` 里的 `clientBundle` preset 生成，仓库外的包需自行复刻构建）。

## 5. 添加 Remote API / Vendored Package / Session Format Version

**adding-a-remote-api.md**（5 步）：

1. 声明 `@Remote` 方法（Controller extends `TypertRemoteService`，lookup 对象仅放顶层参数，可取消方法以 `signal: AbortSignal` 收尾）。
2. 声明 failures（统一 `RemoteError` + 通过 `RemoteErrorDetailsMap` declaration merging 添加 `<domain>/<reason>`，carrier codes `gateway/bad-request|cancelled|internal` 来自 protocol）。
3. 注册（`@Remote` 必须在 Loader entry 插件包，manifest 加 `./typert` + `./remote` 导出 + peer dep 改 protocol，改签名 / 代码表 / namespace / 导出名后跑 `pnpm run build:lib`）。
4. Client 消费（`inject` 列 `remote` + `remote.<ns>`，调用返回 `RemoteResult<T>` 分 `result.ok` / `code` 分支，不写防御性 catch，固定 Host 事实用 `ctx.remote.$host`）。
5. 测试（owner 侧用 `remoteErrorOf` 比 `code` 与 details，Client 侧用 `TestRemote` + `RemoteError` from `@deepseek-ai/dsh-client-test-runtime`，`$host` 直接赋值）。

**adding-a-vendored-package.md**：上游 Cordis 包（如 `@cordisjs/plugin-http`）以 **vendor** 形式钉源码到 `vendor/<dir>/`，非 npm 依赖。`tsconfig.json` 镜像其他 vendor 包：`rootDir: src`、`outDir: lib/types`、严格的 `compilerOptions` 放宽项、`references` 列每个被引用 vendor；`package.json` rescope 名字、保留 `exports` / `type`、声明指向 `lib/types`、发布 `.d.ts.map`、`peerDependencies` 列出 cordis deps、**不**置 `private: true`、设 `publishConfig.access: public`。`tsconfig.base.json` 加 `paths`、`tsconfig.host.json` 加 `references`（在 `packages/*` 前）、`vendor/README.md` 加 manifest 表行（dir / npm 名 / 版本 / 上游 repo / commit SHA）；transitive 上游依赖必须连带 vendor。`scripts/check-vendor-manifest.sh` 守门：`vendor/*/src` 与 `vendor/README.md` 必须同次提交。验证：`pnpm install` → `pnpm run typecheck` → `pnpm run build && pnpm run constraints`。

**adding-a-session-format-version.md**（N+1 版本流程）：先确定 N（最近 released / accepted 格式）→ 用 `release/*` 集成基底 → 加 identity edge 包（库，非插件，`dsh.sessionFormatMigration` 声明 `from: N` / `to: N+1`、export path、migration / source codec / target codec / target header validator / target restorer；复用上一 edge 包的 source codec；不要 copy / redefine released codec）→ 把 `SESSION_FORMAT_VERSION` 改为 N+1 并 `pnpm run gen-session-format-catalog`（自动拒绝 gap / 重复 / 缺依赖）→ 用 `Stage` 接口（每次 `createStage` 独立状态）实现 `transformEvent` / `transformRun` / `finish`，不可共享 mutable stage；新 edge README 作为完整转换与接纳目录（在同 PR 内更新）→ 更新 current-version consumers（writer 常量用当前、released codec 与历史 fixture 保留字面版本；header-only listing 不读 body；write open 必校验并发布最终 current successor）→ 创建 snapshot 继承者（用 keyless refresh + replay 不回写，必要时 `test:snapshot:refresh`）→ 跑 `pnpm run verify-session-format-catalog` / focused vitest / `test:snapshot` / `pnpm run doc-sync` / `pnpm run lint` / `git diff --check`。

## 6. Persistence Type Changes

**流程**：在已装依赖的 contributor checkout 中，先 `pnpm --silent run verify-persistence-changes --json` 预览（`--silent` 是为避免 pnpm lifecycle 文本污染 stdout；失败 exit 1）。接着写 `.artifacts/persistence-change.prose.json`（含 `en` + `zh`，每个三段 `summary` / `compatibility` / `verification`；解释与测试证据由你自己提供，CLI 不作主张）。再跑 `pnpm --silent run persistence-changes --record <date-slug> --prose <file> --json`（不带 `--prose` 留未完成草稿，verification 会拒绝）。该命令校验历史、配对 prose、推断最低版本决策、必要时检查 `SessionHeader.version` 自增。

**type acknowledgement**：受 reviewer 在保持接受基线、记录兼容演化为同版本 acknowledgement 的同时，breaking change 必须先实现更高 writer 版本（见 cookbook `adding-a-session-format-version`）；不自动 bump 无关版本。

**兼容性策略**：按固定 compatibility rules 推断——CLI 不会改源码或放宽规则。machine inventory 把完整图存进 `roots`，`types` 含 `digest` / `names` / `sources`（roots 无法重建时含显式 `schema`）；存储压缩不改变 root fingerprints 也不要求 acknowledgement；历史完整条目保持可读。`--update`（不带 `--prose`）刷新未接受的同一 terminal record 与 schema / catalog / pairing，但拒绝初始 baseline、被依赖的 record 与 finalized checkpoint。竞争 terminal record 时用剩余历史重新 `--update` 未接受那条，重新评估 diff。`--decision` 是受检断言；故意错配会先失败再写。

## 7. Extension Cookbook

**何时用 plugin / bundle / profile**：

- **plugin**：单能力扩展（一个工具 / 一个 hook / 一个 adapter / 一个 UI 节点），落到 group 下。
- **bundle**：`packages/bundle/*/cordis.patch.yml` 贡献 profile 层；产品 launcher（`dsh`）通过命名 profile 拥有 Web / ACP / SDK / 一次性 headless。用户面 overlay 在 `apps/cli/config/examples/`，profile 集成测试在 `apps/cli/tests/profiles/`。
- **profile**：在 launcher 层把一组 plugin / bundle 拼成一个产品入口。

**决策树**：

- 模型可见工具 → `ctx.tools.register()`（`dsh-tool-*` 家族为生产样本）
- 钩子 / 拦截（权限闸、沙箱、plan mode）→ 监听 `tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result` 或 `agent/pre-step` 等。`guard()` 给不可逆终拒；`tools/execute` 包 dispatch 生命周期；`tools/result` 观察不可变结果
- UI → 监听 `agent/assistant-stream`（live chunks）+ `session/event`（durable settlements / boundaries / tool activity），输入用 `followup()` / `steer()`；浏览器侧在 Web Client 注册 `ConversationNodeDefinition` + `conversation.chat.node` keyed renderer
- 外部协议驱动 → stdio / JSON-RPC 适配 `ctx.agents`（acp 是 worked example）
- 模型适配 → `LlmAdapter` + `registerAdapter`
- 工具筛选跨表现层对齐 → `ctx.tools.restrict()`
- 动态提示装配 → `system-prompt/assemble`（保 PTC + 结构化输出）
- 工具 deadline / retry / metrics → `tools/execute` 包装；终态观察 → `tools/result`
- 终轮单调收尾 → `ToolExecution.concludeTurn()`

**feature → mechanism 一一对应**（Agent Note 维护的 microkernel 清单）：每个产品 feature 都映射到某个文档化扩展点的 listener，不存在越界改循环的 row。

## 8. Code Review 与 PR Stack

**maintaining-dsh-code-review.md**：单一指定 operator 周期性运行私有维护工具。每日以 2 UTC day 重叠窗口运行（手动 weekly 用 7 天窗口）。工作流：选 merged-in-window 且 merge commit 可达 `origin/master` 的 PR（不可达或超 250 commit 上限的写入 `skipped-pulls.json` 跳过）→ 收集合并前带 commit anchor 的人类评审反馈（**不**采集 PR conversation comments，因为 GitHub 现态无法给 force-push 安全 baseline，且排除 target-branch-only changes）→ 两个独立 reviewer adapter 分类每条反馈（作者归属 / 是否被采纳）+ 与现行 skill 的关系 → 主 adapter 起草新 `SKILL.md`，两 adapter 同审 diff，blocking findings 循环到双方通过 → 跑 `pnpm run doc-sync` 与 `pnpm run lint`。每个候选都保存到 `~/dsh-code-review-outputs/<timestamp>.{diff,SKILL.md,manifest.json}`，私有 raw I/O 在 `~/Library/Logs/dsh-code-review-maintainer/`。operator 三选一：discard / batch / promote。Promote 用 `dsh-code-review-promote <timestamp>`（从干净 `master`，发现 skill drift 立即停而不覆盖）；adapter 输出**不**原样提交，operator 在评审前做精简、合并、改写。

**responding-to-pr-review-on-a-stack.md**：使用 GitHub 官方 stacked-PR feature（`dsh-merging-stacked-prs` 负责链接与落地）。Ground rules：每个 PR 一个 worktree；GitHub stack 对象（base 链 + `PullRequest.stack` + `stackEntry.position`）权威；**修复落在引入问题的 PR**，再向上游传播（即使下游 PR 也携带该文件）；每次修复保留独立 commit（不要 amend 掉已审过的 commit，仅可 amend 自己未推送未评审的工作）；merge-forward 与 cascading rebase 都允许，rewritten push 必须 lease-protected、不可用 raw `--force`。

**Review ownership**：每条评论先 triage（核实代码，可能误诊断）→ 把采纳 finding 映射到引入它的 PR → 在该 PR 修复 → 沿上游 children 顺序传播（merge-forward：合并父到子，验证后向上；cascading rebase：`gh stack rebase` + 验证 + `gh stack push`，或 `gh stack sync` 但需立刻 post-sync validation）→ 子 agent 报告作 trust-but-verify，必须自己重跑 gate，且 regression guard 须证明 **未修复时也会失败**（红 → 还原）→ 用 `gh api …/comments/{id}/replies` 在 review thread 内回复，标明修复与 head；每次 rewritten push 后重读未解 threads / approvals / mergeability / checks。仅通过官方 stack 流程落地，landing skill 自动链接同作者链、混作者前询问、原生 stack 不可用时硬停。

## 9. 开发流程

**前置**：Node.js 22.19+ / 24+（CI 覆盖 22.19、24、26）；Corepack 启用 pnpm（pin `pnpm@11.7.0`）；Git ≥ 2.26；Windows 与 WSL 2 分开装依赖并保留同 OS 内的 checkout。

**TypeScript 项目布局（face-specific tsconfig）**：

- `tsconfig.json`：solution 根，`files: []`，引用两个 aggregate；tsx 解析脚本的入口。
- `tsconfig.host.json`：Host aggregate，含 Host 包、examples、tests、scripts、website 及 `api/remotes` 的 Host 端。
- `tsconfig.client.json`：Client aggregate，含 `packages/client/*`、tests、`apps/web` 及 `api/remotes` 的 Client 端。
- `tsconfig.base.json`：共享 compilerOptions + 源 `paths`，**不得**加 `include` / `files`（否则泄漏到所有 extending 包）。
- `tsconfig.base.client.json`：浏览器编译（jsx / DOM / `types: []`）。

**tsconfig paths 策略**：单一 base `paths` 把所有 `@deepseek-ai/dsh-*` 解析到 `src`（无 `include`，所以是匹配所有 importer 的 facade）。6 个 host / client 分裂包（`api/remotes` 等）必须用 leaf `tsconfig.host.json` / `tsconfig.client.json` 而非 solution 根；`api/remotes` 是仓库特定的"Host 生成 contract → Client 后续消费"分裂，新包不要模仿。

**工具链（pnpm + tsx + tsdown）**：根构建按生成顺序：`tsc -b tsconfig.host.json` → `tsdown --env.DSH_BUILD_FACE host` → `pnpm --filter @deepseek-ai/dsh-desktop run bundle` → `tsc -b tsconfig.client.json` → `tsdown --env.DSH_BUILD_FACE client` → `pnpm run build:web`。两个 tsdown pass 匹配 `vendor/*` + `packages/*/*` + `apps/cli`；Host pass 另加 `apps/desktop-host`。包级 tsdown 配置按 `DSH_BUILD_FACE` 选条目，Tsdown 仅消费 tsc 阶段产生的 `lib/types` 下 JS。

**SOURCE_LAUNCH contract**：Host 业务方法用 `@Remote` / `@RemoteScope` 声明 → Host 构建生成 Host-for-Client 类型与运行时贡献 → Client `api-remotes` 把这些贡献挂到 `ctx.remote` 与作用域 `agentCtx.remote`。Typert 仅在 Host tsdown 阶段跑，由 `tsconfig.host.json` 喂源；Client tsdown 不启动 Typert。`pnpm run typecheck` 先跑 Host lib 阶段（含生成的 Typert 契约）再 Client tsc；`pnpm run build` 续到 Client tsdown + Web 构建。`pnpm run build:official` 跨平台等价于 CI 与 release 包，**不带**本地 dirty marker；普通 `pnpm run build` 会嵌入版本 / 七字符 commit / dirty marker。`pnpm run dev:web` 先跑完整 build（`--skip-build` 复用现成产物），随后在 watcher 之间共享版本与 git 状态一次——不校验完整构建记录（watcher 会重写）。

**env / hook**：真实 DeepSeek adapter / key-backed demos 读 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_BASE_URL`），real-API e2e 自跳。Lefthook：`pre-commit` 校验 staged pairing、`.oxlintrc.staged.json` + Oxlint bounded retry fix、`THIRD_PARTY_NOTICES.md`、whitespace、vendor manifest guard；`pre-merge-commit` 同 index-backed pairing；`pre-push` 跑 `pnpm run typecheck`。

## 10. 测试规约

**test subprocess launch modes**：CI 与需要构建的 lane 用 built `lib/` 通过共享 dual-mode launcher 跑 profile / Cordis-config 子进程，**不要**手写 `--import tsx`；不加载 Cordis 的协议 / OS fixture 直接用 Node 跑 erasable `.ts`，免 tsx 与无根 paths；只有测试对象是源路径解析时可显式选 `src`。

**keyless recorded-session snapshot**：顶层场景的最高已录父代提供 user input + 模型 replay，并作为期望持久化结果。文件名 `session[.vN].jsonl`（父）/ `session.<ordinal>[.vN].jsonl`（子）；v0 省略 `.v0`，正版本必须小写 `.vN`，文件名须与 header 一致。流程场景通过 `dsh`：headless（一次性）/ SDK（持久控制）/ ACP（自动化协议）/ Web（保留浏览器 + ARIA 证据）。`snapshot.yml` 声明 profile / composition / header class / recording policy / 异常 replay 或 input metadata / workspace facts。`sessionFormat.version` 与 supported coverage 名锁定老 case。Replay / record / refresh 选最高 generation。`test:snapshot:record` 用于模型转写变化，`test:snapshot:refresh` 用于 replay input 仍有效时，每次结果 diff 必须评审。

**真实 API e2e**：`pnpm run test:e2e`，带 key 的测试跑活 provider API——DeepSeek 模型 + 各 provider 特定 smoke（gate 在自己 key 上）；缺 key 自跳以保持无 secret CI 绿色。最高价值是 **smoke 测试**（启动 shipped `dsh` profile → 一条 prompt → 检查世界），捕获"绿色单元测试 / 坏产品"类问题。

**性能基准**：`pnpm run test:bench`（Linux PR gate `node 24 / benchmarks`），timed code 在 plain Node 下运行（不用 tsx）；合成输入施加 time / heap / scaling 预算。包内 `.perf.ts` 仅作诊断。

**snapshot 所有权**：顶层（`snapshots/session/`、`snapshots/sdk/`、`snapshots/acp/`、`snapshots/web/`）是 session-driven；包级 / e2e / mock-only / rationale 证据**不**替代 assembled transcript。owner-local expected output（`*.expected.e2e.ts` 在 `tests/expected/`，对应 `pnpm run test:expected` / `test:web`）不属于顶层快照。Web 浏览器快照：构建 plugin CSS → 比对 `snapshots/web/` 与 `apps/web/tests/expected/`（Chromium）；模型 / 推理选择器在 WebKit。CI 强制 `DSH_SNAPSHOT=replay` 只读；record / refresh 仅本地，diff 必审。

## 11. 防御性模式

每条都是仓库曾发生或几近发生的 bug-class 规则。

- **Report orthogonal outcomes independently**：结果可同时是多件事（进程超时 + exit 0 因 trap signal）。`timedOut` / `signal` / `exitCode` 各自独立字段，不要把一个 flag 嵌套进另一个分支。
- **Honor public contracts on BOTH sides**：实现收到同一结果的多种表示，public API 返出前归一化。`LlmAdapter.stream()` 可抛或发 `finish {kind:'error'|'aborted'}`；`LlmRuntime.stream()` 把模型请求失败只暴露为 terminal finish chunk，中间件与消费者缺陷仍抛。文档化归一化契约，每个来源形态经真实消费者走一遍。
- **Async state is not synchronous state**：`agent.followup()` 无 per-message 完成或结果；background job 完成与 turn 边界 race；`reader.close()` EOF 与 disposal 都触发。不要把 `agent/status` 或 `whenIdle()` 当作某条 follow-up 的结果。Automation caller 真要拥有一次 run 须定义自己的区间（从消息 durable inbox receipt 到下一个 whole-agent `idle`），输出描述为区间范围内而非因果归到那条消息。等待分支若永远不可能发生须显式处理。
- **Dispose must reach quiescence, not just request it**：teardown 发完 kill / abort 不等待即返会留 orphan。cleanup 异步，await children's exit（kill → `done`），关闭 listener / notification registry 在 kill 之前使晚期完成静默。
- **Contain callback exceptions in the dispatcher**：用户 listener 抛错不得拒它所在 promise 或饿死后续 listener。dispatch loop 包 try / catch 并记日志。
- **Never hand untrusted output the ambient environment or predictable paths**：spawned command 拿到 scrubbed env（drop `*KEY*` / `*SECRET*` / `*TOKEN*` / `*PASSWORD*`），temp / spill 文件用私有 0700 目录、随机名、独占 owner-only open（`'wx'`、`0o600`），可预测 world-readable 路径引发 symlink race 与披露。
- **Unlink link-shaped paths**：可能是 symlink 或 Windows junction 的路径用 `lstatSync().isSymbolicLink()` 后 `unlinkSync`（unlink 只删 link 且拒绝真目录）。Windows `rmSync(link)` 对 junction 抛 `ERR_FS_EISDIR`，递归删除可能穿过去。递归 `rmSync` 仅限已知真目录。

## 12. Module Graph

**自动生成的依赖图**：顶部注释 `Generated by scripts/gen-module-graph.ts — do not edit by hand.` + `pnpm run gen-module-graph` 重生成。图描述 `@deepseek-ai/dsh-*` 包之间的 **peer** 依赖（共享实例）；运行时依赖与仅开发期关系不在图上。按 `packages/<group>/<pkg>` 层级分组，边 `a --> b` 表示 a 把 b 列为 peer；名字省略 `@deepseek-ai/` 前缀。图为 mermaid `flowchart TD`，每组一个 subgraph。

**验证脚本**：`pnpm run gen-module-graph` 重生成；图纳入 `verify-puzzle-story` 一类一致性 gate（与 `constraints` / `hygiene` 一并跑），开发规约还要求任何变更高 tier gate 见 `development.md`。布局口径详见 `development.md#typescript-project-layout`——vendored 源码必须通过各自 `vendor/<dir>/tsconfig.json` 进入 Project Reference 图，不被 aggregate 严格程序拉入（重要隔离边界）。