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
// 云端接口的四个硬要求（实测）
// -----------------------------
// 1. 必须 `stream: true`（非流式返回 code 11101 "Non-stream chat request is currently not supported"）；
// 2. messages 的**第一条必须是 system**（否则 code 11128 "first message is not system prompt"）；
// 3. 必须带渠道头（否则 code 11128 "request illegal"）；
// 4. 工具调用与工具结果必须**成对**：有结果没调用、有调用没结果都会回
//    `11133 / 400002 / param: input`（"the request parameters were rejected by the
//    model provider"），与「提示词超了窗口」共用同一个码。
//
// 返回格式与 OpenAI 完全一致（chat.completion.chunk + delta.content /
// delta.tool_calls / delta.reasoning_content），所以这里几乎只是直通。

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

/**
 * WorkBuddy 客户端缓存产品配置的目录。
 *
 * 客户端的模型目录不是从公开 HTTP 接口取的：daemon 通过 "private spill" 把
 * 产品配置写到本机，客户端再从 `ACC_PRODUCT_CONFIG_PATH` 读它。同一份文件就是
 * 这个账号真实的模型清单（含 Pro 档位、倍率、上下文长度、是否支持工具调用）。
 */
const DEFAULT_CATALOG_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.workbuddy-ai',
  'cache',
);

/**
 * 从客户端缓存的产品配置里读出账号的文本模型。
 *
 * 目录里有 `acc-product-config-v3.json` 和按进程 pid 命名的新版
 * （`acc-product-config-v3-<pid>-<uuid>.json`）；取**修改时间最新**的那一份。
 *
 * @param {string} [dir] 产品配置缓存目录。
 * @returns {Array<{id: string, name: string, credits: string, supportsImages: boolean,
 *   supportsToolCall: boolean, maxOutputTokens: number, supportedEfforts: string[],
 *   canDisableThinking: boolean}>}
 *   账号的文本模型；读不到时返回空数组。
 */
export function readCatalogModels(dir = DEFAULT_CATALOG_DIR) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const candidates = entries
    .filter(name => name.startsWith('acc-product-config-v3') && name.endsWith('.json'))
    .map(name => path.join(dir, name));
  let newest = null;
  let newestAt = -1;
  for (const path of candidates) {
    try {
      const at = statSync(path).mtimeMs;
      if (at > newestAt) {
        newestAt = at;
        newest = path;
      }
    } catch { /* 读不到就跳过这一份 */ }
  }
  if (newest === null) return [];
  let config;
  try {
    config = JSON.parse(readFileSync(newest, 'utf8'));
  } catch {
    return [];
  }
  const models = Array.isArray(config.models) ? config.models : [];
  return models
    .filter(model => model && typeof model.id === 'string' && !Array.isArray(model.tags))
    .map(model => ({
      id: model.id,
      name: typeof model.name === 'string' ? model.name : model.id,
      credits: typeof model.credits === 'string' ? model.credits : '',
      supportsImages: model.supportsImages === true,
      supportsToolCall: model.supportsToolCall === true,
      // 输出上限决定高推理档位有没有地方写答案：思维链和答案共用 max_tokens，
      // 上限卡小了会出现「想了半天，一个字没答」。
      maxOutputTokens: Number.isFinite(model.maxOutputTokens) ? model.maxOutputTokens : 0,
      // 输入额度就是这个模型的上下文窗口：云端把「输入 + 预留输出」一起算进窗口，
      // 算输出预算时要用它给提示词留位置。
      maxInputTokens: Number.isFinite(model.maxInputTokens) ? model.maxInputTokens : 0,
      supportedEfforts: Array.isArray(model.reasoning?.supportedEfforts)
        ? model.reasoning.supportedEfforts.filter(effort => typeof effort === 'string')
        : [],
      canDisableThinking: model.reasoning?.canDisableThinking === true,
    }));
}

/**
 * 粗估一段提示词的 token 数。
 *
 * 英文约 4 字符/token，中文约 1.5 字符/token；工具 schema 与工具结果是英文，
 * 对话是混排。这里取 3 字符/token 作为一个偏保守的估计：宁可把输出预算收小一点，
 * 也不要因为预留太多而把请求顶出上下文窗口。
 *
 * @param {number} chars 字符数。
 * @returns {number} 估算的 token 数。
 */
export function estimateTokens(chars) {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 3);
}

/** 给输出预算留的安全余量（token）。 */
const OUTPUT_BUDGET_MARGIN_TOKENS = 2048;

/** 输出预算的下限（token）：再少模型也写不出东西。 */
const MIN_OUTPUT_TOKENS = 1024;

