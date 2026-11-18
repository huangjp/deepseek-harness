---
description: "MiniMax 视频工具：通过 MiniMax 的任务接口生成短视频，并让 MiniMax 模型看懂一段视频里发生了什么。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-minimax-video

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-tool-minimax-video` 给 agent 两个 MiniMax 视频工具。`minimax_video_generate` 创建生成任务、轮询到它结束，并把成品 MP4 提交进附件存储，这样会话留下的是持久文件而不是 MiniMax 会过期的下载链接。`minimax_video_understand` 让 MiniMax 的多模态模型回答一段视频里发生了什么。两者都用与 `minimax` 模型路由相同的 `MINIMAX_API_KEY`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与推迟的工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

挂载本插件，MiniMax key 只需要填一次——与模型路由用的是同一把：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `MINIMAX_API_KEY` | 保存 key 的凭据引用 |
| `apiBaseURL` | `https://api.minimax.cn` | `/v2/video_generation` 所在的原生根 |
| `chatBaseURL` | `https://api.minimax.cn/anthropic` | 视频理解用的 Anthropic 兼容根 |
| `videoModel` | `MiniMax-H3` | 调用方未指定时的模型；另提供 `MiniMax-H3-Highspeed`、`MiniMax-H3-Lite`、`MiniMax-H3-Max` |
| `resolution` | `768P` | `480P`、`768P`、`2K`，可用性随模型而定 |
| `durationSeconds` | `6` | 4–15 秒 |
| `ratio` | `16:9` | 宽高比；图生视频忽略该字段 |
| `pollIntervalMs` / `pollTimeoutMs` | `10000` / `600000` | 状态轮询间隔与整次操作的最后期限 |
| `maxDownloadBytes` | `268435456` | 允许下载的 MP4 上限 |
| `understandingModel` | `MiniMax-M3.1-Flash` | 回答理解请求的模型 |

| 工具 | 接口 | 结果 |
| --- | --- | --- |
| `minimax_video_generate` | `POST /v2/video_generation` | 已存储的 MP4 与任务 id |
| `minimax_video_understand` | `POST /anthropic/v1/messages` | 关于这段视频的回答 |
| `minimax_video_context_enrich` | `POST /v2/h3_context_ir` | 生成应使用的增强提示词 |
| `minimax_video_regenerate` | `POST /v2/video_regeneration` | 重新生成的 2K MP4 |
| `minimax_video_task_list` | `GET /v2/query/video_generation` | 最近一周的任务及其状态 |
| `minimax_video_task_cancel` | `DELETE /v2/video_generation/{id}` | MiniMax 对该任务做了什么 |
| `minimax_video_generate_hailuo` | `POST /v1/video_generation` | 老模型生成的已存储 MP4，可达 1080P |

没有 key 的机器照样能看到工具；真正调用时会失败，并在消息里点名要存入的引用。

<a id="understand-the-implementation"></a>
## 理解实现

生成是原生根上的两次请求：`POST /v2/video_generation` 返回 `task_id`，`GET /v2/query/video_generation/{task_id}` 报告 `queued`、`running`、`succeeded`、`failed` 或 `cancelled`。工具按 `pollIntervalMs` 轮询，直到终态或 `pollTimeoutMs`，随后把 `content.url` 以字节上限流式写入 `attachments.saveFileStream`。结果带上任务 id、附件 id，以及后端是文件型时的落盘路径。

一次生成请求要么是图生视频、要么是参考式，MiniMax 拒绝两者混用的请求；工具根据参数判断属于哪一种，并自行拒绝混用。分辨率与时长同理：每个模型只服务其中一部分，工具在请求到达提供方之前先按这个子集校验，于是不可能的组合是参数错误，而不是一个含糊的 `400`。

另有三个接口扩展了这一族。上下文增强把素材变成生成应使用的提示词，回答的是增强后的提示词而不是视频。重新生成把已完成的视频重渲染为 2K，来源可以是产出它的任务，也可以是一段 768P 源视频。老的 Hailuo 模型能到 1080P，但回答的是文件 id 而不是链接，因此那条路径轮询老的状态接口，再通过文件接口取回下载链接。

视频理解是 Anthropic 兼容根上的一次请求：一个 `video` 内容块，`source` 为 `{type: 'url', url}`，外加作为文本块的问题。请求发送 `thinking: {type: 'adaptive'}` 与 `output_config.effort: 'low'`；`MiniMax-M3.1-Flash` 一定会思考，且拒绝关闭思考的请求。回复里只有 `text` 块会进入工具结果。

两次请求都用 `redirect: 'error'`，因此 key 不会跟随重定向到其它源。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-llm-minimax`](../../llm/llm-minimax/README.zh.md)——共享这份凭据的模型路由。
- [`dsh-tools`](../../core/tools/README.zh.md)——这些工具使用的注册表、schema 与错误契约。
- [MiniMax 视频生成](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)——任务接口与状态取值。
- [MiniMax Create Message](https://platform.minimax.cn/docs/api-reference/text-chat-anthropic)——`video` 内容块与思考规则。

<a id="model-experience"></a>
## 模型体验

### 一次生成调用

#### 模型看到什么

调用方模型只看到工具 schema、自己的参数，以及点明落盘路径的工具结果文本。生成的视频本身不会进入对话：harness 的内容模型只承载文本、图片和文件块，所以视频是用户打开的文件，而不是模型阅读的内容。模型写的提示词就是 MiniMax 视频模型收到的全部输入。

#### Token 影响

生成视频除工具调用与结果外不消耗会话 token，MiniMax 按输出秒数而不是 token 计费。视频理解则会消耗本次会话的 provider token：MiniMax 按 `fps` 采样帧并对每一帧计费，这也是工具暴露 `fps` 与 `detail` 的原因。

#### KV Cache 影响

两个工具都不改动聊天请求：生成是 MiniMax 另一项服务，理解是自带单条消息对话的独立一次性请求。会话前缀不被共享，因此两者都不会使聊天记录的前缀缓存失效。

## 已知限制与推迟的工作

<a id="known-limitations-and-deferred-work"></a>

- **生成的视频不会内联展示。** 结果给出的是落盘路径；要在客户端预览 MP4 需要它自己的 slot，本包没有添加。
- **视频理解接受 URL，不接受本地文件。** 本地视频需要先走 Files API（`mm_file://{file_id}`）或提供公网 URL；本工具接受该引用形式，但不自己上传文件。
- 提供方暂停或限流时，调用会因其状态失败；除任务轮询外没有自动重试。
- **只有最近七天的任务可查。** MiniMax 拒绝更早的任务 id，任务列表也只统计这个窗口。
- **重新生成需要白名单权限**，且来源任务必须成功并落在那个窗口内，否则 MiniMax 拒绝调用。
- 老 Hailuo 模型没有取消或删除接口，其成品视频的下载链接一小时后过期。
- 图片生成、语音、音乐与文件上传由同组的 `dsh-tool-minimax-media` 包提供。

### 开发备注

两个工具每次调用都读取配置，因此改动端点或期限会在下一次调用生效，无需重新挂载插件。生成工具声明的 `timeoutMs` 比 `pollTimeoutMs` 多一分钟，保证 harness 的最后期限不会先于工具自己的期限触发。
