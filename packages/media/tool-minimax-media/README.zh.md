---
description: "MiniMax 媒体工具：图片生成、语音合成与识别、音乐生成、文件上传，全部复用模型路由的同一把 MiniMax API key。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-minimax-media

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-tool-minimax-media` 把 MiniMax 其余的能力交给 agent：生成图片、合成语音、转写音频、列出与创建音色、生成音乐、上传文件。全部复用模型路由使用的 `MINIMAX_API_KEY`。MiniMax 以 URL 返回的产物会立刻下载进附件存储，因为那些链接一天内就会过期；上传则以 `mm_file://` 引用返回，正好是视频工具接受的形式。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与推迟的工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

挂载插件即可；MiniMax key 来自其它 MiniMax 包共用的同一个引用。

| 工具 | 接口 | 结果 |
| --- | --- | --- |
| `minimax_image_generate` | `POST /v1/image_generation` | 已存储的 PNG 及其临时源链接 |
| `minimax_speech_synthesize` | `POST /v1/t2a_v2` | 已存储的音频文件 |
| `minimax_speech_transcribe` | `POST /v1/speech_to_text` | 转写文本、时长与说话人分段 |
| `minimax_list_voices` | `POST /v1/get_voice` | 本账号可用的全部音色 |
| `minimax_voice_clone` | `POST /v1/voice_clone` | 克隆出的音色 id 及其试听音频 |
| `minimax_voice_design` | `POST /v1/voice_design` | 设计出的音色 id 及其试听音频 |
| `minimax_voice_delete` | `POST /v1/delete_voice` | 已删除的音色 id |
| `minimax_speech_synthesize_async` | `POST /v1/t2a_async_v2` | 长文本的已存储音频文件 |
| `minimax_music_generate` | `POST /v1/music_generation` | 已存储的音频文件 |
| `minimax_music_cover` | `POST /v1/music_generation` | 翻唱版本的已存储音频文件 |
| `minimax_music_cover_preprocess` | `POST /v1/music_cover_preprocess` | 翻唱 feature id 与提取出的歌词 |
| `minimax_lyrics_generate` | `POST /v1/lyrics_generation` | 歌词、标题与风格标签 |
| `minimax_file_upload` | `POST /v1/files/upload` | `file_id` 及其 `mm_file://` 引用 |
| `minimax_file_list` | `GET /v1/files/list` | 某个用途下存储的文件 |
| `minimax_file_download` | `GET /v1/files/retrieve_content` | 存储文件的字节，留在工作区 |
| `minimax_file_delete` | `POST /v1/files/delete` | 已删除的文件 id |
| `minimax_count_tokens` | `POST /anthropic/v1/messages/count_tokens` | 一条消息的输入 token 数 |

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `MINIMAX_API_KEY` | 保存 key 的凭据引用 |
| `apiBaseURL` | `https://api.minimax.cn` | 原生 API 根 |
| `imageModel` / `aspectRatio` | `image-01` / `1:1` | 图片默认值 |
| `speechModel` / `voiceId` | `speech-2.8-hd` / `English_expressive_narrator` | 语音合成默认值 |
| `musicModel` | `music-3.0` | 音乐默认值 |
| `asrModel` | `asr-1.0` | 语音识别默认值 |
| `audioFormat` / `sampleRate` | `mp3` / `32000` | 产出音频默认值 |
| `maxDownloadBytes` / `maxUploadBytes` | `134217728` / `52428800` | 下载与上传上限 |
| `pollIntervalMs` / `pollTimeoutMs` | `5000` / `600000` | 后台任务的状态轮询间隔与最后期限 |

两个读文件的工具都通过 `ctx.fs` 解析路径，因此沙箱策略决定它们能上传什么。

<a id="understand-the-implementation"></a>
## 理解实现

每个原生接口都返回 HTTP 200，真正的结果在 `base_resp.status_code` 里；客户端把非 0 状态转成错误，而不是返回空结果。图片与音频响应带一个临时 URL，客户端以字节上限流式写入 `attachments.saveFileStream`，会话因此留下持久文件。

语音识别与文件上传是 multipart 请求：工具通过文件系统服务读取文件、按扩展名推断媒体类型，并把 `model` 与 `file`（上传还要 `purpose`）作为表单字段发送。`minimax_file_upload` 返回 `mm_file://{file_id}`，也就是 `minimax_video_understand` 在视频过大、不便用 URL 传递时接受的引用形式。

