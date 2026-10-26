// Microsoft Copilot → OpenAI 兼容反代
//
// 原理：Copilot 桌面版通过 WebSocket(SignalR JSON) 连到
//   wss://substrate.office.com/m365Copilot/Chathub/<user>@<tenant>?access_token=...
// 本服务复用同一条通道：读收割到的令牌与请求模板 → 建连 → 发 chat 帧 →
// 把流式增量转成 OpenAI SSE。
//
// 令牌来源：由 mitmproxy 插件 token-harvester.py 收割到 token.json。
// 原因见 copilot-protocol-notes.md：设备码流程被 AADSTS70002 拒绝、
// CDP 端口不开放、MSAL 缓存用不可导出密钥加密、内存里只以 ConsString 形式存在。
//
// 零依赖，仅用 Node 标准库（Node >= 22 自带全局 WebSocket）。

import http from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTokenGate } from './token-gate.mjs';
import {
  buildToolInstruction, completeWithToolCalls, createToolCallGate, EXTERNAL_TOOLING_NOTICE,
  looksLikeToolRefusal, resolveToolOutcome, toolCallFailureText, toolTurnText, TOOL_CALL_REFUSAL_REMINDER,
  TOOL_CALL_REPAIR_REMINDER, TRANSCRIPT_TRAILER,
} from './toolprompt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 令牌年龄超过它就视为需要更换（毫秒以外一律用秒）。
 *
 * 微软 access_token 约 1 小时过期，留 15 分钟余量。这个阈值同时决定 `/health`
 * 的 `stale`、错误提示里那句「很可能已失效」，以及是否触发自动刷新 —— 三处必须
 * 同源，否则页面说「陈旧」而反代不刷新，或者反过来。
 */
const TOKEN_STALE_SEC = 45 * 60;

/**
 * 触发刷新后等新令牌落盘的上限。
 *
 * 刷新脚本自身最坏约 100 秒（见 refresh-token.ps1 的收割轮询），加上 mitmdump
 * 启动，120 秒足够覆盖一次正常刷新。超时就放弃等待、让请求带现有令牌继续。
 */
const TOKEN_WAIT_MS = 120000;

// ---------------------------------------------------------------- 配置

function loadConfig() {
  const file = process.env.COPILOT_BRIDGE_CONFIG || path.join(__dirname, 'copilot.config.json');
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { console.error(`[copilot] 配置解析失败 ${file}: ${e.message}`); process.exit(1); }
  }
  return cfg;
}

// 运行时状态。原先是模块级 const，现改为由 startCopilotBridge() 装配 ——
// 这样本文件既能独立 `node copilot-bridge.mjs` 运行，也能被宿主（DSH）内嵌导入。
let config = {};
let serverCfg = {};
let harvestDir = '';
let tokenFile = '';
let templateFile = '';
/** 宿主注入的刷新触发能力；独立运行时为 null（没有脚本路径与锁，刷新无从谈起）。 */
let refreshToken = null;
/** 令牌使用闸门；没有刷新能力时为 null，整段自动刷新不生效。 */
let gate = null;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/**
 * 装配运行时状态。
 * @param {object} [overrides] 宿主直接注入的配置，优先级高于配置文件与环境变量。
 */
function initRuntime(overrides = {}) {
  const base = loadConfig();
  config = { ...base, ...overrides };
  // 已知子对象做浅合并：宿主只传一个字段时不能把整块配置顶掉。
  for (const key of ['server', 'harvest', 'session']) {
    if (overrides[key] && base[key]) config[key] = { ...base[key], ...overrides[key] };
  }
  serverCfg = config.server || {};
  harvestDir = process.env.COPILOT_HARVEST_DIR
    || config.harvest?.dir
    || path.join(process.env.USERPROFILE || '', 'copilot-probe');
  tokenFile = path.join(harvestDir, 'token.json');
  templateFile = path.join(harvestDir, 'chat_template.json');
  // 收割目录换了，上一个目录的缓存值一律作废：否则重启到另一个目录时，
  // 头 5 秒（令牌）/ 30 秒（模板）里读到的还是旧目录的令牌。
  _tokenCache = { at: 0, value: null };
  _tplCache = { at: 0, value: null };

  // 刷新能力是宿主注入的函数，不是配置项：单独持有，别混进 config。
  refreshToken = typeof overrides.refreshToken === 'function' ? overrides.refreshToken : null;
  delete config.refreshToken;
  gate = refreshToken === null ? null : createTokenGate({
    readStamp: readTokenStamp,
    staleSec: TOKEN_STALE_SEC,
    waitMs: TOKEN_WAIT_MS,
    trigger: () => refreshToken(),
    log: (message) => { log(message); },
  });
}

// ---------------------------------------------------------------- 令牌 / 模板

