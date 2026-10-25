---
description: "启动随包分发的三个本地模型反代，并提供设置页读取状态、触发令牌刷新的两条路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-local-bridge

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-host-local-bridge` 把随桌面安装包分发的三个模型反代作为各自独立的回环监听启动：WorkBuddy 反代在 `127.0.0.1:8787`，Microsoft Copilot 反代在 `127.0.0.1:8899`，华为小艺反代在 `127.0.0.1:8123`。在任一开始监听之前，它会跑一次依赖预检：拉起背后的桌面应用、部署收割文件、导入拦截证书，并在 Copilot 访问令牌陈旧时刷新它。同一个插件还提供「本地模型服务」设置页读取的路由：一份两个反代的状态快照、触发 Copilot 令牌刷新的入口，以及那次刷新写下的两份转录的末尾内容。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

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
| `xiaoyi.enabled` | `false` | 是否启动华为小艺反代。默认关：它需要华为「AI空间」应用开着对话页 |
| `xiaoyi.port` | `8123` | 小艺反代端口 |
| `xiaoyi.python` | 自动探测 | 运行 `bridge/xiaoyi-harvest.py` 的解释器；留空则在 `%LOCALAPPDATA%\Programs\Python` 与 `PATH` 里找 |
| `xiaoyi.cacheFile` | `%LOCALAPPDATA%\xiaoyi-bridge\auth.json` | 小艺凭证缓存，上游拒绝时会自动重新收割 |
| `deps.autoStart` | `true` | 已安装但未运行的配套应用是否自动拉起 |
| `deps.autoRefreshToken` | `false` | 启动时令牌陈旧是否自动刷新。默认关：脚本会**直接改写系统代理注册表**约一分钟，绕开用户自己的代理客户端，把它"系统代理归谁管"的状态弄乱 |
| `deps.autoRefreshWhileRunning` | `false` | 是否允许反代在**运行期间**换掉陈旧令牌。默认关：一次刷新会把整台机器的系统代理指向拦截代理约一分钟，期间任何其它出境流量（包括另一个反代）都会失败 |
| `deps.bootstrap` | `true` | 启动时是否把随包的收割文件拷进收割目录 |
| `deps.autoInstallCa` | `true` | 拦截证书尚未受信任时是否自动导入 |
| `deps.autoInstallMitm` | `true` | 缺少拦截代理时是否后台执行 `pip install mitmproxy` |

单个反代启动失败只记一条 warning，另一个照常运行；两者都不会阻断宿主启动。

### 应用运行期间的刷新

访问令牌约一小时过期，而换一份令牌就是重写每个请求都在读的那个文件，所以这两件事必须分开：

- **在途请求绝不被中断。** Copilot 反代数着当前持有令牌的请求数，只要它不为零就不开始刷新。这个窗口里到达的请求直接用正在用的那份令牌，而不是排在邻居后面干等。
- **刷新期间绝不放行。** 一旦刷新开始，在新令牌落盘之前到达的请求会等它，而不是去读一份正在被替换的文件。等待有上限；等不到更新的令牌就让请求带现有令牌继续，并把这次尝试记进日志。

触发依据是令牌自己的年龄，从收割文件里读：一个请求若将带着超过 45 分钟的令牌出门，就先把令牌换掉；一轮请求的最后一个在离开时做同样的事，下一个请求因此不必再等。没有空闲定时器 —— 没人在用反代时刷新，只会白白改系统代理、白驱动一次 Copilot 窗口。失败的尝试一分钟内不重试，因为挡住它的原因（Copilot 没开、前置条件不齐）不会在几秒内消失。

这些规则归反代所有，因为只有它知道什么正在途；宿主只交出触发能力，所以自动刷新与设置页的按钮走同一把锁，不会同时跑起来。

### 设置页路由

每条路由都只在组合的连接信任闸门之下应答，且各自只接受一种方法。它们只传事实与固定代码，不传文案：刷新链路的操作提示是写给日志的中文，所以指引由浏览器查自己的字典得出。

| Route | Method | Answer |
|---|---|---|
| `/local-bridge/status` | `GET` | 一份快照：三个反代的监听、WorkBuddy 与 Copilot 的配套应用、Copilot 令牌年龄、小艺会话凭据年龄、未满足的刷新前置条件，以及当前是否有一次刷新持有锁 |
| `/local-bridge/refresh` | `POST` | 是否已启动刷新进程；未启动时给出拒绝代码 |
| `/local-bridge/log` | `GET` | 上一次尝试写下的两份转录的末尾一段，各自带绝对路径，以及文件是否还有更多内容 |

`POST /local-bridge/refresh` 会把 Windows 系统代理改向约一分钟，并驱动 Copilot 窗口发送一条消息。非 Windows、Copilot 未运行、前置条件未满足、已有一次刷新持锁、刷新脚本缺失，这五种情况下它都拒绝执行。

每份转录都截取末尾 16 KiB：`refresh-token.ps1` 每次尝试都会重写转录，而 PowerShell 那一路的痕迹会一直追加到同一个文件，所以这个上限决定了长期使用的收割目录不会整个被送到浏览器。从文件中间开始读时会丢掉开头那半行，截断落在字符中间时解出的文本仍然是合法的。

两个转录文件名归 `bridge/preflight.mjs` 所有（`REFRESH_LOG_FILES`）：写它们的是那个模块，所以由它命名，控制面读这个名字而不是自己猜。

<a id="understand-the-implementation"></a>
## 理解实现

本插件只做编排，不实现任何反代。每个反代都是 `bridge/` 下零依赖的 Node 模块，经计算出的 URL 动态导入，打包器不会把它内联；机器上与刷新链路有关的事实全部由 `bridge/preflight.mjs` 拥有。

两个决策是承重的：

- **路由挂在一个子 fiber 上。** `webServer` 与 `connection` 写在嵌套的 `ctx.inject` 里，而不是插件自己的 `inject`。没有 web server 的组合照样启动反代；没有信任闸门的组合根本不注册路由 —— 刷新绝不能让未经鉴权的调用方碰到。
- **刷新与否在这里判断，刷新的活不在这里干。** `bridge/preflight.mjs` 导出收割探测、应用探测、证书探测与刷新触发；本包的控制面读这些事实，自行判定哪些前置条件代码未满足，绝不解析那些函数返回的操作提示文案。

真正执行刷新的是 `bridge/refresh-token.ps1`：它拉起本地拦截代理，把系统代理指向它，驱动 Copilot 窗口建立一次连接，从该连接的握手里收割访问令牌，并在 `finally` 中还原代理。一份备份文件让被强杀的那一轮在下次运行时可以补还原。

### 纯文本上游上的工具调用

两个上游都不提供 function calling。WorkBuddy 网关背后是一个自带工具白名单的 agent，它无视调用方给的 tools —— 让它去调一个，它会伸手去够自己的那套然后报错；Copilot 的 `chatHub` 帧只承载一条纯文本 prompt，根本没有工具字段。所以两个反代都用同一份模块（`bridge/toolprompt.mjs`）把工具调用搭在文本上：

1. 请求里的 `tools` 被渲染进提示词：一份清单，外加一种意图格式 —— 模型回答 `{"bridge_tool_calls":[{"name":…,"arguments":{…}}]}`。
2. 回复再被解析回 OpenAI 的 `tool_calls`，`finish_reason: "tool_calls"`。非法 JSON 会被修复（括号不配对、尾逗号、参数误放到 wrapper 层）并带修复提示重试一次；重试后仍像调用却解析不出来的，变成一条明确的错误，而不是冒充最终回答 —— 下游 agent 会把它当成"任务已完成"。
3. 训练时自带调用标记的模型可能无视这套约定，直接吐它学过的格式 —— 实践中见到的是 DeepSeek 的 `<｜DSML｜tool_calls>` 那一族。它的 `invoke` / `parameter` 块会被同样还原，否则整段标记会被当成正文流给用户、工具一次都不执行。分隔符按宽松规则匹配：中途转一层会把全角竖线变成半角或叠成两个，缺闭合标签也照样解析。
4. 之后的提示词里会回放此前的工具轮次：助手表达过的意图连同参数，每条结果用**成对的开始/结束标记**包住并带上它的 `tool_call_id`。多行结果必须这样框起来 —— 工具输出本身可能读起来像对话，不框就会混进回答里。

两个反代不同的只有"提示词怎么送到上游"，所以它们仍是各自独立的模块。Copilot 反代保留普通回答的流式：开头看起来像工具调用的回复先扣住，等能判定再说，其余照常边到边发。WorkBuddy 反代在带工具时整段缓冲，因为它的上游本来就不流式。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-llm-local-bridge`](../../llm/llm-local-bridge/README.zh.md) —— 这些反代所服务的 LLM 路由。
- [`dsh-host-webserver`](../webserver/README.zh.md) —— 本插件注册路由所用的载体与索引渲染接缝。
- [`dsh-host-open-in-app`](../open-in-app/README.zh.md) —— 同类宿主插件，本插件的路由形态与信任闸门照它写。

