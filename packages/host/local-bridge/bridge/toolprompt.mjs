// 文本通道上的工具调用协议
//
// 两条内置通道（WorkBuddy 网关、Microsoft Copilot chatHub）都**没有原生 function
// calling**：前者背后是一个自带白名单工具的 agent，给它 tools 会抛
// `Tool xxx not found`；后者只接受一条纯文本 prompt。所以工具调用只能靠"文本协议"
// 往返：把 tools 渲染成提示词里的清单与格式约定，模型用
// `{"bridge_tool_calls":[{"name":…,"arguments":{…}}]}` 表达意图，本模块把它还原成
// OpenAI 的 tool_calls。
//
// 两条通道共用这里的一份实现，因为它们面对的是同一个协议、同一类模型生成缺陷；
// 各通道不同的只是"怎么把 prompt 送到上游"，那部分留在各自的模块里。
//
// 零依赖，仅用 Node 标准库。

import { parseToolCalls, looksLikeToolCallAttempt } from './toolcalls.mjs';

/**
 * 工具由外部持有并执行这一点的声明。
 *
 * 必须在提示词最前面：通道上游（WorkBuddy 那个 agent、Copilot 的聊天模型）都倾向
 * 按自己的理解发起"原生"调用，而那种调用没有任何人接收。措辞刻意避开"你可以调用
 * 工具"，改成"你只能表达意图"。
 */
export const EXTERNAL_TOOLING_NOTICE = [
  '【运行环境声明（最高优先级，覆盖后面的一切描述）】',
  '本通道是纯文本补全：**没有任何可执行的工具/函数**，你无法直接执行任何工具。',
  '所有工具都由外部调用方持有并执行，你只负责用纯文本表达调用意图。',
  '因此绝对不要输出 tool_calls、function_call 之类的原生函数调用格式 —— 没有人会收到它。',
].join('\n');

/**
 * 把 OpenAI tools 定义渲染成提示词里的清单与格式约定。
 * @param {Array<object>} tools OpenAI 风格 tools 数组。
 * @param {string} [toolChoice] OpenAI 的 tool_choice：`required` / `none` / 其他。
 * @returns {string} 提示词片段；没有可用工具时为空串。
 */
export function buildToolInstruction(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const specs = tools
    .map((t) => ({
      name: t?.function?.name,
      description: t?.function?.description || '',
      parameters: t?.function?.parameters || { type: 'object', properties: {} },
    }))
    .filter((t) => t.name);
  if (!specs.length) return '';

  const lines = [
    '【可用工具清单】（由外部调用方持有并执行，你无法直接执行，只能表达意图）',
    JSON.stringify(specs, null, 2),
    '',
    '【工具调用意图的表达格式】',
    '当你判断需要某个工具时，输出如下 JSON（可以多行缩进，便于你保持括号配对）：',
    '   {"bridge_tool_calls":[{"name":"工具名","arguments":{参数对象}}]}',
    '注意：',
    '  1. 键名必须是 bridge_tool_calls，**不要用 tool_calls**。',
    '  2. 除这段 JSON 外不要输出任何文字、解释、前后缀或 Markdown 代码围栏。',
    '  3. 需要多个工具时，在 bridge_tool_calls 数组里放多个对象。',
    '  4. arguments 必须是满足该工具 parameters 约束的 JSON **对象**（不是字符串）。',
    '  5. 不需要工具时，用自然语言正常回答，不要输出上述 JSON。',
    '  6. 收到"工具执行结果"后，基于结果继续推进；仍需工具就继续按上述格式表达。',
    '  7. **输出的 JSON 必须能被 JSON.parse 解析**：字符串内的双引号要转义为 \\"，',
    '     括号必须成对且嵌套正确；arguments 里如果要写代码/函数字符串，把它当成普通字符串',
    '     处理并转义引号。输出前请逐层核对一遍括号是否闭合。',
  ];
  if (toolChoice === 'required') {
    lines.push('  7. 本次必须以上述 bridge_tool_calls 格式表达一次工具调用意图，不允许只回复文字。');
  } else if (toolChoice === 'none') {
    lines.push('  7. 本次不允许表达任何工具调用意图，只用自然语言回答。');
  }
  return lines.join('\n');
}