/** SignalR JSON 协议用 0x1E 作为记录分隔符，每条消息都必须以它结尾。 */
const RS = '\x1e';

let _tokenCache = { at: 0, value: null };

function loadHarvest() {
  const now = Date.now();
  if (_tokenCache.value && now - _tokenCache.at < 5000) return _tokenCache.value;
  let value = null;
  if (existsSync(tokenFile)) {
    try {
      const j = JSON.parse(readFileSync(tokenFile, 'utf8'));
      if (j && j.access_token && j.params) value = j;
    } catch { /* 半截文件，忽略 */ }
  }
  _tokenCache = { at: now, value };
  return value;
}

/**
 * 读当前令牌的收割时间戳（秒），没有令牌时为 0。
 *
 * 刻意绕过上面那 5 秒缓存：闸门判断「是否陈旧」和「新令牌是否落盘」都读这个值，
 * 读到缓存里的旧值会让自动刷新永远以为没换成功，从而把每个请求都拖满等待上限。
 * @returns 收割时间戳（秒），或 0。
 */
function readTokenStamp() {
  _tokenCache = { at: 0, value: null };
  return loadHarvest()?.harvestedAt || 0;
}

/** 请求模板：优先用收割到的；没有则退回抓包导出的静态模板。 */
let _tplCache = { at: 0, value: null };
function loadTemplate() {
  const now = Date.now();
  if (_tplCache.value && now - _tplCache.at < 30000) return _tplCache.value;
  const h = loadHarvest();
  let value = h?.template || null;
  if (!value && existsSync(templateFile)) {
    try { value = JSON.parse(readFileSync(templateFile, 'utf8')); } catch { /* ignore */ }
  }
  _tplCache = { at: now, value };
  return value;
}

function buildWsUrl(harvest) {
  const p = harvest.params || {};
  const host = p.host || 'substrate.office.com';
  const pathname = p.path || `/m365Copilot/Chathub/${p.XRoutingParameterSessionKey || ''}`;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (k === 'host' || k === 'path') continue;
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  // 每次连接必须换一组全新的会话标识。
  // 实测：复用同一个 chatsessionid 连续建连时，服务端会拒掉第二条
  // （要么 101 升级被拒，要么升级成功但完全不回帧 —— 表现就是"挂到超时"）。
  const hex = randomBytes(16).toString('hex');
  q.set('chatsessionid', hex);
  q.set('clientrequestid', hex);
  q.set('X-SessionId', randomUUID());
  q.set('ConversationId', randomUUID());

  q.set('access_token', harvest.access_token);
  return `wss://${host}${pathname}?${q.toString()}`;
}

// ---------------------------------------------------------------- Sydney 会话

/**
 * 一次对话 = 一条 WebSocket 连接。
 *
 * 帧序列（实测）：
 *   C→S  {"protocol":"json","version":1}\x1e     握手
 *   S→C  {}\x1e
 *   C→S  {"arguments":[<chat 请求>],"target":"chat","type":1}\x1e
 *   S→C  {"type":1,"target":"update","arguments":[{writeAtCursor|messages|...}]}\x1e  × N
 *   S→C  {"type":2,"invocationId":"N","item":{...}}\x1e   完成
 *   S→C  {"type":3,"invocationId":"N"}\x1e                完成确认
 */
class SydneySession {
  constructor({ prompt, harvest, template, signal, onDelta, onStart }) {
    this.prompt = prompt;
    this.harvest = harvest;
    this.template = template;
    this.signal = signal;
    this.onDelta = onDelta;
    this.onStart = onStart;
    this.emitted = '';
    this.done = false;
    this.settled = false;
    this.invocationId = null;
  }

