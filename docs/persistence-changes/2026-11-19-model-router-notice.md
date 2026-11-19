---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-19-model-router-notice

English | [中文](2026-11-19-model-router-notice.zh.md)

## Summary

Adds the log-only model-router/notice session event for an auto-routing switch, fallback, hold, or budget skip.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing logs stay valid. A newer log that contains model-router/notice is refused by an older reader, which is the same rule as every other required event. The event is a status record: omitting it does not change model-visible history, and a reader that understands it shows the detail text in the chat.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/model-router/tests packages/client/ui-chat/tests/route-notice.client.spec.tsx

<a id="dev-note"></a>
## Dev Note

None.