<a id="model-experience"></a>
## 模型体验

None, as the plugin starts local processes and serves browser routes; it registers no prompt, tool schema, or Session event.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## 已知限制与延期工作 <a id="known-limitations-and-deferred-work"></a>

- **整条刷新链路只在 Windows 上可用。** 探测、脚本、UI 自动化与证书导入全都以 Windows 为前提；路由会报出 `process.platform`，好让页面直接说明，而不是以难以排查的方式失败。
- **拦截端口是固定的。** `bridge/refresh-token.ps1` 监听 `8082`，并经 `127.0.0.1:7890`（它配套的代理客户端混合端口）转发；两者都不可配置，因为控制面探测的正是脚本使用的端口，只改一处的配置会让链路本跑不通时却报「就绪」。
- **触发方不等待刷新。** 宿主启动的是一个分离进程，只回报「已启动」。需要结果的那一方 —— 反代在放行请求之前 —— 靠轮询收割令牌的时间戳把它读回来，并有一个期限；设置页显示的进度则来自锁文件与同一个时间戳。
- **刷新令牌期间会接管整台机器的系统代理，所以它是显式开关。** `refresh-token.ps1` 直接写 `ProxyEnable`/`ProxyServer` 注册表项，等于把这项设置从用户平时用的代理客户端手里夺过来；客户端随后若重新接管或停掉自己的内核，系统代理就会指向一个没人监听的端口，于是所有节点全部超时。因此 `deps.autoRefreshToken` 与 `deps.autoRefreshWhileRunning` **都默认关闭**，平时用设置页的「刷新令牌」按钮发起。打开任一项都会驱动 Copilot 窗口发送一条消息。
- **反代不做就绪探测。** 端口被监听并不代表背后的应用可用；上游未登录要到第一个请求才会暴露。
- **工具调用取决于能否认出模型输出的形态。** 桥接渲染出工具清单，并接受三种回法：它要求的 `bridge_tool_calls` JSON、可修复的变体、以及模型自带的 DSML 标记族。模型若发明第四种形态，出来的就是一段文字而不是调用。工具调用也是整份到达而不是流式片段，因为必须先看到完整载荷才能解析。

### 开发备注

**Runtime invariant:** No companion is published. The package owns no independent event sequence or mutable data relation: its status read derives every value from the relay runtime modules, and its routes are covered by the composition-level suite in `tests/control-routes.spec.ts`.
