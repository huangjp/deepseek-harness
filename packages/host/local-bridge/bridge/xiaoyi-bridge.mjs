// 小艺（华为「AI空间」）→ OpenAI 兼容反代
//
// 原理：AI空间 的对话**不走 HTTP**，而是一条 WebSocket：
//   wss://xiaoyi.huawei.com/hivoice/v6/voice/ws
// 发出去一条 JSON（session 信封 + 3 个 context，问题在
// TextRecognizer/AsrRecognize.asrText 里），回来一串流式 JSON：
//   directives[].header.name === 'DisplayStreamingText' → payload.streamingText（累计全文）
//                                                       payload.reasoningText（思维链）
//   isFinal === true 表示结束
// 本服务复用同一条通道，把流式增量转成 OpenAI SSE。
//
// 凭证：`xy_token` 是**会话 cookie**，Chromium 不落盘，每次应用启动由华为 SSO 重新签发。
// 但 AI空间 的渲染进程内存里留着服务器下发的**完整 Set-Cookie 头**（含全部 5 个核心
// cookie），所以一次内存扫描就能全拿到 —— 不需要解 WebView2 的 DPAPI/AES-GCM 加密库
// （那条路只能在应用关闭时读，而没有应用就没有 token，白搭）。
// 原生部分（跨进程读内存）交给 xiaoyi-harvest.py，其余全在 Node 里做。
// 详见 xiaoyi-protocol-notes.md。
//
// 零依赖，仅用 Node 标准库。注意：**不能用全局 WebSocket** —— 内置实现不支持自定义
// 请求头，而小艺的鉴权全在 Cookie 里（只带 xy_token 会被 400），所以这里手写了一个
// 最小的 WS 客户端（node:net / node:tls + 手搓帧）。

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WS_URL = 'wss://xiaoyi.huawei.com/hivoice/v6/voice/ws';
const WS_ORIGIN = 'https://xiaoyi.huawei.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0 PCAISpace/1.1.6.303';

/** 实测最小可用集合。少任何一个都会被 400 拒绝（WAF/csrf 那几个反而不需要）。 */
const REQUIRED = ['xy_token', 'xy_deviceId', 'xy_appName', 'JSID', 'xyxp'];

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- 配置

function loadConfig() {
  const file = process.env.XIAOYI_BRIDGE_CONFIG || path.join(__dirname, 'xiaoyi.config.json');
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { console.error(`[xiaoyi] 配置解析失败 ${file}: ${e.message}`); process.exit(1); }
  }
  return cfg;
}

// 运行时状态由 startXiaoyiBridge() 装配 —— 既能 `node xiaoyi-bridge.mjs` 独立跑，
// 也能被宿主（DSH）内嵌导入。
let config = {};
let serverCfg = {};
let authCfg = {};
let chatCfg = {};
let cacheFile = '';
let harvestScript = '';
let activeBridge = null;

function initRuntime(overrides = {}) {
  const base = loadConfig();
  config = { ...base, ...overrides };
  for (const key of ['server', 'auth', 'chat']) {
    if (overrides[key] && base[key]) config[key] = { ...base[key], ...overrides[key] };
  }
  serverCfg = config.server || {};
  authCfg = config.auth || {};
  chatCfg = config.chat || {};
  cacheFile = process.env.XIAOYI_AUTH_CACHE
    || authCfg.cacheFile
    || path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || '.', 'xiaoyi-bridge', 'auth.json');
  harvestScript = authCfg.harvestScript || path.join(__dirname, 'xiaoyi-harvest.py');
  _auth = null; // 换了配置就把内存里的凭证作废
}

// ---------------------------------------------------------------- Python 定位

