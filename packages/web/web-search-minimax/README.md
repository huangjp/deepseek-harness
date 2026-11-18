---
description: "MiniMax server-side web search as a ctx.web search provider: one MiniMax API key makes the harness web_search tool answer from MiniMax's own search."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-minimax

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-web-search-minimax` registers MiniMax's server-side search on the harness web seam under the provider id `minimax`. A deployment selects it with `web.searchProvider: minimax`, and the existing `web_search` tool then searches through MiniMax using the same API key the `minimax` model route uses. The provider declares MiniMax's `web_search_20250305` server tool, so MiniMax runs the search and returns results inside one request.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin and select it:

```yaml
- insert:
    - id: web-search-minimax
      name: '@deepseek-ai/dsh-web-search-minimax'
- id: web
  config:
    searchProvider: minimax
    fetchProvider: http
```

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `MINIMAX_API_KEY` | Credential reference holding the key; the Models page writes it |
| `baseURL` | `https://api.minimax.cn/anthropic` | Anthropic-compatible root; `/v1/messages` is appended |
| `model` | `MiniMax-M3.1-Flash` | Model that runs the server-side search |
| `maxTokens` | `4096` | Output cap for the search turn |
| `maxUses` | `3` | Searches one request may run before MiniMax pauses the turn |
| `serviceTier` | `standard` | Admission tier; `priority` costs 1.5× and `MiniMax-M3.1-Flash` rejects the field |

`web_fetch` stays on the harness HTTP fetcher: MiniMax documents no standalone fetch endpoint, so page retrieval is not routed through it.

<a id="understand-the-implementation"></a>
## Understand the implementation

`search()` posts one non-streaming Messages request carrying `tools: [{type: 'web_search_20250305', name: 'web_search', max_uses}]`, then maps every `web_search_tool_result` block into the seam's `WebSearchSource` list, deduplicating by URL and preferring the inline result excerpt over a text block's citation.

Two wire facts are MiniMax-specific. First, the request never sends `thinking: {"type": "disabled"}`: `MiniMax-M3.1-Flash` always thinks and answers `400` to a disabled request, so the provider asks for the lowest documented depth (`output_config.effort: "low"`) instead. Second, a reply may end with `stop_reason: "pause_turn"` when the per-request search budget runs out; the provider replays that content as the assistant message and resends, up to two continuations.

Redirects fail the operation rather than forwarding the `Authorization` header to another origin.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-web`](../web/README.md) — the service definition and provider-selection rules this package registers into.
- [`dsh-web-search-deepseek`](../web-search-deepseek/README.md) — the same server-tool pattern against DeepSeek's endpoint.
- [`dsh-llm-minimax`](../../llm/llm-minimax/README.md) — the model route that shares this credential.
- [MiniMax Server Tools](https://platform.minimax.cn/docs/guides/server-tools) — the documented tool declaration and response blocks.

<a id="model-experience"></a>
## Model Experience

### One `web_search` call

#### What the model sees

The model never sees the search request or its response: `tool-web` renders the returned sources into the tool result text the model reads on its next step. Each source contributes its URL, title, excerpt, and publication age when MiniMax supplied them. The provider adds no prompt text of its own beyond the query the harness passes.

#### Token effect

The search turn spends MiniMax tokens against the same key and account: the query, the declared tool, and a short synthesis bounded by `maxTokens`. Those tokens are not part of the conversation's own accounting — the harness meters the `web_search` tool result it renders, not the provider-side search turn.

#### KV Cache effect

Each search is an isolated request with a fresh conversation, so no prefix is shared with the chat session or with another search. MiniMax caching can only help within the `pause_turn` continuations, which resend the same conversation with the previous content appended.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `maxResults` is applied after the full result set arrives: MiniMax reports no result count up front, so the provider slices and reports `truncated` instead of asking for fewer.
- The `tool_choice` MiniMax accepts is `auto` only; this provider declares the single server tool, so no choice is needed.
- A deployment whose MiniMax key lives under another reference sets `apiKeyEnv`; the readiness check and the search read the same reference.
- MiniMax documents no standalone fetch endpoint, so `web_fetch` is unaffected by this package.

### Dev Note

The provider holds no runtime state between searches: options are read from the live settings section at each operation's entry, so a settings write takes effect on the next search without re-registering the provider.
