---
description: "The model router's settings page on the dsh web client's Plugins page: the task-to-route rule table of the model-router namespace."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-model-router

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **Model router** in the Official group to decide which model answers which kind of task. The page holds the router's rule table: each rule names a task shape (keywords, and whether the task carries an image) and the provider route and model that answers it. It also holds the two health knobs that let the router step aside from a route that keeps failing. The page stages every edit and writes it only on save. The page exists while the Host serves the `model-router` namespace.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The **Model router** card in the Official group opens the page. **Route tasks automatically** turns the router on and off. **Routing rules** lists the table in evaluation order: each row carries a name, the keywords that must appear in the message, the attachment condition (**Any**, **Must include an image**, **Must not include an image**), the provider route, the model on that route, and the reasoning effort. The route and the model are picked from the routes this deployment actually registers, so a rule cannot name a route that does not exist; a rule whose route disappears keeps its stored value so it can be corrected rather than silently retargeted. **Move up**, **Move down**, and **Remove rule** change the table's order, and order is what decides which rule wins. A rule with no keywords and no attachment condition matches nothing, so the page refuses to save it. **Failures before a route is skipped** and **Cooldown (minutes)** are the health knobs: after that many consecutive failures the router stops sending tasks to that route, and the cooldown says how long it stays skipped. The cooldown is shown in minutes but written back in milliseconds, and a cooldown the deployment stored in another unit is written back unchanged.

For the breaker to actually move a task, the table needs one catch-all rule that **fits** it — one row with the attachment condition **Must not include an image** and one with **Must include an image** cover every task. When a rule's route is skipped, the next rule that fits takes the task; without a catch-all rule the task stays on the route it already had, which is the one that just failed. The cooldown is a wall-clock window rather than a retry budget: once it expires that route gets one more chance, and a fresh failure skips it again at once.

Nothing is written until **Save**; leaving the page drops the draft, and a rule that is incomplete blocks the save and says why.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the `model-router` namespace through `ctx.configForms.get`, keeps the staged table in `ModelRouterCardController`, and registers `ModelRouterCard` into the Plugins page's `plugins.item` slot through `ctx.configForms.whileServed`.

The rule table is an array of objects, which the shared scalar form model does not carry, so the card keeps its own draft and writes the whole array in one revision-fenced mutation instead of one mutation per row. The two health knobs travel in the same write. The route directory comes from `ctx.remote.session.modelCatalog()`, and the card reads it again whenever the Host reports that adapters or the settings document changed.

The page's copy lives in this package's `settings.modelRouter` dictionary.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the page registers into.
- [ui-settings](../ui-settings/README.md) — the settings scope and the served-namespace watch the page rides.
- [ui-primitives](../ui-primitives/README.md) — the settings form frame the page renders.
- [model-router](../../core/model-router/README.md) — the router that owns the `model-router` namespace and applies the table.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One table, one save** — the page writes the whole rule table and both health knobs in a single mutation, so a deployment that wants per-rule permissions cannot have them here.
- **No route health readout** — the page edits the knobs that make the router skip a route, but it does not show which routes are currently skipped; that state lives in the router's own memory.
- **Effort names come from the adapter** — the reasoning efforts a row offers are the ones the route's catalog advertises, so a deployment that wants an effort the adapter does not list cannot select it here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The card is a pure browser half: it never imports a Host package, so the `model-router` namespace is spelled as a string in `MODEL_ROUTER_NS` rather than imported.

</details>
