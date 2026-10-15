# 05 · Apps + 剩余 Docs

> 仓库根：`D:\coding\deepseek_harness`

---

## 1. apps/cli — `@deepseek-ai/dsh` CLI（核心启动器）

**角色与定位**：`dsh` 是仓库唯一受支持的 Node 应用启动器。SDK、ACP、Web、Headless 都只是不同 profile，而非独立 bin。Python runtime wheel 也打包同一个 `dsh` 命令。

**入口与命令语法**：argv 由 [`src/args.ts`](apps/cli/src/args.ts) 单次解析；[`src/bin.ts`](apps/cli/src/bin.ts) 仅按需动态 import 选中的 runner。无效命令、跨模式选项、致命配置 / 启动失败均退出码非零。

**支持的 entry mode**：`dsh <name>` / `dsh --profile <name>` 启动 profile；`--from-default-profile <template>` 用 shipped 模板创建新 profile；`web / headless / sdk / sdk-minimal / acp` 五大模式首次自动初始化；`desktop` 名称被 CLI 保留拒绝。`plugin` 子命令转发至 pnpm。

**Profile 合成层（优先级递增）**：空根 → 各 bundle 的 `cordis.patch.yml`（按 `dsh.profile.bundles` 顺序） → profile 级 `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。后层按行覆盖前者，patch 替换整行 `config` 而非深合并。

**关键子模块**：

- **plugin management**：转发 pnpm，`add/remove/update/why`；安装后调和 `dsh.profile.bundles`；共享 `dsh-hmr` 监视；subagent（Codex / Claude Code）作为可选 bundle。
- **dump-config / dump-default-config**：打印合成树不启动；带 file 注释、保留 `!!js`。
- **dump-config-schema**：导出 JSON Schema 2020-12，root 描述 entry 列表，`$defs.patchList` 描述 overlay；保留 `x-cordis` 注解。
- **startup-diagnostics**：必须插件失败打印 failed / pending 列表，写 `$DSH_HOME/logs/startup-<ts>-<uuid>.log`（POSIX 0700 / 0600），退出码 1；附 DSH / Node 版本、平台、profile、原始错误栈，**不采集环境变量**。
- **process-shutdown**：SIGTERM / SIGINT 触发 5 秒宽限 drain，第二次信号强制退出；web 进程本地浏览器接管在 SSH 环境下被抑制。

**关键依赖**：核心为 `@deepseek-ai/dsh-base`（含 `dsh-cmdline`、`dsh-hmr`、`@deepseek-ai/dsh-plugin-manager`）+ 大量 `tool-xxx` / `bundle/*` 插件；profile 直接安装的 out-of-tree 插件位于 profile 的 `node_modules`。

---

## 2. apps/desktop — Electron 桌面应用

**角色**：以 Electron RunAsNode 子进程拉起 `dsh` profile runner，加载打包的 Web 入口 `dsh-app://app/`；Host / Node IPC 传递 boot injections 与 readiness；私有 IPC 传递账户凭证（token 仅 preload 内存），不进入 WebSocket 也不进入 renderer。

**默认端口 `19387`**：与 Web 的 `3080` 分开；`webserver.config.port` 可覆盖。HTTP 转发过滤连接级头（`transfer-encoding`、`connection`、`keep-alive`），plugin bundle 响应标 `no-store` 防 Chromium 缓存膨胀。

**Windows EV 签名要求**：扫描 primary runtime + production 依赖中所有 PE 内容（含无扩展名文件）；批量公钥检测 32 文件 / 4 进程，硬件 token 签名串行；每个新签名必须匹配已配置证书并带时间戳；签名失败终止；electron-builder 仅在签名 + 字节校验后才保留 copied runtime；最终 PE 签名审计 + ASAR 干净缓存 + Host smoke 通过才写 release 完成记录。**开发 / 未签名模式不能关闭 Windows code-integrity policy**。

**macOS arm64 / x64 打包**：原图 `resources/icon.png/svg`；平台适配 `resources/icon-windows.*` 与 `resources/icon-macos.*`；导出透明 1024×1024 PNG；macOS PNG 用内嵌圆角背景以兼容旧 ICNS；electron-builder 生成多尺寸 ICO。Dock 鲸鱼放大 20%。tray 图标来自 `resources/tray-windows.ico`（`render:tray-icon` 由 SVG 渲染 16 / 20 / 24 / 32 / 40 / 48 / 64 px）。

**关键决策表**：Release 身份（shell + dsh 同一版本）/ Runtime（自带 Node + pnpm，Electron `ELECTRON_RUN_AS_NODE=1`）/ 包源（`app.asar/dsh` 自带 production 依赖树）/ 状态所有权（Electron 单实例锁独占 `desktop` profile；CLI 与 Desktop 共享 `$DSH_HOME` 但**不共享**可执行包）/ 传输（同一 Web Host 鉴权实现）/ 更新（一个签名更新单元）。

**运行时 / 依赖**：`runtime/bin` 仅对包安装进程可见；`load_workspace_dependencies` 离线安装 Python（numpy / pandas / python-docx / python-pptx / openpyxl / Pillow / lxml / XlsxWriter）+ Node + pnpm；预 `office-docx / pptx / xlsx`；Wheel 经 `scripts/primary-runtime/lock.json` 锁住。

**Window / Quit 行为**：关闭主窗口仅隐藏（macOS / Win），tray 接管 reopen；Quit 前向 Host 询问 in-flight 任务与已 arm 的 `schedule` 提醒；Host 未就绪 / 失败 / 超时 2 秒按"有任务"处理；本地托盘覆盖更新确认。

**Bundle 校验**：`scripts/desktop-bundle-imports.mjs` 拒绝任何 rolldown 无法解析的 import 为 external，否则启动报 `ERR_MODULE_NOT_FOUND`。

---

## 3. apps/web — Web 入口

apps/web 本身是 Vite 产出，被 CLI 的 `dsh web` 通过 `@deepseek-ai/dsh-client-web` shell library 加载；其 `tests/README.md` 表明该目录主要为浏览器 e2e 测试与 fixture：`apps/web/tests/fixtures/office/` 提供 LibreOffice Kit 导出的 `preview.doc / .xls / .ppt`（含 "Office preview 中文文档"），覆盖 Word / Excel / PowerPoint 97 过滤器的 OLE 转换回归。tests 强调 Host-face（编译走 `tsconfig.host.json`），禁止 import `@deepseek-ai/dsh-client-*`（会拉整个 Client TS project 进 Host build graph），常量要镜像而非引用；`assembled-boot.ts` / `assembled-remote.ts` 是显式 project reference 的例外。

---

## 4. Catalog 目录文件（自动生成 + freshness gate）

### config-catalog.md（`scripts/gen-config-catalog.ts`）
- 录入范围：所有 `packages/*` 中**可被 `cordis.yml` 配置**的 plugin —— 对每个可加载包，verbatim 粘贴 config 声明（含 JSDoc） + 引用类型内联或外链 + `inject` / `refs` / `source`。
- 字段标注：每个字段的三标识（`inject` 服务键列表、`refs` 非内联类型、`source` 声明文件）。
- 双重校验：cross-check runtime schemastery schema 与声明类型，schema 校验键必须能在声明类型上找到；`!!js` 表达式不解析；未导出 Config 的字段是 runtime-only seam，不可从 `cordis.yml` 设置。
- Gate：`pnpm run verify-config-catalog`（属 `doc-sync`）。

### tool-catalog.md（`scripts/gen-tool-catalog.ts`）
- 与 config catalog 互补：录入**模型可见**的工具（name + description + JSON-Schema parameters），覆盖 `packages/*/tool-*`，排除 `examples/`。
- **运行时引导**而非纯 AST：`ctx.tools.schemas()` 在真 context 上 boot 每个 tool 插件后读取 —— schema 包含运行时 spread enum、拼接描述、config 驱动 name、原始 JSON Schema 的 MCP 工具，故静态不可得。
- **Completeness guard** glob `packages/*/tool-*`，新 tool 不会被静默未收录。
- 顶部"Tool Package Map"将模型名 ↔ 插件 ↔ 服务依赖 ↔ 写入面 ↔ 别名 ↔ 部署备注对应。
- Gate：`pnpm run verify-tool-catalog`（属 `doc-sync`）。

### persistence-catalog.md（`scripts/gen-persistence-catalog.ts`）
- 录入范围：仓库声明的**所有持久化 Session 事件**（logical + physical header + event envelope + 各插件声明合并）。
- envelope 字段：`type` / `seq` / `time` / `data` + 可选 `ignorable` + conditional `surfaceOp` / `sourceEventSeqs`。
- 机器指纹：每根类型 + 引用类型 SHA-256 摘要列入 `persistence-schema.json`（注释、源位置、别名、readonly、reorder 不影响；tuple 序、属性名、值类型、可选性影响）。
- 产出 4 件套：双语言 catalog + pairing record + known-event module + machine schema inventory。
- Gate：`pnpm run verify-persistence-catalog`。
- 关联：[`persistence-changes/`](apps/cli/persistence-changes) 含历史格式与 change record；[`cookbook/reviewing-persistence-type-changes.md`](apps/cli/cookbook/reviewing-persistence-type-changes.md) 走变更审查流程。

---

## 5. LLM API Wire Extensions

`docs/deepseek-llm-api-wire-extensions.md` 定义 **`@deepseek-ai/dsh-llm-deepseek`** 在 `deepseek-official` Messages 请求上的 Harness 私有扩展（**不**属于 provider-neutral `llm-pi-ai`）。命名约定：HTTP 头 kebab-case；body 字段 `dsh_` 前缀 snake_case；嵌套成员 camelCase；标签值 kebab-case。

**HTTP 头扩展**：`user-agent`（`product/version (+url)`）、`x-deepseek-harness-user-id`（Harness home 匿名 UUID，鉴权后才发）、`x-deepseek-harness-session-id`（带 Session 时）、`x-deepseek-harness-compact`（`compaction` 目的时为 `"1"`）。

**Body 扩展（事务模型）**：`DeepSeekLlmApiExtensionRegistry` 保留每个 top-level 扩展名的 provider 名；空名 / 重复 / 与 base 字段冲突 → dispatch 前失败。prepare 阶段拿到 base body 不可变快照 + cancel signal，可返回 `undefined` 省略；成功 prepare 后 2xx 响应时再跑 `accept()` 事务；非 2xx / transport 失败不 accept；序列化失败发 base body 不带扩展（贡献者下一请求重发）。

**两大扩展字段**：

- **`dsh_plugin_packages`**（`@deepseek-ai/dsh-plugin-package-inventory-deepseek` 提供，默认启用）：`{ version: 1, packages: [{name, version}] }`，仅含 Loader-backed 真实 npm 包；按 `(name, version)` 去重，按 name → version 文本排序；同包多版本并列。
- **`dsh_session_log`**（`@deepseek-ai/dsh-session-log-deepseek` 提供，默认启用）：承载 Session 日志连续后缀；wire Session header 投影 `{ version, id, createdAt, cwd?, parentSession?, seedLength?, origin?, delegationDepth?, agentPreset? }`；watermark 事务写 `session-log-deepseek/delivery-accepted` 事件；at-least-once，重复可，丢序列不可；fork 上传 own inherited prefix from seq 0。

**接收方要求**：按 `version` 分派、不按 JSON 顺序、session-log 验连续 seq、未识别 canonical 事件无 `ignorable: true` 即拒绝重建。

---

## 6. UI 规约

`docs/ui-radius.md`：统一圆角标准 — 6 档 token `--dsw-radius-xs/sm/md/lg/xl/panel` 对应 R4 / R8 / R12 / R16 / R20 / R28，按**角色 + 尺寸变体**选；Button `sm=H28/R8`、`md=H36/R12`，input H32 / selector H36 → R12，settings cards / 消息气泡 R20，dialog / composer R28。规则覆盖嵌套几何（concentric inset = `outer−inset`）、flush fill 继承父圆角、split guide card（外 R20、内方角 + 外层 clip + 外层 `--dsl-guide-entry-radius`）。引入 `superellipse(1.5)` curve（不支持的引擎降级为圆角）；`corner-shape: round` 与 `50% / 100% / 999px` 同 rule 配对；avatar 容器与 `img` 必须同圆。

`docs/web-styling.md`：CSS 归属 — `ui-theme` 拥有 `--dsw-*` 静态 scale、语义别名、typography、motion、gradient / shadow / scrollbar、`base.css`、`corner-shape.css`、`elevation spec`；`ui-layout` 应用 theme snapshot；feature 包只消费 `--dsw-alias-*`。规则强调：CSS Modules + `clsx`（不要 component library / Tailwind）；elevated surfaces `border: 0` + `--dsw-elevation-*`（0.5px hairline 由首层 shadow 携带）；菜单走 `Menu` / `MenuSurface`（macOS 透明覆盖固定 overlay 用 `--dsw-specific-menu` 94% 不透明）；flat border `0.5px`，state-colored / dashed 保留 1px；anchor 用 `--dsw-alias-link` `font-weight:500`、无 underline、hover dotted 3px-offset。

---

## 7. Graph Atlas / Module Graph

`docs/graph-atlas.md` 是**文档关系索引**，列出 7 个 diagram：module dependency graph（generated）、tool schema catalog（generated）、capability seams（hybrid generated）、`apps/cli/composition.md`（hybrid generated）、event producer / consumer matrix（hybrid generated）、agent lifecycle（curated）、tool execution pipeline（curated）。维护模式混合，各页面自标注。

**生成 vs 手动**：module-graph 等由 `scripts/gen-doc-graphs.ts` 生成；`agent-lifecycle.md` 与 `tool-execution-pipeline.md` 为 curated（手写）。

**CI freshness gate**：`pnpm run gen-doc-graphs` 重生；`pnpm run verify-doc-graphs` 校验。决策归档于 `.agents/notes/archived/process/2026-07-03-documentation-graph-atlas.md`。

---

## 8. CONTRIBUTING / SAFETY / BENCHMARK / BRAND / THIRD_PARTY

**CONTRIBUTING.md**：仍处早期阶段，**暂不接受外部 PR**；鼓励 GitHub Discussions 投票、写插件（打 `dsh-plugin` topic）、博客、社区答疑；仓库视为想法 + 官方 showcase + 启发，不视作强约束；社区插件与官方包同等地位。

**SAFETY.md**：明确实验性开发者预览，未做安全审计；能跑模型生成代码、加载三方插件、访问网络 / 进程 / 凭据 / 文件；沙盒 / 批准 / 权限可降险但**不**保证隔离；要求最小权限、隔离环境、备份、审阅插件与命令；按 MIT License 无任何担保。

**BENCHMARK.md**：极简 — 装 Python SDK，跑 `jsonrpc-agent` minimal 变体；独立基准任务用独立 workspace + session id。

**BRAND_GUIDELINES.md**：可使用 "DeepSeek Harness" 描述关系（如 "built on ..."）；命名用缩写 **DSH**；**不要**把全名直接写进项目名（"DeepSeek Harness" 是 DeepSeek 注册商标）；避免让用户误以为有官方背书。

**THIRD_PARTY_NOTICES.md**（`scripts/gen-third-party-notices.ts` 生成）：仓库依赖列表 + 显式披露的 Claude Code 平台 payload closure + Bundled Python distributions。`vendor/` 含 9 个 source-vendored `@deepseek-ai/*`（cosmokit / schemastery / cordis + 6 个 cordis plugins），均为 MIT，保留上游 LICENSE；完整 npm 传递依赖在 `pnpm-lock.yaml`（含 Landlock launcher workspace），Python SDK 在 `python/sdk/uv.lock`。Pre-commit hook + `pnpm run verify-third-party-notices` + `scripts/gen-third-party-notices.spec.ts` 三重校验。

---

## 备注

- `apps/cli/composition.md` 存在（glob 命中），描述 dsh 共享 base 组合的 hybrid generated 图。
- 所有"generated by"文件均含 `<!-- Generated by scripts/gen-*.ts — do not edit by hand. -->` 头，并配套 `verify-*-check` / `verify-*` 脚本。
- 翻译策略：`README.zh.md` 与英文版内容**逐段对齐**（"## 运行"、"## 从源码运行"等 `<a id="...">` 锚点与英文一致），双语文件通过 `English | [中文](*.zh.md)` 互链。