---
description: "把 xAI Grok 作为一等 provider 路由接入：Responses API、可配置的推理档位，由代码注册，而不是用户声明的自定义模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-xai

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-xai` 把 xAI 作为**一条固定路由** `xai-official` 注册到 LLM 接缝上，走 `https://api.x.ai/v1` 的 Responses API。它不是 pi-ai 目录里那个叫 `xai` 的条目：那个 id 已经被安装目录占用。部署配置端点、凭据引用、默认推理档位，以及可选的模型列表。

随包模型是 `grok-4.7`：50 万 token 上下文、接受图片，推理档位为 `low`、`medium`、`high`、`xhigh`。推理不能关闭。默认档位是 `high`，也就是请求不写档位时 xAI 自己用的档位。`XAI_DEFAULT_PRICES` 记录提示不足 20 万 token 的价格：`grok-4.7` 是每百万输入 / 输出 2.00 / 6.00 美元，`grok-build-0.1` 是 1.00 / 2.00 美元。提示达到 20 万 token 时，xAI 对整次请求按两倍计费（4 / 12 与 2 / 4）。路由每个模型只存一个价格，要按高档计费就改掉对应条目。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [延伸探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用户只需要一把 API key。**设置 → 模型** 会列出 **xAI**。在那里粘贴的 key 存在 `XAI_API_KEY` 下。启动进程的环境变量用同一个名字：`export XAI_API_KEY=...`。不要把 key 写进仓库。

| 路由 | 端点 | 默认模型 |
| --- | --- | --- |
| `xai-official` | `https://api.x.ai/v1`（`POST /v1/responses`） | `grok-4.7` |

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `XAI_API_KEY` | 凭据引用。模型页把它写进去 |
| `baseURL` | `https://api.x.ai/v1` | Responses API 根。客户端自己补上 `/responses` |
| `reasoningEffort` | `high` | 请求没有写档位时使用的档位 |
| `models` | `grok-4.7` | 非空列表替换旗舰模型。只有确认接受图片的模型才写 `vision: true` |

解析不到 key 时，请求以 `MISSING_CREDENTIAL` 失败。没有 key 时目录里没有模型。

```yaml
- id: llm-xai
  name: '@deepseek-ai/dsh-llm-xai'
  config:
    apiKeyEnv: XAI_API_KEY
    reasoningEffort: high
    models:
      - id: grok-4.7
        vision: true
        contextWindow: 500000
```

<a id="understand-the-implementation"></a>
## 实现原理

`apply` 注册模型页上的一行（`settingsNs` 是本插件的命名空间，`settingsPath` 为空，因此这一行没有删除控件），并把一份 profile 交给 `PiAiAdapter`：`api: openai-responses`、配置的 `baseURL`，以及模型列表。

Chat Completions（`POST /v1/chat/completions`）仍然存在，xAI 把它标成旧接口。pi-ai 在那条线上还会关掉 Grok 的 `reasoning_effort`。Responses API 才是 pi-ai 自带 xAI 目录用来做流式、工具、图片和 `reasoning.effort` 的协议，所以本路由用它。Anthropic 兼容的 Messages 接口已弃用，这里不用。

`401` 和 `403`，以及 `Incorrect API key` 这类措辞，记成 `AUTH`。健康模型随后把这条路由标成不可用，直到配置改变。普通 `429` 是 `RATE_LIMIT`。正文写明额度用尽或触达花费上限时记成 `QUOTA`，哪怕状态是 `429` 或 `403`，这样它不会被当成短期限流反复重试。

<a id="further-exploration"></a>
## 延伸探索

- [`dsh-llm-pi-ai`](../llm-pi-ai/README.zh.md) — 本包装配的适配器。
- [`dsh-llm-minimax`](../llm-minimax/README.zh.md) — 另一条同样由代码注册的一等路由。
- [`dsh-model-router`](../../core/model-router/README.zh.md) — 要让费用路由看见 Grok，把 `XAI_DEFAULT_PRICES` 抄进 `pricing`。
- [xAI 模型](https://docs.x.ai/docs/models) — 上下文、模态，以及两档价格。
- [xAI 推理](https://docs.x.ai/docs/guides/reasoning) — Responses API 上的 `reasoning.effort`。

<a id="model-experience"></a>
## 模型体验

### 经内置路由的一轮对话

#### 模型看到什么

选中的模型收到 `PiAiAdapter` 为 Responses 路由构造的请求：系统提示、历史、工具目录和推理档位。只有模型声明接受图片时，图片才会作为图像输入送出。请求带 `Authorization: Bearer`，以及 Harness 的归属头。

#### Token 影响

xAI 自己做分词。`grok-4.7` 声明 50 万 token 上下文。推理 token 随回复一起计费。提示不足 20 万 token 时，公开价格是每百万输入 / 输出 2.00 / 6.00 美元。

#### KV Cache 影响

缓存输入有单独的公开价格。更换模型、档位、工具目录或更早的消息，会从那一点起重写前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **存一个价格，按两档计费。** 提示达到 20 万 token 时，xAI 对整次请求按所存价格的两倍计费。`XAI_DEFAULT_PRICES` 只记录 `grok-4.7` 和 `grok-build-0.1` 的低档。
- **模型列表是声明的，不是探测的。** 本包启动时不调用 `GET /v1/models`。xAI 发布了本包没有随包的 id 时，写进 `models`。
- **不使用 Chat Completions，也不使用已弃用的 Messages 接口。**
- **除 `grok-4.7` 以外，图像输入都要显式打开。** 替换行不写 `vision: true` 时只接受文本。

### 开发备注

没有额外的运行时不变式。这条路由就是 `PiAiAdapter` 的契约，加上本包的目录和错误分类。
