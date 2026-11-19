---
description: "把 4SAPI 中转作为一等 provider 路由接入：可配置域名上的 OpenAI 兼容 Chat Completions，模型列表来自密钥。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-4sapi

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-4sapi` 把 4SAPI 中转作为**一条固定路由** `4sapi-relay` 注册到 LLM 接缝上。4SAPI 是基于 new-api 的网关，把 OpenAI、Claude、Gemini、DeepSeek、Kimi、Qwen、GLM、Grok 等供应商聚合到同一个 OpenAI 兼容根路径后面。部署配置接入域名、凭据引用、Claude 所用协议、可选的模型列表，以及可选的按模型价格。

默认协议对所有模型都是 Chat Completions，包括 Claude。这是中转站为跨供应商的流式、工具和图片所写的协议。需要让 `claude-*` 走 `/v1/messages` 时，把 `claudeProtocol` 设为 `anthropic`，4SAPI 在那条线上才会带上 Anthropic 的思考配置。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [延伸探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

**设置 → 模型** 会列出 **4SAPI**。掩码后的密钥字段把令牌存在 `FOURSAPI_API_KEY` 下。启动进程的环境变量用同一个名字：`export FOURSAPI_API_KEY=sk-...`。不要把密钥写进仓库。

卡片上的域名列表是带 `/v1` 的中转根路径。默认是 `https://4sapi.com/v1`。中国大陆应选 `https://4sapi.org/v1` 或 `https://4stoken.com/v1`。其余是 `https://4sapi.top/v1`、`https://us.4sapi.com/v1`、纯 API 专线 `https://4sapi.ai/v1`，以及北美低延迟 `https://4sapi.net/v1`。在 `cordis.patch.yml` 里写的根路径如果没有 `/v1`，Chat Completions 会补上这个后缀。

| 路由 | 默认端点 | 模型 |
| --- | --- | --- |
| `4sapi-relay` | `https://4sapi.com/v1`（`POST /v1/chat/completions`） | 已存密钥的 `GET /v1/models` |

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `FOURSAPI_API_KEY` | 凭据引用。模型页把它写进去 |
| `baseURL` | `https://4sapi.com/v1` | Chat Completions 根。客户端自己补上 `/chat/completions` |
| `claudeProtocol` | `openai` | `anthropic` 把 `claude-*` 发到 `/v1/messages` |
| `models` | 空 | 非空列表替换拉取到的目录。只在 id 推断不对时写 `vision` |
| `pricing` | 空 | 按模型的价格。一行会替换该 id 在 `/api/pricing` 上的值 |
| `usePricingEndpoint` | `true` | 读取 `GET /api/pricing`，补上 `pricing` 没有写的行 |

没有密钥时不列出模型，模型路由器点名这条路由时会跳过该候选。引用解析不到密钥时，直接请求以 `MISSING_CREDENTIAL` 失败。

```yaml
- id: llm-4sapi
  name: '@deepseek-ai/dsh-llm-4sapi'
  config:
    apiKeyEnv: FOURSAPI_API_KEY
    baseURL: https://4sapi.org/v1
    claudeProtocol: openai
    models: []
    pricing:
      - model: deepseek-chat
        inputPerMillion: 1
        outputPerMillion: 2
        currency: USD
```

<a id="understand-the-implementation"></a>
## 实现原理

`apply` 注册模型页上的一行（`settingsNs` 是本插件的入口 id，`settingsPath` 为空，因此这一行没有删除控件），并把一份 profile 交给 `PiAiAdapter`：`api: openai-completions`，以及当前的模型列表。有密钥且 `models` 为空时，列表来自 `GET /v1/models`，并缓存到密钥、接入域名或手工列表发生变化。拉取失败后 30 秒内沿用上一次结果。列表接口返回 401 或 403 时清空目录。

