---
description: "把 MiniMax 作为一等 provider 路由接入：走 Anthropic 兼容的 Messages 接口，暴露 MiniMax 自己的思考深度，由代码注册而不是用户自定义模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-minimax

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-minimax` 把 MiniMax 作为**一条固定路由** `minimax-official` 注册到 LLM 接缝上，走 MiniMax 的 Anthropic 兼容 Messages 接口。它不是 `llm-pi-ai` 里的条目：部署只配置端点、凭据引用和默认深度，不配置路由身份。

这条路由暴露 MiniMax 自己的深度——`low`、`medium`、`high`、`xhigh`、`max`——并把 `max` 公告为默认值，也就是 MiniMax 在请求未指定时自己用的深度。思考以 `{"type":"adaptive"}` 加 `output_config.effort` 发出；`MiniMax-M3.1-Flash` 对关闭思考的请求返回 `400`，所以它的等级里没有 `off`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与推迟的工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用户只需要一把 API key：**设置 → 模型**里会列出 **MiniMax**，在那里粘贴的 key 存入本路由的凭据引用，路由上所有模型共用它。

| 路由 | 端点 | 模型 |
| --- | --- | --- |
| `minimax-official` | `https://api.minimax.cn/anthropic` | `MiniMax-M3.1-Flash`、`MiniMax-M3` |

部署字段：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `MINIMAX_API_KEY` | 保存 key 的凭据引用；设置页写入的就是它 |
| `baseURL` | `https://api.minimax.cn/anthropic` | Anthropic 兼容根；中国大陆之外用 `https://api.minimax.io/anthropic` |
| `reasoningEffort` | `max` | 请求未指定深度时写入的等级 |

引用解析不到 key 时请求以 `MISSING_CREDENTIAL` 失败，而不是发出匿名调用；没有 key 之前，模型目录也不列出任何模型。

<a id="understand-the-implementation"></a>
## 理解实现

`apply` 注册一条设置页渲染的目录项（`settingsNs` 是本插件自己的命名空间，`settingsPath` 为空，所以该行不带删除按钮），并把一份固定 profile 交给 `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter`：`api: anthropic-messages`、配置的 `baseURL`，以及一份声明式目录。

每个模型用 `reasoningEfforts` 声明每个等级对应的线路写法，于是适配器把选中的等级直接映射为 `output_config.effort`，并把未声明的 `off` 钉为不支持。`compat.forceAdaptiveThinking` 让请求发出 `{"type":"adaptive"}`，`compat.supportsTemperature: false` 则让 MiniMax 会忽略的采样字段根本不上线。

key 逐请求通过 `ctx.credentials` 解析；只有在没有挂载凭据服务时才退回启动环境。思考块与工具调用按适配器的持久元数据回放，因此带推理的工具轮次会原样带回签名——这是 MiniMax 的要求。

套餐窗口的 HTTP 429 会在共享的 pi-ai 错误映射之前被分类为 `QUOTA_WINDOW`，因此不会走短时的 `RATE_LIMIT` 重试。MiniMax 文档里的 429 示例（`触发 RPM/TPM/连接数 等限流`）以及错误码 1002 和 2062 仍是 `RATE_LIMIT`。错误码 2056 和 2067，以及套餐用语 `用量上限`、`资源限制`、`套餐额度已用完`，属于窗口。响应体不带 `Retry-After`，也没有恢复时刻，而 pi-ai 只保留 `error.message`，所以恢复时刻从 API 主机上的 `GET /v1/token_plan/remains`（然后是 `/v1/coding_plan/remains`）读取；主机名以 `api.` 开头时，再试 `www` 主机。`end_time` 是 5 小时窗口，`weekly_end_time` 是周窗口。文本模型两个窗口都要有余量；两个都用尽时，任务等待的是周窗口的结束时刻。监听器在 `llm/quota-window` 上返回这份计划。等待由 `@deepseek-ai/dsh-llm-quota-wait` 执行。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-llm-pi-ai`](../llm-pi-ai/README.zh.md)——本包委托的适配器与 profile 解析。
- [`dsh-llm-deepseek`](../llm-deepseek/README.zh.md)——内置的 `deepseek-official` 路由，本包的固定注册方式与设置页姿态都沿用它的模式。
- [MiniMax Anthropic SDK 文档](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)——本 profile 编码的线路契约。

<a id="model-experience"></a>
## 模型体验

### 经由内置路由的一次对话轮次

#### 模型看到什么

被选中的模型收到的就是 `PiAiAdapter` 为任意 pi-ai 路由构造的请求：一段系统提示（`GenerateOptions.system`，否则取历史中首条 `system` 消息的文本）、其余历史、工具目录，以及 pi-ai 通用流式接口支持的字段。每张保留的图片前有一段文字，说明其完整附件 id 与实际请求尺寸。请求带 provider key 与 Harness 归因头；原生回放元数据只在适配器针对历史内容校验通过后才恢复，而 MiniMax 要求思考块的签名原样带回。

#### Token 影响

请求由 MiniMax 自己分词，因此精确输入以它的分词器为准。两个模型都声明 1,000,000 token 上下文窗口。思考 token 在 MiniMax 侧计入 `max_tokens`，所以回复可能在出现任何文本块之前就以 `stop_reason: "max_tokens"` 结束。保留的图片会加上附件与尺寸描述，并计入 provider 自己的视觉 token。

#### KV Cache 影响

MiniMax 在自己的服务端缓存请求前缀，并以 `cache_read_input_tokens` 报告复用情况，所以已完成步骤之后前缀未变的请求会命中复用。改变模型、等级、工具目录或更早的任何消息，都会从该处重写前缀并终止复用；其后的消息保持稳定。

## 已知限制与推迟的工作

<a id="known-limitations-and-deferred-work"></a>

- **视频输入不会发出。** MiniMax 的 Messages 接口接受 `video` 内容块，但 Harness 的内容模型只承载文本、图片和文件块，因此视频附件到达本路由时是不受支持的内容错误，而不是视频块。
- **MiniMax 的服务端 `web_search` 工具尚未逐请求声明。** 这些模型的搜索目前走 harness 的 `web_search` 工具。
- `temperature`、`top_p`、`top_k`、`stop_sequences` 与 `cache_control` 在该接口上会被 MiniMax 忽略；profile 设置 `supportsTemperature: false` 因此不发送 temperature，其余被忽略的字段也不发送。
- **聊天路由无法申请优先调度档位。** MiniMax 为 `MiniMax-M3` 提供 `service_tier: priority`，价格是标准档的 1.5 倍，但 pi-ai 构造的 Anthropic 兼容请求体里没有这个字段，也没有添加它的扩展点。自行构造请求体的同族包——MiniMax 搜索提供方与 token 计数工具——会发送它。需要聊天走优先调度的话，得改 pi-ai。
- 目录是声明的，不是探测来的：启动时不调用模型列表接口，所以 MiniMax 下线的模型在本包变更前仍会被列出。
- **429 响应体不给出恢复时刻。** 上面的用量时钟才是 `end_time` 和 `weekly_end_time` 的来源。窗口从第一次使用起算，所以时钟读不到时改为探测，而不是去猜下一个墙上时钟的 5 小时边界。5 小时窗口的恢复不会补回已经用尽的周窗口。

### 开发备注

本包没有伴随的运行时不变式：它贡献一条固定路由，行为由所委托的 `PiAiAdapter` 契约描述，加上本 profile 声明的目录与兼容开关。