/** 裸名启动会依赖 PATH（Host 进程的 PATH 不保证），所以优先拼绝对路径。 */
function resolvePython() {
  const explicit = authCfg.python || process.env.XIAOYI_PYTHON;
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    for (const root of [path.join(local, 'Programs', 'Python'), path.join(local, 'Microsoft', 'WindowsApps')]) {
      if (!existsSync(root)) continue;
      for (const dir of safeReaddir(root)) {
        const exe = path.join(root, dir, 'python.exe');
        if (existsSync(exe)) candidates.push(exe);
      }
    }
  }
  for (const p of ['C:\\Python313\\python.exe', 'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe']) {
    if (existsSync(p)) candidates.push(p);
  }
  // PATH 里找一遍（不经过 shell，避免注入与解析差异）
  for (const dir of String(process.env.PATH || '').split(';')) {
    if (!dir) continue;
    const exe = path.join(dir, 'python.exe');
    if (existsSync(exe)) candidates.push(exe);
  }
  return candidates[0] || 'python';
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

// ---------------------------------------------------------------- 凭证缓存

let _auth = null; // { jar, at }

function loadCache() {
  try {
    const d = JSON.parse(readFileSync(cacheFile, 'utf8'));
    return d && d.cookies ? d : null;
  } catch { return null; }
}

function saveCache(jar) {
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ cookies: jar, savedAt: Date.now() }, null, 1), 'utf8');
  } catch (e) {
    log('[xiaoyi] 凭证缓存写入失败（不影响本次请求）:', e.message);
  }
}

function cookieHeader(jar) {
  return REQUIRED.filter((k) => jar[k]).map((k) => `${k}=${jar[k]}`).join('; ');
}

// ---------------------------------------------------------------- 收割（spawn Python）

function runHarvester() {
  return new Promise((resolve, reject) => {
    const py = resolvePython();
    const args = [harvestScript];
    if (authCfg.profileDir) args.push('--profile-dir', authCfg.profileDir);
    const child = spawn(py, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(Object.assign(new Error('收割器超时（120 秒）'), { code: 'harvest_timeout' }));
    }, 120000);
    timer.unref?.();
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`启动 Python 失败（${py}）：${e.message}`), { code: 'no_python' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop() || '';
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { /* 下面统一报错 */ }
      if (!parsed) {
        reject(Object.assign(new Error(`收割器没有返回 JSON（退出码 ${code}）${err ? '：' + err.trim().slice(-300) : ''}`),
          { code: 'harvest_bad_output' }));
        return;
      }
      if (!parsed.ok) {
        reject(Object.assign(new Error(parsed.error || '收割失败'), { code: parsed.code || 'harvest_failed' }));
        return;
      }
      resolve(parsed);
    });
  });
}

/** 收割一次，返回完整 jar（缺的字段用缓存补齐 —— 持久 cookie 一年才换一次）。 */
async function harvestAuth() {
  const h = await runHarvester();
  const prev = loadCache();
  const jar = { ...(prev?.cookies || {}), ...h.cookies };
  saveCache(jar);
  _auth = { jar, at: Date.now() };
  return jar;
}

/** 拿一份可用凭证。优先内存 → 磁盘缓存 → 收割。 */
async function ensureAuth(force = false) {
  if (!force && _auth && Date.now() - _auth.at < 10 * 60 * 1000) return _auth.jar;

  const cached = loadCache();
  if (!force && cached && cached.cookies.xy_token && REQUIRED.every((k) => cached.cookies[k])) {
    _auth = { jar: cached.cookies, at: Date.now() };
    return cached.cookies;
  }
  return harvestAuth();
}

// ---------------------------------------------------------------- 最小 WebSocket 客户端

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 建一条 WebSocket 连接。
 * 不用全局 WebSocket 的原因：内置实现不接受自定义请求头，而小艺的 Cookie 必须带。
 * @returns {Promise<{send:(s:string)=>void, close:()=>void, messages:AsyncIterable<string>, status:number}>}
 */
