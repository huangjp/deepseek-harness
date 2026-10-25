# 小艺（华为 AI空间）反代 —— 协议与凭证笔记

抓包时间 2026-10-19，环境：Windows 11 + 华为「AI空间」（`WisdomDispatch.exe`，
华为个人中心 v1.1.6.303）+ FlClash 7890。

## 一、为什么以前找不到对话请求

「AI空间」是个聚合入口，界面上能选四家模型，HTTP 流量里也确实能看到它们：

| 家 | 域名 | 抓到的请求 |
|---|---|---|
| 小艺 Celia | `xiaoyi.huawei.com` | 16 条，**全是辅助接口**（历史、付费、协议） |
| 智谱 ChatGLM | `chatglm.cn` / `sdata.chatglm.cn` | 61 条，配置与会话列表 |
| 讯飞星火 | `xinghuo.xfyun.cn` | 27 条，静态资源与登录态 |
| 百度文心 | `chat.baidu.com` / `wenxin.baidu.com` | 30 条，侧栏与历史 |

**一条对话请求都没有** —— 因为主对话走 WebSocket，HTTP 里只有外围。

## 二、对话通道

```
wss://xiaoyi.huawei.com/hivoice/v6/voice/ws
```

### 请求：一条 JSON

```json
{
  "session": {
    "messageName": "textRecognize", "sender": "Render", "receiver": "DM",
    "deviceId": "<64hex>", "locate": "CN", "sessionId": "<32hex>",
    "interactionId": 1, "messageId": "<sessionId>1",
    "audioStreamId": "audiostreamsession<ts>", "dialogId": 1, "appId": "<sessionId>",
    "devF": "<ts>", "fullDuplexMode": "false", "hwUid": "",
    "isExperiencePlan": true, "vtid": "98345457574478801web",
    "dialogPageId": "", "conversationId": ""
  },
  "contexts": [
    { "header": { "name": "Application", "namespace": "System" },
      "payload": { "apps": [{ "name": "智慧语音",
                              "packageName": "com.huawei.vassistant.web",
                              "version": "14.0.0.100" }] } },
    { "header": { "namespace": "TextRecognizer", "name": "AsrRecognize" },
      "payload": { "vendor": "xunfei", "asrText": "<用户输入>" } },
    { "header": { "namespace": "System", "name": "ClientContext" },
      "payload": { "firstDialog": "true", "loginStatus": true,
                   "interrupt": false, "isXiaoyiAPP": false } }
  ]
}
```

`asrText` 名义上是语音识别结果，实际就是纯文本输入 —— 走这条路不需要音频。

### 响应：一串流式 JSON

| 字段 | 含义 |
|---|---|
| `directives[].header.name === 'DisplayStreamingText'` 的 `payload.streamingText` | **累计全文**（不是增量，要自己差分） |
| 同上 `payload.reasoningText` | 思维链（也是累计） |
| 同上 `payload.stepInfo` | 阶段文本（理解问题 / 查询信息 / 汇总信息 / 深度思考 / 生成总结） |
| `isFinal` | `true` 表示本轮结束 |
| `directives[]` 里的 `DialogFinished` | 另一个结束信号 |

实际调用的模型标识在 `contexts[].payload.llmInfo.fusionLlmModel`，抓到的值是
`search_agent:creative_qa_agent`。

小艺会带**位置上下文**（问天气会直接答"今天郑州天气……"），这是它和通用模型反代的差别。

## 三、凭证

### 最小可用集合只有 5 个

| cookie | 作用 | 备注 |
|---|---|---|
| `xy_token` | 鉴权，`Bearer ` + 810 字符 | **会话 cookie，不落盘** |
| `xy_deviceId` | 设备标识，64 hex | 持久，1 年 |
| `xy_appName` | 固定 `com.huawei.vassistant.web` | 持久 |
| `JSID` | 会话标识，64 hex | 持久 |
| `xyxp` | 300 字符 base64 | 持久 |

对照实验（同一份 token，只改 cookie 集合）：

| 集合 | 结果 |
|---|---|
| 全量 15 个 | 通 |
| 去掉 `HWWAFSESID` / `HWWAFSESTIME` | 通 |
| **上面这 5 个** | **通** |
| 只 `xy_token` + `xy_deviceId` | 400 |

也就是说华为 WAF 会话、`xy_csrf_token`、`HW_id*` 系列都**不需要**。
UA 要带后缀 `PCAISpace/1.1.6.303`。

