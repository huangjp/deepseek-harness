---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-quota-window-wait

English | [中文](2026-11-18-quota-window-wait.zh.md)

## Summary

Adds llm/quota-wait and llm/quota-wait-started session events for a replenishing quota window, and records the already-implemented model/routing-mode event that no earlier acknowledgement listed.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing logs stay valid. A newer log that contains llm/quota-wait or llm/quota-wait-started is refused by an older reader, which is the same rule as every other required event. Those events are status records: omitting them does not change model-visible history, and a reader that understands them uses resumeAtMs only to display the pause. model/routing-mode was already written by model selection and is log-only; this record adds its missing acknowledgement with the same-version decision.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm-quota-wait/tests/wait.spec.ts packages/llm/llm-minimax/tests/quota.spec.ts

<a id="dev-note"></a>
## Dev Note

None.