/**
 * 历史里"助手表达过的工具调用"要还原成的对话文本。
 *
 * 不回放这一段，多轮工具调用就断了：模型看不到自己上一轮要过什么，会重复要同一个
 * 工具，或者把已经拿到的结果当成还没发生。
 * @param {string} content 该条助手消息的正文（可能为空）。
 * @param {Array<object>} toolCalls OpenAI 风格的 tool_calls。
 * @returns {string} 一行对话文本。
 */
export function toolCallTurnText(content, toolCalls) {
  const desc = toolCalls
    .map((tc) => `${tc?.function?.name || '?'}(${tc?.function?.arguments || '{}'})`)
    .join('、');
  return `助手${content ? `: ${content}\n` : ': '}（上一轮表达的 bridge_tool_calls 意图：${desc}）`;
}

/**
 * 历史里一条工具执行结果要还原成的对话文本。
 *
 * 带上 tool_call_id：不带的话模型无法把结果对上它要过的那一次调用，多工具并发时
 * 尤其会把结果张冠李戴。措辞同样避开"调用工具"字样。
 * @param {string} [toolCallId] 该结果对应的调用 id。
 * @param {string} content 结果正文。
 * @returns {string} 一行对话文本。
 */
export function toolResultTurnText(toolCallId, content) {
  return `【外部执行结果${toolCallId ? ` ${toolCallId}` : ''}】${content}`;
}

/**
 * 一条消息若带着工具语义，渲染成它该占的对话文本。
 *
 * 两条通道都靠这个把工具轮次回放进单条 prompt：不回放，多轮工具调用就断了 ——
 * 模型看不到自己上一轮要过什么，会重复要同一个工具，或者把已拿到的结果当成还没发生。
 * @param {object} message OpenAI 风格消息。
 * @param {string} content 该条消息已抽出的正文（可能为空）。
 * @returns {string|null} 对话文本；没有工具语义时返回 null。
 */
export function toolTurnText(message, content) {
  if (message?.role === 'tool') return toolResultTurnText(message.tool_call_id, content);
  if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return toolCallTurnText(content, message.tool_calls);
  }
  return null;
}

/** JSON 非法且确实在表达工具调用时，追加这段提示重试一次。 */export const TOOL_CALL_REPAIR_REMINDER = [
  '【重要】上一次的输出不是合法 JSON（括号或逗号不匹配），本次请求已失败。请重新输出，并严格遵守：',
  '  1. 只输出一个 JSON 对象，不要有注释、尾逗号或 Markdown 代码围栏；',
  '  2. 字符串内的双引号必须转义为 \\"，反斜杠转义为 \\\\；',
  '  3. 括号必须成对、嵌套正确，输出前逐层核对一遍；',
  '  4. arguments 必须是 JSON 对象，不是字符串。',
].join('\n');

/**
 * 把一次模型输出判定成"工具调用"还是"最终回答"。
 * @param {object} input 判定输入。
 * @param {string} input.text 模型输出的全文。
 * @param {boolean} input.hasTools 本次请求是否带了工具清单。
 * @returns {{calls: Array<object>|null, content: string, broken: boolean}}
 *   `broken` 表示"明显在表达工具调用但 JSON 写坏了" —— 调用方必须显式报错，
 *   绝不能把半截 JSON 当最终回答下发（那会让下游 agent 以为任务已完成）。
 */
export function resolveToolOutcome({ text, hasTools }) {
  const raw = String(text ?? '');
  if (!hasTools) return { calls: null, content: raw, broken: false };
  const calls = parseToolCalls(raw);
  if (calls) return { calls, content: '', broken: false };
  if (looksLikeToolCallAttempt(raw)) return { calls: null, content: '', broken: true };
  return { calls: null, content: raw, broken: false };
}

