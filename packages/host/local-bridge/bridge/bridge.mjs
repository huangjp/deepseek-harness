// WeFlow → 本机 API 适配服务 → CodeBuddy / WorkBuddy → 返回总结
//
// 对外提供三类接口：
//   1. OpenAI 兼容层   POST /v1/chat/completions（支持流式与非流式）、GET /v1/models
//   2. 业务层          POST /summarize      —— 直接产出结构化总结 JSON
//   3. 运维层          GET  /health         —— 同时探测 CLI 与 WeFlow 的可用性
//
// 零依赖，仅用 Node 标准库。默认监听 127.0.0.1:8787。

import http from 'node:http';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBackend, Semaphore, classifyCliFailure, sanitizeOwnEnv } from './backends.mjs';
import {
  WeFlowClient, normalizeMessages, trimMessages,
  buildSummaryPrompt, buildSchemaInstruction, parseJsonLoose,
} from './weflow.mjs';
import {
  buildToolInstruction, completeWithToolCalls, toolCallFailureText, toolTurnText, TRANSCRIPT_TRAILER,
} from './toolprompt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 配置

function loadConfig() {
  const file = process.env.BRIDGE_CONFIG || path.join(__dirname, 'bridge.config.json');
  let cfg = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`[bridge] 配置文件解析失败：${file}\n${err.message}`);
      process.exit(1);
    }
  }
  // 允许用环境变量覆盖关键项，便于临时切换后端
  if (process.env.BRIDGE_BACKEND) cfg.backend = process.env.BRIDGE_BACKEND;
  if (process.env.BRIDGE_PORT) cfg.server = { ...cfg.server, port: Number(process.env.BRIDGE_PORT) };
  if (process.env.BRIDGE_API_KEY) cfg.server = { ...cfg.server, apiKey: process.env.BRIDGE_API_KEY };
  return cfg;
}

// 运行时状态。原先是模块级 const，现改为由 startBridge() 装配 ——
// 这样本文件既能独立 `node bridge.mjs` 运行，也能被宿主（DSH）内嵌导入。
let config = {};
let serverCfg = {};
let summaryCfg = {};
let backend = null;
let weflow = null;
let gate = null;
let _removedEnv = [];
let log = (...args) => console.log(new Date().toISOString(), ...args);

/**
 * 装配运行时状态。必须在创建后端之前做，而且必须"先取值、再清除"：
 *   - SERVER__PORT / CODEBUDDY_GATEWAY_PASSWORD 是客户端给会话注入的信息，
 *     要在删掉前先捞出来，作为**兜底候选**并入配置（见下）。
 *   - 而 CODEBUDDY_SERVICE_PROXY_URL 指向的是**上一轮会话**的内部代理地址，
 *     客户端重启后它就是个死端口；留着它会让网关转发 LLM 请求时
 *     报 `upstream connect failed ... (os error 10061)`，且该报错来自客户端
 *     Rust 侧，在本项目代码里搜不到，极具迷惑性。
 *
 * 为什么是"兜底"而不是"覆盖"：客户端每次重启端口/密码都会变，环境变量里留下的
 * 往往是**上一轮**的值（实测 config 里的密码能通、env 里的返回 AUTH_REQUIRED）。
 * 所以这里把 env 值并入候选列表，最终由 ServeBackend 的探测逻辑实测决定用哪个。
 *
 * @param {object} [overrides] 宿主直接注入的配置，优先级高于配置文件与环境变量。
 */
function initRuntime(overrides = {}) {
  const base = loadConfig();
  config = { ...base, ...overrides };
  // 已知子对象做浅合并：宿主只传一个字段（例如只改 server.port）时，
  // 不能把整块配置顶掉 —— 那会连 serve.agentName 这类必填项一起丢掉。
  for (const key of ['server', 'serve', 'cli', 'openai', 'weflow', 'summary']) {
    if (overrides[key] && base[key]) config[key] = { ...base[key], ...overrides[key] };
  }

  const _envPort = process.env.SERVER__PORT;
  const _envPassword = process.env.CODEBUDDY_GATEWAY_PASSWORD;
  if (_envPort) {
    const cfgPort = Number(config.serve?.port) || null;
    const extra = [Number(_envPort)].filter((p) => p && p !== cfgPort);
    config.serve = {
      ...(config.serve || {}),
      port: cfgPort ?? Number(_envPort),
      portFallbacks: [...new Set([...(config.serve?.portFallbacks || []), ...extra])],
    };
  }
  if (_envPassword) {
    config.serve = { ...(config.serve || {}), envPassword: _envPassword };
  }
  _removedEnv = sanitizeOwnEnv();

  serverCfg = config.server || {};
  summaryCfg = config.summary || {};
  // 告诉后端「本服务自己监听的端口」，让端口扫描把自己排除掉
  // （否则每轮扫描都会打到自己身上，刷出 404 噪音）。
  if (config.serve) {
    config.serve = { ...config.serve, selfPort: serverCfg.port || 8787 };
  }
  backend = createBackend(config);
  weflow = new WeFlowClient(config.weflow || {});
  gate = new Semaphore(config.cli?.maxConcurrent ?? 2);
}

