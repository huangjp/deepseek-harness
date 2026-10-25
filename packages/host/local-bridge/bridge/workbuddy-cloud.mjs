// WorkBuddy 云端直连后端
//
// 为什么不用本地 CLI 网关
// ---------------------
// WorkBuddy 云端（https://www.workbuddy.ai/v2/chat/completions）现在做**渠道校验**：
// 请求必须带官方客户端的那组头（X-Agent-Type / X-User-Id / X-Product / X-IDE-* /
// X-Conversation-* / X-Request-ID / X-Trace-ID …），否则一律
//
//     {"code":11128,"msg":"request illegal",
//      "displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。"}}
//
// 本地 CLI 网关的**一次性 agent** 路径（/api/v1/llm/completions）不带这些头，
// 所以走那条路的反代必然 400 —— 与账号、额度、模型都无关。
//
// 本后端直连云端：自己带上渠道头，于是既能通过校验，又完全不碰 WorkBuddy 客户端的
// 会话（不 spawn 进程、不写入用户对话、无状态）。
//
// token 从哪来
// -----------
// access token 由 WorkBuddy 桌面端 daemon 持有，磁盘上是加密的（CLI 独立进程解不开：
// "missing-key role=cbc"）。daemon 内存里是明文，所以用 workbuddy-token.py 收割 ——
// 与 xiaoyi-harvest.py 从 AI空间 进程内存收 cookie 是同一套路数。
//
// 云端接口的三个硬要求（实测）
// -----------------------------
// 1. 必须 `stream: true`（非流式返回 code 11101 "Non-stream chat request is currently not supported"）；
// 2. messages 的**第一条必须是 system**（否则 code 11128 "first message is not system prompt"）；
// 3. 必须带渠道头（否则 code 11128 "request illegal"）。
//
// 返回格式与 OpenAI 完全一致（chat.completion.chunk + delta.content /
// delta.tool_calls / delta.reasoning_content），所以这里几乎只是直通。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 把打包环境下的 ASAR 虚拟路径改写成 ASAR 之外的真实磁盘路径。
 *
 * python 收割器是外部进程，完全不认识 ASAR：它拿到 ASAR 里的路径只会静默失败。
 * （与宿主侧、backends.mjs 里的同名函数成对。）
 *
 * @param {string} filePath - 从模块位置推导出的文件系统路径。
 * @returns {string} 外部进程可用的真实磁盘路径。
 */
function resolveUnpackedPath(filePath) {
  const marker = /([\\/])app\.asar\1/;
  const match = marker.exec(filePath);
  if (!match) return filePath;
  const separator = match[1];
  const head = filePath.slice(0, match.index);
  const tail = filePath.slice(match.index + match[0].length);
  return `${head}${separator}app.asar.unpacked${separator}${tail}`;
}

const DEFAULT_ENDPOINT = 'https://www.workbuddy.ai/v2/chat/completions';

/** 官方客户端的渠道头。键名与 CLI 里的常量一一对应（见 codebuddy-lite-wb.mjs 的 header 常量表）。 */
const CHANNEL_HEADERS = {
  'X-Trace-ID': null,              // 请求级：本次请求 id
  'X-Request-ID': null,
  'X-Root-Request-ID': null,
  'X-Conversation-ID': null,
  'X-Conversation-Request-ID': null,
  'X-Conversation-Message-ID': null,
  'X-Agent-Type': 'main',
  'X-Agent-Intent': 'craft',
  'X-Agent-Purpose': 'conversation',
  'X-IDE-Type': 'WorkBuddy',
  'X-IDE-Name': 'WorkBuddy AI',
  'X-IDE-Version': '5.8.4',
  'X-Product': 'WorkBuddy',
  'X-Product-Version': '5.8.4',
  'X-Private-Data': 'false',
};

/** 兜底 system prompt：云端要求第一条消息是 system，没有就补一条。 */
const FALLBACK_SYSTEM = 'You are a helpful assistant.';

/** 内存里的 token 缓存时长。token 本身有效期很长（实测 exp 在一年后），这里只是省掉重复收割。 */
const TOKEN_TTL_MS = 30 * 60 * 1000;

