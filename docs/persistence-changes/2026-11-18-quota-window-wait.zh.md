---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-quota-window-wait

[English](2026-11-18-quota-window-wait.md) | 中文

## 概述

为会恢复的额度窗口增加 llm/quota-wait 与 llm/quota-wait-started 会话事件，并补记实现里已经存在、此前没有确认记录的 model/routing-mode 事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-quota-window-wait
baseline: false
changes:
  - root: "event:llm/quota-wait"
    previous: null
    after: "fec0f1fff540f8cd732b9897899883b1e2fb2e597f84c90e07e04f4f277047c2"
    decision: same-version
  - root: "event:llm/quota-wait-started"
    previous: null
    after: "069031af248de8436f70f667089884ad1c02559577b853f619a2d28ca36a3589"
    decision: same-version
  - root: "event:model/routing-mode"
    previous: null
    after: "f10b1ad5cdba9dfb73ed6cf0e9ba63c774e4523b8337958b9b51c22ef598acd5"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有日志仍然有效。包含 llm/quota-wait 或 llm/quota-wait-started 的新日志会被更旧的读取方拒绝，这与其他必需事件的规则相同。这些事件是状态记录：省略它们不改变模型可见的历史，理解它们的读取方只用 resumeAtMs 展示这次暂停。model/routing-mode 已由模型选择写入，且只进入日志；本记录用 same-version 补上它缺失的确认。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm-quota-wait/tests/wait.spec.ts packages/llm/llm-minimax/tests/quota.spec.ts

<a id="dev-note"></a>
## 开发备注

无。
