---
description: "xAI Grok as a first-party provider route: the Responses API with configurable reasoning effort, registered from code instead of as a user-declared custom model."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-xai

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-xai` registers xAI on the LLM seam as **one fixed route**, `xai-official`, over the Responses API at `https://api.x.ai/v1`. It is not a `llm-pi-ai` catalog entry named `xai`: that id already belongs to pi-ai's installed catalog. A deployment configures the endpoint, the credential reference, the default effort, and an optional model list.

The shipped model is `grok-4.7`: a 500,000-token context, image input, and reasoning efforts `low`, `medium`, `high`, and `xhigh`. Reasoning cannot be disabled. The default effort is `high`, which is what xAI uses when a request names none. `XAI_DEFAULT_PRICES` records the rate below 200k prompt tokens: `grok-4.7` is $2.00 / $6.00 and `grok-build-0.1` is $1.00 / $2.00 per million input / output tokens. At 200k prompt tokens and above, xAI doubles those rates for the whole request ($4 / $12 and $2 / $4). The router stores one price per model, so replace an entry to bill the long-context tier.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

One API key is all a user supplies. **Settings → Models** lists **xAI**. Pasting a key there stores it under `XAI_API_KEY`. The same name is the environment variable: `export XAI_API_KEY=...` in the process that launches the app. Do not commit the key.

| Route | Endpoint | Default model |
| --- | --- | --- |
| `xai-official` | `https://api.x.ai/v1` (`POST /v1/responses`) | `grok-4.7` |

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `XAI_API_KEY` | Credential reference. The Models page writes it |
| `baseURL` | `https://api.x.ai/v1` | Responses API root. The client appends `/responses` |
| `reasoningEffort` | `high` | Effort used when a request names none |
| `models` | `grok-4.7` | A non-empty list replaces the flagship. Set `vision: true` only for a model that accepts images |

A reference that resolves to no key fails the request with `MISSING_CREDENTIAL`. The catalog offers no models until a key exists.

```yaml
- id: llm-xai
  name: '@deepseek-ai/dsh-llm-xai'
  config:
    apiKeyEnv: XAI_API_KEY
    reasoningEffort: high
    models:
      - id: grok-4.7
        vision: true
        contextWindow: 500000
```

<a id="understand-the-implementation"></a>
## Understand the implementation

`apply` registers a Models-page row (`settingsNs` is this plugin's namespace, `settingsPath` empty so the row has no delete control) and hands `PiAiAdapter` one profile: `api: openai-responses`, the configured `baseURL`, and the model list.

Chat Completions (`POST /v1/chat/completions`) is still documented, and xAI marks it as legacy. pi-ai also disables `reasoning_effort` for Grok on that wire. The Responses API is the protocol pi-ai's xAI catalog already uses for streaming, tools, images, and `reasoning.effort`, so this route uses it. The Anthropic-compatible Messages endpoint is deprecated and is not used.

`401` and `403`, and wording such as `Incorrect API key`, are `AUTH`. The health model then treats the route as unusable until the configuration changes. A plain `429` is `RATE_LIMIT`. A body that says the team used all credits or hit a spending limit is `QUOTA`, including when that text arrives on `429` or `403`, so it is not retried as a short rate limit.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-llm-pi-ai`](../llm-pi-ai/README.md) — the adapter this package delegates to.
- [`dsh-llm-minimax`](../llm-minimax/README.md) — the other fixed first-party route this registration follows.
- [`dsh-model-router`](../../core/model-router/README.md) — copy `XAI_DEFAULT_PRICES` into `pricing` when cost routing should see Grok.
- [xAI models](https://docs.x.ai/docs/models) — context, modalities, and the two price tiers.
- [xAI reasoning](https://docs.x.ai/docs/guides/reasoning) — `reasoning.effort` on the Responses API.

<a id="model-experience"></a>
## Model Experience

### Chat turn through the built-in route

#### What the model sees

The selected model receives the request `PiAiAdapter` builds for a Responses route: the system prompt, the history, the tool catalog, and the reasoning effort. Images travel as image input only when the model advertises them. Requests carry `Authorization: Bearer` plus Harness attribution headers.

#### Token effect

xAI tokenizes the request. `grok-4.7` declares a 500,000-token context. Reasoning tokens are billed with the reply. Below 200k prompt tokens the published rates are $2.00 / $6.00 per million input / output tokens.

#### KV Cache effect

Cached input has its own published rate. Changing the model, the effort, the tool catalog, or an earlier message rewrites the prefix from that point.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One stored price, two billing tiers.** At 200k prompt tokens xAI doubles the stored rate for the whole request. `XAI_DEFAULT_PRICES` records only the lower tier for `grok-4.7` and `grok-build-0.1`.
- **The model list is declared, not discovered.** This package does not call `GET /v1/models` at startup. Add an id under `models` when xAI publishes one this package does not ship.
- **Chat Completions and the deprecated Messages endpoint are not used.**
- **Image input is opt-in for every id except `grok-4.7`.** A replacement row without `vision: true` is text-only.

### Dev Note

No extra runtime invariant. The route is the `PiAiAdapter` contract plus the catalog and the error map in this package.