function wsOpen(urlStr, headers = {}, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const secure = u.protocol === 'wss:';
    const host = u.hostname;
    const port = Number(u.port || (secure ? 443 : 80));
    const key = crypto.randomBytes(16).toString('base64');

    const sock = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

    let buf = Buffer.alloc(0);
    let handshook = false;
    let finished = false;
    let frags = [];
    const queue = [];
    let waiter = null;
    let failure = null;

    const settle = (fn, arg) => { try { fn(arg); } catch { /* ignore */ } };

    const pushMsg = (text) => {
      if (waiter) { const w = waiter; waiter = null; settle(w.resolve, { value: text, done: false }); }
      else queue.push(text);
    };
    const endStream = (err) => {
      if (finished) return;
      finished = true;
      failure = err || null;
      if (waiter) {
        const w = waiter; waiter = null;
        if (err) settle(w.reject, err); else settle(w.resolve, { value: undefined, done: true });
      }
    };

    const close = () => {
      try { sock.destroy(); } catch { /* ignore */ }
      endStream(failure);
    };

    const messages = {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (finished) {
          return failure ? Promise.reject(failure) : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((res, rej) => { waiter = { resolve: res, reject: rej }; });
      },
      return() { close(); return Promise.resolve({ value: undefined, done: true }); },
    };

    const api = {
      status: 0,
      close,
      messages,
      send(text) {
        if (finished) throw new Error('连接已关闭');
        sock.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
      },
    };

    const timer = setTimeout(() => {
      close();
      if (!handshook) reject(Object.assign(new Error('WebSocket 握手超时'), { code: 'ws_timeout' }));
    }, timeoutMs);
    timer.unref?.();

    sock.on('error', (e) => {
      clearTimeout(timer);
      if (!handshook) reject(e); else endStream(e);
    });
    sock.on('close', () => {
      clearTimeout(timer);
      if (!handshook) reject(Object.assign(new Error('WebSocket 连接被关闭'), { code: 'ws_closed' }));
      else endStream(null);
    });

    sock.on(secure ? 'secureConnect' : 'connect', () => {
      const lines = [
        `GET ${u.pathname}${u.search || ''} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      for (const [k, v] of Object.entries(headers)) {
        if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${v}`);
      }
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    });

    const parseFrames = () => {
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2); off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2)); off = 10;
        }
        let mask = null;
        if (masked) {
          if (buf.length < off + 4) return;
          mask = buf.subarray(off, off + 4); off += 4;
        }
        if (buf.length < off + len) return;
        let payload = buf.subarray(off, off + len);
        if (masked) {
          const copy = Buffer.from(payload);
          for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i & 3];
          payload = copy;
        }
        buf = buf.subarray(off + len);

        if (opcode === 0x8) { close(); return; }
        if (opcode === 0x9) { try { sock.write(encodeFrame(0xA, payload)); } catch { /* ignore */ } continue; }
        if (opcode === 0xA) continue;
        if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
          frags.push(payload);
          if (fin) {
            const whole = Buffer.concat(frags);
            frags = [];
            pushMsg(whole.toString('utf8'));
          }
        }
      }
    };

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString('latin1');
        buf = buf.subarray(idx + 4);
        const status = Number((head.split(' ')[1] || '0').trim());
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head);
        const expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        if (status !== 101 || !accept || accept[1] !== expect) {
          clearTimeout(timer);
          close();
          reject(Object.assign(new Error(`小艺拒绝连接（HTTP ${status}）`), { status, code: 'ws_rejected' }));
          return;
        }
        handshook = true;
        api.status = 101;
        clearTimeout(timer);
        resolve(api);
      }
      parseFrames();
    });
  });
}

/** 客户端帧必须加掩码（RFC 6455 §5.3）。 */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// ---------------------------------------------------------------- 对话协议

