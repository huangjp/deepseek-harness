---
description: "dsh Web 客户端插件页上的模型路由设置页：model-router 命名空间的任务到线路规则表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-model-router

[English](README.md) | 中文

## 概述

在侧栏打开**插件**，在官方分组里选择 **模型路由**，即可决定哪一类任务交给哪个模型来做。页面承载路由器的规则表：每条规则说明任务形态（关键词，以及任务是否带图片）和应答它的线路与模型；页面还承载两个健康度参数，让路由器能暂时绕开持续失败的线路。页面暂存全部编辑，只在保存时写入。页面只在 Host 服务 `model-router` 命名空间期间存在。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

官方分组里的 **模型路由**卡片打开这一页。**自动路由任务**开关路由器。**路由规则**按生效顺序列出规则表：每一行包含名称、必须出现在消息里的关键词、附件条件（**不限**、**必须带图片**、**必须不带图片**）、线路、该线路上的模型，以及思考强度。线路和模型都从本部署真实注册的线路里选，所以规则无法指向不存在的线路；某条规则指向的线路消失后，它保留原来的值，等待你修正，而不是被悄悄改指到别处。**上移**、**下移**、**删除规则**改变规则表顺序，而顺序决定哪条规则先生效。既没有关键词也没有附件条件的规则永远不匹配，页面因此拒绝保存它。**跳过某条线路前的失败次数**和**冷却时间（分钟）**是健康度参数：同一条线路连续失败达到该次数后，路由器不再把任务发给它，冷却时间决定它被跳过多久。冷却时间以分钟展示、以毫秒写回，部署里存成其他单位的冷却值会原样写回。

要让熔断真的把任务挪走，表里必须留一条**匹配得上**的兜底规则（附件条件选「必须不带图片」与「必须带图片」各一条即可覆盖全部任务）：某条规则的线路被绕开后，接手的是下一条匹配得上的规则；表里没有兜底规则时，任务会留在它原本那条——也就是刚失败的那条——线路上。冷却时间是墙上的钟而不是重试预算：冷却一过，那条线路会再得到一次机会，而它若再次失败会立刻被重新绕开。

点击**保存**之前不会写入任何内容；离开页面即丢弃草稿，规则没填完整则保存被阻止并说明原因。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

宿主半侧是一个空的 `apply`，只为让本包占一条 Loader 行，客户端模块系统据此送出浏览器半侧。浏览器半侧通过 `ctx.configForms.get` 绑定 `model-router` 命名空间，在 `ModelRouterCardController` 里维护暂存的规则表，并通过 `ctx.configForms.whileServed` 把 `ModelRouterCard` 注册进插件页的 `plugins.item` slot。

规则表是对象数组，共享的标量表单模型承载不了，因此卡片自维护一份草稿，一次带版本栅栏的写入落整张表，而不是每行写一次；两个健康度参数在同一次写入里一并落。线路目录来自 `ctx.remote.session.modelCatalog()`，Host 报告适配器或设置文档变化时页面会重新读取。

页面文案在本包的 `settings.modelRouter` 字典里。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-plugin-manager](../ui-plugin-manager/README.zh.md)——插件页以及本页注册进去的 `plugins.item` slot。
- [ui-settings](../ui-settings/README.zh.md)——本页依赖的设置 scope 与"命名空间被服务期间"的监视。
- [ui-primitives](../ui-primitives/README.zh.md)——本页渲染的设置表单框架。
- [model-router](../../core/model-router/README.zh.md)——拥有 `model-router` 命名空间并应用这张表的路由器。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的设置界面，不注册任何模型面。

#### KV 缓存影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **一张表、一次保存**——页面用一次写入落整张规则表和两个健康度参数，因此需要按规则粒度授权的部署在这里做不到。
- **不显示线路健康度**——页面能改让路由器绕开线路的参数，但看不出当前哪些线路正被跳过；那是路由器自己的内存状态。
- **思考强度由适配器给出**——每一行可选的思考强度来自该线路目录公布的列表，所以适配器没列出的强度在这里选不了。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本卡片是纯浏览器半侧：它不 import 任何宿主包，因此 `model-router` 命名空间在 `MODEL_ROUTER_NS` 里以字符串写出，而不是 import 进来。

</details>