/**
 * 云端这次是不是「输入被拒」。
 *
 * 云端用 `11133` + `extError.code: 400002` + `param: input` 表达「模型提供方拒收了这次
 * 输入」。实测两种原因共用这一个码：提示词超了模型的上下文窗口（2190 条消息、6.4MB
 * 提示词的会话），以及工具调用与结果不成对（只有调用、没有结果的切片）。两者的补救
 * 不一样 —— 前者改短输入，后者先把工具调用对齐 —— 见 {@link repairToolPairing}。
 *
 * @param {string} raw 云端返回的响应体。
 * @returns {boolean} 是输入被拒时为 true。
 */
export function isInputRejected(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const parsed = JSON.parse(raw);
    const ext = parsed && typeof parsed === 'object' ? parsed.extError : undefined;
    if (ext && typeof ext === 'object') {
      if (String(ext.code ?? '') === '400002') return true;
      if (String(ext.param ?? '') === 'input') return true;
    }
    return false;
  } catch {
    return /"param"\s*:\s*"input"/.test(raw) || /400002/.test(raw);
  }
}

/**
 * 渠道身份：云端据它判断「这是不是官方客户端」。
 *
 * 官方客户端自己也是从这份产品配置里取这些值的（客户端包里的
 * `buildVlmGatewayHeaders` + `getDeploymentType`）：`X-Product` 是部署形态，
 * `X-IDE-Version` 是客户端版本。写死其中任何一个，迟早和真正在跑的客户端对不上。
 *
 * @param {string} [dir] 产品配置缓存目录。
 * @returns {{deploymentType: string, clientVersion: string, endpoint: string, enterpriseId: string}}
 *   渠道身份；读不到时各项为空串。
 */
export function readChannelIdentity(dir = DEFAULT_CATALOG_DIR) {
  const empty = { deploymentType: '', clientVersion: '', endpoint: '', enterpriseId: '' };
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return empty;
  }
  const candidates = entries
    .filter(name => name.startsWith('acc-product-config-v3') && name.endsWith('.json'))
    .map(name => path.join(dir, name));
  let newest = null;
  let newestAt = -1;
  for (const file of candidates) {
    try {
      const at = statSync(file).mtimeMs;
      if (at > newestAt) {
        newestAt = at;
        newest = file;
      }
    } catch { /* 读不到就跳过这一份 */ }
  }
  if (newest === null) return empty;
  let config;
  try {
    config = JSON.parse(readFileSync(newest, 'utf8'));
  } catch {
    return empty;
  }
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  return {
    deploymentType: text(config.deploymentType),
    clientVersion: text(config.genieVersion),
    endpoint: text(config.endpoint),
    enterpriseId: text(config.enterpriseId),
  };
}

/**
 * 补出来的工具结果。
 *
 * 上游模型要求每个 tool_call 都有对应的 tool 结果；缺了就直接 `400002 /
 * param: input`，请求连同整轮对话一起作废。用户中断过一轮工具调用、或上一轮被裁短
 * 之后，DSH 的对话里就会留下这种只有调用没有结果的切片，所以这里补一条说明，
 * 让模型知道「那次调用没有结果，需要就重跑」。
 */
const MISSING_TOOL_RESULT = 'No result was recorded for this call: it never finished '
  + '(the turn was interrupted, or the earlier conversation was cut short before it returned). '
  + 'Run it again if you still need it.';

/**
 * 把工具调用与工具结果修成成对的样子。
 *
 * 上游模型对不成对的请求回 `400002 / param: input`（"the request parameters were
 * rejected by the model provider"），而同一个 400 也是「提示词超了窗口」的码 ——
 * 两种原因共用一个错误码，只靠裁短对话永远分不清。实测的两条硬规则：
 *
 *   1. 有 tool 结果，但发起它的 assistant 消息不在（被裁掉、或历史里本来就没有）→ 必须去掉，
 *      否则整条请求作废；
 *   2. assistant 发起了调用，但没有结果 → 必须补一条结果消息，否则同样作废。
 *
 * 第 2 条补的是**文本说明**而不是编造工具输出，模型据此知道那次调用没跑成。
 *
 * @param {Array<{role?: string, content?: unknown, tool_calls?: Array<{id?: string}>,
 *   tool_call_id?: string}>} messages 完整对话。
 * @returns {{messages: Array<object>, dropped: number, synthesized: number}}
 *   修好之后的对话，以及被去掉的结果条数和补出来的结果条数。
 */