/** 当前后端实际使用的模型名（不同后端配置项不同，统一在这里取）。 */
function activeModel() {
  if (config.backend === 'serve') return config.serve?.model || 'deepseek-v4.1-flash';
  if (config.backend === 'wbcloud') return config.wbcloud?.model || 'deepseek-v4.1-flash';
  if (config.backend === 'openai') return config.openai?.model || 'default';
  if (config.backend === 'mock') return 'mock';
  return config.cli?.model || 'default';
}

// ---------------------------------------------------------------- HTTP 工具

const MAX_BODY = 8 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { httpStatus: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
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

/** 统一的错误响应；对 OpenAI 路径额外给出兼容的 error 结构。 */
function sendError(res, err) {
  const status = err.httpStatus || 500;
  sendJson(res, status, {
    error: {
      message: err.message || '内部错误',
      type: err.code || 'internal_error',
      code: err.code || 'internal_error',
      retriable: Boolean(err.retriable),
    },
  });
}

function authorized(req) {
  const key = serverCfg.apiKey;
  if (!key) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${key}` || h === key;
}

// ---------------------------------------------------------------- 请求编排

/** 支持的图片 MIME → 落盘扩展名。 */
const IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

/**
 * 解析 data URL 形式的图片。
 *
 * 远程 http(s) 图片 URL 这里不下载（避免让本服务变成任意 URL 的抓取器），
 * 只记一条日志后跳过 —— 明确跳过好过静默丢弃。
 * @param {string} url 图片 URL。
 * @returns {{mime: string, base64: string}|null} 解析结果，失败为 null。
 */
function decodeImageUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m) {
    if (/^https?:/i.test(url)) log(`[图片] 暂不支持远程图片 URL，已跳过：${url.slice(0, 80)}`);
    return null;
  }
  return { mime: m[1] || 'image/png', base64: m[2] };
}

/**
 * 从 content 里拆出文本与图片。
 *
 * 原实现只 `filter((b) => b?.type === 'text')`，**图片块被静默丢弃** ——
 * 这正是「配置自定义模型后模型看不见图」的根因。这里把图片原样收集出来，
 * 由 invokeModel 按后端能力决定怎么送达（见 {@link deliverImages}）。
 * @param {unknown} content 字符串，或 OpenAI / Anthropic 风格的 content block 数组。
 * @returns {{text: string, images: Array<{mime: string, base64: string}>}} 文本与图片。
 */
function splitContentParts(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const texts = [];
  const images = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text);
      continue;
    }
    // OpenAI 风格：{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
    if (b.type === 'image_url') {
      const url = b.image_url?.url;
      if (typeof url === 'string') {
        const img = decodeImageUrl(url);
        if (img) images.push(img);
      }
      continue;
    }
    // Anthropic 风格：{ type: 'image', source: { type: 'base64', media_type, data } }
    if (b.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string') {
      images.push({ mime: b.source.media_type || 'image/png', base64: b.source.data });
    }
  }
  return { text: texts.join(''), images };
}

/**
 * 把 OpenAI 风格的 messages 压成单条提示词。
 *
 * 需要特殊处理两类消息，否则多轮工具调用会丢上下文：
 *   - assistant 带 tool_calls（内容可能为空）
 *   - role: 'tool' 的工具执行结果
 *
 * 图片不再被丢弃，而是收集进返回值 `images`。
 * @param {Array<object>} messages OpenAI 风格消息数组。
 * @returns {{systemPrompt: string, prompt: string, images: Array<{mime: string, base64: string}>}}
 */
function messagesToPrompt(messages = []) {
  const systemParts = [];
  const convo = [];
  const images = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const { text: content, images: messageImages } = splitContentParts(m.content);
    if (messageImages.length) images.push(...messageImages);

    if (m.role === 'system') {
      if (content) systemParts.push(content);
      continue;
    }
    // 工具轮次（外部执行结果 / 助手表达过的调用意图）必须回放，否则多轮工具调用会丢
    // 上下文。措辞刻意避开"调用工具"字样：见 toolprompt.mjs 顶部注释，那会诱发
    // agent 层的原生 function calling，进而抛 Tool xxx not found。
    const turn = toolTurnText(m, content);
    if (turn !== null) {
      convo.push(turn);
      continue;
    }
    if (!content) continue;
    convo.push(`${m.role === 'assistant' ? '助手' : '用户'}: ${content}`);
  }
  return { systemPrompt: systemParts.join('\n\n'), prompt: convo.join('\n\n'), images };
}

// 工具协议（清单渲染、意图格式、解析重试、历史回放）在 ./toolprompt.mjs，与 Copilot
// 通道共用一份实现 —— 两条通道面对的是同一个文本协议、同一类模型生成缺陷。
//
// 本通道特殊之处只有一点：`/api/v1/llm/completions` 背后不是"纯模型"，而是
// AgentService.runOneTimeWithOverrides() 加载的完整 agent，它自带原生工具集且 provider
// 支持原生 function calling，而 overrides **覆盖不了 agent.tools**。所以提示词里一旦
// 出现"你可以调用工具"这类措辞，模型会发起原生调用，agent 去自己的白名单里查找 ——
// 找不到就抛 `Tool xxx not found in agent create.`，找得到则耗尽轮次抛
// `Max turns (N) exceeded`。这就是下面 BASE_INSTRUCTION 必须无条件置顶的原因。

/**
 * 无条件注入的基础声明。
 *
 * 必须满足两点，缺一不可（都是实测踩出来的）：
 *   1) **无条件**注入 —— 只在带 tools 时注入是不够的。不带 tools 的请求会退回 agent 自己的
 *      instructions，create agent 随即自主发起原生工具调用，报 `Max turns (N) exceeded`。
 *   2) 放在 system prompt **最前面** —— 放在末尾时，会被上游项目那套动辄近万字符、
 *      且反复强调"必须调用 xx 工具"的业务提示词淹没，压制不住。
 */
const BASE_INSTRUCTION = [
  '【运行环境声明（最高优先级，覆盖后面的一切描述）】',
  '你运行在一个纯文本补全通道里，**不是** agent，也**没有任何工具/函数/函数调用能力**。',
  '本通道不会也无法执行任何工具。因此，无论后文怎么描述：',
  '  1. 绝对不要输出 tool_calls、function_call 或任何函数调用格式；',
  '  2. 绝对不要声称"我已调用/正在调用/准备调用某个工具"；',
  '  3. 后文提到的所有工具都由**外部调用方**持有和执行，你只负责用纯文本表达意图。',
  '违反上述任何一条都会导致本次请求直接失败。',
].join('\n');

/**
 * 带图片时的系统指令。
 *
 * 不能复用 BASE_INSTRUCTION —— 它写着「你没有任何工具调用能力、绝对不要调用工具」，
 * 而图片在这条链路上**只能靠 agent 自己用文件读取工具（Read）打开**（上游网关的
 * completions 接口只接受字符串 prompt，没有图片字段）。两条指令直接矛盾时，模型会
 * 服从"最高优先级"那条，于是**永远不去读图**，表现为「未看到图片」或干脆编造内容
 * （实测：编出过加密货币行情、Kimi 界面等）。所以带图时必须换成下面这条。
 */
const IMAGE_INSTRUCTION = [
  '【运行环境声明（最高优先级，覆盖后面的一切描述）】',
  '本次请求附带了图片，图片已落盘到本机。**你唯一能看到图片的方式是用文件读取工具（Read）打开它。**',
  '  1. 必须先用 Read 工具读取后文列出的每一个图片路径，再回答；不要跳过这一步。',
  '  2. 读图是本次任务允许的唯一工具调用；除此之外不要调用任何其它工具。',
  '  3. 不要凭空猜测或编造图片内容。确实读不到时，明确说「读不到图片」，不要编造。',
  '  4. 需要表达下游工具调用意图时，仍按后文约定输出 bridge_tool_calls JSON，不要使用原生 tool_calls 格式。',
].join('\n');

// 工具调用的解析（含 JSON 修复）在 ./toolcalls.mjs：模型输出的 bridge_tool_calls
// 经常括号不配对，必须修复后重试解析，否则半截 JSON 会被当正文吐回下游。

/**
 * 带工具调用的一次（必要时两次）模型调用，共用 `toolprompt.mjs` 的重试与判定。
 *
 * 关键：解析失败**不能**直接把文本当"最终回答"下发 —— 下游 agent 会以为任务已完成，
 * 于是出现"模型说改好了、其实什么都没执行"。
 * @param {object} options 本次调用。
 * @returns {Promise<{outcome: object, text: string, usage: object|undefined}>}
 */
function chatWithTools({ prompt, systemPrompt, model, signal, images }) {
  return completeWithToolCalls({
    systemPrompt,
    hasTools: true,
    log,
    invoke: sys => invokeModel({ prompt, systemPrompt: sys, model, signal, images }),
  });
}

/**
 * 把图片落盘，并生成一段交给上游 agent「自己读文件」的指令块。
 *
 * 为什么不直接传图：serve 后端的上游 `/api/v1/llm/completions` 只接受
 * `userPrompt: string`（其实现里对 userPrompt 调 `.substring()`，传数组必炸），
 * 物理上没有传图通道；cli 后端同样没有图片入参。而这两个上游背后都是
 * **带文件工具的完整 agent**，所以把图片落到本机临时目录、把路径写进提示词，
 * agent 就能用读图能力看到内容。
 * @param {Array<{mime: string, base64: string}>} images 待落盘的图片。
 * @returns {{block: string, dir: string|null}} 提示词片段与临时目录（无图为 null）。
 */
function materializeImages(images) {
  if (!images?.length) return { block: '', dir: null };
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-bridge-img-'));
  // 文件名也要唯一：上游的 Read 工具会做「内容未变化」去重，同名文件第二次读只返回
  // 占位提示而不返回像素（实测）。每次请求都换个非重复的名字，绕开它。
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const lines = images.map((img, i) => {
    const file = path.join(dir, `image-${i + 1}-${nonce}.${IMAGE_EXT[img.mime] || 'png'}`);
    writeFileSync(file, Buffer.from(img.base64, 'base64'));
    return `  ${i + 1}. ${file}`;
  });
  const block = [
    '',
    '【用户上传了图片，请务必先看图再回答】',
    `共 ${images.length} 张，已保存到本机：`,
    ...lines,
    '请用你的文件读取工具打开上述图片（支持图片的读取工具会以视觉方式呈现内容），看清后再作答。',
    '不要凭空猜测图片内容；如果确实读不到，请明确说明读不到，而不是编造。',
  ].join('\n');
  return { block, dir };
}

/** 走一次模型调用（含并发闸门、图片投递与信号透传）。 */
async function invokeModel({ prompt, systemPrompt, model, signal, onDelta, images }) {
  await gate.acquire();
  const hasImages = Array.isArray(images) && images.length > 0;
  // openai 与 wbcloud 都是「真正的 OpenAI 兼容端点」：按多模态 content 数组透传，保真度最高。
  const passthrough = config.backend === 'openai' || config.backend === 'wbcloud';
  let tempDir = null;
  try {
    if (hasImages && passthrough) {
      const content = [{ type: 'text', text: prompt }];
      for (const img of images) {
        content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } });
      }
      const msgs = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content });
      return await backend.complete({ messages: msgs, model, signal, onDelta });
    }

    let finalPrompt = prompt;
    if (hasImages) {
      const delivered = materializeImages(images);
      tempDir = delivered.dir;
      finalPrompt = `${prompt}\n${delivered.block}`;
      log(`[图片] ${images.length} 张已落盘到 ${tempDir}，交由上游 agent 读取`);
    }

    if (passthrough) {
      const msgs = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: finalPrompt });
      return await backend.complete({ messages: msgs, model, signal, onDelta });
    }
    return await backend.complete({
      prompt: finalPrompt,
      systemPrompt,
      model,
      signal,
      onDelta,
      // 看图需要"先调工具读文件、再回答"，1 轮不够；仅在带图时放宽。
      ...(hasImages ? { maxTurns: Math.max(Number(config.serve?.maxTurns) || 1, 4) } : {}),
      // 带图时改用带 Read 工具的 agent —— 纯文本任务型 agent 工具集为空，读不到落盘的图片。
      ...(hasImages && config.serve?.imageAgent ? { imageAgent: config.serve.imageAgent } : {}),
    });
  } finally {
    // 上游已读完文件，调用返回即可清理；清理失败不影响主流程。
    if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    gate.release();
  }
}

// ---------------------------------------------------------------- 路由

async function handleHealth(req, res) {
  const [wf] = await Promise.all([weflow.health()]);
  sendJson(res, 200, {
    ok: true,
    backend: config.backend,
    model: config.backend === 'openai' ? config.openai?.model
      : config.backend === 'wbcloud' ? config.wbcloud?.model
        : config.cli?.model,
    cli: typeof backend.check === 'function' ? await backend.check() : null,
    weflow: wf,
    queue: { active: gate.active, pending: gate.pending, max: gate.max },
    // 宿主启动时跑一次的依赖预检结果（独立运行时为 null）。
    deps: config.preflight ?? null,
  });
}

function handleModels(req, res) {
  const id = activeModel();
  const created = Math.floor(Date.now() / 1000);
  // 多给几个别名：不少客户端会先拉列表、再用自己预设的模型名来请求。
  const ids = [...new Set([id, 'gpt-4o', 'gpt-3.5-turbo', 'default'])];
  sendJson(res, 200, {
    object: 'list',
    data: ids.map((m) => ({ id: m, object: 'model', created, owned_by: 'workbuddy-bridge' })),
  });
}

/**
 * 上游用量 → OpenAI 的 usage。
 *
 * 两种键名都认：上游网关回的可能不是 Anthropic 风格的 `input_tokens`/`output_tokens`
 * （`ServeBackend` 原样透传 `json.usage`）。只认一种的后果就是用量恒为 0 —— 界面上
 * 显示「用量 0 tok」，上下文预算也跟着失真。
 * @param {object|null|undefined} usage 上游返回的用量。
 * @returns {{prompt_tokens: number, completion_tokens: number, total_tokens: number}}
 */
function usageOf(usage) {
  const prompt = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const completion = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

async function handleChatCompletions(req, res) {
  const body = await readJsonBody(req);
  const { prompt: rawPrompt, systemPrompt: baseSystem, images } = messagesToPrompt(body.messages);
  // 只有图片、没有文字时不能判空 —— 那正是"发张图问问"的常见用法。
  if (!rawPrompt.trim() && !images.length) {
    throw Object.assign(new Error('messages 为空'), { httpStatus: 400, code: 'invalid_request' });
  }
  // 多轮时在转录稿末尾划界：模型否则会顺着 `用户: / 助手: / 【外部执行结果…】` 的格式
  // 继续写下去，把上一轮的话和工具输出再吐一遍（线上表现像"内容重复了"）。
  const hasHistory = Array.isArray(body.messages) && body.messages.length > 1;
  const turnPrompt = rawPrompt.trim() ? rawPrompt : '（用户只发了图片，没有文字。请先看图，再说明你看到了什么。）';
  const prompt = hasHistory ? `${turnPrompt}\n\n${TRANSCRIPT_TRAILER}` : turnPrompt;

  // BASE_INSTRUCTION 必须无条件置顶：
  //   - 压制 agent 的原生工具调用（不带 tools 的请求同样需要，否则会自主调用工具）；
  //   - 保证 systemPrompt 永远非空。为空时 61092 不会覆盖 agent 自己的 instructions，
  //     create agent 就会按自己的剧本发起工具调用，报 Max turns exceeded。
  const toolInstruction = buildToolInstruction(body.tools, body.tool_choice);
  // 带图时必须换掉 BASE_INSTRUCTION：它禁止一切工具调用，而图片只能靠 Read 读到。
  const envInstruction = images.length ? IMAGE_INSTRUCTION : BASE_INSTRUCTION;
  const systemPrompt = [envInstruction, baseSystem, toolInstruction].filter(Boolean).join('\n\n');
  const hasTools = Boolean(toolInstruction);

  const model = body.model || activeModel();
  // 组装结果的尺寸要落日志：上游是否把提示词截断、模型到底看到多少字，事后只能靠
  // 这两个数字判断 —— 否则"输出重复/缺失"只能猜。
  log(`[req] msgs=${String(body.messages?.length ?? 0)} tools=${String(body.tools?.length ?? 0)}`
    + ` 历史=${hasHistory ? '有' : '无'} prompt=${String(prompt.length)}字 system=${String(systemPrompt.length)}字`);
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const ctl = new AbortController();
  req.on('close', () => ctl.abort());

  if (!body.stream) {
    let r;
    if (hasTools) {
      const out = await chatWithTools({ prompt, systemPrompt, model, signal: ctl.signal, images });
      r = { ...out.outcome, text: out.text, usage: out.usage };
    } else {
      const x = await invokeModel({ prompt, systemPrompt, model, signal: ctl.signal, images });
      r = { calls: null, content: x.text, broken: false, text: x.text, usage: x.usage };
    }
    // 写坏了但确实在表达工具调用 → 明确报错，不冒充正常回答
    if (r.broken) log('[warn] 重试后仍无法解析工具调用（非流式），下发错误文本');
    const content = r.broken ? toolCallFailureText(r.text) : r.content;
    log(`[res] 工具调用=${r.calls ? String(r.calls.length) : '0'} 输出=${String(r.text ?? '').length}字`
      + ` usage=${JSON.stringify(r.usage ?? null)}`);
    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: r.calls
          ? { role: 'assistant', content: '', tool_calls: r.calls }
          : { role: 'assistant', content },
        finish_reason: r.calls ? 'tool_calls' : 'stop',
      }],
      usage: usageOf(r.usage),
    });
  }

  // 流式：SSE
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

  // 部分客户端（Open WebUI、Cherry Studio 等）要求开启 include_usage 时
  // 末尾补一个只带 usage 的 chunk，否则会报解析错误或一直转圈。
  const writeUsageIfNeeded = () => {
    if (!body.stream_options?.include_usage) return;
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model, choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })}\n\n`);
  };

  try {
    if (!hasTools) {
      // 不带工具：保持真流式，逐段下发
      frame({ role: 'assistant', content: '' });
      await invokeModel({ prompt, systemPrompt, model, signal: ctl.signal, images, onDelta: (t) => frame({ content: t }) });
      frame({}, 'stop');
    } else {
      // 带工具：必须先收全文再判定，否则可能把工具调用 JSON 当正文吐给客户端。
      // 本地模型服务本身也不支持真流式，这里没有额外损失。
      const out = await chatWithTools({ prompt, systemPrompt, model, signal: ctl.signal, images });
      const { calls, content, broken } = out.outcome;
      if (calls) {
        frame({ role: 'assistant', content: '' });
        frame({ tool_calls: calls.map((c, i) => ({ index: i, ...c })) });
        frame({}, 'tool_calls');
      } else if (broken) {
        // 解析失败但明显在表达工具调用：宁可显式报错，也不能让半截 JSON 冒充
        // "最终回答"骗过下游 agent（那会表现为"模型说改好了、其实没执行"）。
        log(`[warn] 重试后仍无法解析工具调用，下发错误帧。原始输出前 300 字：${String(out.text || '').slice(0, 300)}`);
        frame({ role: 'assistant', content: '' });
        frame({ content: toolCallFailureText(out.text) });
        frame({}, 'stop');
      } else {
        frame({ role: 'assistant', content });
        frame({}, 'stop');
      }
    }
    writeUsageIfNeeded();
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    // 错误也要按 SSE 帧下发：客户端可能只解析 choices，纯 HTTP 错误体会被静默吞掉。
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { content: `\n\n[调用失败] ${err.message}` }, finish_reason: 'stop' }],
      error: { message: err.message, code: err.code || 'internal_error' },
    })}\n\n`);
    writeUsageIfNeeded();
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

async function handleSummarize(req, res) {
  const body = await readJsonBody(req);
  const started = Date.now();
  const ctl = new AbortController();
  req.on('close', () => ctl.abort());

  // 消息来源：请求体直接给，或回源 WeFlow 拉取
  let rawMessages = body.messages;
  let source = 'inline';
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    if (!config.weflow?.enabled) {
      throw Object.assign(new Error('未提供 messages，且 WeFlow 未启用（weflow.enabled=false）'), {
        httpStatus: 400, code: 'no_messages',
      });
    }
    rawMessages = await weflow.fetchMessages({
      sessionId: body.sessionId, talker: body.talker,
      startTime: body.startTime, endTime: body.endTime, limit: body.limit,
    });
    source = 'weflow';
  }

  const messages = normalizeMessages(rawMessages);
  if (!messages.length) {
    throw Object.assign(new Error('未能从数据源解析出任何消息'), { httpStatus: 422, code: 'empty_messages' });
  }

  const { text: messagesText, truncated } = trimMessages(messages, {
    maxMessages: summaryCfg.maxMessages ?? 800,
    maxChars: summaryCfg.maxChars ?? 60000,
  });

  const prompt = buildSummaryPrompt({
    messagesText,
    session: { sessionId: body.sessionId, talker: body.talker, name: body.name },
    style: body.style || summaryCfg.style,
    language: body.language || summaryCfg.language,
    messageCount: messages.length,
  });

  // 结构化输出靠提示词约束（--json-schema 在当前版本会挂死，已弃用）
  const systemPrompt = [summaryCfg.systemPrompt, buildSchemaInstruction(summaryCfg.schema)]
    .filter(Boolean).join('\n\n');

  const result = await invokeModel({
    prompt,
    systemPrompt,
    model: body.model,
    signal: ctl.signal,
  });

  const parsed = parseJsonLoose(result.text);
  sendJson(res, 200, {
    ok: true,
    session: { sessionId: body.sessionId ?? null, talker: body.talker ?? null, name: body.name ?? null },
    summary: parsed,
    raw: parsed ? undefined : result.text,
    meta: {
      source,
      messageCount: messages.length,
      truncated,
      model: body.model || config.cli?.model || null,
      elapsedMs: Date.now() - started,
      usage: result.usage || null,
      costUsd: result.costUsd ?? null,
    },
  });
}

async function handleWeFlowSessions(req, res) {
  sendJson(res, 200, await weflow.listSessions());
}

async function handleWeFlowMessages(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const payload = await weflow.fetchMessages({
    sessionId: url.searchParams.get('sessionId'),
    talker: url.searchParams.get('talker'),
    startTime: url.searchParams.get('startTime'),
    endTime: url.searchParams.get('endTime'),
    limit: url.searchParams.get('limit'),
  });
  sendJson(res, 200, { messages: normalizeMessages(payload) });
}

// ---------------------------------------------------------------- 内置测试页

/** 浏览器打开 http://127.0.0.1:8787 即可直接对话，用来确认服务是否正常。 */
function handleTestPage(req, res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkBuddy 本地模型 - 测试页</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2328}
.wrap{max-width:860px;margin:0 auto;padding:20px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#656d76;font-size:13px;margin-bottom:14px}
.bar{display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:10px 12px;margin-bottom:12px;flex-wrap:wrap}
.bar b{font-weight:600}
.ok{color:#1a7f37}.bad{color:#cf222e}
#log{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:14px;min-height:220px;max-height:52vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
.msg{margin-bottom:12px}.who{font-weight:600;font-size:12px;color:#656d76;display:block;margin-bottom:2px}
.u .body{background:#ddf4ff;padding:8px 10px;border-radius:6px;display:inline-block}
.a .body{background:#f6f8fa;padding:8px 10px;border-radius:6px;display:block}
.e .body{background:#ffebe9;color:#cf222e;padding:8px 10px;border-radius:6px;display:block}
.row{display:flex;gap:8px;margin-top:12px}
input{flex:1;padding:10px 12px;border:1px solid #d0d7de;border-radius:8px;font:inherit}
button{padding:10px 18px;border:0;border-radius:8px;background:#1f6feb;color:#fff;font:inherit;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
code{background:#eff1f3;padding:1px 5px;border-radius:4px;font-size:12px}
</style></head><body><div class="wrap">
<h1>WorkBuddy 本地模型 · 测试页</h1>
<div class="sub">如果你能在这里聊起来，说明服务正常，问题出在工具的配置上。</div>
<div class="bar">
  <span>状态：<b id="st" class="bad">检测中…</b></span>
  <span>后端：<b id="bk">-</b></span>
  <span>模型：<b id="md">-</b></span>
</div>
<div id="log"><div class="msg a"><span class="who">系统</span><span class="body">在下面输入内容回车，直接测这个服务。</span></div></div>
<div class="row"><input id="q" placeholder="输入一句话，回车发送…" autocomplete="off"><button id="go">发送</button></div>
<div class="sub" style="margin-top:10px">工具的 Base URL 应填 <code>http://127.0.0.1:8787/v1</code>（注意结尾的 /v1）</div>
</div>
<script>
const log=document.getElementById('log'),st=document.getElementById('st');
const bk=document.getElementById('bk'),md=document.getElementById('md');
const q=document.getElementById('q'),go=document.getElementById('go');
function add(cls,who,body){const d=document.createElement('div');d.className='msg '+cls;
 d.innerHTML='<span class="who">'+who+'</span><span class="body"></span>';
 d.querySelector('.body').textContent=body;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
fetch('/health').then(r=>r.json()).then(h=>{
 bk.textContent=h.backend||'-';md.textContent=h.model||'-';
 var dp=h.deps&&h.deps.apps;
 if(dp){var w=dp.workbuddy||{},p=dp.copilot||{};
  if(!w.running)add(w.installed?'e':'a','依赖',w.installed?'WorkBuddy 已安装但未运行 —— 打开 WorkBuddy 并随便发一条消息，本服务会自动连上':'WorkBuddy 未安装，8787 反代不可用：到 www.workbuddy.cn 下载客户端、安装并登录');
  if(!p.running)add(p.installed?'e':'a','依赖',p.installed?'Copilot 已安装但未运行 —— 启动 Copilot 桌面端即可':'Copilot 未安装，8899 反代不可用：在 Microsoft Store 搜索 Copilot 安装并登录');
  if(dp.copilot&&h.token&&h.token.stale)add('e','令牌','Copilot 令牌已过期（'+Math.round((h.token.ageSec||0)/3600)+' 小时）—— 执行 refresh-token.ps1 重新收割');}
 var c=h.cli||{};
 if(c.ok){st.textContent='正常';st.className='ok';
  if(c.baseUrl)add('a','系统','已连接本地模型服务：'+c.baseUrl);}
 else{st.textContent='未就绪';st.className='bad';
  add('e','状态',c.error||'本地模型服务暂不可用');
  if(c.client&&c.client.running)
   add('a','提示','WorkBuddy 在运行，但网关还没释放。在 WorkBuddy 里发一条消息即可，本服务会在后台自动连上（不用重启）。');
  else
   add('a','提示','没检测到 WorkBuddy 客户端，请先启动它。');}
}).catch(e=>{st.textContent='异常';st.className='bad';add('e','错误','无法连接服务：'+e.message);});
async function send(){
 const text=q.value.trim();if(!text)return;q.value='';add('u','你',text);
 const node=add('a','模型','…');go.disabled=true;
 try{
  const res=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({model:md.textContent,messages:[{role:'user',content:text}],stream:true})});
  if(!res.ok){node.className='msg e';node.querySelector('.body').textContent='HTTP '+res.status+' '+await res.text();return;}
  const rd=res.body.getReader(),dec=new TextDecoder();let buf='',out='';
  for(;;){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});
   let i;while((i=buf.indexOf('\\n\\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+2);
    if(!line.startsWith('data:'))continue;const p=line.slice(5).trim();if(p==='[DONE]')continue;
    try{const j=JSON.parse(p);if(j.error){node.className='msg e';node.querySelector('.body').textContent=j.error.message;return;}
     out+=j.choices?.[0]?.delta?.content||'';node.querySelector('.body').textContent=out;}catch(_){}}}
  if(!out)node.querySelector('.body').textContent='(空响应)';
 }catch(e){node.className='msg e';node.querySelector('.body').textContent=e.message;}
 finally{go.disabled=false;q.focus();}}
go.onclick=send;q.addEventListener('keydown',e=>{if(e.key==='Enter')send();});
</script></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

// ---------------------------------------------------------------- 服务器

// 同一处理器挂多个路径别名：不少客户端会把 Base URL 填成不带 /v1 的形式，
// 那样会直接 404 且很难自查，这里直接兼容掉。
const routes = [
  ['GET', '/', handleTestPage],
  ['GET', '/health', handleHealth],
  ['GET', '/v1/models', handleModels],
  ['GET', '/models', handleModels],
  ['POST', '/v1/chat/completions', handleChatCompletions],
  ['POST', '/chat/completions', handleChatCompletions],
  ['POST', '/v1/completions', handleChatCompletions],
  ['POST', '/completions', handleChatCompletions],
  ['POST', '/summarize', handleSummarize],
  ['GET', '/weflow/sessions', handleWeFlowSessions],
  ['GET', '/weflow/messages', handleWeFlowMessages],
];

/** 构建 HTTP 服务器（只构建，不监听）。 */
function buildServer() {
  return http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const routePath = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    log(`OPTIONS ${routePath} 204 (CORS 预检)`);
    res.writeHead(204, {
      'access-control-allow-origin': serverCfg.cors || '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
    });
    return res.end();
  }

  const hit = routes.find(([m, p]) => m === req.method && p === routePath);
  if (!hit) {
    log(`${req.method} ${routePath} 404 (未匹配路由)`);
    return sendError(res, Object.assign(
      new Error(`未知路由 ${req.method} ${routePath}。可用：GET /health、GET /v1/models、POST /v1/chat/completions、POST /summarize`),
      { httpStatus: 404, code: 'not_found' },
    ));
  }
  if (!authorized(req)) {
    log(`${req.method} ${routePath} 401 (鉴权失败)`);
    return sendError(res, Object.assign(new Error('鉴权失败'), { httpStatus: 401, code: 'unauthorized' }));
  }

  const t0 = Date.now();
  try {
    await hit[2](req, res);
    log(`${req.method} ${routePath} ${res.statusCode} ${Date.now() - t0}ms`);
  } catch (rawErr) {
    // 上游可能抛出非 Error（历史上出现过 throw null），先归一化再取字段，
    // 否则这里自己抛 TypeError，真实原因会被掩盖成一句无用的堆栈。
    const err = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
    const mapped = err.httpStatus ? err : Object.assign(err, classifyCliFailure(err.message));
    log(`${req.method} ${routePath} FAIL ${mapped.httpStatus || 500} ${Date.now() - t0}ms - ${mapped.message}`);
    if (!res.headersSent) sendError(res, mapped);
    else res.end();
  }
  });
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

/** 已启动实例（供 stopBridge 使用）。 */
let activeBridge = null;

/**
 * 启动桥接服务。宿主内嵌（DSH）与独立运行（node bridge.mjs / start.cmd）共用。
 * 监听失败时 reject —— 嵌入式宿主需要知道启动失败，而不是让进程静默半死不活。
 * @param {object} [overrides] 宿主注入的配置，优先级高于配置文件与环境变量。
 * @returns {Promise<{host:string,port:number,server:object,close:()=>Promise<void>}>}
 */
export async function startBridge(overrides = {}) {
  initRuntime(overrides);
  const server = buildServer();
  const host = serverCfg.host || DEFAULT_HOST;
  const port = serverCfg.port || DEFAULT_PORT;

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') {
        log(`[错误] 端口 ${port} 已被占用 —— 可能已经有一个本服务在运行。`);
        log('       直接用现有的即可；要重启请先在任务管理器结束旧的 node.exe。');
        log(`       也可以打开 http://${host}:${port}/ 看是否已有服务在响应。`);
      } else {
        log(`[错误] 服务启动失败：${err.message}`);
      }
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
  // 自检与预热在后台进行，不阻塞启动返回。
  warmUp(host, port).catch((e) => log(`[warn] 启动自检失败: ${e?.message || e}`));
  return activeBridge;
}