  /**
   * 下发一段增量。
   *
   * 合并策略（实测踩出来的）：
   *   - writeAtCursor 是**真实增量流**，优先用它，收到即下发
   *   - messages[].text 是**累计全文**，只在它是已下发文本的严格前向扩展时补齐差额
   *   - 服务端有时会改写（光标重排）导致累计文本不再是前向扩展 —— 这时必须忽略，
   *     否则会像旧实现那样把 "2, 3, 4, 5." 之后又吐一遍 "3, 4, 5."
   *   - contentType=EarlyProgress / messageType=Progress 是"正在检查…"这类进度提示，
   *     属于 UI 噪音，不是回答正文，必须过滤
   */
  #emit(delta) {
    if (!delta) return;
    this.emitted += delta;
    this.onDelta?.(delta);
  }

  static #isNoise(m) {
    const ct = m?.contentType;
    const mt = m?.messageType;
    return ct === 'EarlyProgress' || ct === 'Progress' || mt === 'Progress'
      || mt === 'ReferencesListComplete' || mt === 'InternalSearchQuery';
  }

  #considerFull(full) {
    if (typeof full !== 'string' || !full) return;
    if (full === this.emitted) return;
    if (full.startsWith(this.emitted)) { this.#emit(full.slice(this.emitted.length)); return; }
    // 不是前向扩展（服务端改写）→ 忽略，避免重复
  }

  #considerCursor(frag) {
    if (typeof frag !== 'string' || !frag) return;
    if (this.emitted.endsWith(frag)) return;   // 已覆盖
    this.#emit(frag);
  }

  run() {
    return new Promise((resolve, reject) => {
      const url = buildWsUrl(this.harvest);
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        return reject(Object.assign(new Error(`WebSocket 创建失败：${e.message}`), { code: 'ws_create_failed' }));
      }
      this.ws = ws;

      const timeoutMs = config.session?.timeoutMs ?? 180000;
      const timer = setTimeout(() => {
        this.finish(reject, Object.assign(new Error(`对话超时（${timeoutMs}ms）`), { code: 'upstream_timeout', httpStatus: 504 }));
      }, timeoutMs);

      const onAbort = () => this.finish(reject, Object.assign(new Error('请求已取消'), { code: 'client_closed', httpStatus: 499 }));
      this.signal?.addEventListener?.('abort', onAbort, { once: true });
      this._cleanup = () => { clearTimeout(timer); this.signal?.removeEventListener?.('abort', onAbort); };

      ws.addEventListener('error', (ev) => {
        const msg = ev?.message || ev?.error?.message || 'WebSocket 错误';
        this.finish(reject, Object.assign(new Error(`连接 substrate 失败：${msg}`), { code: 'ws_error', httpStatus: 502 }));
      });

      ws.addEventListener('close', (ev) => {
        log(`[ws] close code=${ev.code} text=${this.emitted.length} sent=${chatSent} recv=${recvCount}`);
        if (this.settled) return;
        // 已收到内容却提前关闭 → 当作正常结束（服务端常在上报 Metrics 后主动断）
        if (this.emitted) return this.finish(resolve, { text: this.emitted, closeCode: ev.code });
        this.finish(reject, Object.assign(
          new Error(`连接被关闭（code=${ev.code}）${ev.reason ? `：${ev.reason}` : ''}`),
          { code: 'ws_closed', httpStatus: 502 }));
      });

      let chatSent = false;
      let recvCount = 0;
      ws.addEventListener('message', (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
        recvCount++;
        if (recvCount <= 6) log(`[ws] recv#${recvCount} len=${data.length}`);
        for (const rec of data.split(RS)) {
          const t = rec.trim();
          if (!t) continue;
          let o;
          try { o = JSON.parse(t); } catch { continue; }

          // 关键时序：SignalR 必须先完成握手才允许发 invocation。
          // 握手回包是空对象 {}。抢跑会让服务端完全无响应，直到超时。
          if (!chatSent && o.type === undefined && o.target === undefined) {
            chatSent = true;
            try {
              const payload = this.buildChatInvocation();
              this.invocationId = String(payload.invocationId ?? '0');
              ws.send(JSON.stringify(payload) + RS);
              this.onStart?.();
            } catch (e) {
              this.finish(reject, e);
              return;
            }
            continue;
          }

          this.handle(o);
        }
      });

      ws.addEventListener('open', () => {
        log(`[ws] open url_len=${url.length}`);
        // 只发握手。invocation 必须等握手回包之后（见下方 message 处理）。
        ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
      });
    });
  }

  /** 用模板构造 chat 请求，只替换提示词与几个一次性 ID。 */
  buildChatInvocation() {
    const tpl = this.template;
    const invocationId = '0';
    let body;

    if (tpl && Array.isArray(tpl.arguments) && tpl.arguments[0]) {
      body = JSON.parse(JSON.stringify(tpl));
    } else {
      throw Object.assign(new Error('缺少请求模板：请先在 Copilot 里发一条消息以完成收割'), {
        code: 'no_template', httpStatus: 503,
      });
    }

    const a = body.arguments[0];
    const hex = randomBytes(16).toString('hex');
    const uuid = randomUUID();

    a.clientCorrelationId = hex;
    a.sessionId = uuid;
    a.requestId = hex;
    a.traceId = hex;
    a.isStartOfSession = false;

    if (!a.message || typeof a.message !== 'object') a.message = {};
    a.message.text = this.prompt;
    a.message.author = 'user';
    a.message.requestId = hex;
    a.message.messageType = a.message.messageType || 'Chat';
    if (!a.message.clientInfo && a.clientInfo) a.message.clientInfo = { ...a.clientInfo };

    body.target = 'chat';
    // 必须保留模板里的流式调用类型。Chat 是 SignalR 的**流式**方法，
    // 用 type=1（普通 Invocation）会被服务端直接拒绝：
    //   "The client attempted to invoke the streaming 'Chat' method
    //    with a non-streaming invocation."
    body.type = (tpl && tpl.type) || 4;
    if (body.invocationId === undefined) body.invocationId = invocationId;
    return body;
  }

  handle(o) {
    if (!o || typeof o !== 'object') return;

    // SignalR 保活
    if (o.type === 6) { try { this.ws?.send(JSON.stringify({ type: 6 }) + RS); } catch { /* ignore */ } return; }

    // 握手回包
    if (!o.type && !o.target && !o.invocationId) return;

    // 调用完成
    if (o.type === 3) { this.done = true; return; }
    if (o.type === 2 && o.item) {
      // StreamItem：item.messages[] 含最终全文，作为兜底补齐
      const msgs = o.item.messages;
      if (Array.isArray(msgs)) {
        for (const m of msgs) {
          if (m?.author === 'bot' && typeof m.text === 'string' && !SydneySession.#isNoise(m)) {
            this.#considerFull(m.text);
          }
        }
      }
      return;
    }

    if (o.target !== 'update' || !Array.isArray(o.arguments)) return;

    for (const arg of o.arguments) {
      if (!arg || typeof arg !== 'object') continue;

      // 累计全文：仅在是前向扩展时补齐差额（过滤进度提示）
      if (Array.isArray(arg.messages)) {
        for (const m of arg.messages) {
          if (m && typeof m.text === 'string' && m.author === 'bot' && !SydneySession.#isNoise(m)) {
            this.#considerFull(m.text);
          }
        }
      }

      // 真实增量流：优先下发
      if (typeof arg.writeAtCursor === 'string' && arg.writeAtCursor) {
        this.#considerCursor(arg.writeAtCursor);
      }

      if (arg.isLastUpdate === true) this.done = true;
    }

    if (this.done) this.finish(this.resolveRef, { text: this.emitted });
  }

  finish(fn, arg) {
    if (this.settled) return;
    this.settled = true;
    this._cleanup?.();
    try { this.ws?.close(); } catch { /* ignore */ }
    fn(arg);
  }
}

