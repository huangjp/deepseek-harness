---
description: "Task-driven model routing for the DeepSeek Harness: a deployment declares a rule table, and each task runs on the provider route that fits it."
kind: "package-reference"
---

# @deepseek-ai/dsh-model-router

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-model-router` picks the provider route a task runs on. A harness deployment registers several routes — one that thinks before it answers, one that accepts images, one tuned for code — but the harness keeps exactly one model selection per Agent, so every task runs on whichever route the user last picked. This plugin reads the task that is about to run and applies the route the deployment's rule table names for it, for the Sessions that left the choice open.

The plugin never changes what a task does; it only changes which route answers it. A Session that pinned a model is left alone entirely. A rule it cannot honor is passed over in favour of the next rule, and the Agent keeps the route it had when no rule applies.

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

A route that cannot answer is worse than no route at all: an exhausted quota, a revoked credential and an unreachable relay all make the request fail. The plugin therefore watches each route's own outcomes and routes around a route that keeps failing. `failureThreshold` consecutive failures — two by default — skip that route for `cooldownMs` milliseconds (five minutes by default), and the next rule that fits the task takes the task instead. A route that answers again becomes eligible at once, and a threshold of zero never routes around anything. The cooldown is a **wall-clock window**, not a retry budget: once it expires the route is eligible again and the next matching task tries it once more, and a fresh failure skips it again at once — the failure count is kept, so an expired cooldown does not clear it.

### Routing mode

A Session chooses the route that answers it, and the chat's model switcher is where that choice is made. A Session that names a provider and model pins that route: it is in the `fixed` routing mode, and this plugin never touches it — no rule matches it, and no rule overrides it. A Session that leaves the choice open is in the `auto` mode, and that is the only kind this plugin routes. A Session that has never recorded a mode follows the deployment's default, which is `auto` unless the deployment declares otherwise.

The mode is read when the loop claims the task, so a Session that switches back to `auto` is routed again from its next task on.

<a id="understand-the-implementation"></a>
## Understand the implementation

The decision happens on `agent/inbox/claimed`, which the agent loop emits at `packages/core/agent-loop/src/agent.ts` while it claims the messages for a step. The plugin first reads the Session's routing mode: a Session in the `fixed` mode is left alone, so the decision below applies only to a Session in the `auto` mode. The very next line captures the step's model selection, so a route the plugin selects in that event is the route the **first** step uses rather than the one after it. This is why the plugin listens to the inbox rather than to `agent/pre-step`: the pre-step waterfall runs after the selection has already been captured, and a selection made there would apply to the next step only.

The plugin calls `agent.model.select()`, the same public seam the Models page uses. The selection is recorded in the session log as a `model/selection` event, so a routed session reads back the route each step actually used.

Two pieces make the decision synchronous. The rule table and the signals come from the message the loop already holds. The **catalog** of the routes the rule table names is read asynchronously and cached, because the decision cannot await a lookup between the claim and the selection. The cache is refreshed when `llm/adapters-updated` fires, and a rule whose target is not cached is passed over — routing to an unregistered route would fail the request instead of falling back.

The catalog resolves each rule's exact model rather than listing a route's models. A route's own listing reports the route as empty while that route's credential does not resolve, and a route that cannot answer yet is still the route a rule names. The plugin's own startup waits, for a bounded time, for the routes its rules name to register, so the first turn of a session is routed instead of falling back to the Agent's own route.

Failures are read from the `agent/request-error` waterfall, which every failed request attempt passes through, and answers are read from the `assistant/message` session event, which names the provider that produced them. The plugin listens ahead of the retry policy on that waterfall, so it sees every failed attempt rather than only the ones the retry policy passes on. The state is held per plugin rather than per session: a route that cannot answer for one session cannot answer for another either, so the next session's decision does not pay for the failure the last one already paid for.

<a id="further-exploration"></a>
## Further Exploration

- The rules themselves are data: `packages/core/model-router/src/rules.ts` holds the matcher, and `packages/core/model-router/src/catalog.ts` holds the cached registry view.
- `packages/client/ui-settings-model-router` is the browser half that edits this table from the Plugins page.
- The seam the plugin writes to is `agent.model.select()` in `packages/core/agent/src/runtime-types.ts`; the loop's capture point is `packages/core/agent-loop/src/agent.ts`.
- `packages/llm/llm-local-bridge` registers the bundled local relay routes this plugin usually routes between.

<a id="model-experience"></a>
## Model Experience

### Route selection before the first request

#### What the model sees

Routing does not change the messages the model reads. The only model-visible addition is the model-switch notice the harness appends when the routed route differs from the route the previous request used: a user-role message naming the provider and model it moved from and the one it moved to. A decision that keeps the route the Agent already holds appends nothing.

#### Token effect

Routing adds no tokens to the request. The rule table is read from the plugin's configuration rather than from the conversation, and the signals it reads — the claimed message's text and its image blocks — are already part of the request. Changing route does change the request's own accounting: the harness drops the previous provider's replay state from the assistant history, so a switched route sends its history without that state.

#### KV Cache effect

The routed route replaces the request's provider and model, so the cached prefix the previous provider held for this conversation is not reused: a request that follows a route change is an independent model request rather than an append onto the previous one. A decision that keeps the route the Agent already holds changes nothing in the request, and therefore leaves an already-reusable prefix intact.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Rules read the message only.** A rule sees the claimed message's text and whether it carries an image. It does not see the Agent's preset, its tool set, the task's history length, or the deployment's own notion of what kind of work is running, so two tasks that ask for the same thing in different words can land on different routes.
- **A route change drops the previous provider's replay state.** The harness keeps assistant history in a form only its owning adapter can replay, so switching routes sends the history without that state. A task whose earlier turns carried provider-specific replay data may lose it mid-conversation.
- **Effort is not validated against the deployment's credentials.** The plugin checks that the target route offers the requested effort and declines one it does not, but a target whose credential is missing fails at request time with the provider's own error rather than at routing time.
- **No cross-provider fallback.** A route that fails after the decision is not retried on another route; the harness's own retry policy stays with the route it selected. The next decision routes around a route that keeps failing, so the tasks after it land elsewhere — but the task that hit the failure still fails.
