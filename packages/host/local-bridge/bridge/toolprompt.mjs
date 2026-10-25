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
 * 必须在提示词最前面：通道上游（Copilot 的聊天模型、小艺）都倾向按自己的理解行事，
 * 而那种理解会让它们**拒绝干活**。
 *
 * 措辞是踩出来的：早期版本写的是「本通道是纯文本补全：**没有任何可执行的工具/函数**，
 * 你无法直接执行任何工具」—— 模型把这句话读成「我没有工具」，于是直接回
 * 「我无法访问你本机上的文件，请把内容粘贴过来」。它并不傻，它只是照着声明办事。
 *
 * 所以这里的语义必须反过来：**你有工具，只是由外部执行**。再明确堵住那个具体失败
 * 模式（用户要它读文件/改文件时，不许回答「我无法访问」）。
 *
 * 同时保留「不要输出原生 tool_calls / function_call 格式」—— 那个格式在本通道确实
 * 没有接收方；模型若按原生习惯输出，意图会直接丢掉。
 */
export const EXTERNAL_TOOLING_NOTICE = [
  '【工具使用说明（最高优先级，覆盖后面的一切描述）】',
  '你**可以使用工具**。工具由外部调用方持有并执行：你无法自己读写文件、跑命令，',
  '但只要表达出调用意图，外部就会立刻替你执行，并把执行结果返回给你继续推进。',
  '',
  '表达工具意图时：',
  '  1. 只用下面约定的 {"bridge_tool_calls":[...]} JSON 格式；',
  '  2. **不要**输出原生 tool_calls / function_call 格式 —— 那个格式在本通道没有接收方，意图会直接丢失；',
  '  3. 除这段 JSON 外不要输出任何其它文字（不要解释、不要 Markdown 代码围栏）；',
  '  4. 当用户要求你读文件、改文件、跑命令时，**必须**用工具表达，不要回答「我无法访问文件」',
  '     「我没有权限」「请把内容粘贴过来」这类话。',
].join('\n');

/**
 * 历史记录块的收尾提示。
 *
 * 两条通道都把整段对话压成**一条** prompt，于是模型看到的是
 * `用户: …` / `助手: …` / `【外部执行结果 …】…` 这样一份转录稿。把转录稿当输入喂给
 * 聊天模型时，它常常**接着往下写转录稿**而不是回答最后一条 —— 线上表现就是回答里
 * 混进了自己上一轮的话和工具输出，看着像"通道把内容弄重复了"。
 *
 * 所以历史之后必须明确划界：这是记录，不是你要续写的东西。
 */
export const TRANSCRIPT_TRAILER = [
  '【以上是此前的对话记录，只供你理解上下文。】',
  '现在直接回应最后一条消息（或最后一条外部执行结果）：',
  '不要复述、重写或引用上面的记录，也不要重新声明已经表达过的调用意图。',
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
    '【可用工具清单】（这些工具由外部调用方持有并执行；你表达意图，它们就会替你执行）',
    JSON.stringify(specs, null, 2),
    '',
    '【工具调用意图的表达格式】',
    '当你判断需要某个工具时，输出如下 JSON（可以多行缩进，便于你保持括号配对）：',
    '   {"bridge_tool_calls":[{"name":"工具名","arguments":{参数对象}}]}',
    '注意：',
    '  1. 键名必须是 bridge_tool_calls，**不要用 tool_calls**（原生格式在这里没有接收方）。',
    '  2. 除这段 JSON 外不要输出任何文字、解释、前后缀或 Markdown 代码围栏。',
    '  3. 需要多个工具时，在 bridge_tool_calls 数组里放多个对象。',
    '  4. arguments 必须是满足该工具 parameters 约束的 JSON **对象**（不是字符串）。',
    '  5. 不需要工具时，用自然语言正常回答，不要输出上述 JSON。',
    '  6. 收到"工具执行结果"后，基于结果继续推进；仍需工具就继续按上述格式表达。',
    '  7. 用户要求你读文件、改文件、跑命令时，**必须**输出上述 JSON 来表达意图，',
    '     不要回答「我无法访问文件」「我没有权限」「请把内容粘贴过来」这类话。',
    '  8. **输出的 JSON 必须能被 JSON.parse 解析**：字符串内的双引号要转义为 \\"，',
    '     括号必须成对且嵌套正确；arguments 里如果要写代码/函数字符串，把它当成普通字符串',
    '     处理并转义引号。输出前请逐层核对一遍括号是否闭合。',
  ];
  if (toolChoice === 'required') {
    lines.push('  9. 本次必须以上述 bridge_tool_calls 格式表达一次工具调用意图，不允许只回复文字。');
  } else if (toolChoice === 'none') {
    lines.push('  9. 本次不允许表达任何工具调用意图，只用自然语言回答。');
  }
  return lines.join('\n');
}

