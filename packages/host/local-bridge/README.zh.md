---
description: "启动随包分发的两个本地模型反代，并提供设置页读取状态、触发令牌刷新的两条路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-local-bridge

[English](README.md) | 中文

## Summary

`@deepseek-ai/dsh-host-local-bridge` 把随桌面安装包分发的两个模型反代作为各自独立的回环监听启动：WorkBuddy 反代在 `127.0.0.1:8787`，Microsoft Copilot 反代在 `127.0.0.1:8899`。在任一开始监听之前，它会跑一次依赖预检：拉起背后的桌面应用、部署收割文件、导入拦截证书，并在 Copilot 访问令牌陈旧时刷新它。同一个插件还提供「本地模型服务」设置页读取的两条路由：一份两个反代的状态快照，以及触发 Copilot 令牌刷新的入口。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

在随包分发反代的组合里挂载本插件；桌面端的 `web-app` bundle 就是这样一个组合。反代本身由另一个插件 `@deepseek-ai/dsh-llm-local-bridge` 提供，它在 LLM 接缝上声明了 `dpv41f` 与 `slefgpt56` 两条路由；本包只负责启动这些路由要访问的进程。

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | 是否启动反代；关闭时设置页的路由依然存在 |
| `host` | `127.0.0.1` | 两个反代共用的监听地址 |
| `port` | `8787` | WorkBuddy 反代端口 |
| `backend` | `serve` | WorkBuddy 的模型通道：客户端网关、CodeBuddy CLI，或任意 OpenAI 兼容端点 |
| `cacheDir` | 系统临时目录 | 网关凭据缓存；安装目录通常不可写 |
| `copilot.enabled` | `true` | 是否启动 Copilot 反代 |
| `copilot.port` | `8899` | Copilot 反代端口 |
| `copilot.harvestDir` | `%USERPROFILE%\copilot-probe` | 收割到的令牌、请求模板与刷新转录 |
| `deps.autoStart` | `true` | 已安装但未运行的配套应用是否自动拉起 |
| `deps.autoRefreshToken` | `true` | 启动时令牌陈旧是否自动刷新 |
| `deps.bootstrap` | `true` | 启动时是否把随包的收割文件拷进收割目录 |
| `deps.autoInstallCa` | `true` | 拦截证书尚未受信任时是否自动导入 |
| `deps.autoInstallMitm` | `true` | 缺少拦截代理时是否后台执行 `pip install mitmproxy` |

单个反代启动失败只记一条 warning，另一个照常运行；两者都不会阻断宿主启动。

### The settings routes

两条路由都只在组合的连接信任闸门之下应答，且各自只接受一种方法。它们只传事实与固定代码，不传文案：刷新链路的操作提示是写给日志的中文，所以指引由浏览器查自己的字典得出。

| Route | Method | Answer |
|---|---|---|
| `/local-bridge/status` | `GET` | 一份快照：两个反代的监听与配套应用、Copilot 令牌年龄、未满足的刷新前置条件，以及当前是否有一次刷新持有锁 |
| `/local-bridge/refresh` | `POST` | 是否已启动刷新进程；未启动时给出拒绝代码 |

`POST /local-bridge/refresh` 会把 Windows 系统代理改向约一分钟，并驱动 Copilot 窗口发送一条消息。非 Windows、Copilot 未运行、前置条件未满足、已有一次刷新持锁、刷新脚本缺失，这五种情况下它都拒绝执行。

<a id="understand-the-implementation"></a>
## Understand the implementation

本插件只做编排，不实现任何反代。每个反代都是 `bridge/` 下零依赖的 Node 模块，经计算出的 URL 动态导入，打包器不会把它内联；机器上与刷新链路有关的事实全部由 `bridge/preflight.mjs` 拥有。

两个决策是承重的：

- **路由挂在一个子 fiber 上。** `webServer` 与 `connection` 写在嵌套的 `ctx.inject` 里，而不是插件自己的 `inject`。没有 web server 的组合照样启动反代；没有信任闸门的组合根本不注册路由 —— 刷新绝不能让未经鉴权的调用方碰到。
- **刷新与否在这里判断，刷新的活不在这里干。** `bridge/preflight.mjs` 导出收割探测、应用探测、证书探测与刷新触发；本包的控制面读这些事实，自行判定哪些前置条件代码未满足，绝不解析那些函数返回的操作提示文案。

真正执行刷新的是 `bridge/refresh-token.ps1`：它拉起本地拦截代理，把系统代理指向它，驱动 Copilot 窗口建立一次连接，从该连接的握手里收割访问令牌，并在 `finally` 中还原代理。一份备份文件让被强杀的那一轮在下次运行时可以补还原。

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-llm-local-bridge`](../../llm/llm-local-bridge/README.zh.md) —— 这些反代所服务的 LLM 路由。
- [`dsh-host-webserver`](../webserver/README.zh.md) —— 本插件注册路由所用的载体与索引渲染接缝。
- [`dsh-host-open-in-app`](../open-in-app/README.zh.md) —— 同类宿主插件，本插件的路由形态与信任闸门照它写。

<a id="model-experience"></a>
## Model Experience

None, as the plugin starts local processes and serves browser routes; it registers no prompt, tool schema, or Session event.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **整条刷新链路只在 Windows 上可用。** 探测、脚本、UI 自动化与证书导入全都以 Windows 为前提；路由会报出 `process.platform`，好让页面直接说明，而不是以难以排查的方式失败。
- **拦截端口是固定的。** `bridge/refresh-token.ps1` 监听 `8082`，并经 `127.0.0.1:7890`（它配套的代理客户端混合端口）转发；两者都不可配置，因为控制面探测的正是脚本使用的端口，只改一处的配置会让链路本跑不通时却报「就绪」。
- **刷新不被等待。** 宿主启动的是一个分离进程，只回报「已启动」；进度靠锁文件与收割令牌的时间戳回读。
- **`deps.autoRefreshToken` 默认开启，且其副作用不是静默的。** 它会在启动时改向系统代理约一分钟，证书导入还会弹出一次无法压制的 Windows 安全确认。
- **反代不做就绪探测。** 端口被监听并不代表背后的应用可用；上游未登录要到第一个请求才会暴露。

### Dev Note

**Runtime invariant:** No companion is published. The package owns no independent event sequence or mutable data relation: its status read derives every value from the relay runtime modules, and its routes are covered by the composition-level suite in `tests/control-routes.spec.ts`.
