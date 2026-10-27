---
description: "DeepSeek Harness 的按任务模型路由：部署声明一张规则表，每个任务自动落到合适的 provider 通道上。"
kind: "package-reference"
---

# @deepseek-ai/dsh-model-router

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-model-router` 负责挑选一个任务该走哪条 provider 通道。一个 harness 部署通常注册了多条通道——有的先想再答，有的能收图，有的偏代码——但 harness 每个 Agent 只有一份模型选择，于是所有任务都跑在用户最后选的那条通道上。本插件读出即将执行的任务，并按部署声明的规则表换上它该走的那条通道。

本插件不改任务做什么，只改由谁来做。它无法兑现的规则会被放弃，Agent 保持原有通道。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [延伸探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在注册了一条以上 provider 通道的组合里挂载本插件，然后在设置里声明规则表：

```yaml
- id: model-router
  name: '@deepseek-ai/dsh-model-router'
  config:
    enabled: true
    rules:
      - name: long-form-writing
        keywords: ['小说', '章节', '正文']
        provider: slefminimax
        model: MiniMax-M3.1-Flash
        reasoningEffort: max
      - name: image-tasks
        hasImage: true
        provider: dpv41f
        model: deepseek-v4.1-flash
      - name: code-tasks
        keywords: ['实现', '修复', '重构']
        provider: slefgpt56
        model: copilot
```

路由**默认关闭**。一条规则在它声明的每个条件都成立时命中：`keywords` 对被认领消息的正文做大小写不敏感的匹配，`hasImage` 约束消息是否带图。两者都不声明的规则什么都不匹配，所以无条件规则不会悄悄吞掉所有任务。多条规则命中时第一条生效，因此最具体的规则要写在最前面。

只有部署确实注册了该 provider 与 model 时，目标才会被兑现。指向未注册通道的规则会被放弃并记一条 debug 日志，而不是照用；任务带图而目标通道不收图时，规则同样被放弃。目标通道提供该档位时才应用请求的 `reasoningEffort`，否则由目标通道用自己的默认值。

<a id="understand-the-implementation"></a>
## 实现原理

决策发生在 `agent/inbox/claimed` 上——agent 循环在 `packages/core/agent-loop/src/agent.ts` 里认领一个 step 的消息时发出的事件。紧接的下一行就捕获了该 step 的模型选择，所以插件在这个事件里选定的通道，是**第一个** step 就会用上的通道，而不是下一个 step 才换。这正是本插件监听收件箱而不是 `agent/pre-step` 的原因：pre-step waterfall 跑在选择已经被捕获之后，在那里做的选择只能作用于下一个 step。

插件调用 `agent.model.select()`，与模型选择页用的是同一个公开接口。该选择会以 `model/selection` 事件记入会话日志，因此被路由过的会话能读回每个 step 实际走的通道。

有两处让决策保持同步。规则表和信号都来自循环已经握在手里的那条消息。而**已注册通道及其模型的目录**是异步读取后缓存的——决策不能在被认领与选择被捕获之间等待一次查询。缓存会在 `llm/adapters-updated` 触发时刷新；目标不在缓存里的规则会被放弃——路由到未注册通道会让请求直接失败，而不是退回原通道。

<a id="further-exploration"></a>
## 延伸探索

- 规则本身是数据：`packages/core/model-router/src/rules.ts` 是匹配器，`packages/core/model-router/src/catalog.ts` 是缓存的注册表视图。
- 插件写入的接口是 `packages/core/agent/src/runtime-types.ts` 里的 `agent.model.select()`；循环捕获选择的位置在 `packages/core/agent-loop/src/agent.ts`。
- `packages/llm/llm-local-bridge` 注册了本插件通常在其间切换的随包本地反代通道。

## 模型体验

### 请求发出前的路由选择

#### 模型看到什么

路由不改变模型读到的消息。唯一多出来的模型可见内容，是当被路由到的通道与上一次请求所用通道不同时，harness 追加的换模型通知：一条 user 角色消息，写明它从哪个 provider 与 model 换到了哪个。保持 Agent 原有通道的决策不会追加任何东西。

#### Token 影响

路由不给请求增加 token。规则表读自插件配置而非对话，被读到的信号——被认领消息的正文与其中的图片块——本来就已在请求里。换了通道确实会改变请求自身的计量：harness 会从助手历史里剥掉上一个 provider 的 replay state，于是换道后的请求发送的是不带该状态的历史。

#### KV Cache 影响

被路由到的通道替换了请求的 provider 与 model，因此上一个 provider 为这段对话缓存的前缀不会被复用：换道之后的请求是一次独立的模型请求，而不是接在之前那次之后追加。当决策保持 Agent 原有通道时，请求内容没有任何变化，因而已经可复用的前缀保持完整。

## 已知限制与后续工作

- **规则只读消息。** 一条规则看到的是被认领消息的正文，以及它是否带图。它看不到 Agent 的预设、工具集、任务的历史长度，也看不到部署自己认为这是什么性质的工作，因此同一件事用不同措辞说出来，可能落到不同通道。
- **换道会丢掉上一个 provider 的 replay state。** harness 只让拥有该数据的 adapter 回放助手历史，因此换通道后发送的历史不含那份状态。早期轮次里带过 provider 专属 replay 数据的任务，可能在对话中途丢掉它。
- **effort 不对部署的凭证做校验。** 插件只检查目标通道是否提供所请求的档位，不提供就放弃，但目标通道凭证缺失时，仍会在请求阶段以该 provider 自己的错误失败，而不是在路由阶段失败。
- **没有跨通道回退。** 决策之后通道失败时不会换另一条通道重试，harness 自己的重试策略仍留在它选中的那条通道上。