/** 停止由 startBridge() 启动的服务（幂等）。 */
export async function stopBridge() {
  const current = activeBridge;
  if (!current) return;
  activeBridge = null;
  await current.close();
}

/** 监听成功后的自检、预热与保活。 */
async function warmUp(host, port) {
  const backendCheck = typeof backend.check === 'function'
    ? await backend.check({ live: false })
    : { ok: true };
  log(`weflow-bridge 已启动: http://${host}:${port}`);
  log(`浏览器测试页: http://${host}:${port}/   （打开就能直接对话，用来验证服务）`);
  log(`后端=${config.backend} 模型=${activeModel()} 并发=${gate.max}`);
  if (config.backend === 'serve') {
    log(`本地模型服务: ${backendCheck.baseUrl || '待探测'} agent=${backendCheck.agentName} `
      + `端口来源=${backendCheck.portSource} 密码来源=${backendCheck.passwordSource}`);
    log(`候选端口: ${(backendCheck.candidatePorts || []).join(', ')}（启动后自动探测可用端口）`);
    if (backendCheck.credentialCache) {
      const cc = backendCheck.credentialCache;
      log(`凭证缓存: ${cc.hasCachedPort || cc.hasCachedPassword ? '已命中（含上次可用的端口/密码）' : '为空（首次运行，将在首次请求时写入）'} -> ${cc.path}`);
    }
    // 启动即在后台预热端点解析：把探测/扫描的耗时挪到用户发第一个请求之前。
    // 并且**一直重试到成功为止** —— 客户端刚重启时，携带密码的子进程还没被
    // spawn 出来，这一轮探测必然落空；等用户随手用一下 WorkBuddy，它就会自己好。
    if (typeof backend.resolveEndpointLive === 'function') {
      let warmDone = false;

      // 长期保活：只在已经就绪后启用；端点过期时静默重解析，
      // 这样会话切换 / 网关轮换后能自动跟上，不会跑着跑着突然失效。
      const startKeepAlive = () => {
        const keepAlive = setInterval(() => {
          if (backend._probed && backend._probed.expire > Date.now()) return;
          backend.resolveEndpointLive()
            .then((v) => log(`端点已自动切换: http://${v.host}:${v.port}（来源=${v.source}）`))
            .catch(() => { /* 静默，交给请求路径上的重试 */ });
        }, 60000);
        keepAlive.unref?.();
      };

      const warm = async (round) => {
        if (warmDone) return;
        try {
          const v = await backend.resolveEndpointLive({ retryMs: 2000 });
          warmDone = true;
          log(`端点就绪: http://${v.host}:${v.port}（来源=${v.source}${round > 1 ? `，第 ${round} 轮` : ''}）`);
          startKeepAlive();
        } catch (e) {
          const msg = String(e?.message || e).split('\n')[0];
          log(`端点尚未就绪（第 ${round} 轮）: ${msg}`);
          if (round === 1) {
            log('  → 服务已可用但暂时连不上模型。这通常是分阶段的：');
            log('    ① 网关要等你在 WorkBuddy 里表达一次「对话意图」才被释放；');
            log('    ② 携带密码的子进程要等 agent 真正跑起来才被 spawn。');
            log('  → 打开 WorkBuddy 随便发一条消息即可，后台会自动连上。');
          }
          // 刚重启的窗口要"秒级跟手"：网关是在你发消息的那一刻才被监听的
          // （实测套接字创建时间 == 发消息时刻），所以轮询间隔直接决定
          // 「发完消息 → 能用」的体感延迟。单轮开销约 2~4s，5s 间隔 ≈ 每 8~9s 一轮。
          // 40 轮（约 6 分钟）后退避到 15s，再远退到 120s，避免长期空转。
          const delay = round <= 40 ? 5000 : round <= 100 ? 15000 : 120000;
          setTimeout(() => warm(round + 1), delay).unref?.();
        }
      };
      warm(1);
    }
    if (_removedEnv.length) {
      log(`已从环境变量中清除会话级污染: ${_removedEnv.join(', ')}`);
    }
  } else {
    log(`CLI 可执行文件: ${backendCheck.ok ? 'OK' : '缺失'} (${backendCheck.binPath || '-'})`);
  }
  log(`WeFlow: ${config.weflow?.enabled ? config.weflow.baseUrl : '未启用'}`);
}

// ---------------------------------------------------------------- 独立运行入口

// 被宿主 import 时不自动启动；只有 `node bridge.mjs` 直接执行时才自启并接管信号。
// （嵌入式宿主自己管生命周期，绝不能让它被 process.exit 带走。）
const IS_MAIN = typeof process.argv[1] === 'string'
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  startBridge().catch(() => process.exit(1));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('收到退出信号，正在关闭…');
      const force = setTimeout(() => process.exit(0), 3000);
      force.unref?.();
      stopBridge().then(() => process.exit(0), () => process.exit(0));
    });
  }
}
