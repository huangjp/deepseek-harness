---
description: "Task-driven model routing for the DeepSeek Harness: a deployment declares a rule table, and each task runs on the provider route that fits it."
kind: "package-reference"
---

# @deepseek-ai/dsh-model-router

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-model-router` picks the provider route a task runs on. A harness deployment registers several routes — one that thinks before it answers, one that accepts images, one tuned for code — but the harness keeps exactly one model selection per Agent, so every task runs on whichever route the user last picked. This plugin reads the task that is about to run and applies the route the deployment's rule table names for it, for the Sessions that left the choice open. It never changes what a task does, only which route answers it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a composition that has more than one provider route registered, then declare the rule table in its settings:

```yaml
- id: model-router
  name: '@deepseek-ai/dsh-model-router'
  config:
    enabled: true
    rules:
      - name: long-form-writing
        keywords: ['小说', '章节', '正文']
        provider: slefminimax
        model: MiniMax-M3.1-Flash
        reasoningEffort: max
      - name: image-tasks
        hasImage: true
        provider: dpv41f
        model: deepseek-v4.1-flash
      - name: code-tasks
        keywords: ['实现', '修复', '重构']
        provider: slefgpt56
        model: copilot
      # 兜底：两条 hasImage 规则合起来覆盖「其余所有任务」。
      - name: fallback-text
        hasImage: false
        provider: dpv41f
        model: deepseek-v4.1-flash
      - name: fallback-image
        hasImage: true
        provider: dpv41f
        model: deepseek-v4.1-flash
    # 连续失败几次后暂时绕开这条通道；0 = 永不绕开
    failureThreshold: 2
    # 绕开后的冷却时长（毫秒）
    cooldownMs: 300000
```

Routing is **off by default**. A rule matches when every condition it states holds: `keywords` are matched case-insensitively against the claimed message's text, and `hasImage` constrains whether the message carries an image. A rule that states neither condition matches nothing, so an unconditional rule cannot silently capture every task. The rules are read top to bottom and the first match wins, so the most specific rule belongs first.

The table is also editable at runtime. The `dsh-client-ui-settings-model-router` companion package puts it on the web client's Plugins page, so a deployment can retune which model answers which kind of work without editing YAML. The plugin reads the table as a volatile value and refreshes its cached route view when it changes, so a table edited in the page applies to the next task.

A target is honored only when the deployment registers that provider and model. A rule whose target is not registered, or whose target does not accept the image the task carries, cannot be honored: it is passed over with a debug log and the next rule is considered, so a later rule that names a usable route still gets its turn. A requested `reasoningEffort` is applied when the target route offers that effort; otherwise the target keeps its own default.

Because a rule that states no condition matches nothing, a deployment expresses "everything else" as the two `hasImage` rules shown above: one for a task without an image, one for a task with an image. Those same two rules are what lets the breaker move a task: when a rule's route is skipped, the next rule that **fits** the task takes it, and a table without a rule that fits leaves the Agent on the route it already had — the one that just failed.

A route that cannot answer is worse than no route at all: an exhausted quota, a revoked credential and an unreachable relay all make the request fail. The plugin therefore watches each route's own outcomes and routes around a route that keeps failing. `failureThreshold` consecutive failures — two by default — skip that route for `cooldownMs` milliseconds (five minutes by default), and the next rule that fits the task takes the task instead. A route that answers again becomes eligible at once, and a threshold of zero never routes around an ordinary failure. The cooldown is a **wall-clock window**, not a retry budget: once it expires the route is eligible again and the next matching task tries it once more, and a fresh failure skips it again at once — the failure count is kept, so an expired cooldown does not clear it.

Leaving the sections below unset keeps an existing rule table on its previous behavior: classification only writes a debug log, stickiness, cost, and fallback stay off, and health stays the consecutive-failure breaker above.

### Difficulty tiers

The classifier assigns `simple`, `standard`, or `hard` when the message is claimed, and by default it does not call a model. It reads prompt length, the latest usage total in the session, images or files, the number of `tool/call` events, whether `todo_write` or `plan` has run, fenced code, a step list of three or more lines, the selected reasoning effort, and Chinese and English keywords and hints (for example "深度思考", "think hard", "简短"). An empty keyword array means the built-in list; a non-empty array replaces that list.

A rule may add a `tier` condition, which must hold together with its keywords and `hasImage`. A non-empty `routes` list replaces that rule's own `provider` and `model` as the candidate list. `tierRoutes` is consulted after the rule table: when no earlier rule takes the task, the list for the classified tier is tried. Another plugin may `provide` a service named `modelRouterClassifier` to replace the classifier. The decision cannot wait, so that service must return synchronously.

```yaml
classifier:
  enabled: true
