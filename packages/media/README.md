---
description: "The media group map: model-facing tools that generate and understand media through a hosted provider, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/media

English | [中文](README.zh.md)

## Summary

The media group gives agents tools for content the harness conversation model cannot carry: short video generation, and asking a vision model what happens in a video. Each package wraps one provider's REST API, keeps the credential shared with that provider's model route, and stores what it produces as a durable attachment instead of a URL that expires. The group ships no UI of its own.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-minimax-video`](tool-minimax-video/README.md) | `minimax_video_generate` (task create + poll + store) and `minimax_video_understand` | registers on `ctx.tools` |
| [`tool-minimax-media`](tool-minimax-media/README.md) | Image generation, speech synthesis and recognition, music generation, and file upload | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Tools subsystem](../../docs/subsystems/tools.md) — the tool contract, activation gates, and result rendering these tools use.
- [Generated tool catalog](../../docs/tool-catalog.md) — the schemas the model receives.
- [`dsh-llm-minimax`](../llm/llm-minimax/README.md) — the model route that shares this provider's API key.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

A media tool's output is a file, not conversation: the harness content model carries text, image, and file blocks, so a generated video is committed to the attachment store and the tool result names the stored path. Adding an image- or video-bearing tool means reading the attachment rules in [the tool cookbook](../../docs/cookbook/adding-a-tool.md) before choosing a result shape.

</details>
