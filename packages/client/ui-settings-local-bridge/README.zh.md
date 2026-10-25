---
description: "dsh web 客户端的「本地模型服务」设置页：内置反代的监听状态、Copilot 令牌年龄、小艺会话凭据年龄、刷新前置条件，以及手动刷新令牌。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-local-bridge

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-client-ui-settings-local-bridge` 是 dsh web 客户端的「本地模型服务」页。它读取 `@deepseek-ai/dsh-host-local-bridge` 提供的三条路由，展示两个内置反代：各自是否在监听、背后的桌面应用是否在运行、收割到的 Copilot 访问令牌有多旧，以及一次刷新还差哪些条件。一个需确认的动作会请求宿主刷新该令牌，页面随后持续报告这次尝试的进度，直到出现更新的令牌，并在下方显示这次尝试写下的转录。本页不写任何设置命名空间。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在同时挂载了 `@deepseek-ai/dsh-host-local-bridge` 的组合里挂载本插件；桌面端的 `web-app` bundle 两个都挂。本页注册一个 `settings.section` 条目，排在「模型」页之后 —— 它报告的路由正是那一页列出的路由。

本页对机器只读，其状态留在各自属主处：这里不写任何设置命名空间，所有事实都由宿主回答。

### 页面展示的内容

| Area | Reads |
|---|---|
| Each relay | Its loopback port, whether a connect succeeds, and — for the two relays with a desktop application behind them — whether that application is running, installed-but-stopped, or absent |
| The Copilot token | When it was harvested, that age in the active language, and whether it is past the platform's one-hour lifetime |
| The Celia session cookie | Whether it was harvested, that age in the active language, and which cookie names the harvest did not produce |
| Refresh requirements | Four checks — the interception proxy, the harvest script, the upstream proxy, and the interception certificate — each with its remedy while unmet |
| The refresh action | One confirmed gesture, its progress while the host harvests, and its outcome once the token lands |
| The refresh log | Both transcripts the last attempt wrote, each under its own heading and path, with one action that copies them together |

只有在宿主会接受时才提供该动作：Windows 上、Copilot 应用在运行、全部前置条件满足、且没有已在进行的尝试。宿主仍然返回的拒绝，会连它给出的原因一起报告。

### 读取刷新日志

没有产出令牌的刷新，原因只留在转录里 —— 脚本自己那份记录，或者进程压根没起来时 PowerShell 那一路的痕迹 —— 所以本页把它们显示在用户已经在的地方，而不是给一个路径让用户自己去读。只要一次尝试失败或被拒绝，这段折叠内容就自动展开，其余时候保持收起；内容为空的转录不会显示，被宿主截断的则会说明。

复制会把两份转录一起放上剪贴板，每一份前面带上它来自的绝对路径，这样粘贴出来的日志能自己说明是哪几个文件。浏览器拒绝复制时会如实报告，而不是当作成功。

### 拒绝原因

宿主用固定代码回答刷新请求，句子由本页挑选。没有代码的拒绝与该约定相悖，按「进程没能启动」处理。

| Code | Reported as |
|---|---|
| `unsupported-platform` | Refreshing is available on Windows only |
| `copilot-not-running` | Start the Copilot desktop app first |
| `prerequisites-missing` | A requirement above is unmet; the checklist names it |
| `busy` | A refresh is already running |
| `script-missing` | The refresh script is missing; restart the app to redeploy it |
| `spawn-failed` | The refresh process could not start |

<a id="understand-the-implementation"></a>
## 理解实现

两个决策是承重的：

- **本页观察刷新，从不等待刷新。** 刷新是宿主上一个独立的一到两分钟进程，所以只要宿主持有的锁还在，本页就显示进行中的提示，并每五秒重读一次 —— 转录也一起读 —— 直到能判断这次尝试已结束。完成与否由两个事实决定，而不是只看那把锁：锁的存活时间比取锁的进程更长，因此「锁被取得之后又收割到令牌」才算成功。没有新令牌就结束的尝试按失败报告，而不是静默当作成功。
- **线上数据在入口处校验。** 每一份响应都逐字段检查后才进入渲染，所以本构建读不懂的载荷会变成页面自己的失败态，而不是渲染出乱码。本构建不认识的「前置条件」或「拒绝」代码会被丢弃，而不是让整次读取失败 —— 版本错配不该把载荷其余部分填出的清单清空。宿主太旧、没有日志路由时，页面就不显示转录，这不算错误。

两个存储都不做合并：后一次读取会取代仍在飞行中的前一次，因此慢的应答不会覆盖更新的快照；销毁时轮询与发布同时停止。转录单独占一个存储，因为不断增长日志不该让反代事实跟着重渲染。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-host-local-bridge`](../../host/local-bridge/README.zh.md) —— 启动反代并提供这些路由的宿主插件。
- [`dsh-client-ui-settings`](../ui-settings/README.zh.md) —— 本页所占 `settings.section` 座位所属的设置域基座。
- [`dsh-client-ui-settings-models`](../ui-settings-models/README.zh.md) —— 导航中位于本页之前的页面，列出这些反代所服务的路由。

<a id="model-experience"></a>
## 模型体验

None, as the package is a browser-side settings page that reads relay status; it registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## 已知限制与延期工作 <a id="known-limitations-and-deferred-work"></a>

- **本页实际上只在 Windows 上有意义。** 两个反代与刷新链路都以 Windows 为前提；在其他平台上本页会直接说明，并收起那个动作，而不是提供一个必然被拒绝的控件。
- **刷新无法取消，也无法等待。** 宿主启动的是分离进程，所以本页只能报告「已启动」然后观察；离开设置页并不会让它停下。
- **上游代理是用户自己的。** 刷新链路经 `127.0.0.1:7890`（它配套客户端的混合端口）转发。本页会把该条件报为未满足，但无法配置成别的端口。
- **刷新锁比这次尝试活得更久。** 提示在令牌推进时清除，所以失败的尝试会被及时读成失败；在宿主锁窗口内再次操作会以 busy 被拒绝，而不是排队。
- **除转录之外没有进度。** 宿主给出的是每次尝试的原始输出，不是解析后的进度流，所以本页无法显示这次尝试走到了哪一步 —— 它显示的是脚本写下的内容。

### 开发备注

**Runtime invariant:** No companion is published. The package owns one store whose snapshots are derived from the host's route answers; its behavior is covered by the controller and component suites beside it.