/** 裸名启动依赖 PATH（宿主进程的 PATH 不保证），所以优先拼绝对路径。 */
function resolvePython(cfg) {
  const explicit = cfg.python || process.env.WORKBUDDY_PYTHON;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    for (const root of [path.join(local, 'Programs', 'Python'), path.join(local, 'Microsoft', 'WindowsApps')]) {
      if (!existsSync(root)) continue;
      let dirs = [];
      try { dirs = readdirSync(root); } catch { dirs = []; }
      for (const dir of dirs) {
        const exe = path.join(root, dir, 'python.exe');
        if (existsSync(exe)) candidates.push(exe);
      }
    }
  }
  for (const exe of candidates.sort().reverse()) {
    try {
      const out = spawnSyncCapture(exe, ['-c', 'import zstandard']);
      if (out === 0) return exe;
    } catch { /* 试下一个 */ }
  }
  return 'python';
}

/** 同步跑一条命令，只取退出码。 */
function spawnSyncCapture(cmd, args) {
  try {
    return spawnSync(cmd, args, { windowsHide: true, stdio: 'ignore' }).status ?? 1;
  } catch {
    return 1;
  }
}

/**
 * UUIDv7 —— 云端那几个 id（conversation / request / trace）都是这个形态。
 * 顺序部分用毫秒时间戳，保证同一进程内单调递增。
 */
