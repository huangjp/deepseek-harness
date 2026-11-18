---
description: "把 MiniMax 的服务端网页搜索注册为 ctx.web 搜索提供方：一把 MiniMax API key 就能让 harness 的 web_search 工具走 MiniMax 自己的搜索。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-minimax

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-web-search-minimax` 以提供方 id `minimax` 把 MiniMax 的服务端搜索注册到 harness 的 web 接缝上。部署用 `web.searchProvider: minimax` 选中它，现有的 `web_search` 工具随即通过 MiniMax 搜索，复用的是 `minimax` 模型路由那只 API key。该提供方声明 MiniMax 的 `web_search_20250305` 服务端工具，搜索由 MiniMax 执行，并在同一次请求里返回结果。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与推迟的工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

挂载插件并选中它：

```yaml
- insert:
    - id: web-search-minimax
      name: '@deepseek-ai/dsh-web-search-minimax'
- id: web
  config:
    searchProvider: minimax
    fetchProvider: http
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `MINIMAX_API_KEY` | 保存 key 的凭据引用；设置页写入的就是它 |
| `baseURL` | `https://api.minimax.cn/anthropic` | Anthropic 兼容根；后续拼接 `/v1/messages` |
| `model` | `MiniMax-M3.1-Flash` | 执行服务端搜索的模型 |
| `maxTokens` | `4096` | 搜索这一轮的输出上限 |
| `maxUses` | `3` | 一次请求可执行的搜索次数，到顶后 MiniMax 会暂停该轮 |
| `serviceTier` | `standard` | 调度档位；`priority` 价格是 1.5 倍，且 `MiniMax-M3.1-Flash` 拒绝该字段 |

`web_fetch` 仍走 harness 的 HTTP 抓取器：MiniMax 没有文档化的独立抓取接口，因此页面抓取不经过它。

<a id="understand-the-implementation"></a>
## 理解实现

`search()` 发送一次非流式 Messages 请求，携带 `tools: [{type: 'web_search_20250305', name: 'web_search', max_uses}]`，随后把每个 `web_search_tool_result` 块映射成接缝的 `WebSearchSource` 列表，按 URL 去重，并优先采用结果自带的摘要，其次是文本块 citation 里的摘录。

两处线路细节是 MiniMax 特有的。第一，请求绝不发送 `thinking: {"type": "disabled"}`：`MiniMax-M3.1-Flash` 一定会思考，对关闭思考的请求返回 `400`，所以提供方改为请求文档中最低的深度（`output_config.effort: "low"`）。第二，若一次请求的搜索预算用尽，回复可能以 `stop_reason: "pause_turn"` 结束；提供方会把该内容作为 assistant 消息回放后重发，最多续两次。

重定向会让操作直接失败，而不是把 `Authorization` 头转发到另一个源。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-web`](../web/README.zh.md)——本包注册进去的服务定义与提供方选择规则。
- [`dsh-web-search-deepseek`](../web-search-deepseek/README.zh.md)——同一套服务端工具模式在 DeepSeek 端点上的实现。
- [`dsh-llm-minimax`](../../llm/llm-minimax/README.zh.md)——共享这份凭据的模型路由。
- [MiniMax 服务端工具](https://platform.minimax.cn/docs/guides/server-tools)——文档化的工具声明与响应块。

<a id="model-experience"></a>
## 模型体验

### 一次 `web_search` 调用

#### 模型看到什么

模型看不到这次搜索请求及其响应：`tool-web` 把返回的来源渲染进工具结果文本，模型在下一步读到的是那段文本。每个来源贡献它的 URL、标题、摘要，以及 MiniMax 给出时的发布时间。除 harness 传入的查询外，提供方不添加任何自己的提示文本。

#### Token 影响

搜索这一轮消耗的是同一把 key、同一个账号下的 MiniMax token：查询、声明的工具，以及受 `maxTokens` 约束的简短综合。这些 token 不计入会话自身的用量——harness 计量的是它渲染出的 `web_search` 工具结果，而不是提供方侧的搜索轮次。

#### KV Cache 影响

每次搜索都是一次独立请求、一段全新对话，因此与聊天会话、与其它搜索都不共享前缀。MiniMax 的缓存只可能在 `pause_turn` 续写内部起作用，那种续写会带着上一次内容重发同一段对话。

## 已知限制与推迟的工作

<a id="known-limitations-and-deferred-work"></a>

- `maxResults` 是在完整结果集返回后才裁剪的：MiniMax 不会提前给出结果数量，所以提供方只能先全部取回再切片并标记 `truncated`。
- MiniMax 只接受 `tool_choice: auto`；本提供方只声明唯一的服务端工具，因此无需选择。
- 若部署把 MiniMax key 存在别的引用下，需要设置 `apiKeyEnv`；就绪检查与搜索读的是同一个引用。
- MiniMax 没有文档化的独立抓取接口，因此本包不影响 `web_fetch`。

### 开发备注

提供方在两次搜索之间不持有运行时状态：每次操作入口都从实时设置段读取选项，因此一次设置写入在下次搜索即生效，无需重新注册提供方。
