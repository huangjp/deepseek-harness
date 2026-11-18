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
| `backend` | `wbcloud` | WorkBuddy 的模型通道：`wbcloud`（直连 WorkBuddy 云端，自带官方客户端的渠道头）/ `serve`（客户端网关）/ `cli`（CodeBuddy CLI）/ `openai`（任意 OpenAI 兼容端点） |
| `cacheDir` | 系统临时目录 | 网关凭据缓存；安装目录通常不可写 |
| `wbcloud.python` | 自动探测 | 运行 `bridge/workbuddy-token.py` 的解释器；留空则在 `%LOCALAPPDATA%\Programs\Python` 与 `PATH` 里找 |
| `wbcloud.harvestScript` | 随包分发 | 从客户端进程内存收割 WorkBuddy access token 的脚本；留空则用 `bridge/workbuddy-token.py` |
| `wbcloud.catalogDir` | `%USERPROFILE%\.workbuddy-ai\cache` | WorkBuddy 客户端缓存产品配置的目录；反代从那里读账号的模型清单 |
| `copilot.enabled` | `true` | 是否启动 Copilot 反代 |
| `copilot.port` | `8899` | Copilot 反代端口 |
| `copilot.harvestDir` | `%USERPROFILE%\copilot-probe` | 收割到的令牌、请求模板与刷新转录 |
| `copilot.tools.allow` | `["read", "write"]` | 交给 Copilot 通道的工具清单。chatHub 的请求里没有 `tools` 字段，工具只以提示词清单存在，模型手上就只有清单里写着的那些；给空数组则这条通道只做纯文本生成 |
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

真正执行刷新的是 `bridge/refresh-token.ps1`：它拉起本地拦截代理，把系统代理指向它，驱动 Copilot 窗口建立一次连接，从该连接的握手里收割访问令牌，并在 `finally` 中还原代理。一份备份文件让被强杀的那一轮在下次运行时可以补还原。上一次留下仍在监听的代理，只有在仍加载着当前这份收割脚本时才会被复用；比脚本更旧的进程会被停掉重起 —— mitmproxy 在监视的脚本变化时先把它卸掉，却不保证把新的装回去，于是端口仍在监听、却没有插件在收割。

### WorkBuddy 的模型目录

`wbcloud` 反代把 `model` 原样透传给 `https://www.workbuddy.ai/v2/chat/completions`，所以账号带的每个模型 id 都能用 —— 具体的那些（GPT-6 与 GPT-5.6 两族、Grok、Gemini、Kimi、GLM、MiniMax、DeepSeek、混元预览）以及客户端为用户解析的 `Auto`/`Fast`/`Balanced`/`Primary` 别名。id 是小写的；显示名不是 id，拿显示名去请求会被拒（`model [...] service info not found`）。

模型目录不由公开 HTTP 接口提供：daemon 把产品配置 spill 到本地文件，客户端从 `ACC_PRODUCT_CONFIG_PATH` 读它。反代读的是同一份文件（`wbcloud.catalogDir`，默认 `%USERPROFILE%\.workbuddy-ai\cache`），取其中最新的 `acc-product-config-v3*.json`，在 `/v1/models` 上给出文本模型 —— 于是清单跟着账号走，而不是跟着一份写死的清单走。带 `tags` 的是媒体模型与 agent 人设，不是对话模型，不计入。DSH 路由则静态声明同一份模型清单，因为 pi-ai 没有动态发现模型：`openai-completions` 传输从不调 `/v1/models`，模型选择器里能看到它们，靠的是路由的声明。

### 推理强度

云端认的是 OpenAI 的 `reasoning_effort` —— `low`、`medium`、`high`、`xhigh`、`max` —— 所以反代把请求里的这个字段转发出去；调用方没给强度时就不写这个字段，由云端按模型自己的默认档位走。请求里写了 `off` 的会被翻成云端的 `none`；字面量 `off` 会被拒（`400`，参数名 `reasoning.effort`）。云端点名了参数的拒绝，报错里就带上那个参数名 —— 账号不再提供的档位因此读起来是「云端拒了 `reasoning.effort`」，而不是一句没头没脑的「参数不合法」。

请求的输出上限跟着账号目录走（每个模型自己的 `maxOutputTokens`），而不是写死一个数。思维链和答案共用这个额度，写死的数会让高推理档位没地方写答案 —— 模型想完了、额度花光了，回来一句空。

这个上限还会按提示词实际占的位置再收一收：云端把**提示词 + 预留输出**一起算进模型的上下文窗口，所以一个自己放得下的请求，也可能因为反代预留了满额的输出而被顶出窗口。反代因此按提示词的 token 估算值，只预留剩下的位置（留一点余量），长对话才发得出去。

上游拒收输入时回 `11133` + `extError.code: 400002` + `param: input`，同一个码盖着两种原因。一种是工具配对：某条 `tool_calls` 没有对应的结果、或者某条结果找不到发起它的调用时，上游会拒掉整条请求 —— 一轮工具调用被中断、或者上一轮重试裁短过，对话里就会留下这种切片。反代每次请求都先把配对修好（只有调用没有结果的补一条说明，只有结果没有调用的去掉），于是一轮被中断不会再让之后每一步都失败。另一种是装不下：先原样重试一次，再裁短对话 —— 先留最近 8 条、再留 2 条 —— 并且只在工具调用的边界上切，切片不会以一条工具结果开头，否则又会因为上面那条配对规则被拒。

