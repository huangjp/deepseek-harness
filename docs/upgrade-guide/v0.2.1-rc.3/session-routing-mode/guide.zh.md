---
kind: upgrade-guide
description: "Session 模型选择新增了路由模式，模型选择 RPC 的请求与响应结构随之改变。"
---

# Session 模型选择带上路由模式

[English](guide.md) | 中文

## 变更

Session 现在会记录路由模式。`auto` 把线路交给 Host 的路由策略决定；`fixed` 钉住 Session 选中的模型，任何路由器都不会用另一条线路作答。没有记录模式的 Session 跟随部署的默认模式，除非 profile 设置了 `agent-default-model.routingMode`，默认就是 `auto`。

`session.selectModel` 现在接受只带模式的请求：`provider` 与 `model` 变为可选，只带 `routingMode` 的请求改变由谁挑选线路，而不必指明线路。指明线路的请求仍然应用该线路，并且同时把 Session 切到 `fixed`。响应新增 `routingMode`，只带模式的请求返回 `selected: null`。`session.modelCatalog` 新增 `defaultRoutingMode` 与 `routingAvailable`。

`modelSelection` 投影视图新增 `routingMode`，新的 `model/routing-mode` Session 事件记录该模式。把投影视图当作精确对象解码的消费者必须接受这个新字段。

## 迁移

1. 更新所有 `session.selectModel` 的消费者：把 `provider` 与 `model` 当作可选，并从响应中读取 `routingMode`。同时发送线路与 `routingMode` 的请求会应用该线路，并把模式钉为 `fixed`。
2. 更新所有 `modelSelection` 投影视图的消费者：带上新的 `routingMode` 字段，并从 `session.modelCatalog` 读取 `defaultRoutingMode` 与 `routingAvailable`。没有路由插件的 Host 上 `routingAvailable` 为 `false`，这类 Host 的行为等同于每个 Session 都被钉住。
3. 确认只带模式的 `session.selectModel` 返回 `{ selected: null, routingMode: 'auto' }` 且下一次请求由路由策略作答，而指明线路的请求返回 `{ selected, routingMode: 'fixed' }` 并保持该线路。