function buildPayload(text, deviceId) {
  const sid = crypto.randomBytes(16).toString('hex');
  const ts = Date.now();
  return {
    session: {
      messageName: 'textRecognize', sender: 'Render', receiver: 'DM',
      deviceId, locate: 'CN', sessionId: sid, interactionId: 1, messageId: `${sid}1`,
      audioStreamId: `audiostreamsession${ts}`, dialogId: 1, appId: sid,
      devF: String(ts), fullDuplexMode: 'false', hwUid: '',
      isExperiencePlan: true, vtid: '98345457574478801web',
      dialogPageId: '', conversationId: '',
    },
    contexts: [
      {
        header: { name: 'Application', namespace: 'System' },
        payload: { apps: [{ name: '智慧语音', packageName: 'com.huawei.vassistant.web', version: '14.0.0.100' }] },
      },
      {
        header: { namespace: 'TextRecognizer', name: 'AsrRecognize' },
        payload: { vendor: 'xunfei', asrText: text },
      },
      {
        header: { namespace: 'System', name: 'ClientContext' },
        payload: { firstDialog: 'true', loginStatus: true, interrupt: false, isXiaoyiAPP: false },
      },
    ],
  };
}

/**
 * 小艺会在正文尾部掺零宽字符（`\u200b` 之类）—— 实测一次回复能带 20 个以上。
 * 它们在终端里不可见，但会污染输出与 token 计数，所以在**差分之前**统一剥掉：
 * 拿剥离后的文本做累计比较，零宽字符就永远进不了 delta。
 */
const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/g;
const clean = (s) => s.replace(ZERO_WIDTH, '');

/**
 * 问一句，边收边吐。yield ('reasoning'|'content', 增量)。
 * 注意 streamingText 是**累计全文**，所以要自己做差分。
 */
async function* streamChat(prompt, jar, { timeoutMs = 180000 } = {}) {
  const ws = await wsOpen(WS_URL, {
    Cookie: cookieHeader(jar),
    Origin: WS_ORIGIN,
    'User-Agent': UA,
  });

  const deadline = Date.now() + timeoutMs;
  let prevAnswer = '';
  let prevReason = '';

  try {
    ws.send(JSON.stringify(buildPayload(prompt, jar.xy_deviceId || crypto.randomBytes(32).toString('hex'))));

    for await (const raw of ws.messages) {
      if (Date.now() > deadline) throw Object.assign(new Error('小艺响应超时'), { code: 'chat_timeout' });

      let d;
      try { d = JSON.parse(raw); } catch { continue; }

      for (const dir of d.directives || []) {
        if ((dir.header || {}).name !== 'DisplayStreamingText') continue;
        const p = dir.payload || {};

        const r = clean(p.reasoningText || '');
        if (r && r !== prevReason) {
          const delta = r.startsWith(prevReason) ? r.slice(prevReason.length) : r;
          prevReason = r;
          if (delta) yield ['reasoning', delta];
        }

        const t = clean(p.streamingText || '');
        if (t && t !== prevAnswer) {
          const delta = t.startsWith(prevAnswer) ? t.slice(prevAnswer.length) : t;
          prevAnswer = t;
          if (delta) yield ['content', delta];
        }
      }
      if (d.isFinal) return;
    }
  } finally {
    ws.close();
  }
}

/** 把 OpenAI 的 messages 压成一段给小艺的文本。 */
function buildPrompt(messages) {
  const systems = [];
  const turns = [];
  for (const m of messages || []) {
    let content = m.content;
    if (Array.isArray(content)) content = content.map((c) => (c && c.text) || '').join('');
    content = String(content || '').trim();
    if (!content) continue;
    if (m.role === 'system') systems.push(content);
    else turns.push([m.role === 'assistant' ? '助手' : '用户', content]);
  }
  if (!turns.length) return '';
  const body = turns.length === 1 ? turns[0][1] : turns.map(([w, t]) => `${w}：${t}`).join('\n');
  return systems.length ? `（要求：${systems.join('；')}）\n\n${body}` : body;
}

// ---------------------------------------------------------------- HTTP 辅助

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': serverCfg.cors || '*',
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err.httpStatus || (err.status === 400 || err.status === 401 ? 502 : 500);
  sendJson(res, status, {
    error: { message: err.message, type: err.code || 'bridge_error', code: err.code || null },
  });
}