渠道头里的客户端版本与部署形态，取自**账号自己的产品配置**（缓存的 `acc-product-config-v3*.json` 里的 `genieVersion` 与 `deploymentType`）—— 官方客户端自己也是从这份配置里取这两个值的。整组头与客户端发的同形：`X-Product` 是部署形态（`SaaS`），`X-IDE-Name` 是 `WorkBuddy`，`X-Private-Data` 是 `true`，请求里还带上客户端发的 `x-requested-with`、`x-codebuddy-request`、`acp-connection-id` 与 B3 链路追踪头。写死的版本号或手写的产品名，在客户端自动更新后就和真正在跑的那个对不上，而云端的渠道校验读的正是这组头。`GET /health` 会报出当前用的版本与部署形态。

`400` + `code: 11128` 的意思是「云端此刻不接受这次调用」。实测它与请求大小、推理强度、渠道头都无关：90 字的提示词也会撞上；它总在短时间内连续调用之后出现，停几分钟又自己好了。账号本来就有频率与额度上限——云端另一条提示写得很直白："usage exceeds frequency limit … you can switch to the other models"——只是它对不同模型报的码不一样：忙的模型给 `14003`/`no_capacity`（"模型忙，请换模型或稍后重试"），其余的给 `11128`。所以这是**账号侧的限流**，不是反代少了参数。反代把能自动做的都做了：重新收割令牌、等 1.5 秒、把**同一条请求**原样重试一次 —— 它不裁对话，因为这个码与请求内容无关，裁了只会让模型丢掉正在做的事。每次被拒还会写进 `%LOCALAPPDATA%\workbuddy-bridge\channel.log`，记下这次请求的形状（模型、消息条数、提示词字符数、工具数、输出上限、推理强度、配对修复去掉和补上的条数）以及每一次尝试的消息条数与状态码，下次再遇到时就能拿它与一次成功的请求对比。`401`/`403` 走同一条重试路径 —— 令牌被轮换时正是需要它。

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
- **WorkBuddy 的令牌需要提权读取器。** WorkBuddy 5.9.4 会把自己重新以提权方式启动，于是它进程树里的每个进程都是高完整性级别，中完整性的读取器对它调用 `OpenProcess(PROCESS_VM_READ)` 会被拒绝。`bridge/workbuddy-token.py` 因此把收割到的令牌缓存到 `%LOCALAPPDATA%\workbuddy-bridge\token.json`，并在自己的扫描被拒时通过常规的同意提示重启一份提权副本；提权副本负责缓存令牌，原进程再把它读回来。所以提示只在缓存令牌过期时出现，不是每次调用都出现；用户拒绝提示的部署仍然得到原来的「找不到访问令牌」错误。
- **拦截端口是固定的。** `bridge/refresh-token.ps1` 监听 `8082`，并经 `127.0.0.1:7890`（它配套的代理客户端混合端口）转发；两者都不可配置，因为控制面探测的正是脚本使用的端口，只改一处的配置会让链路本跑不通时却报「就绪」。
- **触发方不等待刷新。** 宿主启动的是一个分离进程，只回报「已启动」。需要结果的那一方 —— 反代在放行请求之前 —— 靠轮询收割令牌的时间戳把它读回来，并有一个期限；设置页显示的进度则来自锁文件与同一个时间戳。
- **刷新令牌期间会接管整台机器的系统代理，所以它是显式开关。** `refresh-token.ps1` 直接写 `ProxyEnable`/`ProxyServer` 注册表项，等于把这项设置从用户平时用的代理客户端手里夺过来；客户端随后若重新接管或停掉自己的内核，系统代理就会指向一个没人监听的端口，于是所有节点全部超时。因此 `deps.autoRefreshToken` 与 `deps.autoRefreshWhileRunning` **都默认关闭**，平时用设置页的「刷新令牌」按钮发起。打开任一项都会驱动 Copilot 窗口发送一条消息。
- **反代不做就绪探测。** 端口被监听并不代表背后的应用可用；上游未登录要到第一个请求才会暴露。
- **工具调用取决于能否认出模型输出的形态。** 桥接渲染出工具清单，并接受三种回法：它要求的 `bridge_tool_calls` JSON、可修复的变体、以及模型自带的 DSML 标记族。模型若发明第四种形态，出来的就是一段文字而不是调用。工具调用也是整份到达而不是流式片段，因为必须先看到完整载荷才能解析。
- **Copilot 的 chatHub 通道根本承载不了工具调用。** 它的请求里没有 `tools` 字段，工具只以提示词清单存在；而另一端的模型是按 chatHub 给它的那套**服务端 agent 人设**回答的：它自己去找文件、报 `FILE_NOT_FOUND`、或者宣称自己在 `/mnt/data/...` 建了文件 —— 从不吐我们的 JSON。对着真实存在的文件实测：27 个工具与 2 个工具各跑 8 次，工具调用都是 0；换三种提示措辞（包括一种把格式写死、明确禁止它假装找文件的）也毫无变化。人设之所以压得住，是因为我们的说明是以**用户消息**身份到达的：请求里没有 system prompt 字段（`plugins` 是内置的 Bing 搜索，`options` 与 `extraExtensionParameters` 都是空的）。所以这条通道是纯文本通道 —— 用它出正文，任何要落盘的活交给有原生 function calling 的通道。

- **Copilot 通道的文本协议不稳，而清单大小不是原因。** chatHub 的请求里没有 `tools` 字段，工具只以提示词清单存在，模型得自己把 JSON 写出来。现在提示词里列出真实工具名、并说明 `bridge_tool_calls` 是 JSON 的键名而不是工具名；请求最多问三轮，每轮把对应的提醒追加进去，而不是只重试一次。这两处都**不能**让这条通道变得可用 —— 原因见上一条。这条通道还与已安装的实例共用同一条采集到的会话，两个反代指向同一账号会互相抢。

### 开发备注

**Runtime invariant:** No companion is published. The package owns no independent event sequence or mutable data relation: its status read derives every value from the relay runtime modules, and its routes are covered by the composition-level suite in `tests/control-routes.spec.ts`.
