# Microsoft Copilot 桌面版 — 协议逆向笔记

> 采集时间：2026-10-12
> 采集方式：mitmproxy 12.2.3 插入系统代理链（8082 → FlClash 7890）
> 应用版本：Copilot 155.0.4283.45（Edge/WebView2 内核 154.0.4258.62）

## 1. 应用本质

`copilotapp.exe` 不是独立应用，是 **Edge/WebView2 换壳**：

- 用户数据目录布局 = Chromium（`Local State` / `Cookies` / `Network` / `Local Storage`）
- 渲染进程命令行带 `--top-chrome-webui --edge-skip-compat-layer-relaunch`
- 业务逻辑**全部在远端加载的 JS 里**，本地二进制搜不到任何 `/api/` 业务路径

主界面来自 SSR 页面：

```
GET https://cr.m365copilotapp.svc.cloud.microsoft/hwav2/chat
    ?version=155.0.4283.45&client-request-id=<uuid>
    &M365ChatFeatures=enableCaptionButtonSizeToken&SSRDesktopTest=2
    &isSignedOut=false&...
→  200 text/html  约 393 KB
```

静态资源（CSS/JS）来自公开 CDN，**无需认证即可下载**：

```
https://res.public.onecdn.static.microsoft/midgard/versionless-v2/<file>
```

关键 bundle：
- `route-shared.chatproviders.*.chunk.js` — 会话提供者
- `m365chat-response-state.shared.*.chunk.js` — 消息/轮次状态机
- `m365chat-compose-ciq.shared.*.chunk.js` — 输入框与实体注解
- `route-shared-chat-setup.*.chunk.js` — 环境与端点选择

## 2. 认证链

```
POST https://login.live.com/RST2.srf
     Content-Type: application/soap+xml
→    200  ~18–21 KB SOAP/WS-Trust 响应
```

由此得到两类令牌：

| 令牌 | 用途 | 形态 |
|---|---|---|
| `Authorization: Bearer <JWE>` | 调用 `cr.m365copilotapp.svc.cloud.microsoft` | JWE，`RSA-OAEP` + `A128CBC-HS256` |
| `access_token=<JWE>` | **WebSocket 对话**，放在 URL query 里 | JWE，`dir` + `A256CBC-HS512` |

JS 里还提到第三个：`substrateSearchToken`（搜索专用）。

## 3. 端点清单（实测）

```
GET  substrate.office.com/search/api/v2/init?scenario=Harmony.Win32.Copilot_Peek&cvid=<uuid>
POST substrate.office.com/search/api/v1/userconfig
POST substrate.office.com/search/api/v1/suggestions?setflight=...
GET  substrate.office.com/m365Copilot/UsageStatus?scenario=OfficeWebFreeConsumerCopilot&product=windows
POST substrate.office.com/m365Copilot/EventListener/Client?EventId=ExecuteAction&variants=...
POST cr.m365copilotapp.svc.cloud.microsoft/chat/api/ic3proxy
POST cr.m365copilotapp.svc.cloud.microsoft/events?SSRDesktopTest=2
POST cr.m365copilotapp.svc.cloud.microsoft/resources/app-shell-action
GET  cr.m365copilotapp.svc.cloud.microsoft/hwav2/chat
```

环境选点（JS 内硬编码）：

```js
case 'dod':      'https://substrate-dod.office365.us'
case 'gcc-high': 'https://substrate.office365.us'
default:         'https://substrate.office.com'
```

## 4. 对话通道 = WebSocket + SignalR + Sydney chatHub

### 4.1 连接 URL

```
wss://substrate.office.com/m365Copilot/Chathub/
    00000000-0000-0000-<userid>@84df9e7f-e9f6-40af-b435-aaaaaaaaaaaa
    ?chatsessionid=<hex32>
    &XRoutingParameterSessionKey=00000000-0000-0000-<userid>
    &clientrequestid=<hex32>
    &X-SessionId=<uuid>
    &ConversationId=<uuid>
    &access_token=<JWE>
    &variants=<逗号分隔的特性开关，数百个>
    &source=%22officedesktop%22
    &product=Office
    &agentHost=Bizchat.FullScreen
    &licenseType=Free
    &isEdu=false
    &agent=web
    &scenario=OfficeWebFreeConsumerCopilot
→  101 Switching Protocols
```

JS 中依据 agent 选择传输：

```js
transportHint: agentIsStreamHubEligible ? 'chathub' : 'streamhub'
```

（另有 `streamhub` 通道，未在本次抓包中出现。）

### 4.2 帧序列（实测 28 帧）

**握手**

```
C→S  {"protocol":"json","version":1}
S→C  {}
C→S  {"type":6}                      ← 保活
```

**发起一轮对话**

```
C→S  {"arguments":[ { ...请求体... } ],"target":"chat","type":1}
```

请求体关键字段（实测）：

```json
{
  "source": "officedesktop",
  "clientCorrelationId": "<hex32>",
  "sessionId": "<uuid>",
  "optionsSets": [ "search_result_progress_messages_with_search_queries",
                   "update_textdoc_response_after_streaming",
                   "cwc_flux_v3", "flux_v3_references", ... 数百项 ],
  ...
}
```

