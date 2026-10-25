---
description: "Built-in local-bridge LLM providers for the DeepSeek Harness desktop app: three fixed, non-deletable routes pointing at the bundled WorkBuddy, Copilot, and Huawei Celia relays."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-local-bridge

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-local-bridge` registers the three local model relays in the DeepSeek Harness desktop installer as **fixed, built-in LLM routes**: `dpv41f` (WorkBuddy, `127.0.0.1:8787`), `slefgpt56` (Microsoft Copilot, `127.0.0.1:8899`), and `hwcelia` (Huawei Celia, `127.0.0.1:8123`). All are declared in code and mounted on the LLM seam the way `dsh-llm-deepseek` registers `deepseek-official`, so they exist on every boot with no setup.

They live **outside** the user-editable `llm-pi-ai` settings namespace, because a patch entry there replaces a row's entire `config`. They are still **listed on the Models page without a delete control**: an empty `settingsPath` denies the page a remove button, exactly as it does for `deepseek-official`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in a composition that serves the bundled local relays — the desktop app's `web-app` bundle is the one that does. A request selects a route with `GenerateOptions.provider` set to `dpv41f`, `slefgpt56`, or `hwcelia`:

| Route | Endpoint | Models |
| --- | --- | --- |
| `dpv41f` | `http://127.0.0.1:8787/v1` | `deepseek-v4.1-flash`, `gpt-4o`, `gpt-3.5-turbo`, `default` |
| `slefgpt56` | `http://127.0.0.1:8899/v1` | `copilot`, `m365-copilot` |
| `hwcelia` | `http://127.0.0.1:8123/v1` | `xiaoyi-chat`, `xiaoyi` |

The relays are started by the separate `@deepseek-ai/dsh-host-local-bridge` host plugin; this package only declares the routes, so a composition can mount one without the other (a route then simply has nothing listening).

No credential is required. Each profile carries the hop's `authorization: Bearer local-bridge` header, which the relay accepts as a placeholder, so `resolveApiKey` intentionally defers and returns `undefined`. Writing an `apiKeyEnv` here instead would fail resolution with `MISSING_CREDENTIAL` on a machine that has no such key.

Only the WorkBuddy route declares `input: [text, image]`. A model that omits it is treated as text-only and the harness rejects an attached image before sending (`MODEL_DOES_NOT_SUPPORT_IMAGES`, surfaced as "current model does not support images"). The Copilot route declares `text` because its SignalR `chatHub` frame carries one plain-text prompt field and no attachment field. The Huawei Celia route declares `text` for the same reason: its upstream is a text-in/text-out WebSocket frame. Claiming image support on either would only move the failure upstream, after the attachment was already recorded in the session.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin builds one `PiAiAdapter` from the `dsh-llm-pi-ai` package and hands it to `ctx.llm.registerAdapter(['dpv41f', 'slefgpt56', 'hwcelia'], adapter)` at mount. That single call is what makes the routes *built-in*: the LLM registry owns the route names, so a request resolves them regardless of any settings document. `PiAiAdapter` supplies `providerInfo`/`listModels`, which is why the routes still appear in the model picker with their catalogs.

Two decisions are load-bearing:

- **The directory entries carry an empty `settingsPath`.** `registerConfigurableProviders` is what places a route into the Models-page directory, so it is called — otherwise the three routes are absent from that page. Visibility and removability are separate facts there: the page derives `removable` from a *non-empty* path present in the **user** settings layer, so an empty path is precisely what removes the delete control. `deepseek-official` is undeletable for the same reason.
- **Profiles resolved once, at mount.** `resolveProfiles` validates and defaults the fixed configuration into a `Map` that the adapter's `profiles` hook returns unchanged. There is no settings section to watch, so no re-registration path is needed — the routes cannot drift.

The exported `Config` exists only so the Host's settings service has a namespace for those rows to anchor to: without a `Config`, `settings.describe` projects no namespace at all and the Models page drops the entries before rendering them. Its single `routes` field is never read by this plugin, the Models page's curated editor treats this namespace as unknown (generic hint, Apply disabled), and `configure({ auto: false })` keeps the Plugins settings section from generating a page for it.

Because these routes name no credential reference, `providerUsable` reports them as ready without a key, so they never open as a first-run API-key setup card — including on a fresh install where they are the only providers present.

The adapter receives the same auth and attachment seams `llm-pi-ai` uses (`credentialStoreFrom`, `authContextFrom`, and `resolveImageAttachmentAccess` over `ctx.attachments`), so image offloading and durable attachment references behave as they do for any other route.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-host-webserver`](../../host/webserver/README.md) — the host layer the desktop bundle composes; the relay host plugin joins it in the `web-app` bundle's insert list.
- [`dsh-llm-pi-ai`(../llm-pi-ai/README.md — the settings-driven multi-provider adapter whose adapter and profile resolution this package reuses.
- [`dsh-llm-deepseek`(../llm-deepseek/README.md — the built-in `deepseek-official` route whose fixed-registration pattern this package follows.

<a id="model-experience"></a>
## Model Experience

### Relay request through the built-in route

#### What the model sees

The selected bridge model receives the same request the `PiAiAdapter` builds for any pi-ai route: one system prompt (`GenerateOptions.system`, otherwise the text of a leading `system` history message), the remaining history, tools, and the sampling fields pi-ai's common streaming API supports. Each retained image is preceded by text naming its complete attachment id and actual request dimensions, and — when the execution filesystem maps the attachment provider's host object — by a read-only normalized-object path warning that normalization or request projection may have resized or re-encoded the upload. Requests carry the route's `authorization: Bearer local-bridge` header plus Harness attribution headers; `attributionHeaders()` reserves only `user-agent`, so the authorization header survives unchanged. Provider-native replay metadata is restored only when the adapter validates it for the historical content.

#### Token effect

The relay's own tokenization governs exact input, not the harness. Retained images add the stable attachment and coordinate descriptor; an image-offload placeholder replaces an omitted image's visual tokens. Because the catalog is declared rather than probed, the declared context window and output cap are the profile's configured values (262,144 and 32,768 by default), which a relay is free to differ from.

#### KV Cache effect

Conversion preserves logical request order, while image handles and offload placeholders add model-visible text. A changed execution-world path rewrites a historical handle and can prevent reuse from that image even when attachment identity and request bytes stay stable. Changing provider, model, or any upstream token has the same suffix effect; an offload decision turns an earlier image into placeholder text, so reuse ends at that message and the prefix stays stable afterwards.

## Known Limitations and Deferred Work

- The endpoints are compiled in. A deployment that runs the relays on other ports, or a relay that requires real authentication, needs a code change rather than a setting.
- The `slefgpt56` and `hwcelia` catalogs declare `text` only. The Copilot relay's SignalR `chatHub` frame carries no attachment field and the Celia relay's WebSocket frame is text-in/text-out, so an image sent through either route is rejected by the relay with an explicit `400 images_unsupported` rather than silently dropped. Declaring `text` refuses the attachment before the request instead.
- Declaring a model id does not prove the relay serves it: no availability probe runs at boot. A request to an unserved id fails at the relay.
- **Tool calls are emulated, not native.** Neither upstream offers function calling, so the relay renders the tool list into the prompt and parses the reply back into `tool_calls`; a model that ignores the format returns prose instead of a call, and tool calls arrive whole rather than as streamed fragments. Both routes still accept `tools` and answer `finish_reason: "tool_calls"` like any other route.

### Dev Note

No runtime invariant companion is published because this package owns no diverging runtime observations: it contributes two fixed routes whose behavior is fully described by the `PiAiAdapter` contract it delegates to.