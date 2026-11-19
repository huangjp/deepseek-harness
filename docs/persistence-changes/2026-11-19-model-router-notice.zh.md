---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-19-model-router-notice

[English](2026-11-19-model-router-notice.md) | 中文

## 概述

新增仅记日志的 model-router/notice 会话事件，用于自动路由的换道、回退、额度暂停或预算跳过。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-19-model-router-notice
baseline: false
changes:
  - root: "event:model-router/notice"
    previous: null
    after: "bddf77c494ffe4fd64629fd16d8c96f8259d7347c20c33345e54f6490c253175"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有日志仍然有效。含有 model-router/notice 的较新日志会被较旧的读取器拒绝，这与其他必读事件的规则相同。该事件是状态记录：省略它不会改变模型可见历史，能识别它的读取器只在聊天里显示详情。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/model-router/tests packages/client/ui-chat/tests/route-notice.client.spec.tsx

<a id="dev-note"></a>
## 开发备注

无。