function authorized(req) {
  const key = serverCfg.apiKey;
  if (!key) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${key}` || auth === key;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

// ---------------------------------------------------------------- 处理器

async function handleHealth(req, res) {
  const cached = loadCache();
  const jar = cached?.cookies || {};
  const missing = REQUIRED.filter((k) => !jar[k]);
  sendJson(res, 200, {
    ok: missing.length === 0,
    token: jar.xy_token ? 'cached' : 'missing',
    missing,
    savedAt: cached?.savedAt || null,
    ageHours: cached?.savedAt ? Number(((Date.now() - cached.savedAt) / 3600000).toFixed(1)) : null,
    cacheFile,
    hint: missing.length
      ? '需要 AI空间 正在运行并打开对话页（小艺），xy_token 只能从它的 WebView2 内存里捞'
      : undefined,
  });
}

async function handleModels(req, res) {
  const now = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    object: 'list',
    data: [
      { id: 'xiaoyi-chat', object: 'model', created: now, owned_by: 'huawei-celia' },
      { id: 'xiaoyi', object: 'model', created: now, owned_by: 'huawei-celia' },
    ],
  });
}

async function handleChatCompletions(req, res) {
  let body;
  try { body = await readJson(req); } catch (e) {
    return sendError(res, Object.assign(new Error(`请求体不是合法 JSON：${e.message}`), { httpStatus: 400, code: 'bad_request' }));
  }

  const model = body.model || 'xiaoyi-chat';
  const prompt = buildPrompt(body.messages);
  if (!prompt) {
    return sendError(res, Object.assign(new Error('messages 为空'), { httpStatus: 400, code: 'bad_request' }));
  }
  const timeoutMs = chatCfg.timeoutMs || 180000;
  const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);

  // token 失效时自动重收一次再试。实测华为边缘节点对无效凭据可能回 400 / 401 / 403 / 407，
  // 都算「凭证可能过期」；429 是限流，重收也没用，不在此列。
  const STALE_STATUS = new Set([400, 401, 403, 407]);
  const run = async (jar, onDelta) => {
    let buf = '';
    let reasoning = '';
    for await (const [kind, delta] of streamChat(prompt, jar, { timeoutMs })) {
      if (kind === 'reasoning') reasoning += delta;
      else buf += delta;
      onDelta?.(kind, delta);
    }
    return { content: buf, reasoning };
  };

  const withRetry = async (onDelta) => {
    let jar = await ensureAuth();
    try {
      return await run(jar, onDelta);
    } catch (e) {
      if (!STALE_STATUS.has(e.status)) throw e;
      log(`[xiaoyi] 令牌被拒（HTTP ${e.status}），重新收割后重试`);
      jar = await ensureAuth(true);
      return await run(jar, onDelta);
    }
  };

  if (body.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': serverCfg.cors || '*',
    });
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

    res.write(chunk({ role: 'assistant', content: '' }));
    try {
      await withRetry((kind, delta) => {
        res.write(chunk(kind === 'reasoning' ? { reasoning_content: delta } : { content: delta }));
      });
    } catch (e) {
      log('[xiaoyi] 流式失败:', e.message);
      res.write(chunk({ content: `\n\n[错误] ${e.message}` }));
    }
    res.write(chunk({}, 'stop'));
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  const out = await withRetry(null);
  const message = { role: 'assistant', content: out.content };
  if (out.reasoning) message.reasoning_content = out.reasoning;
  sendJson(res, 200, {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: Math.max(1, Math.round(prompt.length / 2)),
      completion_tokens: Math.max(1, Math.round(out.content.length / 2)),
      total_tokens: Math.max(2, Math.round((prompt.length + out.content.length) / 2)),
    },
  });
}

async function handleTestPage(req, res) {
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>小艺反代</title>
<style>
 body{font:14px/1.6 system-ui,"Microsoft YaHei";max-width:820px;margin:24px auto;padding:0 16px;color:#222}
 #log{border:1px solid #ddd;border-radius:8px;padding:12px;height:340px;overflow:auto;background:#fafafa;white-space:pre-wrap}
 #q{width:100%;padding:8px;font:inherit;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
 button{margin-top:8px;padding:8px 18px;font:inherit;border:0;border-radius:6px;background:#2d6cdf;color:#fff;cursor:pointer}
 button:disabled{background:#9bb6e6;cursor:default}
 .r{color:#888}
</style>
<h2>小艺反代 · 测试</h2>
<input id="q" placeholder="问点什么，回车发送" value="用一句话介绍你自己">
<button id="go">发送</button>
<div id="log"></div>
<script>
const log=document.getElementById('log'),q=document.getElementById('q'),go=document.getElementById('go');
const add=(t,c)=>{const d=document.createElement('div');if(c)d.className=c;d.textContent=t;log.appendChild(d);log.scrollTop=log.scrollHeight;};
async function send(){
 const t=q.value.trim(); if(!t)return;
 go.disabled=true; add('我: '+t);
 try{
  const r=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({messages:[{role:'user',content:t}],stream:true})});
  const rd=r.body.getReader(),dec=new TextDecoder(); let buf='',out='',rs='';
  for(;;){const{done,value}=await rd.read(); if(done)break; buf+=dec.decode(value,{stream:true});
   let i; while((i=buf.indexOf('\\n\\n'))>=0){const line=buf.slice(0,i).trim(); buf=buf.slice(i+2);
    if(!line.startsWith('data:'))continue; const p=line.slice(5).trim(); if(p==='[DONE]')continue;
    try{const j=JSON.parse(p); if(j.error){add('错误: '+j.error.message);go.disabled=false;return;}
     const d=j.choices?.[0]?.delta||{}; if(d.reasoning_content)rs+=d.reasoning_content;
     out+=d.content||'';}catch(_){}}
  }
  if(rs)add('思考: '+rs,'r');
  add('小艺: '+(out||'(空)'));
 }catch(e){add('异常: '+e.message);}finally{go.disabled=false;}
}
go.onclick=send; q.addEventListener('keydown',e=>{if(e.key==='Enter')send();});
</script></html>`;
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
    if (!hit) {
      return sendError(res, Object.assign(new Error(`未知路由 ${req.method} ${routePath}`),
        { httpStatus: 404, code: 'not_found' }));
    }
    if (!authorized(req)) {
      return sendError(res, Object.assign(new Error('鉴权失败'), { httpStatus: 401, code: 'unauthorized' }));
    }

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
const DEFAULT_PORT = 8123;

/**
 * 启动小艺反代。宿主内嵌与独立运行（node xiaoyi-bridge.mjs）共用。
 * 监听失败时 reject —— 嵌入式宿主需要知道启动失败。
 */
export async function startXiaoyiBridge(overrides = {}) {
  initRuntime(overrides);
  if (activeBridge) return activeBridge;

  const host = serverCfg.host || DEFAULT_HOST;
  const port = serverCfg.port ?? DEFAULT_PORT;
  const server = buildServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
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

  const cached = loadCache();
  const missing = REQUIRED.filter((k) => !cached?.cookies?.[k]);
  log(`xiaoyi-bridge 已启动: http://${host}:${port}`);
  log(`测试页: http://${host}:${port}/  |  OpenAI Base URL: http://${host}:${port}/v1`);
  log(`凭证缓存: ${cacheFile}`);
  log(missing.length
    ? `凭证: 缺 ${missing.join(', ')} —— 首次请求会触发收割（需要 AI空间 开着对话页）`
    : '凭证: 已缓存');
  return activeBridge;
}

/** 停止由 startXiaoyiBridge() 启动的服务（幂等）。 */
export async function stopXiaoyiBridge() {
  const current = activeBridge;
  if (!current) return;
  activeBridge = null;
  await current.close();
}

// ---------------------------------------------------------------- 独立运行入口

const IS_MAIN = typeof process.argv[1] === 'string'
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  startXiaoyiBridge().catch((e) => { console.error(e.message); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('收到退出信号');
      const force = setTimeout(() => process.exit(0), 2000);
      force.unref?.();
      stopXiaoyiBridge().then(() => process.exit(0), () => process.exit(0));
    });
  }
}
