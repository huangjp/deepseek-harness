---
description: "MiniMax as a first-party provider route: the Anthropic-compatible Messages endpoint with MiniMax's own thinking depths, registered from code instead of as a user-declared custom model."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-minimax

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-minimax` registers MiniMax on the LLM seam as **one fixed route**, `minimax-official`, over MiniMax's Anthropic-compatible Messages endpoint. It is not a `llm-pi-ai` entry: a deployment configures the endpoint, the credential reference, and the default depth, never the route identity.

The route advertises MiniMax's own depths — `low`, `medium`, `high`, `xhigh`, `max` — and publishes `max` as the default, the depth MiniMax uses when a request names none. Thinking travels as `{"type":"adaptive"}` plus `output_config.effort`; `MiniMax-M3.1-Flash` answers `400` to a disabled-thinking request, so `off` is absent.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

One API key is all a user supplies: **Settings → Models** lists **MiniMax**, and the key pasted there is stored under the route's credential reference and used by every model on it.

| Route | Endpoint | Models |
| --- | --- | --- |
| `minimax-official` | `https://api.minimax.cn/anthropic` | `MiniMax-M3.1-Flash`, `MiniMax-M3` |

Deployment fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `MINIMAX_API_KEY` | Credential reference holding the key; the Models page writes it |
| `baseURL` | `https://api.minimax.cn/anthropic` | Anthropic-compatible root; use `https://api.minimax.io/anthropic` outside mainland China |
| `reasoningEffort` | `max` | Depth materialized into a request that names none |

A reference that resolves to no key fails the request with `MISSING_CREDENTIAL` instead of sending an anonymous call, and the catalog offers no models until one exists.

<a id="understand-the-implementation"></a>
## Understand the implementation

`apply` registers a directory entry the Models page renders (`settingsNs` is this plugin's own namespace, `settingsPath` empty so the row carries no delete control) and hands `@deepseek-ai/dsh-llm-pi-ai`'s `PiAiAdapter` one fixed profile: `api: anthropic-messages`, the configured `baseURL`, and a declared catalog.

Each model declares `reasoningEfforts` as the exact wire spelling of every level, so the adapter maps the selected level straight to `output_config.effort` and pins the undeclared `off` to unsupported. `compat.forceAdaptiveThinking` makes the request send `{"type":"adaptive"}`, and `compat.supportsTemperature: false` keeps a sampling field MiniMax ignores off the wire.

The key is resolved per request through `ctx.credentials`, falling back to the launching environment only when no credentials service is mounted. Thinking blocks and tool calls replay through the adapter's durable metadata, so a tool turn that carried reasoning continues with its signature unchanged, which MiniMax requires.

A plan-window HTTP 429 is classified as `QUOTA_WINDOW` before the shared pi-ai error map, so it does not take the short `RATE_LIMIT` retry. MiniMax's documented 429 example (`触发 RPM/TPM/连接数 等限流`) and codes 1002 and 2062 stay `RATE_LIMIT`. Codes 2056 and 2067, and the plan wording `用量上限` / `资源限制` / `套餐额度已用完`, are the window. The body does not carry `Retry-After` or a reset time, and pi-ai keeps only `error.message`, so the reset is read from `GET /v1/token_plan/remains` (then `/v1/coding_plan/remains`) on the API host and, when the host starts with `api.`, on the `www` host. `end_time` is the 5-hour window and `weekly_end_time` is the weekly window. Text models need both; when both are exhausted the weekly end is the one the task waits for. The listener returns that plan on `llm/quota-window`. `@deepseek-ai/dsh-llm-quota-wait` performs the wait.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-llm-pi-ai`](../llm-pi-ai/README.md) — the adapter and profile resolution this package delegates to.
- [`dsh-llm-deepseek`](../llm-deepseek/README.md) — the built-in `deepseek-official` route, whose fixed registration and Models-page posture this package follows.
- [MiniMax Anthropic SDK reference](https://platform.minimax.cn/docs/api-reference/text-anthropic-api) — the wire contract this profile encodes.

<a id="model-experience"></a>
## Model Experience

### Chat turn through the built-in route

#### What the model sees

The selected model receives the request `PiAiAdapter` builds for any pi-ai route: one system prompt (`GenerateOptions.system`, otherwise the text of a leading `system` history message), the remaining history, the tool catalog, and the fields pi-ai's common streaming API supports. Each retained image is preceded by text naming its complete attachment id and actual request dimensions. Requests carry the provider key plus Harness attribution headers; native replay metadata is restored only when the adapter validates it for the historical content, and MiniMax requires a thinking block's signature to travel unchanged.

#### Token effect

MiniMax tokenizes the request, so its own tokenizer governs exact input. Both models declare a 1,000,000-token context window. Thinking tokens count toward `max_tokens` on MiniMax's side, which is why a reply can end with `stop_reason: "max_tokens"` before any text block appears. Retained images add the attachment and dimension descriptor plus the provider's own visual tokens.

#### KV Cache effect

MiniMax caches request prefixes on its side and reports reuse as `cache_read_input_tokens`, so a request whose prefix is unchanged after a completed step reuses it. Changing the model, the effort level, the tool catalog, or any earlier message rewrites the prefix from that point and ends reuse there; the following messages stay stable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Video input is not sent.** MiniMax's Messages endpoint accepts `video` content blocks, but the Harness content model carries text, image, and file blocks only, so a video attachment reaches this route as an unsupported content error rather than a video block.
- **MiniMax's server-side `web_search` tool is not declared per request.** Search reaches these models through the harness `web_search` tool instead.
- `temperature`, `top_p`, `top_k`, `stop_sequences`, and `cache_control` are ignored by MiniMax on this endpoint; the profile sets `supportsTemperature: false` so no temperature is sent, and no other ignored field is emitted.
- **The chat route cannot ask for the priority admission tier.** MiniMax offers `service_tier: priority` for `MiniMax-M3`, at 1.5× the price, but the Anthropic-compatible request body pi-ai builds carries no such field and offers no way to add one. The sibling packages that own their request body — the MiniMax search provider and the token-counting tool — do send it. A deployment that needs priority admission on chat would need a pi-ai change.
- The catalog is declared, not probed: no model-listing call runs at boot, so a model MiniMax retires stays advertised until this package changes.
- **The 429 body does not name the reset.** The usage clock above is the source of `end_time` and `weekly_end_time`. Windows start at first use, so a missing clock probes instead of guessing the next wall-clock 5-hour boundary. A 5-hour reset does not restore a weekly window that is also exhausted.

### Dev Note

No runtime invariant companion is published: the package contributes one fixed route whose behavior is described by the `PiAiAdapter` contract it delegates to, plus this profile's declared catalogs and compatibility switches.
