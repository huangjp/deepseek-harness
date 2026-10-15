// 工具调用解析：把模型输出的**纯文本**还原成 OpenAI tool_calls。
//
// 背景（为什么要单独一个模块、为什么不能只用 JSON.parse）：
//   本地模型服务 /api/v1/llm/completions 不支持原生 function calling，工具调用只能靠
//   "文本协议"表达：{"bridge_tool_calls":[{"name":"...","arguments":{...}}]}。
//   模型在这种"长嵌套 JSON + 内嵌代码/函数字符串"的生成上并不可靠 —— 实测（2026-10-08
//   下游 formcreate-agent 的生产 trace）约 1/3 的输出会出现：
//     - 少一个 }（brace 净差 +1）
//     - 多一个 ]（bracket 净差 -1）
//     - 多一个 }
//     - 把 summarize / scenarios 误放到 wrapper 层，而不是塞进 arguments
//   旧实现只做「剥围栏 + 括号平衡扫描 + JSON.parse」，遇到这类输出直接判"不是工具调用"，
//   于是半截 JSON 被当正文吐给下游 agent —— 表现为"模型回答已改好，其实什么都没执行"。
//
// 本模块做三件事：
//   1. 候选提取：整体 → 从 bridge_tool_calls 起点截到文本末尾 → 逐个括号平衡片段
//   2. JSON 修复：去尾逗号 → 用栈补齐 / 丢弃错配括号 → 逐个重试解析
//   3. 结构兜底：只有一个调用时，把误放在 wrapper 层的参数键并回 arguments

/**
 * 从文本里提取所有"括号平衡"的 JSON 对象子串（正确处理字符串内的引号与转义）。
 * 注意：对**本身就不平衡**的输出无效 —— 那种情况交给 repairJsonText。
 */
export function extractJsonObjects(text) {
  const s = String(text);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end > i) out.push(s.slice(i, end + 1));
  }
  return out;
}

/** 去掉对象/数组里的尾逗号（字符串内不动）。 */
function stripTrailingCommas(s) {
  const out = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { out.push(c); esc = false; continue; }
    if (c === '\\') { out.push(c); if (inStr) esc = true; continue; }
    if (c === '"') { inStr = !inStr; out.push(c); continue; }
    if (!inStr && c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue; // 后面直接是闭合符 → 丢掉这个逗号
    }
    out.push(c);
  }
  return out.join('');
}

/**
 * 用栈把"近似 JSON"修成合法 JSON：
 *   - 闭合符在栈里找不到对应开括号 → 视为多余，丢弃
 *   - 闭合符与栈顶不匹配 → 先补上中间缺失的闭合符，再闭合匹配的那个
 *   - 结尾仍有未闭合的开括号 → 按栈逆序补全
 *   - 字符串未闭合（引号成对性被破坏）→ 末尾补一个 "
 * 字符串内部的括号不参与（用 inStr / esc 跟踪）。
 */
function balanceJson(s) {
  const out = [];
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { out.push(c); esc = false; continue; }
    if (c === '\\') { out.push(c); if (inStr) esc = true; continue; }
    if (c === '"') { inStr = !inStr; out.push(c); continue; }
    if (inStr) { out.push(c); continue; }
    if (c === '{' || c === '[') { stack.push(c); out.push(c); continue; }
    if (c === '}' || c === ']') {
      const want = c === '}' ? '{' : '[';
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k] === want) { idx = k; break; }
      }
      if (idx < 0) continue; // 多余闭合符 → 丢弃
      for (let k = stack.length - 1; k > idx; k--) out.push(stack[k] === '{' ? '}' : ']');
      stack.length = idx; // 连同匹配的开括号一起弹出
      out.push(c);
      continue;
    }
    out.push(c);
  }
  if (inStr) out.push('"');
  while (stack.length) { const o = stack.pop(); out.push(o === '{' ? '}' : ']'); }
  return out.join('');
}

/** 生成若干"修复后的 JSON 候选"（去重、保序、尽量轻量）。 */
export function repairJsonText(s) {
  const seen = new Set();
  const out = [];
  const push = (x) => {
    const t = String(x ?? '').trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  };
  push(s);
  const noTrailing = stripTrailingCommas(String(s ?? ''));
  push(noTrailing);
  push(balanceJson(String(s ?? '')));
  push(balanceJson(noTrailing));
  return out;
}

/** 把解析出来的对象转成 tool_calls；不是工具调用则返回 null。 */
function toToolCalls(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  let list = null;
  let wrapperKeys = [];
  if (Array.isArray(obj.bridge_tool_calls)) {
    list = obj.bridge_tool_calls;
    wrapperKeys = Object.keys(obj).filter((k) => k !== 'bridge_tool_calls');
  } else if (Array.isArray(obj.tool_calls)) {
    list = obj.tool_calls;
    wrapperKeys = Object.keys(obj).filter((k) => k !== 'tool_calls');
  } else if (obj.name && obj.arguments !== undefined) {
    list = [obj];
  }
  if (!Array.isArray(list) || !list.length) return null;

  const calls = list
    .map((t, i) => {
      const name = String(t?.name || t?.function?.name || '');
      let args = t?.arguments !== undefined ? t.arguments : t?.function?.arguments;
      if (args === undefined || args === null) args = {};
      // 模型常见错误：把 summarize / scenarios 之类参数放到 wrapper 层。
      // 只有一个调用时并回 arguments（不覆盖已有键），多个调用时语义不明，不做猜测。
      if (list.length === 1 && wrapperKeys.length && args && typeof args === 'object' && !Array.isArray(args)) {
        const merged = { ...args };
        for (const k of wrapperKeys) {
          if (merged[k] === undefined && obj[k] !== undefined) merged[k] = obj[k];
        }
        args = merged;
      }
      return {
        id: `call_${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`,
        type: 'function',
        function: {
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      };
    })
    .filter((c) => c.function.name);

  return calls.length ? calls : null;
}

/** 从模型输出里解析工具调用；不是工具调用则返回 null。 */
export function parseToolCalls(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const seeds = [];
  // 优先：从 bridge_tool_calls 所在对象的起点截到文本末尾
  // （模型常把 JSON 放在一句正文之后、结尾之前，且结尾的 JSON 可能本身不平衡）
  const key = s.indexOf('bridge_tool_calls');
  if (key >= 0) {
    const start = s.lastIndexOf('{', key);
    if (start >= 0) seeds.push(s.slice(start));
  }
  seeds.push(s);
  seeds.push(...extractJsonObjects(s));

  for (const seed of seeds) {
    for (const cand of repairJsonText(seed)) {
      let obj;
      try { obj = JSON.parse(cand); } catch { continue; }
      const calls = toToolCalls(obj);
      if (calls) return calls;
    }
  }
  return null;
}

/** 文本看起来像是在表达工具调用（用于区分"合法的文字回答"和"写坏了的工具调用"）。 */
export function looksLikeToolCallAttempt(text) {
  return /bridge_tool_calls|"arguments"\s*:|"tool_calls"\s*:/.test(String(text || ''));
}
