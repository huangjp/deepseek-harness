---
description: "Holds an agent step until a replenishing provider quota window opens, then resumes the same task."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-quota-wait

English | [中文](README.zh.md)

## Summary

Mount `@deepseek-ai/dsh-llm-quota-wait` to keep a running task on the same step when a provider reports a replenishing quota window (`QUOTA_WINDOW`). The step waits until the provider can serve again, then retries that step inside the same open turn. Short `RATE_LIMIT` failures stay on `@deepseek-ai/dsh-llm-retry`. Direct `ctx.llm.stream()` calls are not held.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin next to `dsh-llm-retry` in a composition that runs the agent loop. It has no configuration. A provider opts in by finishing the failed request with code `QUOTA_WINDOW`. It may also listen on `llm/quota-window` and return `{ window, resetAtMs }` for that route; any other route must call `next()`.

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
- name: '@deepseek-ai/dsh-llm-quota-wait'
```

`QUOTA_WINDOW` is not in the default retryable set, so the ordinary retry policy delegates and this plugin owns the wait. A reported `resetAtMs` sleeps until that instant plus two seconds. When the clock is missing, stale, or more than eight days away, the wait probes: 60 seconds, then doubling, capped at 15 minutes, until the request succeeds or the turn is cancelled. Each probe is the retried model request, not a side loop.

The wait is visible before it starts. The plugin appends `llm/quota-wait` with the provider, the window (`interval`, `weekly`, or `unknown`), and absolute `resumeAtMs`, then `llm/quota-wait-started` when the same step is about to run again. The Chat row reads those events. Headless logs the same pause at info. Cancelling the turn aborts the timer and ends the turn as aborted; the step is not retried.

A `llm/quota-hold` notice tells the model router the route should be skipped until `resumeAtMs`. That skip applies only to later auto-routed claims. The in-flight step, including an auto-routed one, keeps the model selection it already captured and waits. Fixed mode never consults the skip, so a session pinned to the provider waits when its own request hits the window. `QUOTA_WINDOW` does not increment the router's failure cooldown.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The listener sits on `agent/request-error` and returns `{ kind: 'retry' }` only for `QUOTA_WINDOW`. The agent loop then runs the same step again over the durable history, including tool results already committed in the turn. The sleep is one timer, or several timers of at most the platform limit when the delay is longer than that limit. There is no polling loop.

`scheduleQuotaWait` is the pure decision: a usable reset wins over the probe. Consecutive probes are counted in plugin memory per session and provider and cleared when that provider appends an assistant message.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-llm-retry](../llm-retry/README.md) — the short retry policy this wait does not replace.
- [dsh-llm-minimax](../llm-minimax/README.md) — the provider that classifies MiniMax plan-window 429s and reads the usage clock.
- [dsh-model-router](../../core/model-router/README.md) — how a quota hold skips later auto-routed claims without counting as a breaker failure.

-----

<a id="model-experience"></a>
## Model Experience

### Quota-window resume

#### What the model sees

No wait event, delay, or provider error is model-visible. The retried step rebuilds the same provider and model request from the durable history. Tool results committed before the window stay in that history.

#### Token effect

The `llm/quota-wait` record sends no tokens. The retry is a new provider request and may repeat input-token billing for the same step. Probes are further billed requests.

#### KV Cache effect

A retry of the same step sends the same prefix the failed attempt sent, so a provider that caches that prefix can reuse it. The wait does not rewrite history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A process restart does not resume the wait.** Agent-loop resume closes an open turn as interrupted before any plugin can re-enter the model request. The `llm/quota-wait` event remains in the log, and the user continues the task with a new turn. Tool results committed before the restart remain in the session.
- **Only agent-loop request failures are held.** A direct `ctx.llm.stream()` call still ends on `QUOTA_WINDOW`.
- **The in-flight step cannot change provider.** Auto-routed sessions wait on the route the step already captured. Later claims may use another rule; this step does not.

### Dev Note

No runtime invariant companion is published: the wait is the `agent/request-error` decision plus the two session events, and `scheduleQuotaWait` is covered by unit tests.