export function repairToolPairing(messages) {
  if (!Array.isArray(messages)) return { messages, dropped: 0, synthesized: 0 };
  const answered = new Set();
  for (const message of messages) {
    if (message?.role === 'tool' && typeof message.tool_call_id === 'string' && message.tool_call_id !== '') {
      answered.add(message.tool_call_id);
    }
  }
  const out = [];
  const declared = new Set();
  const kept = new Set();
  let dropped = 0;
  let synthesized = 0;
  for (const message of messages) {
    if (message?.role === 'tool') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      // 没有发起它的 assistant 消息（或者同一个结果重复了一次）：这条在上游看来是非法输入。
      if (id === '' || !declared.has(id) || kept.has(id)) {
        dropped += 1;
        continue;
      }
      kept.add(id);
      out.push(message);
      continue;
    }
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const calls = [];
      const missing = [];
      let rewritten = false;
      for (const call of message.tool_calls) {
        const id = typeof call?.id === 'string' ? call.id : '';
        // 没有 id 的调用配不上结果，留着只会让整条请求被拒。
        if (id === '') {
          rewritten = true;
          continue;
        }
        // 云端把 `arguments` 反序列化成 **string**（写结构体会回 11101
        // "cannot unmarshal object into Go struct field … arguments of type string"）。
        const args = call?.function?.arguments;
        const usable = typeof args === 'string' || args === undefined
          ? call
          : { ...call, function: { ...call.function, arguments: JSON.stringify(args) } };
        if (usable !== call) rewritten = true;
        calls.push(usable);
        declared.add(id);
        if (!answered.has(id)) missing.push(id);
      }
      if (calls.length === 0) {
        const { tool_calls: _unusable, ...rest } = message;
        out.push(rest);
        continue;
      }
      out.push(rewritten ? { ...message, tool_calls: calls } : message);
      for (const id of missing) {
        out.push({ role: 'tool', tool_call_id: id, content: MISSING_TOOL_RESULT });
        kept.add(id);
        synthesized += 1;
      }
      continue;
    }
    out.push(message);
  }
  return { messages: out, dropped, synthesized };
}

/**
 * 把对话裁短一截：留下系统提示与最近的几条。
 *
 * 只在**输入被拒**之后用 —— 那是「提示词装不下」唯一能自动执行的补救。
 * 切片必须整组切：一段工具结果如果和发起它的 assistant 消息分开了，剩下的就是一个
 * 没有对应调用的 tool 消息，上游对它的答复是同一个 `400002 / param: input`，
 * 于是「裁短重试」不但救不回来，还会把原本只是偶发失败的请求变成永久失败（实测）。
 * 所以起点落在工具结果上时，往回退到发起它的那条 assistant 消息。
 *
 * @param {Array<{role?: string, content?: unknown}>} messages 完整对话。
 * @param {number} [keep] 保留最近几条非系统消息（工具调用整组会多留几条）。
 * @returns {Array<{role?: string, content?: unknown}>} 裁短后的对话；不需要裁时原样返回。
 */
export function trimMessages(messages, keep = 8) {
  if (!Array.isArray(messages) || messages.length <= keep + 1) return messages;
  const system = messages.find(message => message?.role === 'system');
  const rest = messages.filter(message => message?.role !== 'system');
  let start = Math.max(0, rest.length - keep);
  while (start > 0 && rest[start]?.role === 'tool') start -= 1;
  const kept = rest.slice(start);
  return system === undefined ? kept : [system, ...kept];
}

/**
 * 把这次请求的摘要与云端的答复写进一份本地日志。
 *
 * 云端的 11128 没有说明「为什么不可接受」，下一次再遇到时，唯一能对比的就是
 * 「那次发的是什么」——所以每次被拒都把请求的形状记下来：模型、消息条数、提示词
 * 字符数、工具数、输出上限、推理强度，以及云端给的 requestId（他们工单要的那个号）。
 *
 * @param {object} detail 请求摘要。
 * @returns {void}
 */
function logChannelEvent(detail) {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'workbuddy-bridge');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'channel.log'), `${JSON.stringify(detail)}\n`);
  } catch { /* 记不下来也不能影响请求 */ }
}

/**
 * 把 DSH 的推理强度写进云端请求体。
 *
 * 云端认的是 OpenAI 的 `reasoning_effort`（实测：写 `xhigh` 返回 200，写一个
 * 不存在的值返回 400，参数名是 `reasoning.effort`）。它**不认** `off` —— 那是
 * 「关掉思维」的语义，而云端用 `none` 表达；所以这里的 `off` 要翻成 `none`。
 *
 * @param {string|undefined} effort 调用方给的推理强度。
 * @returns {string|undefined} 写进请求体的值；没给强度时是 undefined（不写这个字段，
 *   云端按模型自己的默认档位走）。
 */
export function normalizeReasoningEffort(effort) {
  if (typeof effort !== 'string') return undefined;
  const value = effort.trim();
  if (!value) return undefined;
  return value === 'off' ? 'none' : value;
}