**流式返回**（多次，`target` 恒为 `update`）

```json
{"type":1,"target":"update","arguments":[{
   "writeAtCursor": "<增量文本>",      // ← 真正的 token 流
   "references": {},
   "nonce": "<base64>"
}]}
```

```json
{"type":1,"target":"update","arguments":[{
   "messages":[{
      "text": "<累计全文>",
      "author": "bot",
      "messageId": "<uuid>",
      "requestId": "<hex32>",
      "adaptiveCards": [{"type":"AdaptiveCard","version":"1.0",
                         "body":[{"type":"TextBlock","text":"<全文>","wrap":true}]}],
      "sourceAttributions": [],
      "contentOrigin": "DeepLeo",       // ← 模型/来源标识
      "spokenText": "<语音用全文>",
      "scores": [{"component":"BotOffense","score":1.36e-13}]
   }],
   "nonce": "<base64>",
   "conversationId": "<uuid>",
   "requestId": "<hex32>"
}]}
```

**结束标记**

```json
{"type":1,"target":"update","arguments":[{
   "messages":[ ... "isLastUpdate": true ... ],
   "nonce": "...", "isLastUpdate": true, "requestId": "..."
}]}
```

**调用完成**

```
S→C  {"type":2,"invocationId":"0","item":{ ...完整轮次... }}
S→C  {"type":3,"invocationId":"0"}
```

**成功后客户端回报指标**

```
C→S  {"arguments":[{ "Timestamps": {...}, "RenderedChunkMetrics": {...},
                     "ReceivedTokenMetrics": {...} }],
      "target":"Metrics","type":1}
```

### 4.3 流式增量语义

- 首个 `writeAtCursor` 之前会先来一条 `contentOrigin: "EarlyProgress"` 的进度消息
- `writeAtCursor` 是**增量**，需要自行拼接
- `messages[].text` 是**累计全文**，可用于校对
- 出现 `isLastUpdate: true` 即本轮结束

## 5. 复刻成 OpenAI 兼容反代需要什么

| 环节 | 状态 | 说明 |
|---|---|---|
| 对话协议 | ✅ 已完全掌握 | SignalR JSON + chatHub，帧格式见上 |
| 端点与参数 | ✅ 已掌握 | URL、query 参数、`variants` 列表可直接照抄 |
| 流式映射 | ✅ 清晰 | `writeAtCursor` → OpenAI `delta.content` |
| **`access_token` 获取** | ❌ **未解决** | 见下 |
| 令牌续期 | ❌ 未解决 | JWE 有有效期，需周期性重取 |

### 唯一卡点：`access_token` 从哪来

该 JWE 直接出现在 WS 的 query 里，但**尚未定位签发它的端点**。
`sydneyClient`（负责建连与取令牌）的代码不在已下载的 chunk 中，需继续扒 CDN 上的 sydney 相关 chunk，或对应用做一次「取令牌端点」的定向抓包。

候选思路：
1. 从 JS 里定位 sydneyClient 的令牌提供者（`tokenProvider` / `sydneyToken`）
2. 定向抓包 `cr.m365copilotapp.svc.cloud.microsoft` 上与 token 有关的响应
3. 长期旁路嗅探（把 WS URL 里的 token 捞出来复用）—— 能跑通但工程上不优雅

## 6. 可行性结论

**技术上可做，但属于「有状态长连接私有协议」范畴**，与 WorkBuddy 那种「本地无状态 HTTP + 进程环境块明文口令」不是一个量级。

主要风险：
- 协议随客户端版本变动（`variants` / `optionsSets` 每次会话都在变）
- 令牌为加密 JWE，无法自签，只能转发
- 微软对非官方客户端调用有风控与计量（`meteringAllowances` / `throttlingState` / `UsageStatus`）

---

## 7. 实现记录（copilot-bridge.mjs）

已实现并端到端验证通过。以下是**实测踩出来**的关键约束，改代码前务必先读。

### 7.1 令牌获取：只剩抓包一条路

四种「不依赖抓包」的方案全部实测封死：

| 路线 | 实测结果 |
|---|---|
| OAuth 设备码流程 | `AADSTS70002`：client `c0ab8ce9-e9a0-42e7-b064-33d422df41f1` 非 mobile，不支持 |
| CDP 注入页面 | `--remote-debugging-port` / `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 均不生效，无 `DevToolsActivePort` |
| 离线解密 MSAL 缓存 | 缓存项为 `{"id","nonce","data"}`，密钥是不可导出 WebCrypto key，仅页面自身能解 |
| 扫进程内存 | 令牌只以 V8 ConsString 形式存在，UTF-8/UTF-16 连续字节扫描均无命中 |

因此采用 **mitmproxy 收割**：`token-harvester.py` 从 Chathub 握手 URL 里取出
`access_token` 与全部建连参数，同时抓下客户端首条 `target=chat` 帧作为请求模板，
原子写入 `%USERPROFILE%\copilot-probe\token.json`。

MSAL 缓存里确认的令牌谱系（供参考）：

```
clientId : c0ab8ce9-e9a0-42e7-b064-33d422df41f1
scope    : https://substrate.office.com/sydney/v2/.default   ← WS 用的就是这个
           https://ic3-consumers.teams.office.com/.default
           https://arc.msn.com/v4/.default
