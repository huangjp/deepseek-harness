---
description: "在提供方的可恢复额度窗口打开之前暂停当前 agent 步骤，然后继续同一个任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-quota-wait

[English](README.md) | 中文

## 概述

挂载 `@deepseek-ai/dsh-llm-quota-wait` 后，当提供方报告一个会恢复的额度窗口（`QUOTA_WINDOW`）时，正在运行的任务会停在同一步骤上。该步骤等到提供方又能服务，再在同一个未结束的回合里重试。短时的 `RATE_LIMIT` 仍由 `@deepseek-ai/dsh-llm-retry` 处理。直接的 `ctx.llm.stream()` 调用不会被挂起。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与推迟的工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件和 `dsh-llm-retry` 一起挂进运行 agent 循环的组合。它没有配置。提供方的接入方式是让失败请求以 `QUOTA_WINDOW` 结束。它也可以监听 `llm/quota-window`，并为自己的路由返回 `{ window, resetAtMs }`；其他路由必须调用 `next()`。

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
- name: '@deepseek-ai/dsh-llm-quota-wait'
```

`QUOTA_WINDOW` 不在默认的可重试集合里，因此普通重试策略会把这次失败交出来，由本插件负责等待。报告了 `resetAtMs` 时，睡眠到该时刻再加两秒。时钟缺失、过期，或远于八天时，改为探测：先等 60 秒，然后加倍，上限 15 分钟，直到请求成功或回合被取消。每一次探测都是重试的模型请求，不是旁边的循环。

等待在开始之前就是可见的。插件先追加 `llm/quota-wait`，带上提供方、窗口（`interval`、`weekly` 或 `unknown`）和绝对的 `resumeAtMs`，并在同一步骤即将再次运行时追加 `llm/quota-wait-started`。Chat 行读取这些事件。无界面运行在 info 日志里写下同一次暂停。取消回合会中止计时器，并以 aborted 结束回合；该步骤不会重试。

`llm/quota-hold` 通知告诉模型路由：在 `resumeAtMs` 之前应跳过这条路由。这个跳过只作用于之后的自动路由认领。进行中的步骤，包括已经自动路由过的步骤，保持它已经捕获的模型选择并等待。固定模式不看这个跳过，因此钉在该提供方上的会话会在自己的请求碰到窗口时等待。`QUOTA_WINDOW` 不计入路由的失败冷却。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

监听器挂在 `agent/request-error` 上，只对 `QUOTA_WINDOW` 返回 `{ kind: 'retry' }`。agent 循环随后在持久历史上重跑同一步骤，包括本回合已经提交的工具结果。睡眠是一个计时器；当延迟长于平台单次计时上限时，拆成若干段，每段不超过该上限。没有轮询循环。

`scheduleQuotaWait` 是纯决策：可用的重置时刻优先于探测。连续探测按会话和提供方记在插件内存里，并在该提供方追加一条助手消息时清掉。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-llm-retry](../llm-retry/README.zh.md)——本等待不取代的短重试策略。
- [dsh-llm-minimax](../llm-minimax/README.zh.md)——把 MiniMax 的套餐窗口 429 分类，并读取用量时钟的提供方。
- [dsh-model-router](../../core/model-router/README.zh.md)——额度暂停如何让之后的自动路由认领跳过该路由，同时不把它算进熔断。

-----

<a id="model-experience"></a>
## 模型体验

### 额度窗口恢复

#### 模型看到什么

等待事件、延迟和提供方错误都不会进入模型。重试的步骤从持久历史重建同一个提供方和模型请求。窗口之前已经提交的工具结果留在这段历史里。

#### Token 影响

`llm/quota-wait` 记录本身不发送 token。重试是一次新的提供方请求，可能为同一步骤再次计算输入 token。探测是更多次计费请求。

#### KV Cache 影响

同一步骤的重试发送失败那次相同的前缀，因此会缓存该前缀的提供方可以复用它。等待不改写历史。

## 已知限制与推迟的工作

<a id="known-limitations-and-deferred-work"></a>

- **进程重启不会恢复这次等待。** agent 循环在恢复会话时，会先把未结束的回合以 interrupted 关闭，任何插件都来不及重新进入那次模型请求。`llm/quota-wait` 事件留在日志里，用户用新的回合继续任务。重启前已经提交的工具结果仍在会话里。
- **只有 agent 循环的请求失败会被挂起。** 直接的 `ctx.llm.stream()` 调用仍会在 `QUOTA_WINDOW` 上结束。
- **进行中的步骤不能更换提供方。** 自动路由的会话会在步骤已经捕获的路由上等待。之后的认领可以用另一条规则；这一步不会。

### 开发备注

没有发布运行时不变量配套说明：等待就是 `agent/request-error` 上的决定加上两条会话事件，`scheduleQuotaWait` 由单元测试覆盖。