stickiness:
  enabled: false
health:
  mode: consecutive
tierRoutes:
  hard:
    - provider: minimax-official
      model: MiniMax-M3.1-Flash
      reasoningEffort: high
rules:
  - name: hard-writing
    tier: hard
    keywords: ['小说']
    routes:
      - provider: slefminimax
        model: MiniMax-M3.1-Flash
        reasoningEffort: max
      - provider: dpv41f
        model: deepseek-v4.1-flash
    provider: slefminimax
    model: MiniMax-M3.1-Flash
```

Every claim writes a debug log with the tier and the three scores, for example `tier hard (simple=0 standard=1 hard=8; hint-hard)`.

### Session stickiness

`stickiness.enabled` defaults to `false`. When it is on, an Agent routed in auto mode keeps that route on later turns, so the prompt cache and the reply's style stay put. It leaves the route only when the route is cooling down, held for a quota window, over its budget, out of remaining quota, or marked unusable by an auth or other 4xx configuration failure; when the tier rises by at least `upgradeSteps` (1 by default, so simple to standard switches; 2 switches only from simple to hard); or when the task carries an image and the route does not accept one. A drop in tier does not switch. The record hangs off the in-process Agent object, so the turn after a process restart is chosen from the rule table again.

The reason for leaving is the same info log as a route selection, for example `leaving p1/m1 because the task rose from simple to hard`.

### Route health

`health.mode` defaults to `consecutive`, which is the "`failureThreshold` failures, then `cooldownMs`" breaker above. With `scored`, auto routing picks the healthier candidate among the routes that match and can be honored. Equal scores keep rule order, so a table of healthy routes behaves as it did before.

The score is an exponential moving average of success, latency, and time to first token. Failures are weighted: timeout, 5xx, network, and unclassified each count as 1; a short 429 (`RATE_LIMIT`) counts as 0.5 by default, so it trips more slowly; one `QUOTA` counts as the whole threshold. Auth codes and other 4xx statuses do not open a cooldown. They mark the route unusable until `llm/adapters-updated` or `loader/volatile-update`, which is a configuration or route-registration change. Once the weighted penalty reaches the threshold the circuit opens. The cooldown starts at `cooldownMs`, doubles by `backoffFactor` (2 by default) with `jitterRatio` jitter, and is capped by `maxCooldownMs`. After the cooldown, `probeLimit` requests (1 by default) are admitted. A successful probe closes the circuit; a failed probe lengthens the cooldown.

`failureThreshold: 0` still does not open a cooldown for an ordinary failure. An auth mark and a `hold` are not affected by that zero.

The failure code `QUOTA_WINDOW` does not move the breaker. This plugin listens for `llm/quota-hold` and calls `hold` with that notice's `resumeAtMs`. Later auto-mode claims skip the route until that instant, and stickiness logs the quota window as the reason for leaving. `fixed` mode does not consult the skip: the in-flight step stays on the same route and the quota-wait plugin resumes it when the window opens.

### Quota and cost

`cost.enabled` defaults to `false`. Turning it on without `pricing` does not change routing. Each price names the cost per million input tokens and per million output tokens, an optional currency, and optional 24-hour and 30-day budgets. Token totals and the estimate live in process memory and are cleared by a restart. A route that has spent its budget is skipped in auto mode, and the reason is budget.

A provider that can report remaining quota answers `llm/quota-remaining`. MiniMax reuses the usage clock it already has, rather than a second endpoint. The claim reads it asynchronously, and the next claim is the one that uses the reading. When the remaining fraction falls below `cost.remainingThreshold` (0.2 by default), that route's health score is scaled down, before a 429. A reading of 0 skips the route, and the reason is quota.

```yaml
cost:
  enabled: true
  remainingThreshold: 0.2
pricing:
  - provider: minimax-official
    model: MiniMax-M3.1-Flash
    inputPerMillion: 1.2
    outputPerMillion: 4
    currency: USD
    dailyBudget: 20
    monthlyBudget: 400