```

### 7.2 五个必须遵守的协议约束

1. **`\x1e` 是 SignalR JSON 的记录分隔符**
   每条消息（含握手）都必须以 `0x1E` 结尾；一个 WS 帧里可能含多条记录，
   必须按 `\x1e` 切开逐条 `JSON.parse`。

2. **必须先完成握手才能发 invocation**
   顺序是 `{"protocol":"json","version":1}\x1e` → 服务端回 `{}\x1e` → 才能发 chat。
   抢跑（在 `open` 里一起发）会让服务端**完全不回帧**，表现就是挂到超时。

3. **`Chat` 是流式方法，必须用 `type: 4`（StreamInvocation）**
   用 `type: 1` 会被明确拒绝：
   `The client attempted to invoke the streaming 'Chat' method with a non-streaming invocation.`
   请求模板里本来就是 `type: 4`，**照抄模板，不要覆盖**。

4. **每次连接必须换一组全新的会话标识**
   `chatsessionid` / `clientrequestid` / `X-SessionId` / `ConversationId` 四个都要新生成。
   复用同一个 `chatsessionid` 连续建连时，服务端会拒掉后一条
   （要么 101 升级被拒，要么升级成功但不回帧）。

5. **服务端有关闭冷却，约 10 秒**
   一条 Chathub 连接关闭后紧接着新建会被拒（`non-101`）。
   桥里做了退避重试（1s→2s→4s→8s，最多 5 次），**只在还没吐出任何内容时重试**，
   避免重复输出。

### 7.3 流式合并算法

服务端同时给两种形态：

- `writeAtCursor` —— **真实增量**，收到即可下发
- `messages[].text` —— **累计全文**，只在它是已下发文本的严格前向扩展时补齐差额

服务端有时会做光标重排式的改写，导致累计全文不再是前向扩展。
这时**必须忽略**，否则会出现 `2, 3, 4, 5.` 之后又吐一遍 `3, 4, 5.` 的重复。

另外 `contentType: "EarlyProgress"` / `messageType: "Progress"` 是
"正在检查…"这类 UI 进度提示，**不是回答正文，必须过滤**。

### 7.4 文件清单

| 文件 | 作用 |
|---|---|
| `copilot-bridge.mjs` | 反代主体：`/v1/chat/completions`（流式+非流式）、`/v1/models`、`/health`、`/` 测试页 |
| `copilot.config.json` | 监听端口、收割目录、超时与重试 |
| `token-harvester.py` | mitmproxy 插件：收割令牌 + 请求模板 |
| `refresh-token.ps1` | 一键刷新令牌：临时切代理 → UI 自动化触发建连 → 等收割 → 还原代理 |
| `probe_ws.mjs` | 逐帧探针，排查协议问题时用 |
| `test_bridge.mjs` | 端到端验收（流式 ×3、中文、非流式、错误映射） |
| `test_parse.mjs` | 用真实抓包帧离线验证增量合并算法 |

### 7.5 使用

```powershell
# 1. 首次或令牌过期后刷新（Copilot 桌面端需在运行）
powershell -ExecutionPolicy Bypass -File refresh-token.ps1

# 2. 起反代
node copilot-bridge.mjs
#    OpenAI Base URL : http://127.0.0.1:8899/v1
#    浏览器测试页     : http://127.0.0.1:8899/

# 3. 验收
node test_bridge.mjs
```

### 7.6 已知限制

- **令牌约 1 小时过期**，且刷新用的 refresh token 拿不到，
  所以桥依赖 Copilot 桌面端保持运行态；过期后跑一次 `refresh-token.ps1` 即可。
- **建连冷却**导致首次请求可能慢到 10~30 秒；已在桥内用退避重试吸收，但体感上偶发会等。
- 收割依赖 mitmproxy 的 CA 已装入当前用户受信任根证书
  （`%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer`）。
  不需要刷新令牌时，mitmproxy 可以完全退出，桥**直连** substrate，不依赖代理链。

---

## 8. 采集环境备注

- 系统代理：`127.0.0.1:8082`（mitmproxy）→ 上游 `127.0.0.1:7890`（FlClash）
- mitmproxy 仅解密 Copilot 相关域名：
  `cr\.m365copilotapp\.svc\.cloud\.microsoft | substrate\.office\.com | copilot\.microsoft\.com | roaming\.svc\.cloud\.microsoft | m365\.cloud\.microsoft | login\.live\.com | ic3-consumers\.teams\.office\.com`
- 其余流量隧道直通（避免 CDN 静态资源被 MITM 导致界面掉样式）
- 还原系统代理：把 `ProxyServer` 改回 `127.0.0.1:7890`
  （`refresh-token.ps1` 会在结束时自动还原）
