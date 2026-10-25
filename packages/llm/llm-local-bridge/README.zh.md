---
description: "DeepSeek Harness 桌面版内置的本地反代 LLM provider：三个固定、不可删除的路由，分别指向随包分发的 WorkBuddy、Copilot 与小艺反代。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-local-bridge

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-local-bridge` 把随 DeepSeek Harness 桌面安装包一起分发的三个本地模型反代注册为**固定的内置 LLM 路由**：`dpv41f`（WorkBuddy 反代，`127.0.0.1:8787`）、`slefgpt56`（Microsoft Copilot 反代，`127.0.0.1:8899`）与 `hwcelia`（华为小艺反代，`127.0.0.1:8123`）。三者都以代码声明，用与 `dsh-llm-deepseek` 注册 `deepseek-official` 相同的方式挂到 LLM 服务上，因此每次启动都在，全新安装的机器也无需任何配置步骤。

它们刻意**不放在**用户可编辑的 `llm-pi-ai` 设置命名空间：该处的 patch 条目会替换整行 `config`，用户只要在「设置 → 模型」页配过任何自定义 provider，内置反代就会被一并抹掉。用固定路由（`ctx.llm.registerAdapter`）注册则完全绕开该命名空间。

它们同时**会显示在同一个「设置 → 模型」页上，但不带删除按钮**：让路由在该页可见的是 `registerConfigurableProviders`，而让它拿不到删除按钮的是**空的** `settingsPath` —— 与 `deepseek-official` 不可删除的机制完全相同。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在会提供这些内置本地反代的组合里挂载本插件 —— 桌面版的 `web-app` bundle 就是那个组合。请求用 `GenerateOptions.provider` 选择路由：

| 路由 | 端点 | 模型 |
| --- | --- | --- |
| `dpv41f` | `http://127.0.0.1:8787/v1` | `deepseek-v4.1-flash`、`gpt-4o`、`gpt-3.5-turbo`、`default` |
| `slefgpt56` | `http://127.0.0.1:8899/v1` | `copilot`、`m365-copilot` |
| `hwcelia` | `http://127.0.0.1:8123/v1` | `xiaoyi-chat`、`xiaoyi` |

反代本身由独立的 `@deepseek-ai/dsh-host-local-bridge` 宿主插件启动；本包只声明路由，所以组合可以只挂其中一个（此时对应路由没有监听方）。

无需任何凭据。每个 profile 都带上该跳的 `authorization: Bearer local-bridge` 头，反代把它当作占位值接受，因此 `resolveApiKey` 有意不解析、直接返回 `undefined`。若在此处改写 `apiKeyEnv`，在没有该环境变量的机器上会在解析阶段以 `MISSING_CREDENTIAL` 失败。

只有 WorkBuddy 路由声明了 `input: [text, image]`。不声明的模型会被视为纯文本，宿主在发送前就以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拦下附图（提示「当前模型不支持图片」）。Copilot 路由声明 `text`，因为它的 SignalR `chatHub` 帧只有一个纯文本提示字段，没有附件字段。小艺路由同理：上游是一来一往的文本 WebSocket 帧。给它们声明图片支持只会把失败推到上游，而附图那时已经记进会话了。

<a id="understand-the-implementation"></a>
## 理解实现

本插件用 `dsh-llm-pi-ai` 包构造一个 `PiAiAdapter`，并在挂载时交给 `ctx.llm.registerAdapter(['dpv41f', 'slefgpt56', 'hwcelia'], adapter)`。正是这一句让路由成为**内置**：路由名由 LLM 注册表持有，所以无论设置文档如何，请求都能解析到它们。`PiAiAdapter` 提供 `providerInfo`/`listModels`，这就是三条路由仍带着目录出现在模型选择器里的原因。

有两个决定性设计：

- **目录条目的 `settingsPath` 为空。** 把路由放进「设置 → 模型」页目录的正是 `registerConfigurableProviders`，所以它被调用了 —— 否则这三条路由在该页完全不可见。而在那一页，可见与可删是两个独立事实：只有当**用户层**存在一条**非空**路径时才会判定 `removable`，因此空路径恰好就是拿掉删除按钮的原因 —— `deepseek-official` 不可删除也是同一机制。
- **profile 只在挂载时解析一次。** `resolveProfiles` 把固定配置校验并补齐默认值，得到一个 `Map`，adapter 的 `profiles` 钩子原样返回。这里没有设置节需要监听，所以也不需要重新注册路径 —— 路由不会漂移。