/**
 * 历史里"助手表达过的工具调用"要还原成的对话文本。
 *
 * 不回放这一段，多轮工具调用就断了：模型看不到自己上一轮要过什么，会重复要同一个
 * 工具，或者把已经拿到的结果当成还没发生。
 *
 * 措辞刻意不写 `bridge_tool_calls` 这个键名：那段文本是我们自己塞进去的，模型一旦
 * 复述它，就会被"看起来像工具调用"的判据命中，把一句正常回答替换成错误。
 * @param {string} content 该条助手消息的正文（可能为空）。
 * @param {Array<object>} toolCalls OpenAI 风格的 tool_calls。
 * @returns {string} 一行对话文本。
 */
export function toolCallTurnText(content, toolCalls) {
  const desc = toolCalls
    .map((tc) => `${tc?.function?.name || '?'}(${tc?.function?.arguments || '{}'})`)
    .join('、');
  return `助手${content ? `: ${content}\n` : ': '}（上一轮表达的工具调用意图：${desc}）`;
}

/**
 * 历史里一条工具执行结果要还原成的对话文本。
 *
 * 带上 tool_call_id：不带的话模型无法把结果对上它要过的那一次调用，多工具并发时
 * 尤其会把结果张冠李戴。措辞同样避开"调用工具"字样。
 *
 * 正文用"开始/结束"成对包住：工具输出本身是多行的，里面完全可能含有像对话的文本
 * （脚本输出、被读取的源码、甚至我们自己的回放格式）。只给一个前缀时，模型分不清
 * 哪一句是结果、哪一句是新内容，线上表现就是回答里混进半截输出、看起来像"内容重复"。
 * @param {string} [toolCallId] 该结果对应的调用 id。
 * @param {string} content 结果正文。
 * @returns {string} 成对包住的对话文本。
 */