/** 跑一次完整对话，返回 { text, usage }。 */
/**
 * 给连接类错误补一句令牌年龄提示。
 *
 * Copilot 的 access_token 约一小时过期，而刷新只能靠抓包（见 protocol notes）：
 * 过期时服务端会拒绝 WebSocket 升级，桥接这边只能看到一句笼统的 "WebSocket 错误" ——
 * 那会让人误以为服务没起来。这里按令牌年龄补上可操作的提示。
 * @param {Error} error 原始错误。
 * @returns {Error} 可能被补充了提示的错误（原地修改并返回）。
 */
function withTokenAgeHint(error) {
  const h = loadHarvest();
  if (!h?.harvestedAt || !error) return error;
  const ageSec = Math.round(Date.now() / 1000 - h.harvestedAt);
  const ageText = ageSec >= 5400
    ? `${Math.round(ageSec / 3600)} 小时`
    : `${Math.max(Math.round(ageSec / 60), 0)} 分钟`;
  if (ageSec < TOKEN_STALE_SEC) return error;
  error.message += `\n（令牌已收割 ${ageText}，微软 access_token 约 1 小时过期，很可能已失效；`
    + '请保持 Copilot 桌面端运行并执行 refresh-token.ps1 重新收割，然后重试。）';
  return error;
}

async function runChat({ prompt, signal, onDelta }) {
  const harvest = loadHarvest();
  if (!harvest) {
    throw Object.assign(new Error(
      '尚未收割到令牌。请确认：① mitmproxy 已挂 token-harvester.py 并处于系统代理链中；'
      + '② Copilot 桌面端正在运行；③ 在 Copilot 里随便发一条消息。',
    ), { code: 'no_token', httpStatus: 503 });
  }
  const template = loadTemplate();
  const maxAttempts = config.session?.connectRetries ?? 5;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const session = new SydneySession({ prompt, harvest, template, signal, onDelta });
    try {
      return await new Promise((resolve, reject) => {
        session.resolveRef = resolve;
        session.run().then(resolve, reject);
      });
    } catch (e) {
      lastErr = e;
      // 服务端对同一会话的建连有并发/频率限制，实测偶发 101 被拒。
      // 只在本轮**还没吐出任何内容**时重试，否则会重复输出。
      const retriable = (e.code === 'ws_error' || e.code === 'ws_closed') && !session.emitted;
      if (!retriable || attempt === maxAttempts) throw withTokenAgeHint(e);
      // 实测服务端在关闭一条 Chathub 连接后有约 10 秒的冷却，
      // 期间新建连会被拒（non-101）。退避按 1s→2s→4s→8s 递增，覆盖整个冷却窗口。
      const delay = Math.min(8000, 1000 * 2 ** (attempt - 1));
      log(`[retry] 第 ${attempt} 次建连失败（${e.message}），${delay}ms 后重试`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw withTokenAgeHint(lastErr);
}

// ---------------------------------------------------------------- HTTP 工具

const MAX_BODY = 8 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求体过大'), { httpStatus: 413, code: 'payload_too_large' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { httpStatus: 400, code: 'invalid_json' })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': serverCfg.cors || '*',
  });
  res.end(body);
}