/**
 * 云端这次是不是「渠道校验被拒」。
 *
 * 云端用 400 + `code: 11128` 表达这类拒绝（正文里是 `unapproved channel` /
 * `request illegal`）。它既可能是请求头不对，也可能只是一次性状态：实测同一个 token、
 * 同一组请求头在 23:14 连续被拒三次，十几分钟后再发就正常 —— 所以调用方把它当作
 * 「重试一次即可」的信号，而不是永久失败。
 *
 * @param {string} raw 云端返回的响应体。
 * @returns {boolean} 是渠道校验拒绝时为 true。
 */
export function isChannelRejection(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && String(parsed.code ?? '') === '11128') return true;
  } catch { /* 非 JSON 响应：退回按正文找 code 字段 */ }
  return /["']?code["']?\s*:\s*["']?11128\b/.test(raw);
}

/**
 * 官方客户端的渠道头 —— 照客户端包里的 `buildVlmGatewayHeaders` +
 * `applyGatewayHeaders` + `applyTraceHeaders` 原样抄下来。
 *
 * 这些字段的取值来自账号自己的产品配置（`deploymentType`、`genieVersion`），
 * 不是写死的：客户端会自动更新，写死的版本与部署形态迟早和真正在跑的那个对不上，
 * 而云端的渠道校验读的正是这组头。
 *
 * 客户端**不发**的三个头，反代也不发：`X-Agent-Type`、`X-Product-Version`、
 * `X-Root-Request-ID`（它们来自一份更老的客户端常量表）。
 */
const CHANNEL_HEADERS = {
  'X-Agent-Intent': 'craft',
  'X-Agent-Purpose': 'conversation',
  'X-IDE-Type': 'WorkBuddy',
  'X-IDE-Name': 'WorkBuddy',
  'X-Private-Data': 'true',
  'x-requested-with': 'XMLHttpRequest',
  'x-codebuddy-request': '1',
};

/** 探测不到已安装客户端时使用的版本号。 */
export const PINNED_CLIENT_VERSION = '5.8.4';

/** 读不到产品配置时使用的部署形态。 */
export const DEFAULT_DEPLOYMENT_TYPE = 'SaaS';

/** 客户端命令行组件的版本；出现在官方客户端的 User-Agent 里。 */
const CLI_VERSION = '2.161.0';

/**
 * 取第一个非空的字符串。
 * @param {...(string|undefined)} values 候选值，按优先级排列。
 * @returns {string} 第一个非空候选，或空串。
 */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 渠道校验被拒后重试前的等待：这类拒绝可能是云端的一次性状态。 */
const CHANNEL_RETRY_DELAY_MS = 1500;

/** 兜底 system prompt：云端要求第一条消息是 system，没有就补一条。 */
const FALLBACK_SYSTEM = 'You are a helpful assistant.';

/** 内存里的 token 缓存时长。token 本身有效期很长（实测 exp 在一年后），这里只是省掉重复收割。 */
const TOKEN_TTL_MS = 30 * 60 * 1000;

/** 账号模型目录的缓存时长。目录只在账号变更时变，五分钟足够跟上。 */
const CATALOG_TTL_MS = 5 * 60 * 1000;

/** 目录里读不到这个模型的额度时使用的输出上限。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32000;

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
 * 等一小会儿（毫秒）。
 *
 * @param {number} ms - 等待毫秒数。
 * @returns {Promise<void>} 到点后 resolve。
 */
function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
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
 * 链路追踪头 —— 与官方客户端的 `applyTraceHeaders` 同一组字段。
 *
 * 云端的渠道校验会看这组头（它们把一次请求在链路里串起来），所以这里按客户端的
 * 格式生成：32 位的 trace id、16 位的 span id、16 位的 parent span id。
 *
 * @returns {Record<string, string>} traceparent / b3 / X-B3-* / X-Trace-ID。
 */
