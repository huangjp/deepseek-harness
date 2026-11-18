---
description: "MiniMax video tools: generate a short video through MiniMax's task endpoint, and ask a MiniMax model what happens in a video."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-minimax-video

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-tool-minimax-video` gives the agent two MiniMax video tools. `minimax_video_generate` creates a generation task, polls it until it settles, and commits the finished MP4 into the attachment store so the session keeps a durable file instead of MiniMax's expiring download URL. `minimax_video_understand` asks a MiniMax multimodal model what happens in a video. Both use the same `MINIMAX_API_KEY` as the `minimax` model route.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin and fill in the MiniMax key once — the same one the model route uses:

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `MINIMAX_API_KEY` | Credential reference holding the key |
| `apiBaseURL` | `https://api.minimax.cn` | Native root for `/v2/video_generation` |
| `chatBaseURL` | `https://api.minimax.cn/anthropic` | Anthropic-compatible root for understanding |
| `videoModel` | `MiniMax-H3` | Model when the caller names none; `MiniMax-H3-Highspeed`, `MiniMax-H3-Lite`, and `MiniMax-H3-Max` are also offered |
| `resolution` | `768P` | `480P`, `768P`, or `2K`, per model availability |
| `durationSeconds` | `6` | 4–15 seconds |
| `ratio` | `16:9` | Aspect ratio; image-to-video ignores it |
| `pollIntervalMs` / `pollTimeoutMs` | `10000` / `600000` | Status cadence and whole-operation deadline |
| `maxDownloadBytes` | `268435456` | Largest accepted MP4 download |
| `understandingModel` | `MiniMax-M3.1-Flash` | Model that answers an understanding turn |

| Tool | Endpoint | Result |
| --- | --- | --- |
| `minimax_video_generate` | `POST /v2/video_generation` | Stored MP4 plus the task id |
| `minimax_video_understand` | `POST /anthropic/v1/messages` | The answer about the video |
| `minimax_video_context_enrich` | `POST /v2/h3_context_ir` | The enriched prompt a generation should use |
| `minimax_video_regenerate` | `POST /v2/video_regeneration` | Stored 2K MP4 of a regenerated video |
| `minimax_video_task_list` | `GET /v2/query/video_generation` | The tasks of the last week and their states |
| `minimax_video_task_cancel` | `DELETE /v2/video_generation/{id}` | What MiniMax did with the task |
| `minimax_video_generate_hailuo` | `POST /v1/video_generation` | Stored MP4 from the older models, which reach 1080P |

A machine without the key can still see the tools; calling one fails with a message naming the reference to store.

<a id="understand-the-implementation"></a>
## Understand the implementation

Generation is two requests on the native host: `POST /v2/video_generation` returns a `task_id`, and `GET /v2/query/video_generation/{task_id}` reports `queued`, `running`, `succeeded`, `failed`, or `cancelled`. The tool polls at `pollIntervalMs` until a terminal state or `pollTimeoutMs`, then streams `content.url` through `attachments.saveFileStream` with a byte cap. The result carries the task id, the attachment id, and the host path when the backend is file-backed.

A generation request is either image-to-video or reference-based, never both, and MiniMax refuses a request that mixes them; the tool decides which form the arguments describe and refuses a mixture itself. The same applies to the resolutions and the clip lengths: each model serves a subset, and the tool checks the request against that subset before it reaches the provider, so an impossible combination is an argument error rather than an opaque `400`.

Three more endpoints extend the family. Context enrichment turns material into the prompt a generation should use, and answers with the enriched prompt rather than a video. Regeneration re-renders a finished video at 2K, either from the task that produced it or from a 768P source video. The older Hailuo models reach 1080P but answer with a file id rather than a URL, so that path polls the older status endpoint and then resolves the download URL through the file endpoint.

Understanding is one request on the Anthropic-compatible root: a `video` content block whose `source` is `{type: 'url', url}`, plus the question as a text block. The request sends `thinking: {type: 'adaptive'}` and `output_config.effort: 'low'`; `MiniMax-M3.1-Flash` always thinks and rejects a disabled request. Only `text` blocks of the reply become the tool result.

Both requests use `redirect: 'error'`, so the key never follows a redirect to another origin.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-llm-minimax`](../../llm/llm-minimax/README.md) — the model route that shares this credential.
- [`dsh-tools`](../../core/tools/README.md) — the registry, schema, and error contract these tools use.
- [MiniMax video generation](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create) — the task endpoints and their status values.
- [MiniMax Create Message](https://platform.minimax.cn/docs/api-reference/text-chat-anthropic) — the `video` content block and thinking rules.

<a id="model-experience"></a>
## Model Experience

### One generation call

#### What the model sees

The calling model sees only the tool schema, its own arguments, and the tool result text naming the stored path. The generated video itself never enters the conversation: the harness content model carries text, image, and file blocks, so a video is a file the user opens rather than content the model reads. The prompt the model wrote is the entire input MiniMax's video model receives.

#### Token effect

Generating a video spends no conversation tokens beyond the tool call and result, and MiniMax bills generation by output seconds rather than by tokens. Understanding a video does spend this conversation's provider tokens: MiniMax samples frames at `fps` and charges each sampled frame, which is why the tool exposes `fps` and `detail`.

#### KV Cache effect

Neither tool touches the chat request: generation is a separate MiniMax service, and understanding is a separate one-shot request with its own single-message conversation. No prefix is shared with the session, so neither call can invalidate the chat transcript's cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Generated videos are not shown inline.** The result names a stored path; a client card that previews the MP4 would need its own slot, which this package does not add.
- **Understanding takes a URL, not a local file.** Local videos need the Files API (`mm_file://{file_id}`) or a public URL; this tool accepts the reference form but does not upload files itself.
- A paused or rate-limited provider answer fails the call with the provider's status; there is no automatic retry beyond the task poll.
- **Only the last seven days of tasks are queryable.** MiniMax refuses an older task id, and the task list counts only that window.
- **Regeneration needs whitelisted access** and a source task that succeeded inside that window; MiniMax refuses the call otherwise.
- The older Hailuo models have no cancel or delete endpoint, and their finished video is reachable through a download URL that expires after an hour.
- Image generation, speech, music, and file upload are separate capabilities that the sibling `dsh-tool-minimax-media` package provides.

### Dev Note

Both tools read their configuration at each call, so a changed endpoint or deadline applies to the next call without remounting the plugin. The generation tool declares a `timeoutMs` one minute above `pollTimeoutMs`, so the harness deadline never fires before the tool's own.