```

### Fallback chain

`fallback.enabled` defaults to `false`. When it is on, a rule's non-empty `routes` list is the ordered candidate list. If the chosen route fails before it has written any reply text, the recovery action names the next candidate that is still healthy, not held, and not over its budget or remaining quota, and the same step may switch up to `maxHops` times (1 by default). `model.select` during recovery still applies only to a later step. `fixed` mode and `QUOTA_WINDOW` do not switch routes.

Text already written into the stream is not handed to the next route. The failed attempt is stored as `assistant/attempt` and is not part of the next request's model history. The next route sees the conversation from before this failure, plus the harness's existing model-switch notice.

```yaml
fallback:
  enabled: true
  maxHops: 2
```

`xai-official` can sit in that same ordered list. Below 200k prompt tokens, `grok-4.7` is $2 / $6 and `grok-build-0.1` is $1 / $2 per million input / output tokens; at 200k and above xAI doubles both. Put different numbers under `pricing` to replace them. Without `XAI_API_KEY` the route lists no models and the router skips it. The shipped web rule table does not route to Grok.

```yaml
rules:
  - name: grok-fallback
    keywords: ['小说']
    provider: minimax-official
    model: MiniMax-M3.1-Flash
    routes:
      - provider: minimax-official
        model: MiniMax-M3.1-Flash
      - provider: xai-official
        model: grok-4.7
pricing:
  - provider: xai-official
    model: grok-4.7
    inputPerMillion: 2
    outputPerMillion: 6
    currency: USD
  - provider: xai-official
    model: grok-build-0.1
    inputPerMillion: 1
    outputPerMillion: 2
    currency: USD
fallback:
  enabled: true
  maxHops: 1
