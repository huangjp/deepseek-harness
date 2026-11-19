# Agent Note: MiniMax quota window wait

Status: implemented

English | [中文](2026-11-18-minimax-quota-window-wait.zh.md)

## Problem

MiniMax's Anthropic-compatible Messages route answers HTTP 429 both when the short request rate is exceeded and when the plan window is used up. The short case is usable again within about a minute. The plan case is either the 5-hour window or the shared weekly window, and MiniMax's usage rules say the quota returns when that window ends. The windows start at first use. The 429 body that MiniMax documents, and the bodies observed for codes 2056 and 2067, carry the plan wording and the code. They do not carry `Retry-After` or a reset instant. pi-ai keeps only `error.message`, so the response headers never reach the harness.

The ordinary retry policy treats a 429 as `RATE_LIMIT`, sleeps at most ten seconds, and gives up after five attempts. A plan window therefore ends the turn. The user has to come back and continue the task by hand. The model router's breaker counts two failures and then skips the route for five minutes, which is the wrong clock for a window that lasts hours or a week, and it does not keep the in-flight step alive.

## Decision

`QUOTA_WINDOW` is the provider-neutral code for a replenishing window. `RATE_LIMIT` remains the short limit, and `QUOTA` remains a balance that this wait does not treat as recoverable. MiniMax classifies 2056, 2067, and the plan wording as `QUOTA_WINDOW` before the shared pi-ai map. Codes 1002 and 2062, and the documented RPM/TPM/concurrency text, stay on that map and therefore on `dsh-llm-retry`.

`dsh-llm-quota-wait` listens on `agent/request-error` after the short retry policy. For `QUOTA_WINDOW` it asks `llm/quota-window`. MiniMax answers with the usage clock: `GET /v1/token_plan/remains`, then the coding-plan path, on the API host and the `www` host when the configured host starts with `api.`. `end_time` is the 5-hour window and `weekly_end_time` is the weekly window. Text models need both; when both are exhausted the weekly end is binding, because a 5-hour reset does not restore weekly quota. The step sleeps until that instant plus two seconds, appends `llm/quota-wait` with the absolute resume time before the sleep, and then retries the same step. Cancellation is the turn abort signal.

When the clock is missing, already past, or more than eight days away, the wait probes from one minute, doubling to fifteen minutes. It does not invent a wall-clock 5-hour boundary. The probe is the retried model request. One timer, or several timers under the platform limit, performs the sleep.

The in-flight step always waits, including when the session's routing mode is auto, because the step's model selection is already fixed and the loop will not change provider inside it. Fixed mode is the same wait. Later auto-routed claims skip the route until `resumeAtMs` because the plugin emits `llm/quota-hold`. `QUOTA_WINDOW` does not increment the router's failure count, so the five-minute cooldown does not replace the window. Another provider opts in by emitting `QUOTA_WINDOW` and, if it can, answering `llm/quota-window`.

## Alternatives considered

**Stretch `retryPolicy.maxDelayMs` to a week.** The short retry budget, the five-attempt cap, and the ten-second default exist for `RATE_LIMIT` and transport failures. A plan window is a different failure and would spend that budget or be refused when `Retry-After` exceeds `maxDelayMs`.

**Fail over the in-flight auto-routed step to another route.** The step captures its model selection before the request, and `agent/request` is not allowed to change it. Failing the turn so the next user message can be routed elsewhere drops the task the user already started. Later claims still fail over through the hold.

**Guess the next 5-hour boundary from the wall clock.** MiniMax starts each window at first use. A boundary computed from the epoch can miss the real reset by hours.

**Resume the wait after a process restart.** Resume closes an open turn as interrupted before a plugin runs. Re-opening that turn would be a new agent-loop lifecycle. The committed tool results stay; the wait does not.

## Consequences

A MiniMax session that hits a plan window stays on the same turn until the window opens or the user cancels. A short 429 still uses the quick retry. Auto-routed work that has not started can use another rule for the whole window instead of a five-minute cooldown. The cost is a long-lived in-process timer and, when the clock is missing, billed probe requests. A restart still ends the open turn, and the user continues it afterward.