function sendError(res, err) {
  sendJson(res, err.httpStatus || 500, {
    error: { message: err.message || '内部错误', type: err.code || 'internal_error', code: err.code || 'internal_error' },
  });
}

function authorized(req) {
  const key = serverCfg.apiKey;
  if (!key) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${key}` || h === key;
}

/**
 * chatHub 不返回 usage，所以按字符数估算一个。
 *
 * 不估的话 DSH 侧永远显示「用量 0 tok」，上下文预算也跟着失真（整段会话被当成没有
 * 成本，压缩时机就没了参照）。中文按 1.5 字/token、其余按 4 字符/token 取折中值 ——
 * 估得准不准不影响功能，只影响预算判断，所以够用即可。
 *
 * @param {string} prompt 本次送上去的提示词全文。
 * @param {string} output 模型输出。
 * @returns {{prompt_tokens: number, completion_tokens: number, total_tokens: number}}
 */
function estimateUsage(prompt, output) {
  const count = (s) => {
    const text = String(s ?? '');
    const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff]/g) || []).length;
    return Math.max(0, Math.round(cjk / 1.5 + (text.length - cjk) / 4));
  };
  const promptTokens = count(prompt);
  const completionTokens = count(output);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/**
 * OpenAI messages → 单条提示词（Copilot 只收纯文本 user 消息）。
 *
 * 图片：Copilot 的 SignalR chatHub 通道只接受纯文本 prompt，协议里没有附件 /
 * 多模态字段（见 copilot-protocol-notes.md），图片无法投递。这里**显式统计**图片块，
 * 由调用方直接报错 —— 静默丢掉图片会让模型对着"空气"作答，那比报错更糟。
 * @param {Array<object>} messages OpenAI 风格消息数组。
 * @returns {{systemPrompt: string, prompt: string, imageCount: number}}
 */
function messagesToPrompt(messages = []) {
  const sys = [];
  const convo = [];
  let imageCount = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') content += b.text;
        else if (b.type === 'image_url' || b.type === 'image') imageCount += 1;
      }
    }
    if (m.role === 'system') { if (content) sys.push(content); continue; }
    // 工具轮次必须回放：只压正文的话，助手那条消息的内容经常是空的，整轮就消失了，
    // 模型看不到自己上一轮要过什么、也看不到结果对应哪一次调用。
    const turn = toolTurnText(m, content);
    if (turn !== null) { convo.push(turn); continue; }
    if (!content) continue;
    convo.push(`${m.role === 'assistant' ? '助手' : '用户'}: ${content}`);
  }
  const prompt = convo.join('\n\n');
  return { systemPrompt: sys.join('\n\n'), prompt, imageCount };
}

// ---------------------------------------------------------------- 路由

function handleHealth(req, res) {
  const h = loadHarvest();
  const tpl = loadTemplate();
  const tokens = gate?.state() ?? { inFlight: 0, refreshing: false };
  sendJson(res, 200, {
    ok: Boolean(h),
    token: h ? {
      harvestedAt: h.harvestedAt ? new Date(h.harvestedAt * 1000).toISOString() : null,
      ageSec: h.harvestedAt ? Math.round(Date.now() / 1000 - h.harvestedAt) : null,
      // 微软 access_token 约 1 小时过期；超过 TOKEN_STALE_SEC 就标为可疑，省得调用时
      // 才报一句笼统的 WebSocket 错误。这个阈值同时决定是否自动刷新。
      stale: h.harvestedAt ? (Date.now() / 1000 - h.harvestedAt) > TOKEN_STALE_SEC : null,
      length: h.access_token ? h.access_token.length : 0,
      host: h.params?.host || null,
      conversationId: h.params?.ConversationId || null,
    } : null,
    template: tpl ? { optionsSets: tpl.arguments?.[0]?.optionsSets?.length ?? 0 } : null,
    tokenFile,
    // 宿主启动时跑一次的依赖预检结果（独立运行时为 null）。
    deps: config.preflight ?? null,
    // 令牌替换与使用互斥的状态：`auto` 说明宿主是否注入了刷新能力。
    refresh: { auto: gate !== null, inFlight: tokens.inFlight, running: tokens.refreshing },
    hint: h?.harvestedAt && (Date.now() / 1000 - h.harvestedAt) > TOKEN_STALE_SEC
      ? '令牌已超过 45 分钟，很可能已过期 —— 请保持 Copilot 桌面端运行并执行 refresh-token.ps1 重新收割'
      : undefined,
  });
}

function handleModels(req, res) {
  const created = Math.floor(Date.now() / 1000);
  const ids = ['copilot', 'm365-copilot', 'gpt-4o', 'default'];
  sendJson(res, 200, {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created, owned_by: 'copilot-bridge' })),
  });
}

async function handleChatCompletions(req, res) {
  const body = await readJsonBody(req);
  const { systemPrompt, prompt: userPrompt, imageCount } = messagesToPrompt(body.messages);
  // 这条通道载不了图，必须显式拒绝：静默丢弃会让模型对着"空气"作答。
  if (imageCount > 0) {
    throw Object.assign(new Error(
      `Copilot 通道（SignalR chatHub）只接受纯文本，无法接收图片（本次请求含 ${imageCount} 张）。`
      + '请改用支持图片的通道，或把图片内容用文字描述后重发。',
    ), { httpStatus: 400, code: 'images_unsupported' });
  }
  if (!userPrompt.trim()) {
    throw Object.assign(new Error('messages 为空'), { httpStatus: 400, code: 'invalid_request' });
  }
  // 工具协议：本通道没有原生 function calling，`tools` 只能渲染成提示词里的清单与格式
  // 约定，模型的意图再解析回 OpenAI tool_calls。
  const toolInstruction = buildToolInstruction(body.tools, body.tool_choice);
  const hasTools = Boolean(toolInstruction);
  // 声明置顶（它是"最高优先级"的那条），但**工具清单要排在用户请求之后**：
  // chatHub 的服务端 system prompt 权重很高，清单若排在用户请求前面，模型最后看到的
  // 就只有"用户要我建文件"，于是它会**直接声称建好了**而不去调工具（实测：整轮零调用，
  // 回答是「已创建文件 docs/v2/100-test.md」）。放在请求之后，它最后看到的才是
  // 「你可以用哪些工具、怎么表达」。
  const systemParts = [hasTools ? EXTERNAL_TOOLING_NOTICE : '', systemPrompt];
  const system = systemParts.filter(Boolean).join('\n\n');
  // 多轮时在转录稿末尾划界：模型否则会顺着 `用户: / 助手: / 【外部执行结果…】` 的格式
  // 继续写下去，把上一轮的话和工具输出再吐一遍（线上表现像"内容重复了"）。
  const hasHistory = Array.isArray(body.messages) && body.messages.length > 1;
  const turnPrompt = hasHistory ? `${userPrompt}\n\n${TRANSCRIPT_TRAILER}` : userPrompt;
  /** 把（可能被重试改写的）system 段、对话正文与工具清单拼成这一条 prompt。 */
  const compose = (systemText) => [systemText, turnPrompt, toolInstruction].filter(Boolean).join('\n\n');
  const prompt = compose(system);

  const model = body.model || 'copilot';
  const id = `chatcmpl-${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const ctl = new AbortController();
  req.on('close', () => ctl.abort());

  // 令牌陈旧就先换新再占用通道；正在刷新则在这里等它落地。占用之后到 leave() 之前，
  // 闸门不会开始刷新 —— 在途请求带着的令牌不会被中途替换掉。
  if (gate) await gate.enter();
  try {
    if (!body.stream) {
      if (!hasTools) {
        const r = await runChat({ prompt, signal: ctl.signal });
        return sendJson(res, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
          usage: estimateUsage(prompt, r.text),
        });
      }
      const out = await completeWithToolCalls({
        systemPrompt: system,
        hasTools: true,
        log,
        invoke: systemText => runChat({ prompt: compose(systemText), signal: ctl.signal }),
      });
      const { calls, content, broken } = out.outcome;
      return sendJson(res, 200, {
        id, object: 'chat.completion', created, model,
        choices: [{
          index: 0,
          message: calls
            ? { role: 'assistant', content: '', tool_calls: calls }
            : { role: 'assistant', content: broken ? toolCallFailureText(out.text) : content },
          finish_reason: calls ? 'tool_calls' : 'stop',
        }],
        usage: estimateUsage(prompt, out.text),
      });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': serverCfg.cors || '*',
    });
    const frame = (delta, finish = null) => {
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
    };
    const usageIfNeeded = () => {
      if (!body.stream_options?.include_usage) return;
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model, choices: [],
        usage: estimateUsage(prompt, ''),
      })}\n\n`);
    };

    try {
      frame({ role: 'assistant', content: '' });
      if (!hasTools) {
        await runChat({ prompt, signal: ctl.signal, onDelta: (t) => frame({ content: t }) });
        frame({}, 'stop');
      } else {
        // 带工具时不能把工具调用 JSON 当正文流给客户端，但普通回答仍应逐段下发 ——
        // 所以用闸门按开头判定：像工具调用就整段扣住，否则一路直发。
        const streaming = createToolCallGate();
        const first = await runChat({
          prompt,
          signal: ctl.signal,
          onDelta: (t) => {
            const text = streaming.push(t);
            if (text) frame({ content: text });
          },
        });
        let outcome = resolveToolOutcome({ text: first.text, hasTools });
        let finalText = first.text;
        if (!outcome.broken && hasTools && looksLikeToolRefusal(finalText)) {
          // 拒答：模型不认为该调工具（"我无法访问你本机上的文件"）。换一种说法让它重来。
          log('[warn] 模型拒绝了工具任务，重试一次并强制给出工具意图');
          const retry = await runChat({
            prompt: compose(`${system}\n\n${TOOL_CALL_REFUSAL_REMINDER}`),
            signal: ctl.signal,
          });
          finalText = retry.text;
          outcome = resolveToolOutcome({ text: finalText, hasTools });
        } else if (outcome.broken) {
          // 第一次的 JSON 写坏了：带修复提示重试一次，这次不流式（不能回吐半截）。
          log('[warn] 工具调用解析失败，疑似 JSON 非法，重试一次');
          const retry = await runChat({
            prompt: compose(`${system}\n\n${TOOL_CALL_REPAIR_REMINDER}`),
            signal: ctl.signal,
          });
          finalText = retry.text;
          outcome = resolveToolOutcome({ text: finalText, hasTools });
        }
        const { calls, content, broken } = outcome;
        // 扣住的文本只有"确认是正文"时才放出去；工具调用与解析失败都要丢掉它。
        const held = streaming.settle(calls !== null || broken);
        if (calls) {
          frame({ tool_calls: calls.map((c, i) => ({ index: i, ...c })) });
          frame({}, 'tool_calls');
        } else if (broken) {
          log(`[warn] 重试后仍无法解析工具调用，下发错误帧。原始输出前 300 字：${String(finalText || '').slice(0, 300)}`);
          frame({ content: toolCallFailureText(finalText) });
          frame({}, 'stop');
        } else {
          if (held || content) frame({ content: held || content });
          frame({}, 'stop');
        }
      }
      usageIfNeeded();
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { content: `\n\n[调用失败] ${err.message}` }, finish_reason: 'stop' }],
        error: { message: err.message, code: err.code || 'internal_error' },
      })}\n\n`);
      usageIfNeeded();
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } finally {
    // 最后一个请求离开时闸门会顺手把陈旧的令牌换掉，下一个请求就不必再等一次刷新。
    if (gate) gate.leave();
  }
}