有两个接口的回答形状与其它不同。识别接口从**请求头**读取语言，因此客户端把它发在头部而不是请求体里；字幕形式回答的是文本而不是 JSON，因此客户端按文本读取。音色设计的试听音频是**十六进制**而不是 URL，因此客户端解码这些字节后直接存储。

两个音色工具在 MiniMax 要求时都是两次调用：克隆先把样本以 `voice_clone` 用途上传，再把 `file_id` 发到克隆接口；设计则一次调用给出描述与试听文本，返回新的 `voice_id`。

还有三种形态走同一个客户端。异步语音接口接受的文本远多于同步接口，因此工具先建任务、轮询，再通过文件接口取回成品音频。翻唱是两步：预处理提取歌词与 feature id，翻唱调用把它们变成一首歌。token 计数则向 Messages 接口询问一条消息要花多少 token，而不生成任何内容，并且可以按请求将要使用的调度档位来计量。

文件内容接口即使在 spec 里声明为 `application/json`，实际返回的是原始字节，因此客户端按字节读取，绝不解析它。

所有请求都用 `redirect: 'error'`，key 不会跟随重定向到其它源。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-tool-minimax-video`](../tool-minimax-video/README.zh.md)——共享这份凭据的生成与理解工具。
- [`dsh-llm-minimax`](../../llm/llm-minimax/README.zh.md)——同一把 key 上的模型路由。
- [MiniMax 图片生成](https://platform.minimax.cn/docs/api-reference/image-generation-t2i)、[语音合成](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)、[语音识别](https://platform.minimax.cn/docs/api-reference/speech-to-text)、[音色列表](https://platform.minimax.cn/docs/api-reference/voice-management-get)、[音色克隆](https://platform.minimax.cn/docs/api-reference/voice-cloning-clone)、[音色设计](https://platform.minimax.cn/docs/api-reference/voice-design-design)、[音乐](https://platform.minimax.cn/docs/api-reference/music-generation)与[文件上传](https://platform.minimax.cn/docs/api-reference/file-management-upload)——本包编码的接口。

<a id="model-experience"></a>
## 模型体验

### 一次媒体调用

#### 模型看到什么

模型看到工具 schema、自己的参数，以及一个点明落盘路径、转写文本或 `mm_file://` 引用的结果。产出的图片与音频不会进入对话：harness 的内容模型只承载文本、图片和文件块，所以生成的画或歌是用户打开的文件。转写是唯一把结果变成对话内容的能力，它以文本形式返回。

#### Token 影响

这些调用除工具调用与结果外不消耗会话 token；MiniMax 按张、按字符或按音频秒计费。例外是之后被附加到消息里的生成图片：从那时起它的视觉 token 与其它图片一样计入。

#### KV Cache 影响

每次调用都是与聊天请求无关的独立 MiniMax 服务，因此这里没有什么会让会话的前缀缓存失效。之后某一轮附加了生成的图片，会像任何新附件一样改变那一轮的前缀。

## 已知限制与推迟的工作

<a id="known-limitations-and-deferred-work"></a>

- **产出的媒体不会内联展示。** 结果是落盘路径；要预览需要各自的客户端 slot，本包没有添加。
- **上传只读工作区文件。** 文件系统服务决定某个路径是否可达；没有挂载 `ctx.fs` 的部署会得到解释性错误。
- **克隆出的音色会过期。** MiniMax 会删除 7 天内从未使用过的克隆音色；克隆音色要使用过一次之后才会出现在 `minimax_list_voices` 里。
- 克隆要求样本时长在 10 秒到 5 分钟之间；过长或过短都会被 MiniMax 拒绝，工具本身不校验时长。
- 音色设计的试听单独计费，其费用与合成按字符同价。
- **异步语音工具接受文本而不是文件。** MiniMax 也接受承载百万字符的文本文件，本工具没有上传它。
- 文件接口与上传接口的用途名并不相同：列表与删除接受 `t2a_async` 和 `video_generation`，而上传接口不接受这两个。
- MiniMax 已于 2026-08-20 起对新账号停售付费音乐与歌词接口；没有音乐权限的 key 调用那两个工具会得到权限错误。

### 开发备注

配置在每次调用时读取，因此改动声音、模型或端点会在下一次调用生效，无需重新挂载插件。各工具共用一个客户端模块，`base_resp` 信封处理与下载上限因此只有一处实现。
