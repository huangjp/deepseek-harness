# DeepSeek Harness 学习知识库

> 范围：仓库 `D:\coding\deepseek_harness` 的核心文档切片（按用户决策"核心 + 子系统 + cookbook + 49 group README"）。
> 排除：`.agents/notes/archived/*`（frozen 历史）、`scripts/*`、`python/*`、`native/*`、`vendor/*`、`benchmarks/*`、所有 `.zh.md` 翻译副本。
> 生成方式：6 个并行 explore 子代理批量读取 → 整合 → 落盘。所有结构化中文摘要，专有名词保留英文。

---

## 索引

| # | 文件 | 内容 |
|---|---|---|
| 00 | [00-overview.md](./00-overview.md) | 项目身份 / Cordis 核心 / Architecture / Turn 流程 / Capability Seam / Session 持久化 / 顶层 AGENTS 规约 |
| 01 | [01-subsystems.md](./01-subsystems.md) | 53 个 subsystem：核心 spine / 模型适配 / 执行能力 / 文件数据 / 协作工作流 / 用户协作 / UI Web / 规划扩展 |
| 03 | [02-cookbook-and-practices.md](./02-cookbook-and-practices.md) | Cookbook（加 package / tool / LLM adapter / settings card / Remote API / vendored / session format）+ persistence 变更流程 + extension cookbook + PR stack + 开发 / 测试 / 防御性模式 + module graph |
| 04 | [03-packages-overview.md](./03-packages-overview.md) | 54 个 packages group 索引：定位 / 关键概念 / 子包 / ctx 接口 / 典型依赖 |
| 05 | [04-key-packages.md](./04-key-packages.md) | 关键 packages 内部摘要：core / session / llm / shell / terminal / ssh / subprocess / sandbox / web / fs / browser-use / computer-use / subagent / workflow / mcp / hooks / webhook / bundle / sdk / acp / boot / preset / experimental / test-support / runtime-diagnostics / util |
| 06 | [05-apps-and-misc.md](./05-apps-and-misc.md) | apps/cli / apps/desktop / apps/web + config-catalog / tool-catalog / persistence-catalog / LLM wire extensions / UI 规约 / graph atlas / CONTRIBUTING / SAFETY / BRAND |

---

## 使用建议

1. **入门路径**：`00` → `02` 的 §9 开发流程 + §10 测试规约 → `02` 的 §5 加 Remote API / vendored package / session format
2. **理解 agent 行为**：先读 `00` 的 §3 Architecture + §4 Turn 流程，再看 `01` 的 `core / session / tools / agent-loop` 摘要
3. **理解 capability seam**：看 `00` 的 §5 Capability Seam 三元组，再按需查 `01` 的 `shell / fs / ssh / web / sandbox / lsp / spill / attachment / terminal / ptc-runtime / web / browser-use / computer-use`
4. **理解持久化**：`00` 的 §6 → `02` 的 §6 persistence type changes → `04` 的 session/* 摘要 → `04` 的 session-format-vN-to-vN+1 摘要
5. **理解 UI / 客户端**：`01` 的 §7 UI / Web（web-client / web-server / conversation / slots / sidebar-right / client-modules / client-resources）+ `05` 的 apps/web + §6 UI 规约
6. **理解扩展点 / 决策**：`02` 的 §7 Extension Cookbook（决策树）+ `02` 的 §8 Code Review 与 PR Stack

---

## 项目速记

- **CLI**：`npx @deepseek-ai/dsh web`（默认端口 `127.0.0.1:3080`）
- **5 个 profile**：`web` / `headless` / `sdk` / `sdk-minimal` / `acp`
- **版本**：`0.2.0-rc.1`（pre-stable，README 警告"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"）
- **Session 格式**：V4 finalized / V3 released
- **Node**：^22.19 || >=24，pnpm 11.7.0
- **不接收外部 PR**：CONTRIBUTING.md 明确写到 v0.2
- **54 个 packages group**：见 `03-packages-overview.md`
- **53 个 subsystem**：见 `01-subsystems.md`（docs/subsystems/*.md）