function handleTestPage(req, res) {
  const h = loadHarvest();
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Copilot 反代 · 测试页</title><style>
body{margin:0;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2328}
.wrap{max-width:860px;margin:0 auto;padding:20px}h1{font-size:18px;margin:0 0 10px}
.bar{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:10px 12px;margin-bottom:12px}
#log{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:14px;min-height:220px;max-height:52vh;overflow:auto;white-space:pre-wrap}
.row{display:flex;gap:8px;margin-top:12px}input{flex:1;padding:10px;border:1px solid #d0d7de;border-radius:8px}
button{padding:10px 18px;border:0;border-radius:8px;background:#1f6feb;color:#fff;cursor:pointer}
.ok{color:#1a7f37}.bad{color:#cf222e}</style></head><body><div class="wrap">
<h1>Microsoft Copilot · 本地反代</h1>
<div class="bar">令牌：<b class="${h ? 'ok' : 'bad'}">${h ? '已收割' : '未收割'}</b>
 ${h ? `（${h.params?.host || ''}，采集于 ${new Date((h.harvestedAt || 0) * 1000).toLocaleTimeString()}）` : '— 请在 Copilot 里发一条消息'}</div>
<div id="log">输入内容回车测试。</div>
<div class="row"><input id="q" placeholder="输入一句话，回车…"><button id="go">发送</button></div>
<div class="bar" style="margin-top:10px">Base URL：<code>http://127.0.0.1:${serverCfg.port || 8899}/v1</code></div>
</div><script>
const log=document.getElementById('log'),q=document.getElementById('q'),go=document.getElementById('go');
function add(t){log.textContent+='\\n\\n'+t;log.scrollTop=log.scrollHeight;}
async function send(){const t=q.value.trim();if(!t)return;q.value='';add('你: '+t);go.disabled=true;
 try{const r=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({messages:[{role:'user',content:t}],stream:true})});
  const rd=r.body.getReader(),dec=new TextDecoder();let buf='',out='';
  for(;;){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});
   let i;while((i=buf.indexOf('\\n\\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+2);
    if(!line.startsWith('data:'))continue;const p=line.slice(5).trim();if(p==='[DONE]')continue;
    try{const j=JSON.parse(p);if(j.error){add('错误: '+j.error.message);go.disabled=false;return;}
     out+=j.choices?.[0]?.delta?.content||'';}catch(_){}}}
  add('Copilot: '+(out||'(空)'));
 }catch(e){add('异常: '+e.message);}finally{go.disabled=false;}}
go.onclick=send;q.addEventListener('keydown',e=>{if(e.key==='Enter')send();});
</script></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ---------------------------------------------------------------- 服务器

const routes = [
  ['GET', '/', handleTestPage],
  ['GET', '/health', handleHealth],
  ['GET', '/v1/models', handleModels],
  ['GET', '/models', handleModels],
  ['POST', '/v1/chat/completions', handleChatCompletions],
  ['POST', '/chat/completions', handleChatCompletions],
];

/** 构建 HTTP 服务器（只构建，不监听）。 */
function buildServer() {
  return http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const routePath = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': serverCfg.cors || '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
    });
    return res.end();
  }

  const hit = routes.find(([m, p]) => m === req.method && p === routePath);
  if (!hit) return sendError(res, Object.assign(new Error(`未知路由 ${req.method} ${routePath}`), { httpStatus: 404, code: 'not_found' }));
  if (!authorized(req)) return sendError(res, Object.assign(new Error('鉴权失败'), { httpStatus: 401, code: 'unauthorized' }));

  const t0 = Date.now();
  try {
    await hit[2](req, res);
    log(`${req.method} ${routePath} ${res.statusCode} ${Date.now() - t0}ms`);
  } catch (err) {
    log(`${req.method} ${routePath} FAIL ${err.httpStatus || 500} ${Date.now() - t0}ms - ${err.message}`);
    if (!res.headersSent) sendError(res, err); else res.end();
  }
  });
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8899;