### 为什么从内存拿，而不是解 cookie 库

`xy_token` 是会话 cookie，Chromium **不落盘** —— 磁盘 cookie 库里根本没有它
（只有另外 4 个持久 cookie）。所以「解 WebView2 的 Cookies 库」这条路，
只有在应用关闭时才能读，而没有应用就没有 token，白搭。

而 AI空间 的渲染进程内存里留着服务器下发的**完整 Set-Cookie 头**：

```
xy_token=Bearer <810字符>; path=/; ... secure; httponly
xy_deviceId=<64hex>; path=/; max-age=31536000; expires=...
```

一次扫描就能把 5 个全拿到。**不需要** DPAPI，也**不需要** AES-GCM。

### 内存扫描要点

- 进程过滤：`msedgewebview2.exe` 往往有二十几个（Office、QQ、小组件都用），
  只留命令行里带 `personalcenter` 的（用 PEB 读命令行，见 `xiaoyi-harvest.py`）。
- 只扫 `MEM_PRIVATE` + 可读页，跳过 `MEM_MAPPED`（那多是 DLL 静态数据，扫了白扫）。
- **同一份数据有多处副本，其中一些是被截断的**（值中间夹着 `\x00` 或堆元数据，
  比如 `xy_appName=com\x00huawei. ...`）。所以每个字段都收集全部候选，
  最后按形状校验挑最长的那个 —— 截断的副本会被校验规则筛掉。
- 只靠 `[0-9A-F]{700,900}` 找 token 会被填充串淹没：内存里有大量
  `000000...`、`08080808...` 同样是 700+ 长的十六进制，实测 360 个候选里
  18 个不同值全是垃圾。用 `xy_token … Bearer ` 这个上下文特征才能一次命中。

实测耗时：全部 5 个 cookie 约 **3 秒**（早期版本 110 秒，差在"精确特征 + 只扫私有内存 + 候选校验"）。

## 四、Node 侧为什么手写 WebSocket

Node 22 自带全局 `WebSocket`，但**不支持自定义请求头**，而小艺的鉴权全在 Cookie 里。
所以 `xiaoyi-bridge.mjs` 里用 `node:net` / `node:tls` + 手搓帧实现了一个最小客户端
（握手、掩码、分片、ping/pong 都在 100 行内）。同目录的 `copilot-bridge.mjs` 能用全局
`WebSocket`，是因为 Copilot 把 `access_token` 放在 URL 查询串里。

## 五、失效与自愈

华为边缘节点对无效凭据的返回码不统一，实测见过 **400 / 401 / 403 / 407**（407 是
"Proxy Authentication Required"，别被它误导成代理问题）。这些一律当作"凭证可能过期"，
重新收割一次再试；429 是限流，重收没用。

token 有效期实测 **40+ 小时**（10-19 抓的，10-21 仍在用），所以缓存起来、
失效才重收。缓存文件 `%LOCALAPPDATA%\xiaoyi-bridge\auth.json`。

## 六、已知边界

- **输入长度上限约 8000 字符**：超了**不报错**，上游只是把答案换成一句固定英文模板
  「Sorry, I don't know the answer to that. Would you like to ask me something else?」
  —— 没有错误码、没有异常，客户端只看到「模型答非所问」，极难定位。
  实测（同一份真实会话回放）：7999 字符正常作答，8494 字符起稳定兜底。
  所以 `buildPrompt()` 必须自己把提示词收敛到远低于这个阈值（当前上限 4000 字符）。
- **单轮通道**：每次调用都新建 session（`sessionId` 随机），没有多轮上下文。
  把整段对话历史喂进去，它会照着**第一条**用户输入回答，而不是最后一条 ——
  所以 `buildPrompt()` 只保留最后一条真实用户输入。
- **必须有 AI空间 且开着对话页**：WebView2 是懒加载的，不打开页面就没有
  `PersonalCenter` 的渲染进程，内存里也没有 token。
- 只接了**小艺**一家。智谱 / 讯飞 / 文心在 HTTP 流量里也没暴露对话接口，
  大概率同样是 WS 或需要各自的 PoW，未验证。
- 协议是逆向出来的，华为改版会失效。失效后的第一现场是 `/health` 与日志里的
  握手状态码，其次是 `xiaoyi-harvest.py` 的 `no_cookies`。