导出的 `Config` 存在的唯一目的，是让宿主设置服务有一个命名空间可供这些行锚定：没有 `Config` 时 `settings.describe` 根本不投影任何命名空间，「设置 → 模型」页会在渲染前把这些条目丢掉。它唯一的 `routes` 字段本插件从不读取；该页的定制编辑器也不认识这个命名空间（只渲染通用提示，Apply 按钮禁用），而 `configure({ auto: false })` 让「插件」设置分区不为它生成页面。

由于这些路由不声明任何凭据引用，`providerUsable` 会在无需密钥的情况下判定它们可用，因此它们不会退化成首启时的 API Key 设置卡片 —— 包括在这两条路由是机器上唯一 provider 的全新安装场景。

adapter 拿到的是 `llm-pi-ai` 所用的同一套 auth 与附件接入点（`credentialStoreFrom`、`authContextFrom`，以及经 `ctx.attachments` 的 `resolveImageAttachmentAccess`），因此图片卸载与持久化附件引用的行为与其他路由一致。

<a id="further-exploration"></a>
## 延伸探索

- [`dsh-host-webserver`](../../host/webserver/README.zh.md) —— 桌面 bundle 所组合的宿主层；反代宿主插件在 `web-app` bundle 的 insert 段里与它并列。
- [`dsh-llm-pi-ai`(../llm-pi-ai/README.zh.md —— 由设置驱动的多 provider 适配器；本包复用了它的 adapter 与 profile 解析。
- [`dsh-llm-deepseek`(../llm-deepseek/README.zh.md —— 内置路由 `deepseek-official`，其固定注册模式正是本包遵循的样板。

<a id="model-experience"></a>
## 模型体验

### 经内置路由发出的反代请求

#### 模型看到什么

被选中的反代模型收到的请求，与任何 pi-ai 路由下 `PiAiAdapter` 构造的请求相同：一条系统提示（`GenerateOptions.system`，否则取历史中首条 `system` 消息的文本）、其余历史、工具，以及 pi-ai 通用流式 API 支持的采样字段。每张保留的图片前面都有文本，写明其完整 attachment id 与实际请求尺寸；当执行期文件系统映射了附件提供者的宿主对象时，还会附上只读的规范化对象路径，并提示规范化或请求投影可能已对上传做过缩放或重编码。请求带上该路由的 `authorization: Bearer local-bridge` 头与 Harness 归因头；`attributionHeaders()` 只保留 `user-agent`，所以 authorization 头原样通过。提供方原生的回放元数据只在适配器判定其适用于历史内容时才恢复。

#### Token 影响

精确的输入由反代自身的分词决定，而不是由宿主决定。保留的图片会加上稳定的附件与坐标描述符；图片卸载占位符则替换掉被省略图片的视觉 token。由于目录是声明而非探测得到的，声明的上下文窗口与输出上限就是profile 的配置值（默认 262,144 与 32,768），反代可以与之不同。

#### KV 缓存影响

转换保持逻辑请求顺序，而图片句柄与卸载占位符会增加模型可见文本。执行期路径变化会改写历史句柄，即使附件身份与请求字节都稳定，也可能让该图片之前的复用失效。更换 provider、模型或任何上游 token 都有同样的后缀效应；一次卸载决定会把更早的图片变成占位文本，因此复用止于该消息，之后前缀保持稳定。

## 已知限制与后续工作 <a id="known-limitations-and-deferred-work"></a>

- 端点编译在代码里。把反代跑在其他端口、或反代需要真实鉴权的部署，需要改代码而不是改设置。
- `slefgpt56` 与 `hwcelia` 的目录只声明 `text`。Copilot 反代的 SignalR `chatHub` 帧没有附件字段，小艺反代的 WebSocket 帧是一来一往的纯文本，所以走这两条路由的附图会由反代以明确的 `400 images_unsupported` 拒绝，而不是被静默丢弃。声明 `text` 则是请求发出前就拒掉附图。
- 声明某个模型 id 并不证明反代会服务它：启动时不做可用性探测。请求一个未开放的 id 会在反代处失败。
- **工具调用是模拟的，不是原生的。** 两个上游都不提供 function calling，所以反代把工具清单渲染进提示词，再把模型的回复解析回 `tool_calls`；不遵守该格式的模型只会回一段文字而不是调用，而且调用是整份到达、不是流式片段。两条路由仍然照常接受 `tools`、并像其它路由一样回 `finish_reason: "tool_calls"`。

### 开发备注

未发布运行时不变性伴随文档，因为本包不产生任何偏离的运行时观察：它贡献的两条固定路由，其行为已由它所委托的 `PiAiAdapter` 契约完整描述。