/** 已启动实例（供 stopCopilotBridge 使用）。 */
let activeBridge = null;

/**
 * 启动 Copilot 反代服务。宿主内嵌（DSH）与独立运行（node copilot-bridge.mjs）共用。
 * 监听失败时 reject —— 嵌入式宿主需要知道启动失败。
 * @param {object} [overrides] 宿主注入的配置，优先级高于配置文件与环境变量。
 * @returns {Promise<{host:string,port:number,server:object,close:()=>Promise<void>}>}
 */
export async function startCopilotBridge(overrides = {}) {
  initRuntime(overrides);
  const server = buildServer();
  const host = serverCfg.host || DEFAULT_HOST;
  const port = serverCfg.port || DEFAULT_PORT;

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') log(`[错误] 端口 ${port} 被占用`);
      else log(`[错误] 启动失败：${err.message}`);
      reject(err);
    };
    server.once('error', onError);
    server.once('listening', () => {
      server.removeListener('error', onError);
      resolve();
    });
    server.listen(port, host);
  });

  activeBridge = {
    host,
    port,
    server,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
  const h = loadHarvest();
  log(`copilot-bridge 已启动: http://${host}:${port}`);
  log(`测试页: http://${host}:${port}/  |  OpenAI Base URL: http://${host}:${port}/v1`);
  log(`令牌文件: ${tokenFile}`);
  log(h
    ? `令牌: 已收割（${h.params?.host || '?'}，长度 ${h.access_token?.length}）`
    : '令牌: 未收割 —— 请在 Copilot 里发一条消息，收割器会自动写入');
  log(gate
    ? `令牌自动刷新: 开启（超过 ${Math.round(TOKEN_STALE_SEC / 60)} 分钟时，在无请求在途的空档里换新）`
    : '令牌自动刷新: 关闭 —— 未注入刷新能力（独立运行时没有刷新脚本路径与锁）');
  return activeBridge;
}

/** 停止由 startCopilotBridge() 启动的服务（幂等）。 */
export async function stopCopilotBridge() {
  const current = activeBridge;
  if (!current) return;
  activeBridge = null;
  // 等新令牌的那个轮询是唯一的定时器；反代一停就让它收尾。
  gate?.dispose();
  gate = null;
  await current.close();
}

// ---------------------------------------------------------------- 独立运行入口

// 被宿主 import 时不自动启动；只有直接执行本文件时才自启并接管信号。
const IS_MAIN = typeof process.argv[1] === 'string'
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  startCopilotBridge().catch(() => process.exit(1));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('收到退出信号');
      const force = setTimeout(() => process.exit(0), 2000);
      force.unref?.();
      stopCopilotBridge().then(() => process.exit(0), () => process.exit(0));
    });
  }
}
