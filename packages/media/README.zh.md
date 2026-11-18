---
description: "媒体组地图：通过托管提供方生成与理解媒体的模型侧工具，供浏览本组的用户与维护者使用。"
kind: "package-group"
---

# packages/media

[English](README.md) | 中文

## 概述

媒体组给 agent 提供对话内容模型承载不了的能力：生成短视频，以及让视觉模型看懂一段视频里发生了什么。每个包封装一个提供方的 REST 接口，与该提供方的模型路由共用同一把凭据，并把产物存成持久附件，而不是一个会过期的链接。本组自身不带 UI。

## 目录

- [包列表](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包列表

| 包 | 作用 | ctx key |
|---|---|---|
| [`tool-minimax-video`](tool-minimax-video/README.zh.md) | `minimax_video_generate`（建任务 + 轮询 + 落盘）与 `minimax_video_understand` | 注册到 `ctx.tools` |
| [`tool-minimax-media`](tool-minimax-media/README.zh.md) | 图片生成、语音合成与识别、音乐生成、文件上传 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [工具子系统](../../docs/subsystems/tools.zh.md)——这些工具使用的工具契约、激活条件与结果渲染。
- [生成的工具目录](../../docs/tool-catalog.zh.md)——模型收到的 schema。
- [`dsh-llm-minimax`](../llm/llm-minimax/README.zh.md)——与该提供方共用 API key 的模型路由。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

媒体工具的产物是文件而不是对话：harness 的内容模型只承载文本、图片和文件块，因此生成的视频会先提交到附件存储，工具结果里给出的是落盘路径。要新增带图片/视频的工具，先读[工具 cookbook](../../docs/cookbook/adding-a-tool.zh.md) 里的附件规则再决定结果形状。

</details>
