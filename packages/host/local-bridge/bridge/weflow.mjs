// WeFlow 对接层。
//
// WeFlow 是一个纯本地的微信聊天记录查看/分析工具，在「设置 -> API 服务 -> 启动服务」
// 后会监听 http://127.0.0.1:5031，把本地消息能力映射成 HTTP 接口。
//
// 说明：WeFlow 的 HTTP API 官方标注为"早期阶段，接口可能变动"，不同版本的
// 路径与字段名可能不同。因此这里把「端点路径」和「查询参数名」都做成可配置，
// 并把响应解析写成容错模式（数组 / {data:[]} / {messages:[]} 都能吃）。

import { classifyCliFailure } from './backends.mjs';

export class WeFlowClient {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.base = (cfg.baseUrl || 'http://127.0.0.1:5031').replace(/\/$/, '');
    this.ep = cfg.endpoints || {};
    this.q = cfg.query || {};
  }

  #headers() {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }

  async #get(pathname, params = {}, timeoutMs = 15000) {
    const url = new URL(this.base + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: this.#headers(), signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) {
        throw Object.assign(new Error(`WeFlow 返回 HTTP ${res.status}`), {
          code: 'weflow_error', httpStatus: 502, retriable: res.status >= 500,
        });
      }
      try { return JSON.parse(text); } catch { return { raw: text }; }
    } catch (err) {
      if (err.name === 'AbortError') {
        throw Object.assign(new Error('WeFlow 请求超时'), { code: 'weflow_timeout', httpStatus: 504, retriable: true });
      }
      if (err.code === 'weflow_error') throw err;
      throw Object.assign(new Error(`无法连接 WeFlow（${this.base}）：${err.message}`), {
        code: 'weflow_unreachable', httpStatus: 502, retriable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    if (!this.cfg.enabled) return { ok: false, enabled: false, baseUrl: this.base };
    try {
      await this.#get(this.ep.health || '/', {}, 5000);
      return { ok: true, enabled: true, baseUrl: this.base };
    } catch (err) {
      return { ok: false, enabled: true, baseUrl: this.base, error: err.message };
    }
  }

  async listSessions() {
    return await this.#get(this.ep.sessions || '/api/sessions');
  }

  async fetchMessages({ sessionId, talker, startTime, endTime, limit } = {}) {
    const params = {};
    if (sessionId) params[this.q.sessionId || 'sessionId'] = sessionId;
    if (talker) params[this.q.talker || 'talker'] = talker;
    if (startTime) params[this.q.startTime || 'startTime'] = startTime;
    if (endTime) params[this.q.endTime || 'endTime'] = endTime;
    if (limit) params[this.q.limit || 'limit'] = limit;
    return await this.#get(this.ep.messages || '/api/messages', params, 30000);
  }
}

/** 容错地从一个未知结构的响应里取出消息数组。 */
export function extractMessageArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['messages', 'data', 'list', 'items', 'records', 'result']) {
    const v = payload[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const nested = extractMessageArray(v);
      if (nested.length) return nested;
    }
  }
  return [];
}

/** 把一条原始消息规整成 {time, speaker, text}。字段名做了多路兜底。 */
export function normalizeMessage(m, index) {
  if (typeof m === 'string') return { time: '', speaker: '', text: m };
  if (!m || typeof m !== 'object') return null;

  const pick = (...keys) => {
    for (const k of keys) {
      const v = m[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
    return '';
  };

  let text = pick('text', 'content', 'msg', 'message', 'body', 'plainText');
  // 非文本消息（图片/语音/链接等）保留一个占位描述，避免总结时丢失上下文
  if (!text) {
    const type = pick('type', 'msgType', 'messageType') || 'unknown';
    text = `[${type}]`;
  }

  return {
    time: pick('time', 'timestamp', 'createTime', 'date', 'sendTime'),
    speaker: pick('speaker', 'sender', 'from', 'nickName', 'displayName', 'talker', 'name') || `#${index + 1}`,
    text,
  };
}

export function normalizeMessages(raw) {
  const arr = extractMessageArray(raw);
  const out = [];
  arr.forEach((m, i) => {
    const n = normalizeMessage(m, i);
    if (n && n.text) out.push(n);
  });
  return out;
}

/**
 * 裁剪消息集：从两端保留最新内容，控制 token 规模。
 * 优先保留靠后的消息（总结通常更关心近况），但保留开头一小段作为背景。
 */
export function trimMessages(messages, { maxMessages = 800, maxChars = 60000 } = {}) {
  let list = messages;
  if (list.length > maxMessages) {
    const head = list.slice(0, Math.floor(maxMessages * 0.15));
    const tail = list.slice(-(maxMessages - head.length));
    list = [...head, { time: '', speaker: '', text: `…（中间省略 ${messages.length - maxMessages} 条）…` }, ...tail];
  }

  const render = (arr) => arr.map((m) => `${m.time ? `[${m.time}] ` : ''}${m.speaker}: ${m.text}`).join('\n');
  let text = render(list);
  if (text.length <= maxChars) return { list, text, truncated: list !== messages };

  // 超长则按比例截断尾部，并明确告知模型内容被裁剪
  const head = list.slice(0, Math.max(1, Math.floor(list.length * 0.15)));
  const tailCount = Math.max(1, Math.floor(list.length * 0.85));
  const tail = list.slice(-tailCount);
  const merged = [...head, { time: '', speaker: '', text: '…（中间内容因长度限制被省略）…' }, ...tail];
  text = render(merged);
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（内容已截断）…`;
  return { list: merged, text, truncated: true };
}

/** 构造总结用的用户提示词。 */
export function buildSummaryPrompt({ messagesText, session, style, language, messageCount }) {
  const scope = session?.sessionId || session?.talker || session?.name || '未指定会话';
  const styleHint = style === 'brief'
    ? '风格：极简，overview 不超过 2 句，topics 最多 3 条，keyPoints 最多 5 条。'
    : '风格：详细，尽量覆盖全部有价值的信息点。';
  const langHint = language === 'en' ? '用英文输出。' : '用简体中文输出。';

  return [
    `请总结下面这段微信聊天记录（共 ${messageCount} 条，会话：${scope}）。`,
    langHint,
    styleHint,
    '要求：只依据聊天内容本身，不要编造未出现的信息；actionItems 没有就返回空数组；notableQuotes 最多 5 条。',
    '',
    '===== 聊天记录开始 =====',
    messagesText,
    '===== 聊天记录结束 =====',
  ].join('\n');
}

/**
 * 用提示词约束 JSON 输出。
 *
 * 为什么不用 CLI 的 --json-schema：实测该参数会让进程挂死（90s 无任何输出），
 * 属于当前版本不可用的能力，因此改为"文字约束 + 宽松解析"。
 */
export function buildSchemaInstruction(schema) {
  if (!schema) return '';
  return [
    '输出格式要求（必须严格遵守）：',
    '1. 只输出一个 JSON 对象，不要输出任何解释性文字。',
    '2. 不要使用 Markdown 代码围栏。',
    '3. JSON 必须满足下面的 JSON Schema：',
    JSON.stringify(schema),
  ].join('\n');
}

/** 尝试把模型输出解析成 JSON（容忍 ```json 围栏和前后杂讯）。 */
export function parseJsonLoose(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 继续尝试截取 */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

export { classifyCliFailure };