`claudeProtocol: anthropic` 把 `claude-*` 改写到 `anthropic-messages`，并去掉这些模型根路径上的 `/v1`，因为 Messages 客户端自己会补上 `/v1/messages`。这些模型提供推理档位 `off`、`low`、`medium`、`high`。其他 id 仍走 Chat Completions。默认情况下每个 id，包括 Claude，都走 Chat Completions。

`insufficient_user_quota`、`余额不足`，以及 new-api 的其他额度措辞，记成 `QUOTA`，哪怕状态是 403。`401` 和 `无效的令牌` 记成 `AUTH`，健康模型随后把这条路由标成不可用，直到配置改变。普通 `429` 是 `RATE_LIMIT`。HTTP 5xx 以及 `无可用渠道` / `no available channel` 是 `SERVER`，重试策略会再发。`GET /v1/dashboard/billing/subscription` 和 `GET /v1/dashboard/billing/usage` 都能解析时，写入 `llm/quota-remaining`；失败则不提供这个信号。`GET /api/pricing` 把 new-api 的 `model_ratio` 1 换成每百万输入 token 2 美元，输出再乘 `completion_ratio`。按次价格和分组倍率不参与换算。日志写出合并后的行数。模型路由器的计费读它自己的 `pricing` 表，因此要把打算入账的行抄过去。

<a id="further-exploration"></a>
## 延伸探索

- [`dsh-llm-pi-ai`](../llm-pi-ai/README.zh.md) — 本包装配的适配器。
- [`dsh-llm-xai`](../llm-xai/README.zh.md) — 另一条同样由代码注册的一等路由。
- [`dsh-model-router`](../../core/model-router/README.zh.md) — 健康分类、回退链，以及要抄进去的价格表。
- [4SAPI 接入说明](https://4sapi.com/blog/4sapi-api-integration-setup-guide) — 域名、Bearer 鉴权，以及 `/v1`。
- [new-api](https://github.com/QuantumNous/new-api) — 本路由读取其错误码和账单接口的网关。

<a id="model-experience"></a>
## 模型体验

### 经内置路由的一轮对话

#### 模型看到什么

选中的模型收到 `PiAiAdapter` 为 Chat Completions 路由构造的请求：系统提示、历史和工具目录。只有模型声明接受图片时，图片才会作为图像输入送出。请求带 `Authorization: Bearer`，以及 Harness 的归属头。走 Anthropic 线的 `claude-*` 模型收到的是 Messages 请求，并带上选中的推理档位。

#### Token 影响

中转站自己做分词，并按账户分组计费。本包不追加 token。列表没有给出上下文窗口的模型，按 128,000 token 描述，输出能力按 8,192 token 描述，直到 `models` 写上别的数字。

#### KV Cache 影响

中转站上游如果有提示缓存，就跟随该供应商。更换模型、工具目录或更早的消息，会从那一点起重写前缀。把同一个 Claude 模型在 Chat Completions 和 Messages 之间换线，会改变线上格式，因此这次切换不能复用前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **价格是倍率，不是分组账单。** `model_ratio` 为 1 时记成每百万输入 token 2 美元。分组倍率和按次的 `quota_type` 1 不计入。把实际支付的数字写进 `pricing`，或写进模型路由器的 `pricing`。
- **图像能力从模型 id 推断。** 列表不声明模态。对不上保守规则的 id 保持纯文本，直到写上 `vision: true`。
- **上下文窗口只有一个回退值。** 列表没给窗口时，按 128,000 token 描述。
- **Chat Completions 不发送 Anthropic 的思考配置。** 需要思考块时，对 `claude-*` 使用 `claudeProtocol: anthropic`。这个设置下，其他供应商仍走 Chat Completions。
- **模型列表拉取失败后 30 秒内保持为空。** 更换密钥或接入域名会立刻重试。

### 开发备注

没有额外的运行时不变式。这条路由就是 `PiAiAdapter` 的契约，加上本包的目录拉取、价格解析和错误分类。