function uuid7() {
  const ts = BigInt(Date.now()) & 0xffffffffffffn;
  const rand = BigInt(Math.floor(Math.random() * 0x100000000)) & 0xffffffffn;
  const bytes = Buffer.alloc(16);
  // 前 48 位是毫秒时间戳（云端那几类 id 都是 01a1… 开头，就是这个时间戳）。
  bytes.writeUInt16BE(Number(ts >> 32n), 0);
  bytes.writeUInt32BE(Number(ts & 0xffffffffn), 2);
  // 第 7 段的最高位固定为 7（版本号），云端按这个认 UUIDv7。
  // 随机部分只能占剩下的 12 位 —— 不掩的话高位会盖掉版本号。
  bytes.writeUInt16BE(0x7000 | Number((rand >> 16n) & 0x0fffn), 6);
  bytes.writeUInt16BE(Number(rand & 0xffffn), 8);
  bytes.writeUInt16BE(Math.floor(Math.random() * 0x10000), 10);
  bytes.writeUIntBE(Math.floor(Math.random() * 0x100000000), 12, 4);
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * 直连 WorkBuddy 云端的后端。
 *
 * 接口与 {@link ServeBackend} 一致，所以 bridge.mjs 的上层逻辑（工具文本协议、
 * SSE 分帧、并发闸门）完全不用改。
 */
export class WorkBuddyCloudBackend {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.endpoint = cfg.endpoint || DEFAULT_ENDPOINT;
    this.model = cfg.model || 'deepseek-v4.1-flash';
    this.timeoutMs = cfg.timeoutMs ?? 180000;
    this.userAgent = cfg.userAgent
      || 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0';
    this.harvestScript = cfg.harvestScript
      || resolveUnpackedPath(path.join(__dirname, 'workbuddy-token.py'));
    this._token = null;
    this._tokenAt = 0;
  }

  /** 启动自检，供 /health 用。 */
  async check() {
    const base = {
      endpoint: this.endpoint,
      model: this.model,
      harvestScript: this.harvestScript,
      python: resolvePython(this.cfg),
      ok: false,
    };
    try {
      const cred = await this.ensureToken(true);
      base.ok = true;
      base.uid = cred.uid;
      base.tokenExpiresAt = cred.expiresAt || 0;
      return base;
    } catch (e) {
      base.error = String(e?.message || e).split('\n')[0];
      return base;
    }
  }

  /** 收割一次 access token。 */
  runHarvester() {
    return new Promise((resolve, reject) => {
      const py = resolvePython(this.cfg);
      const child = spawn(py, [this.harvestScript], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        reject(Object.assign(new Error('token 收割超时（120 秒）'), { code: 'harvest_timeout' }));
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

  /** 拿一份可用 token。优先内存缓存 → 重新收割。 */
  async ensureToken(force = false) {
    if (!force && this._token && Date.now() - this._tokenAt < TOKEN_TTL_MS) return this._token;
    const cred = await this.runHarvester();
    this._token = cred;
    this._tokenAt = Date.now();
    return cred;
  }

  /** 构造渠道头。 */
  buildHeaders({ token, uid, model }) {
    const reqId = uuid7();
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': this.userAgent,
    };
    for (const [name, value] of Object.entries(CHANNEL_HEADERS)) {
      if (value === null) continue;
      headers[name] = value;
    }
    headers['X-User-Id'] = uid || '';
    headers['X-Request-ID'] = reqId;
    headers['X-Trace-ID'] = reqId;
    headers['X-Root-Request-ID'] = reqId;
    headers['X-Conversation-ID'] = uuid7();
    headers['X-Conversation-Request-ID'] = uuid7();
    headers['X-Conversation-Message-ID'] = reqId;
    headers['X-Model-ID'] = model || this.model;
    return headers;
  }

  /**
   * 把 OpenAI 的 messages 规整成云端要的形状：**第一条必须是 system**。
   *
   * @param {Array<{role?: string, content?: unknown}>} [messages]
   * @param {string} [systemPrompt]
   * @param {string} [prompt]
   * @returns {Array<{role: string, content: unknown}>}
   */
  static normalizeMessages({ messages, systemPrompt, prompt }) {
    let msgs = Array.isArray(messages) ? messages.slice() : [];
    if (!msgs.length) {
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      if (prompt) msgs.push({ role: 'user', content: prompt });
    }
    if (msgs.length && msgs[0].role !== 'system') {
      msgs.unshift({ role: 'system', content: FALLBACK_SYSTEM });
    }
    return msgs;
  }

  /**
   * 一次模型调用。
   *
   * @param {object} options
   * @param {Array<{role?: string, content?: unknown}>} [options.messages] OpenAI 形态的完整消息。
   * @param {string} [options.systemPrompt]
   * @param {string} [options.prompt]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   * @param {(chunk: string) => void} [options.onDelta]
   * @param {Array<object>} [options.tools] OpenAI 形态的 tools；给了就走**原生** function calling。
   * @param {string} [options.toolChoice]
   * @returns {Promise<{text: string, toolCalls: Array<object>|null, usage: object|null, sessionId: string|null, costUsd: null, durationMs: number, raw: object}>}
   */
  async complete({ messages, systemPrompt, prompt, tools, toolChoice, model, timeoutMs, signal, onDelta } = {}) {
    const started = Date.now();
    const useModel = model || this.model;
    const msgs = WorkBuddyCloudBackend.normalizeMessages({ messages, systemPrompt, prompt });
    if (!msgs.length) {
      throw Object.assign(new Error('消息为空'), { code: 'invalid_request', httpStatus: 400 });
    }

    const body = {
      model: useModel,
      messages: msgs,
      stream: true,
      max_tokens: this.cfg.maxTokens ?? 32000,
      temperature: this.cfg.temperature ?? 1,
    };
    // 云端原生支持 function calling（实测会回标准 delta.tool_calls）。走原生时**不要**再
    // 往提示词里塞「请输出 bridge_tool_calls」那套文本协议 —— 两套并存会让模型一半概率
    // 去输出纯文本、一半概率去输出原生 tool_calls，而解析器只认其中一种。
    const nativeTools = Array.isArray(tools) && tools.length > 0;
    if (nativeTools) {
      body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs ?? this.timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    let text = '';
    let reasoning = '';
    let usage = null;
    let last = null;
    // 原生 tool_calls 是**分片**下发的：第一个分片带 id 与 function.name，后续分片只带
    // arguments 的一小段。按 index 归并，arguments 直接拼接。
    const toolAcc = new Map();
    try {
      const cred = await this.ensureToken();
      let res = await this.post(body, this.buildHeaders({ token: cred.token, uid: cred.uid, model: useModel }), ctl.signal);
      if (res.status === 401 || res.status === 403) {
        // token 过期/被换：重新收割一次再试。
        const fresh = await this.ensureToken(true);
        res = await this.post(body, this.buildHeaders({ token: fresh.token, uid: fresh.uid, model: useModel }), ctl.signal);
      }
      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        throw this.mapError(res.status, raw);
      }
      const parsed = await this.consumeSse(res, (chunk) => {
        if (chunk.reasoning) reasoning += chunk.reasoning;
        if (chunk.content) {
          text += chunk.content;
          onDelta?.(chunk.content);
        }
        if (chunk.usage) usage = chunk.usage;
        for (const tc of chunk.toolCalls || []) {
          const index = Number.isInteger(tc?.index) ? tc.index : toolAcc.size;
          const cur = toolAcc.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) cur.id = tc.id;
          if (tc.type) cur.type = tc.type;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          toolAcc.set(index, cur);
        }
      });
      last = parsed;
      const toolCalls = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => ({
          id: c.id || `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          type: c.type || 'function',
          function: { name: c.function.name, arguments: c.function.arguments || '{}' },
        }))
        .filter((c) => c.function.name);
      return {
        text,
        toolCalls: toolCalls.length ? toolCalls : null,
        usage: usage || null,
        sessionId: null,
        costUsd: null,
        durationMs: Date.now() - started,
        raw: last,
        reasoning,
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        throw Object.assign(new Error(`调用 WorkBuddy 云端超时（${timeoutMs ?? this.timeoutMs}ms）`), {
          code: 'upstream_timeout', httpStatus: 504, retriable: true,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /** 发请求。 */
  async post(body, headers, signal) {
    return fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }

  /** 把云端的错误响应映射成带诊断信息的异常。 */
  mapError(status, raw) {
    let detail = raw.slice(0, 300);
    let code = '';
    let msg = '';
    try {
      const j = JSON.parse(raw);
      code = String(j.code ?? '');
      msg = String(j.msg ?? '');
      detail = msg || detail;
    } catch { /* 非 JSON 响应 */ }
    if (status === 400 && code === '11128') {
      return Object.assign(new Error(
        `WorkBuddy 云端拒绝了这次调用（渠道校验失败）：${detail || 'request illegal'}。`
        + '云端要求请求带官方客户端的渠道头；若经过本地 CLI 网关转发，那条路径不带这些头，必然被拒。'
      ), { code: 'upstream_rejected', httpStatus: 502, retriable: false });
    }
    if (status === 400 && code === '11101') {
      return Object.assign(new Error(
        `WorkBuddy 云端拒绝非流式请求（${detail}）。`
      ), { code: 'upstream_rejected', httpStatus: 502, retriable: false });
    }
    if (status === 401 || status === 403) {
      return Object.assign(new Error(`WorkBuddy 云端鉴权失败：${detail || status}`), {
        code: 'upstream_auth', httpStatus: 502, retriable: false,
      });
    }
    if (status === 429) {
      return Object.assign(new Error(`WorkBuddy 云端限流：${detail || status}`), {
        code: 'upstream_rate_limited', httpStatus: 502, retriable: true,
      });
    }
    return Object.assign(new Error(`WorkBuddy 云端返回 HTTP ${status}：${detail}`), {
      code: 'upstream_error', httpStatus: 502, retriable: status >= 500,
    });
  }

  /**
   * 读 SSE 流。
   *
   * 云端的帧是标准 OpenAI chunk：`data: {"choices":[{"delta":{"content":"..."}}]}`，
   * 前面还可能有一行 `: heartbeat` 注释。
   */
  async consumeSse(res, onChunk) {
    const reader = res.body?.getReader?.();
    if (!reader) {
      const text = await res.text();
      return { raw: text };
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let last = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        last = obj;
        const choice = obj?.choices?.[0];
        const delta = choice?.delta || {};
        onChunk({
          content: typeof delta.content === 'string' ? delta.content : '',
          reasoning: typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '',
          toolCalls: Array.isArray(delta.tool_calls) ? delta.tool_calls : null,
          usage: obj.usage || null,
        });
      }
    }
    return { raw: last };
  }
}