/**
 * 解析失败时下发给调用方的错误文本。
 * @param {string} text 模型最后那次原始输出。
 * @returns {string} 错误文本（含原始输出片段，便于排查是哪个模型不适合本通道）。
 */
export function toolCallFailureText(text) {
  return '[bridge] 模型输出的工具调用 JSON 非法，本次未执行任何工具（已重试 1 次）。'
    + '请重试；若反复出现，说明该模型不适合当前文本桥通道。'
    + `\n\n原始输出片段：\n${String(text || '').slice(0, 300)}`;
}

/**
 * 带工具时的一次（必要时两次）模型调用（非流式）。
 *
 * JSON 写坏时先重试一次；仍失败就把最后一次的原文与判定一起交回去，由调用方显式
 * 报错 —— 绝不把半截 JSON 当"最终回答"下发。
 * @param {object} options 调用参数。
 * @param {(systemPrompt: string) => Promise<{text: string, usage?: object}>} options.invoke
 *   用给定 system prompt 走上游一次；由各通道实现。
 * @param {string} options.systemPrompt 本次的 system prompt。
 * @param {boolean} options.hasTools 本次请求是否带了工具清单。
 * @param {(message: string) => void} [options.log] 收过程日志。
 * @returns {Promise<{outcome: {calls: Array<object>|null, content: string, broken: boolean}, text: string, usage: object|undefined}>}
 */
export async function completeWithToolCalls({ invoke, systemPrompt, hasTools, log = () => {} }) {
  const first = await invoke(systemPrompt);
  const decided = resolveToolOutcome({ text: first.text, hasTools });
  if (!decided.broken) return { outcome: decided, text: first.text, usage: first.usage };
  log(`[warn] 工具调用解析失败，疑似 JSON 非法（输出 ${String(first.text || '').length} 字），重试一次`);
  const retry = await invoke(`${systemPrompt}\n\n${TOOL_CALL_REPAIR_REMINDER}`);
  return {
    outcome: resolveToolOutcome({ text: retry.text, hasTools }),
    text: retry.text,
    usage: retry.usage || first.usage,
  };
}

/**
 * 流式通道上"边流边判"的闸门。
 *
 * 工具调用必须收全文才能解析，但普通回答应当照常逐段下发 —— 带工具时无条件缓冲会
 * 让每条回答都失去流式。约定里模型要么整段输出工具调用 JSON，要么正常说话，所以
 * 只要看开头就能分开：开头（忽略空白）是 `{`、代码围栏，或是模型自带的调用标记
 * （`<｜DSML｜…`）就当工具调用，扣住不发；否则立刻判定为正文，之后一路直发。
 *
 * 标记开头的判定要能容忍"还没收全"：首段可能只有一个 `<`，这时不能急着判成正文，
 * 否则 `<｜DSML｜…` 的前半截已经流出去了。只有确认后面不是标记才放行。
 * @returns {{push: (delta: string) => string, settle: (isCall: boolean) => string}}
 *   `push` 返回此刻可以立即下发的文本（可能为空）；`settle` 在收尾时返回仍扣着的
 *   文本 —— 判定为工具调用时丢弃，否则作为正文补齐。
 */
export function createToolCallGate() {
  /** 'undecided' | 'prose' | 'toolish' */
  let mode = 'undecided';
  let held = '';
  return {
    push(delta) {
      if (mode === 'prose') return delta;
      held += delta;
      if (mode === 'toolish') return '';
      if (/^\s*$/u.test(held)) return '';
      if (/^\s*[`{]/u.test(held)) {
        mode = 'toolish';
        return '';
      }
      // 可能是原生标记的开头：先扣住，等下一个增量再判。
      if (/^\s*<\s*$/u.test(held)) return '';
      if (/^\s*<\s*[｜|]/u.test(held)) {
        mode = 'toolish';
        return '';
      }
      mode = 'prose';
      const out = held;
      held = '';
      return out;
    },
    settle(isCall) {
      const out = isCall ? '' : held;
      held = '';
      return out;
    },
  };
}
