---
description: "4SAPI relay as a first-party provider route: OpenAI-compatible chat completions over a configurable base URL, with models listed from the key."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-4sapi

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-4sapi` registers the 4SAPI relay on the LLM seam as **one fixed route**, `4sapi-relay`. 4SAPI is a new-api gateway that aggregates OpenAI, Claude, Gemini, DeepSeek, Kimi, Qwen, GLM, Grok, and other vendors behind one OpenAI-compatible root. A deployment configures the base URL, the credential reference, the Claude wire, an optional model list, and optional per-model prices.

The default wire is chat completions for every model, including Claude. That is the protocol the relay documents for streaming, tools, and images across vendors. Set `claudeProtocol` to `anthropic` when `claude-*` models should use `/v1/messages`, which is where 4SAPI applies Anthropic thinking configuration.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

**Settings → Models** lists **4SAPI**. The masked key field stores the token under `FOURSAPI_API_KEY`. The same name is the environment variable: `export FOURSAPI_API_KEY=sk-...` in the process that launches the app. Do not commit the key.

The card's host list is the relay root, including `/v1`. The default is `https://4sapi.com/v1`. Mainland China should pick `https://4sapi.org/v1` or `https://4stoken.com/v1`. The other hosts are `https://4sapi.top/v1`, `https://us.4sapi.com/v1`, the API-only line `https://4sapi.ai/v1`, and the North-America line `https://4sapi.net/v1`. A root written in `cordis.patch.yml` without `/v1` gains that suffix for chat completions.

| Route | Default endpoint | Models |
| --- | --- | --- |
| `4sapi-relay` | `https://4sapi.com/v1` (`POST /v1/chat/completions`) | `GET /v1/models` for the stored key |

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `FOURSAPI_API_KEY` | Credential reference. The Models page writes it |
| `baseURL` | `https://4sapi.com/v1` | Chat-completions root. The client appends `/chat/completions` |
| `claudeProtocol` | `openai` | `anthropic` sends `claude-*` to `/v1/messages` |
| `models` | empty | A non-empty list replaces the fetched catalog. Set `vision` only when the id's inference is wrong |
| `pricing` | empty | Per-model prices. A row replaces the `/api/pricing` value for that id |
| `usePricingEndpoint` | `true` | Read `GET /api/pricing` for rows `pricing` does not name |

No key lists no models, and a model router that names the route skips that candidate. A reference that resolves to no key fails a direct request with `MISSING_CREDENTIAL`.

```yaml
- id: llm-4sapi
  name: '@deepseek-ai/dsh-llm-4sapi'
  config:
    apiKeyEnv: FOURSAPI_API_KEY
    baseURL: https://4sapi.org/v1
    claudeProtocol: openai
    models: []
    pricing:
      - model: deepseek-chat
        inputPerMillion: 1
        outputPerMillion: 2
        currency: USD
```

<a id="understand-the-implementation"></a>
## Understand the implementation

`apply` registers a Models-page row (`settingsNs` is this plugin's entry id, `settingsPath` empty so the row has no delete control) and hands `PiAiAdapter` one profile: `api: openai-completions` and the current model list. The list is fetched from `GET /v1/models` when a key is present and `models` is empty, then cached until the key, the base URL, or the override changes. A failed listing is reused for 30 seconds. HTTP 401 or 403 on the listing clears the catalog.

`claudeProtocol: anthropic` rewrites `claude-*` models onto `anthropic-messages` and strips `/v1` from their root, because the Messages client appends `/v1/messages` itself. Those models advertise reasoning levels `off`, `low`, `medium`, and `high`. Other ids stay on chat completions. The default leaves every id, including Claude, on chat completions.

`insufficient_user_quota`, `余额不足`, and the other new-api quota wordings are `QUOTA`, including when the status is 403. `401` and `无效的令牌` are `AUTH`, so the health model treats the route as unusable until the configuration changes. A plain `429` is `RATE_LIMIT`. HTTP 5xx and `无可用渠道` / `no available channel` are `SERVER`, which the retry policy repeats. `GET /v1/dashboard/billing/subscription` and `GET /v1/dashboard/billing/usage` feed `llm/quota-remaining` when both bodies parse; a failure leaves the signal unset. `GET /api/pricing` converts new-api `model_ratio` 1 to $2 per million input tokens and multiplies output by `completion_ratio`. Per-call prices and group ratios are not applied. The log names the merged row count. Model-router billing reads its own `pricing` table, so copy the rows you intend to bill.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-llm-pi-ai`](../llm-pi-ai/README.md) — the adapter this package delegates to.
- [`dsh-llm-xai`](../llm-xai/README.md) — the other fixed first-party route this registration follows.
- [`dsh-model-router`](../../core/model-router/README.md) — health classes, fallback chains, and the pricing table to copy into.
- [4SAPI integration guide](https://4sapi.com/blog/4sapi-api-integration-setup-guide) — hosts, bearer auth, and `/v1`.
- [new-api](https://github.com/QuantumNous/new-api) — the gateway whose error codes and billing endpoints this route reads.

<a id="model-experience"></a>
## Model Experience

### Chat turn through the built-in route

#### What the model sees

The selected model receives the request `PiAiAdapter` builds for a chat-completions route: the system prompt, the history, and the tool catalog. Images travel as image input only when the model advertises them. Requests carry `Authorization: Bearer` plus Harness attribution headers. A `claude-*` model on the Anthropic wire receives the Messages request instead, including the selected reasoning level.

#### Token effect

The relay tokenizes the request and bills the account group. This package does not add tokens. A model whose listing omits a context window is described as 128,000 tokens, and its output capability is described as 8,192 tokens, until `models` names other numbers.

#### KV Cache effect

The relay's prompt cache, when the upstream vendor has one, follows that vendor. Changing the model, the tool catalog, or an earlier message rewrites the prefix from that point. Switching a Claude model between chat completions and Messages changes the wire, so the prefix is not reused across that switch.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Prices are ratios, not the group's bill.** `model_ratio` 1 is recorded as $2 per million input tokens. Group multipliers and per-call `quota_type` 1 prices are omitted. Copy the numbers you pay into `pricing` or into the model router's `pricing`.
- **Vision is inferred from the model id.** A listing does not declare modalities. An id that does not match the conservative pattern stays text until `vision: true`.
- **One context-window fallback.** A listing that omits the window is described as 128,000 tokens.
- **Chat completions does not send Anthropic thinking configuration.** Use `claudeProtocol: anthropic` for `claude-*` when thinking blocks are required. Other vendors stay on chat completions on that setting too.
- **A failed model listing stays empty for 30 seconds.** Changing the key or the base URL retries immediately.

### Dev Note

No extra runtime invariant. The route is the `PiAiAdapter` contract plus the catalog fetch, the price parse, and the error map in this package.