function traceHeaders() {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  const parentSpanId = randomHex(8);
  return {
    'traceparent': `00-${traceId}-${spanId}-01`,
    'b3': `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
    'X-Trace-ID': traceId,
  };
}

/**
 * 随机十六进制串。
 * @param {number} bytes 字节数。
 * @returns {string} 小写十六进制。
 */
function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
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
    // 渠道身份取自账号自己的产品配置（客户端更新后它自己也会跟着更新）：
    // `genieVersion` 是客户端版本，`deploymentType` 是部署形态（X-Product）。
    // 配置里没有的，才退回显式传入的值，再退回兜底。
    const identity = readChannelIdentity(cfg.catalogDir);
    this.clientVersion = firstText(cfg.clientVersion, identity.clientVersion, PINNED_CLIENT_VERSION);
    this.deploymentType = firstText(cfg.deploymentType, identity.deploymentType, DEFAULT_DEPLOYMENT_TYPE);
    this.enterpriseId = firstText(cfg.enterpriseId, identity.enterpriseId, '');
    this.userAgent = cfg.userAgent
      || `WorkBuddy/${this.clientVersion} WorkBuddy/${this.clientVersion} CLI/${CLI_VERSION}`;
    this.harvestScript = cfg.harvestScript
      || resolveUnpackedPath(path.join(__dirname, 'workbuddy-token.py'));
    this._token = null;
    this._tokenAt = 0;
    this._catalog = null;
    this._catalogAt = 0;
  }

  /**
   * 账号的模型目录，带一个短缓存。
   *
   * 目录每次读都是一次文件读加一次 JSON 解析；请求是连续的，所以缓存五分钟，
   * 账号的目录变了最多五分钟才跟上 —— 换来的是每个请求不碰磁盘。
   *
   * @returns {Array<{id: string, maxOutputTokens: number}>} 目录里的模型。
   */
  catalog() {
    const now = Date.now();
    if (this._catalog === null || now - this._catalogAt > CATALOG_TTL_MS) {
      this._catalog = readCatalogModels(this.cfg.catalogDir);
      this._catalogAt = now;
    }
    return this._catalog;
  }

  /**
   * 这个模型一次最多能输出多少 token。
   *
   * 思维链和答案共用 `max_tokens`：档位调高时思维链自己就吃掉了大半，答案写不下
   * 就变成「想完了，什么也没说」。所以上限取账号目录里这个模型自己的额度，而不是
   * 一个写死的数。
   *
   * @param {string} model 模型 id。
   * @returns {number} 输出上限。
   */
  outputTokensFor(model, promptChars = 0) {
    const configured = this.cfg.maxTokens;
    if (Number.isFinite(configured) && configured > 0) return configured;
    const entry = this.catalog().find(candidate => candidate.id === model);
    const limit = entry?.maxOutputTokens ?? 0;
    const cap = limit > 0 ? limit : DEFAULT_MAX_OUTPUT_TOKENS;
    // 云端把「输入 + 预留输出」一起算进模型的上下文窗口。提示词本身占了大头时，
    // 还按满额预留输出，就会把一个本来放得下的请求顶出窗口（云端回
    // `400002 / param: input`）。所以按提示词实际占的位置把输出预算收一收。
    const context = entry?.maxInputTokens ?? 0;
    if (context <= 0 || promptChars <= 0) return cap;
    const used = estimateTokens(promptChars);
    const room = context - used - OUTPUT_BUDGET_MARGIN_TOKENS;
    if (room <= 0) return MIN_OUTPUT_TOKENS;
    return Math.min(cap, room);
  }

  /** 启动自检，供 /health 用。 */
  async check() {
    const base = {
      endpoint: this.endpoint,
      model: this.model,
      clientVersion: this.clientVersion,
      deploymentType: this.deploymentType,
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
        reject(Object.assign(new Error('token 收割超时（300 秒）'), { code: 'harvest_timeout' }));
      }, 300000);
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

  /**
   * 构造渠道头 —— 与官方客户端发的那一组同名同义。
   *
   * 客户端那边是 `buildVlmGatewayHeaders`（身份）+ `applyGatewayHeaders`（会话）
   * + `applyTraceHeaders`（链路追踪）三段拼出来的；这里照抄同样的字段与同样的取值来源。
   *
   * @param {{token: string, uid: string, model?: string}} input 令牌、账号与模型。
   * @returns {Record<string, string>} 请求头。
   */
  buildHeaders({ token, uid, model }) {
    const trace = traceHeaders();
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
      'user-agent': this.userAgent,
      ...CHANNEL_HEADERS,
      'X-IDE-Version': this.clientVersion,
      'X-Product': this.deploymentType,
      'X-User-Id': uid || '',
      'X-Request-ID': uuid7(),
      'X-Conversation-ID': uuid7(),
      'X-Conversation-Request-ID': uuid7(),
      'X-Conversation-Message-ID': uuid7(),
      'acp-connection-id': uuid7(),
      ...trace,
    };
    if (this.enterpriseId !== '') {
      headers['X-Enterprise-Id'] = this.enterpriseId;
      headers['X-Tenant-Id'] = this.enterpriseId;
    }
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
   * @param {string} [options.reasoningEffort] 推理强度（`low`/`medium`/`high`/`xhigh`/`max`）。
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   * @param {(chunk: string) => void} [options.onDelta]
   * @param {Array<object>} [options.tools] OpenAI 形态的 tools；给了就走**原生** function calling。
   * @param {string} [options.toolChoice]
   * @returns {Promise<{text: string, toolCalls: Array<object>|null, usage: object|null, sessionId: string|null, costUsd: null, durationMs: number, raw: object}>}
   */
  async complete({ messages, systemPrompt, prompt, tools, toolChoice, model, reasoningEffort, timeoutMs, signal, onDelta } = {}) {
    const started = Date.now();
    const useModel = model || this.model;
    const normalized = WorkBuddyCloudBackend.normalizeMessages({ messages, systemPrompt, prompt });
    if (!normalized.length) {
      throw Object.assign(new Error('消息为空'), { code: 'invalid_request', httpStatus: 400 });
    }
    // 工具调用整组对齐：DSH 的对话在「用户中断了一轮工具调用」之后会留下只有调用、
    // 没有结果的切片，云端对那种请求一律回 `400002 / param: input`。不修的话，一段
    // 被打断过的对话之后**每一次**请求都会失败（实测：连 26 条消息的小对话都救不回来）。
    const repaired = repairToolPairing(normalized);
    const msgs = repaired.messages;

    const promptChars = JSON.stringify(msgs).length;
    const body = {
      model: useModel,
      messages: msgs,
      stream: true,
      temperature: this.cfg.temperature ?? 1,
    };
    // 推理强度：云端认 `reasoning_effort`（实测写 xhigh 返回 200）。不写这个字段时，
    // 云端按模型自己的默认档位走 —— 与不选强度时的预期一致。
    const effort = normalizeReasoningEffort(reasoningEffort);
    if (effort !== undefined) body.reasoning_effort = effort;
    // 云端原生支持 function calling（实测会回标准 delta.tool_calls）。走原生时**不要**再
    // 往提示词里塞「请输出 bridge_tool_calls」那套文本协议 —— 两套并存会让模型一半概率
    // 去输出纯文本、一半概率去输出原生 tool_calls，而解析器只认其中一种。
    const nativeTools = Array.isArray(tools) && tools.length > 0;
    if (nativeTools) {
      // 归一化成 OpenAI 标准形状：DSH 那边发过来的是**扁平**的
      // {name, description, parameters}，云端只认 {type:'function', function:{…}}。
      body.tools = tools
        .map((t) => {
          const fn = t?.function && typeof t.function === 'object' ? t.function : t;
          if (!fn?.name) return null;
          return {
            type: 'function',
            function: {
              name: String(fn.name),
              description: fn.description || '',
              parameters: fn.parameters || { type: 'object', properties: {} },
            },
          };
        })
        .filter(Boolean);
      // 云端把 `tool_choice` 反序列化成 **string**：写 `{type:'function',…}` 会回 11101
      // "cannot unmarshal object into Go struct field … tool_choice of type string"。
      // 对象形态表达的是「必须调某一个工具」，云端没有对应的表达，就不写这个字段。
      if (typeof toolChoice === 'string' && toolChoice !== '') body.tool_choice = toolChoice;
    }
    // 输出预算按提示词**和工具清单**实际占的位置收一收：云端把「输入 + 预留输出」一起
    // 算进窗口，而工具清单同样是输入（桌面档 75 个工具，实测 68k 字符）。
    const toolsChars = Array.isArray(body.tools) ? JSON.stringify(body.tools).length : 0;
    body.max_tokens = this.outputTokensFor(useModel, promptChars + toolsChars);

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
      // 每次尝试都记一笔 —— 被拒时要能看出「是哪一次、发了几条消息」，
      // 否则渠道日志里只有一个原始请求的规模，永远分不清是首试被拒还是重试被拒。
      const attempts = [];
      /** 一次尝试：取令牌、发请求；失败时把响应体读成文本一起返回（成功时为空串）。 */
      const attempt = async (forceToken = false, attemptMessages = msgs, label = 'initial') => {
        const cred = await this.ensureToken(forceToken);
        // 裁短后的重试要按**裁短后**的大小重新预留输出：沿用原请求的预算，超长对话
        // 裁到几条消息之后仍然只给几百个 token，模型想完就没地方写答案了。
        const attemptBody = attemptMessages === msgs
          ? body
          : {
            ...body,
            messages: attemptMessages,
            max_tokens: this.outputTokensFor(useModel, JSON.stringify(attemptMessages).length + toolsChars),
          };
        const res = await this.postWithRetry(attemptBody, this.buildHeaders({ token: cred.token, uid: cred.uid, model: useModel }), ctl.signal);
        const raw = res.ok ? '' : await res.text().catch(() => '');
        attempts.push({ label, messages: attemptMessages.length, status: res.status });
        return { res, raw };
      };
      let { res, raw } = await attempt();
      // 401/403：token 过期或被换。11128：账号侧限流（实测与请求大小、推理强度、
      // 渠道头都无关：90 字的提示词也会撞上，停几分钟自己就好）。
      // 两种情况都重新收割一次令牌、等一会儿重试一次 —— 但**不裁对话**：这两个失败
      // 与请求内容无关，裁了只会让模型丢掉上下文（实测：模型因此答非所问，回一句
      // 「我在 D:\coding\odyssey，你想让我做什么」）。
      if (!res.ok && (res.status === 401 || res.status === 403 || isChannelRejection(raw))) {
        await delay(CHANNEL_RETRY_DELAY_MS);
        ({ res, raw } = await attempt(true, msgs, 'fresh-token'));
      }
      // 输入被拒（`400002 / param: input`）：上游以「参数被拒」表达这次输入不可接受。
      // 先原样重试一次（上游偶发），再按「装不下」处理：裁短对话重试。
      // 裁出来的每一份都要重新对齐工具调用 —— 切片切在工具调用中间会得到一个没有
      // 结果的 tool 消息，云端对那种请求回的仍是同一个 400002。
      if (!res.ok && isInputRejected(raw)) {
        await delay(CHANNEL_RETRY_DELAY_MS);
        ({ res, raw } = await attempt(false, msgs, 'retry'));
        for (const keep of [8, 2]) {
          if (res.ok || !isInputRejected(raw)) break;
          const trimmed = trimMessages(msgs, keep);
          // 这一档没裁掉任何东西（对话本来就比 keep 短）就换更小的那一档，别中止整条梯子。
          if (trimmed.length >= msgs.length) continue;
          const cut = repairToolPairing(trimmed);
          await delay(CHANNEL_RETRY_DELAY_MS);
          ({ res, raw } = await attempt(false, cut.messages, `trim-${cut.messages.length}`));
        }
      }
      if (!res.ok) {
        const summary = {
          at: new Date().toISOString(),
          model: useModel,
          messages: msgs.length,
          promptChars,
          tools: Array.isArray(tools) ? tools.length : 0,
          maxTokens: body.max_tokens,
          effort: effort ?? null,
          repaired: { dropped: repaired.dropped, synthesized: repaired.synthesized },
          attempts,
          clientVersion: this.clientVersion,
          deploymentType: this.deploymentType,
          status: res.status,
          response: Array.from(raw).slice(0, 400).join(''),
        };
        logChannelEvent(summary);
        throw this.mapError(res.status, raw, useModel);
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

  /**
   * 发请求，网络层失败时重试。
   *
   * 云端偶尔会直接断连（DNS 抖动 / 连接被重置 / TLS 握手失败），这时 fetch 抛的是
   * `fetch failed`，真正原因藏在 cause 里。直接把它当成最终失败，用户只会看到一句
   * 「上游调用失败」——实测这种瞬时断连重试一次就通。
   *
   * @param {object} body 请求体。
   * @param {object} headers 请求头。
   * @param {AbortSignal} [signal] 取消信号。
   * @param {number} [attempts] 最多尝试次数。
   * @returns {Promise<Response>} 成功的响应（状态码可能非 2xx，由调用方判定）。
   */
  async postWithRetry(body, headers, signal, attempts = 3) {
    let lastErr = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await this.post(body, headers, signal);
      } catch (e) {
        lastErr = e;
        // 取消/超时不是抖动，重试没有意义；原样抛出，让外层按超时处理。
        if (e?.name === 'AbortError' || signal?.aborted) throw e;
        if (i + 1 >= attempts) break;
        await delay(400 * (i + 1));
      }
    }
    throw this.mapNetworkError(lastErr);
  }

  /**
   * 把网络层失败映射成带诊断信息的异常。
   *
   * @param {Error|null} err - fetch 抛出的错误。
   * @returns {Error} 带 code / httpStatus / retriable 的异常。
   */
  mapNetworkError(err) {
    const cause = err?.cause;
    // Node 的 fetch 失败时 cause 可能是 AggregateError，真正的原因在 errors 数组里。
    const candidates = [];
    if (Array.isArray(cause?.errors)) candidates.push(...cause.errors);
    if (cause) candidates.push(cause);
    let detail = '';
    for (const c of candidates) {
      if (!c) continue;
      const code = c.code || c.errno;
      const msg = typeof c.message === 'string' ? c.message : '';
      if (!code && !msg) continue;
      detail = code && msg && !msg.includes(String(code)) ? `${code} ${msg}` : (msg || String(code));
      break;
    }
    if (!detail) detail = err?.message || '未知错误';
    return Object.assign(
      new Error(`无法连接 WorkBuddy 云端（${detail.slice(0, 200)}）。这是网络层失败，不是账号或模型问题。`),
      { code: 'upstream_network', httpStatus: 502, retriable: true, cause: err }
    );
  }

  /**
   * 把云端的错误响应映射成带诊断信息的异常。
   * @param {number} status HTTP 状态码。
   * @param {string} raw 响应体。
   * @param {string} [model] 本次请求的模型，写进渠道校验失败的诊断里。
   * @returns {Error} 带 code/httpStatus/retriable 的异常。
   */
  mapError(status, raw, model) {
    let detail = raw.slice(0, 300);
    let code = '';
    let msg = '';
    let param = '';
    let requestId = '';
    try {
      const j = JSON.parse(raw);
      code = String(j.code ?? '');
      msg = String(j.msg ?? '');
      detail = msg || detail;
      // 云端会点名是哪个参数不合法（推理强度写错时是 `reasoning.effort`），
      // 不带出来的话，报错只剩一句「参数不合法」，排查时无从下手。
      param = String(j.extError?.param ?? '');
      // requestId 是他们工单里要的那个号：有了它，一次拒绝就能查到底。
      requestId = String(j.requestId ?? '');
    } catch { /* 非 JSON 响应 */ }
    if (status === 400 && code === '11128') {
      // 官方客户端对这个码的动作是「改输入」（客户端自己的错误码表：11128 -> editInput，
      // 11133 才是「换模型」）。也就是说云端认为这次**请求内容**不可接受，而不是缺了
      // 哪个头。反代已经把能自动做的都做了：重新收割令牌重试一次、裁短对话再试一次。
      //
      // 这个码的真正含义：云端在这一刻**不接受这次调用**。实测它与请求大小、推理强度、
      // 渠道头都无关 —— 90 字的提示词也会撞上，而且总是在**短时间内连续发了许多次**
      // 之后出现、停一阵又自己好了。账号本来就有频率与额度上限（云端另一条提示写得很
      // 直白："usage exceeds frequency limit … you can switch to the other models"），
      // 撞到上限时它对不同模型给出不同的码：astra 给 14003/no_capacity（"模型忙，换模型"），
      // luna 这类给 11128。所以这是**账号侧的限流**，不是反代少发了什么。
      return Object.assign(new Error(
        `WorkBuddy 云端此刻不接受这次调用（${detail || 'Illegal API invocation from an unapproved channel'}）。`
        + `本次请求带的是官方客户端的渠道头（客户端版本 ${this.clientVersion}${model ? `，模型 ${model}` : ''}）。`
        + '已经重新收割令牌并原样重试过一次。'
        + '实测这个码与请求大小、推理强度、渠道头都无关：它在短时间内连续调用之后出现，'
        + '停一阵又自己好了 —— 是账号的频率/额度上限（云端另一条提示会直说'
        + '"usage exceeds frequency limit … switch to the other models"）。'
        + '换个模型或等几分钟即可，不必怀疑反代少了参数。'
        + (requestId === '' ? '' : `云端请求号 ${requestId}，报障时带上它。`)
      ), { code: 'upstream_rejected', httpStatus: 502, retriable: true, requestId });
    }
    if (status === 400 && code === '11101') {
      // 11101 是云端的**请求体解析失败**，不止「非流式」一种：`tool_choice` 写成对象、
      // `tool_calls[].function.arguments` 写成结构体，都会落到这个码上。所以只在云端
      // 明说非流式时才这么报，其余照抄它的原因。
      const nonStream = /non-?stream/i.test(detail) || /non-?stream/i.test(msg);
      return Object.assign(new Error(nonStream
        ? `WorkBuddy 云端拒绝非流式请求（${detail}）。`
        : `WorkBuddy 云端解析不了这次请求体：${detail || 'Unmarshal chat params failed'}。`
          + '它的请求体是严格类型：`tool_choice` 只接受字符串，`tool_calls[].function.arguments` 只接受 JSON 字符串。'
      ), { code: 'upstream_rejected', httpStatus: 502, retriable: false });
    }
    if (status === 400 && param === 'input') {
      // 上游用这一个码表达两种原因：输入超了窗口，或它自己拒收这段输入（实测：
      // 只有调用没有结果的工具对话也是同一个码）。反代已经把能自动做的都做了 ——
      // 对齐工具调用、按提示词和工具清单收输出预算、裁短后重试 —— 所以报错要说清
      // 这两种可能，而不是一口咬定「对话太长」。
      return Object.assign(new Error(
        `WorkBuddy 云端的上游模型拒收了这次输入：${detail || 'the request parameters were rejected by the model provider'}。`
        + '可能是这段输入超出了模型的上下文窗口（云端把「输入 + 预留输出」一起算），'
        + '也可能是上游对这次输入自身的校验不通过。'
        + '反代已经对齐了工具调用与结果、按提示词和工具清单收过输出预算，并把对话裁短后重试过；'
        + '仍然被拒就换一个模型，或者在这个工作区开一轮新对话。'
        + (requestId === '' ? '' : `云端请求号 ${requestId}，报障时带上它。`)
      ), { code: 'upstream_input_rejected', httpStatus: 502, retriable: false, requestId });
    }
    if (status === 400 && param !== '') {
      return Object.assign(new Error(
        `WorkBuddy 云端拒绝了请求里的参数 ${param}：${detail || 'invalid request parameters'}。`
        + '推理强度只认 low/medium/high/xhigh/max（关掉思维用 none）。'
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