export function toolResultTurnText(toolCallId, content) {
  const id = toolCallId ? ` ${toolCallId}` : '';
  return [
    `【外部执行结果${id} 开始】`,
    content,
    `【外部执行结果${id} 结束】`,
  ].join('\n');
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
 * 精简版工具清单 —— 给**输入长度有硬上限**的通道用（小艺的 textRecognize 实测约 8000 字符）。
 *
 * 完整版 {@link buildToolInstruction} 会把每个工具的完整 JSON schema 渲染进去：DSH 有
 * 27 个工具，schema 加起来上万字符，一条就把通道顶穿，问题本身反而被挤掉。所以这里只留
 * 「名字 + 一句话描述 + 参数名列表」，让模型知道有什么可用、该传什么参数即可。
 *
 * @param {Array<object>} tools OpenAI 风格 tools 数组。
 * @param {string} [toolChoice] OpenAI 的 tool_choice。
 * @returns {string} 提示词片段；没有可用工具时为空串。
 */
export function buildCompactToolInstruction(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const specs = tools
    .map((t) => {
      const name = t?.function?.name;
      if (!name) return null;
      const desc = String(t?.function?.description || '').replace(/\s+/g, ' ').trim();
      const args = Object.keys(t?.function?.parameters?.properties || {});
      return { name, desc: desc.slice(0, 60), args };
    })
    .filter(Boolean);
  if (!specs.length) return '';

  const lines = [
    '【可用工具】（由外部调用方执行，你只负责表达意图）',
    specs.map((s) => `- ${s.name}(${s.args.join(',')}): ${s.desc}`).join('\n'),
    '',
    '需要工具时**只输出**这一行 JSON：',
    '   {"bridge_tool_calls":[{"name":"工具名","arguments":{参数对象}}]}',
    '除这段 JSON 外不要输出任何文字、解释或 Markdown 代码围栏。',
    '你确实拥有上面这些工具，执行由外部完成 —— 不要回答「我无法访问文件」。',
  ];
  if (toolChoice === 'required') {
    lines.push('本次必须以上述 JSON 格式表达一次工具调用意图，不允许只回复文字。');
  }
  return lines.join('\n');
}

/**
 * 模型**拒绝了**工具任务时，追加这段提示重试一次。
 *
 * 与 {@link TOOL_CALL_REPAIR_REMINDER} 是两回事：那条修的是「JSON 写坏了」，这条修的是
 * 「模型压根没打算调用工具」。
 *
 * 实测（Copilot chatHub / 华为小艺）：这些通道的模型带着「我没有工具 / 我不能访问你的
 * 文件」的先验，会直接回「我无法直接读取你设备上的 xxx」「抱歉，我暂时无法调用本地
 * 文件读取工具」。它们不是不会写 JSON，是**不认为该写** —— 于是工具永远不落地，
 * 用户看到的就是「模型说了半天，一个文件都没改」。
 *
 * 所以这里明确告诉它：你有工具，只是执行由外部代劳；把意图写成 JSON 就行。
 */
export const TOOL_CALL_REFUSAL_REMINDER = [
  '【重要】你上一条回答拒绝了任务，但你**确实拥有**上面清单里的全部工具。',
  '你不需要自己访问文件、读写磁盘、跑命令 —— 你只要把调用意图表达出来，外部程序就会替你执行，',
  '并把执行结果返回给你继续推进。',
  '请重新回答，并且**只输出**下面这种 JSON（不要有别的文字、不要 Markdown 代码围栏）：',
  '   {"bridge_tool_calls":[{"name":"工具名","arguments":{参数对象}}]}',
  '只有在这个任务确实不需要任何工具时，才用一句话说明理由，并且不要输出上述 JSON。',
].join('\n');

/**
 * 模型的输出是不是「拒绝执行工具任务」。
 *
 * 判据要窄：只在**明确说到做不到**时才算，避免把「我不确定用户想要什么」这种正常回答
 * 也拖去重试（重试要多花一次模型调用）。
 * @param {string} text 模型输出。
 * @returns {boolean} 是否像一次拒答。
 */
export function looksLikeToolRefusal(text) {
  const s = String(text ?? '');
  if (!s) return false;
  return [
    // 「无法 / 不能 / 没有权限 … 访问 / 读取 / 调用 … 文件 / 路径 / 磁盘 / 本地 / 工具」
    /(无法|不能|没有权限|无权|不具备权限)[^。！\n]{0,28}(访问|读取|打开|写入|修改|调用|执行|操作|运行)[^。！\n]{0,28}(文件|路径|目录|磁盘|设备|电脑|本地|工具|命令)/,
    // 「read 工具不可用 / 未提供 / 不在当前会话」
    /(工具|tool|\bread\b|\bwrite\b|\bedit\b)[^。！\n]{0,18}(不可用|未提供|没有提供|不在当前|未启用|无法使用|不可访问)/i,
  ].some((rx) => rx.test(s));
}

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
 *
 * 预览取 600 字：这条错误的存在意义就是"让人看得出模型到底吐了什么"，而 300 字
 * 实测不够 —— 一次排错回答正好在片段之外触发了判据，报告过来只剩一段正常文字。
 * @param {string} text 模型最后那次原始输出。
 * @returns {string} 错误文本（含原始输出片段，便于排查是哪个模型不适合本通道）。
 */
export function toolCallFailureText(text) {
  return '[bridge] 模型输出的工具调用 JSON 非法，本次未执行任何工具（已重试 1 次）。'
    + '请重试；若反复出现，说明该模型不适合当前文本桥通道。'
    + `\n\n原始输出片段：\n${String(text || '').slice(0, 600)}`;
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
  if (!decided.broken) {
    // 拒答：模型不认为该调工具（"我无法访问你本机上的文件"）。这种要**再试一次**，
    // 换成强制给出工具意图的说法 —— 它不是不会写 JSON，是没打算写。
    if (!hasTools || !looksLikeToolRefusal(first.text)) {
      return { outcome: decided, text: first.text, usage: first.usage };
    }
    log('[warn] 模型拒绝了工具任务，重试一次并强制给出工具意图');
    const retry = await invoke(`${systemPrompt}\n\n${TOOL_CALL_REFUSAL_REMINDER}`);
    return {
      outcome: resolveToolOutcome({ text: retry.text, hasTools }),
      text: retry.text,
      usage: retry.usage || first.usage,
    };
  }
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