```

### Observability

Every claim is recorded on the in-process `ctx.modelRouter`: the matched rule, the tier and scores, the candidates and their health scores, the chosen route, the reason for leaving, cumulative tokens, the estimated cost, and, once the answer finishes, latency and time to first token. `snapshot()` aggregates by route, and `decisions()` keeps the latest 50 claims. The Plugins page has no stats remote, so the desktop settings page cannot read this memory.

When auto mode leaves a route, or the same step falls back, the session appends `model-router/notice`. The chat shows that reason on one row, the same way it shows a quota wait. The event does not enter model history.

### Routing mode

A Session chooses the route that answers it, and the chat's model switcher is where that choice is made. A Session that names a provider and model pins that route: it is in the `fixed` routing mode, and this plugin never touches it — no rule matches it, and no rule overrides it. A Session that leaves the choice open is in the `auto` mode, and that is the only kind this plugin routes. A Session that has never recorded a mode follows the deployment's default, which is `auto` unless the deployment declares otherwise.

The mode is read when the loop claims the task, so a Session that switches back to `auto` is routed again from its next task on.

<a id="understand-the-implementation"></a>
## Understand the implementation

The decision happens on `agent/inbox/claimed`, which the agent loop emits at `packages/core/agent-loop/src/agent.ts` while it claims the messages for a step. The plugin first reads the Session's routing mode: a Session in the `fixed` mode is left alone, so the decision below applies only to a Session in the `auto` mode. The very next line captures the step's model selection, so a route the plugin selects in that event is the route the **first** step uses rather than the one after it. This is why the plugin listens to the inbox rather than to `agent/pre-step`: the pre-step waterfall runs after the selection has already been captured, and a selection made there would apply to the next step only.

The plugin calls `agent.model.select()`, the same public seam the Models page uses. The selection is recorded in the session log as a `model/selection` event, so a routed session reads back the route each step actually used.

Two pieces make the decision synchronous. The rule table and the signals come from the message the loop already holds. The **catalog** of the routes the rule table names is read asynchronously and cached, because the decision cannot await a lookup between the claim and the selection. The cache is refreshed when `llm/adapters-updated` fires, and a rule whose target is not cached is passed over — routing to an unregistered route would fail the request instead of falling back.

The catalog resolves each rule's exact model rather than listing a route's models. A route's own listing reports the route as empty while that route's credential does not resolve, and a route that cannot answer yet is still the route a rule names. The plugin's own startup waits, for a bounded time, for the routes its rules name to register, so the first turn of a session is routed instead of falling back to the Agent's own route.

Failures are read from the `agent/request-error` waterfall, which every failed request attempt passes through, and answers are read from the `assistant/message` session event, which names the provider that produced them. The plugin listens ahead of the retry policy on that waterfall, so it sees every failed attempt rather than only the ones the retry policy passes on. Stream frames supply latency and time to first token, which feed the health score and not the consecutive-failure count. The state is held per plugin rather than per session: a route that cannot answer for one session cannot answer for another either, so the next session's decision does not pay for the failure the last one already paid for. Classification, stickiness, and selection all happen in that same claim, and the decision stays synchronous.

<a id="further-exploration"></a>
## Further Exploration

- The rules themselves are data: `packages/core/model-router/src/rules.ts` holds the matcher, `packages/core/model-router/src/classify.ts` holds the default classifier, `packages/core/model-router/src/health.ts` holds the breaker, and `packages/core/model-router/src/catalog.ts` holds the cached registry view.
- `packages/client/ui-settings-model-router` is the browser half that edits this table from the Plugins page.
- The seam the plugin writes to is `agent.model.select()` in `packages/core/agent/src/runtime-types.ts`; the loop's capture point is `packages/core/agent-loop/src/agent.ts`.
- `packages/llm/llm-local-bridge` registers the bundled local relay routes this plugin usually routes between.

<a id="model-experience"></a>
## Model Experience

### Route selection before the first request

#### What the model sees

Routing does not change the messages the model reads. The only model-visible addition is the model-switch notice the harness appends when the routed route differs from the route the previous request used: a user-role message naming the provider and model it moved from and the one it moved to. A decision that keeps the route the Agent already holds appends nothing.

##### The notice the model reads

```markdown
[model changed: assistant turns above this point were generated by {from}; the session continues with {to}]
```

#### Token effect

Routing adds no tokens to the request. The rule table is read from the plugin's configuration rather than from the conversation, and the signals it reads — the claimed message's text and its image blocks — are already part of the request. Changing route does change the request's own accounting: the harness drops the previous provider's replay state from the assistant history, so a switched route sends its history without that state.

#### KV Cache effect

The routed route replaces the request's provider and model, so the cached prefix the previous provider held for this conversation is not reused: a request that follows a route change is an independent model request rather than an append onto the previous one. A decision that keeps the route the Agent already holds changes nothing in the request, and therefore leaves an already-reusable prefix intact. With stickiness on, later turns keep that route, so the prefix stays reusable; the route changes when the tier rises, the route is unhealthy, or the task starts carrying an image, and that change still uses the harness's existing model-switch notice.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Rules read the message only.** A rule sees the claimed message's text and whether it carries an image. It does not see the Agent's preset, its tool set, the task's history length, or the deployment's own notion of what kind of work is running, so two tasks that ask for the same thing in different words can land on different routes.
- **A route change drops the previous provider's replay state.** The harness keeps assistant history in a form only its owning adapter can replay, so switching routes sends the history without that state. A task whose earlier turns carried provider-specific replay data may lose it mid-conversation.
- **Effort is not validated against the deployment's credentials.** The plugin checks that the target route offers the requested effort and declines one it does not, but a target whose credential is missing fails at request time with the provider's own error rather than at routing time.
- **Fallback does not replay a partial reply.** `fallback.enabled` is off unless configured. When it is on, the same step moves to the next candidate only if the route fails before it writes reply text. Text already streamed stays on `assistant/attempt` and is not sent to the next route. `fixed` mode and `QUOTA_WINDOW` stay on the original route.
- **The classifier does not call a model.** It reads length, usage, attachments, tool history, and keywords. The same request phrased differently can land in a different tier. `modelRouterClassifier` can be another synchronous implementation, but the claim cannot wait for a second model call.
- **Stickiness does not cross a process.** The record hangs off the current Agent object. The turn after a restart is chosen from the rule table again.
- **The Plugins page does not edit tier or the candidate list.** A save writes `tier` and `routes` back unchanged, and the page has no controls for them. Change them in YAML.
- **Scored health is off unless configured.** Without `health.mode: scored` the breaker stays consecutive failures. `QUOTA_WINDOW` is not counted. `llm/quota-hold` skips later auto routing until the resume instant; `fixed` mode still waits on the same route.
- **Cost and stats do not cross a process.** Without price metadata the cost logic is a no-op. Usage, budgets, and `ctx.modelRouter` live in memory. A remaining-quota reading is asynchronous, so the claim that requested it does not use it yet. The Plugins page does not render the aggregate.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The rule table lives in the plugin's settings namespace, so a deployment that wants a table different from the shipped one writes a `model-router` row in its profile patch; the patch replaces the whole row rather than merging into it. The router reads the claimed message's text and image blocks only, and it applies a decision when the Agent claims a message — not when the user opens a turn — so a rule that matches a later message of the same turn is not consulted for that turn.

</details>
