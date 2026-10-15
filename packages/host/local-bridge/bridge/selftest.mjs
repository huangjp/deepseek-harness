// 端到端自测。
//
// 分两阶段，避免"链路没通却因为拿到了模型报错文本而误判成功"：
//   阶段 1  mock 后端   —— 验证适配层自身：路由、SSE 帧、JSON 契约、错误映射、并发
//   阶段 2  真实后端     —— 验证凭证是否可用、真实总结 JSON 是否符合 schema
//
// 用法：
//   node selftest.mjs          两阶段都跑
//   node selftest.mjs --mock   只跑阶段 1（不消耗额度）

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseToolCalls, looksLikeToolCallAttempt } from './toolcalls.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, 'bridge.config.json'), 'utf8'));
const MOCK_ONLY = process.argv.includes('--mock');

// 模型在鉴权失败时会把这行文本当成正文吐回来，必须显式识别，否则会假通过。
const AUTH_ERROR_MARK = /authentication required|please use \/login/i;

const SYNTHETIC_CHAT = [
  { time: '2026-09-29 09:12', speaker: '张伟', text: '明天下午三点的评审会你参加吗？' },
  { time: '2026-09-29 09:13', speaker: '李娜', text: '参加，我把上周的接口文档再顺一遍' },
  { time: '2026-09-29 09:15', speaker: '张伟', text: '好，那登录鉴权那块你重点讲，老板上次提过' },
  { time: '2026-09-29 09:20', speaker: '李娜', text: '没问题。另外测试环境数据库昨天挂了，运维说今天中午前恢复' },
  { time: '2026-09-29 09:22', speaker: '张伟', text: '那我先跟运维确认一下，别影响评审演示' },
  { time: '2026-09-29 09:25', speaker: '李娜', text: '好的，演示用的假数据我已经准备好了' },
];

const results = [];
const record = (phase, name, status, detail = '') => {
  results.push({ phase, name, status, detail });
  const tag = status === 'pass' ? 'PASS' : status === 'blocked' ? 'BLOCK' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
};

async function startBridge(env) {
  const port = env.BRIDGE_PORT;
  const child = spawn(process.execPath, [path.join(__dirname, 'bridge.mjs')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => { log += b.toString(); });
  child.stderr.on('data', (b) => { log += b.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const auth = config.server?.apiKey ? { authorization: `Bearer ${config.server.apiKey}` } : {};

  const call = async (pathname, options = {}) => {
    const res = await fetch(base + pathname, {
      ...options,
      headers: { 'content-type': 'application/json', ...auth, ...(options.headers || {}) },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 可能是 SSE */ }
    return { status: res.status, json, text };
  };

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const r = await call('/health'); if (r.status === 200) break; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 400));
  }

  return { base, auth, call, child, stop: () => { try { child.kill(); } catch { /* ignore */ } }, getLog: () => log };
}

async function runPhase(phase, env, { expectModel }) {
  const srv = await startBridge(env);
  try {
    const health = await srv.call('/health');
    record(phase, '服务启动 /health', health.status === 200 && health.json?.ok ? 'pass' : 'fail',
      `backend=${health.json?.backend} model=${health.json?.model}`);

    if (expectModel === 'real') {
      const b = health.json?.cli || {};
      const label = health.json?.backend === 'serve' ? '本地服务端点已解析' : 'CLI 可执行文件存在';
      record(phase, label, b.ok !== false ? 'pass' : 'fail',
        b.baseUrl || b.binPath || JSON.stringify(b));
    }

    const models = await srv.call('/v1/models');
    record(phase, 'GET /v1/models', models.status === 200 && Array.isArray(models.json?.data) ? 'pass' : 'fail',
      models.json?.data?.[0]?.id || '');

    // --- 非流式对话 ---
    const chat = await srv.call('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: config.cli?.model, messages: [{ role: 'user', content: '只回复两个字：可用' }] }),
    });
    const chatText = chat.json?.choices?.[0]?.message?.content || '';
    if (chat.status !== 200) {
      const msg = chat.json?.error?.message || chat.text.slice(0, 140);
      record(phase, 'POST /v1/chat/completions（非流式）', expectModel === 'real' ? 'blocked' : 'fail', msg);
    } else if (AUTH_ERROR_MARK.test(chatText)) {
      // 关键断言：拿到了 200 但正文是鉴权错误 -> 必须判失败，不能算通过
      record(phase, 'POST /v1/chat/completions（非流式）', 'blocked', '模型返回鉴权错误文本（CLI 未登录）');
    } else {
      record(phase, 'POST /v1/chat/completions（非流式）', chatText.length > 0 ? 'pass' : 'fail', `返回 ${chatText.length} 字`);
    }

    // --- 流式对话 ---
    let streamed = '';
    let streamErr = '';
    try {
      const res = await fetch(`${srv.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...srv.auth },
        body: JSON.stringify({ messages: [{ role: 'user', content: '数到三' }], stream: true }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 2);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.error) streamErr = evt.error.message;
            else streamed += evt?.choices?.[0]?.delta?.content || '';
          } catch { /* ignore */ }
        }
      }
    } catch (err) { streamErr = err.message; }

    if (streamErr || AUTH_ERROR_MARK.test(streamed)) {
      record(phase, 'POST /v1/chat/completions（流式 SSE）', expectModel === 'real' ? 'blocked' : 'fail', streamErr || '模型返回鉴权错误文本');
    } else {
      record(phase, 'POST /v1/chat/completions（流式 SSE）', streamed.length > 0 ? 'pass' : 'fail', `收到 ${streamed.length} 字增量`);
    }

    // --- 结构化总结（核心验收项）---
    const sum = await srv.call('/summarize', {
      method: 'POST',
      body: JSON.stringify({ messages: SYNTHETIC_CHAT, sessionId: 'selftest', style: 'detailed' }),
    });
    const summary = sum.json?.summary;

    if (sum.status !== 200) {
      record(phase, 'POST /summarize 返回 JSON', expectModel === 'real' ? 'blocked' : 'fail',
        sum.json?.error?.message || sum.text.slice(0, 140));
    } else if (!summary) {
      record(phase, 'POST /summarize 返回 JSON', 'fail', '返回 200 但 summary 不是可解析的 JSON');
      if (sum.json?.raw) console.log(`        原始输出片段: ${String(sum.json.raw).slice(0, 200)}`);
    } else {
      const required = config.summary?.schema?.required || [];
      const missing = required.filter((k) => summary[k] === undefined);
      record(phase, 'POST /summarize 返回 JSON', 'pass');
      record(phase, '总结符合 schema 必填字段', missing.length === 0 ? 'pass' : 'fail',
        missing.length ? `缺少 ${missing.join(', ')}` : required.join(', '));
      record(phase, '总结内容非空', summary.headline && summary.overview ? 'pass' : 'fail',
        summary.headline ? `"${String(summary.headline).slice(0, 40)}"` : '');
      console.log('\n  ---- 总结样例 ----');
      console.log('  ' + JSON.stringify(summary, null, 2).split('\n').join('\n  '));
      console.log('');
    }

    // --- 错误映射：非法请求应当被明确拒绝，而不是 500 ---
    const bad = await srv.call('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) });
    record(phase, '空 messages 被正确拒绝(400)', bad.status === 400 ? 'pass' : 'fail', `HTTP ${bad.status}`);

    const notFound = await srv.call('/nope');
    record(phase, '未知路由返回 404', notFound.status === 404 ? 'pass' : 'fail', `HTTP ${notFound.status}`);

    // --- 兼容性：别名路径与浏览器测试页 ---
    const alias = await srv.call('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: '只回复两个字：可用' }] }),
    });
    const aliasText = alias.json?.choices?.[0]?.message?.content || '';
    record(phase, '别名路径 /chat/completions（不带 /v1）',
      alias.status === 200 && !AUTH_ERROR_MARK.test(aliasText) ? 'pass' : (expectModel === 'real' ? 'blocked' : 'fail'),
      alias.status === 200 ? `返回 ${aliasText.length} 字` : `HTTP ${alias.status}`);

    const page = await srv.call('/');
    record(phase, '浏览器测试页 GET /', page.status === 200 && page.text.includes('WorkBuddy') ? 'pass' : 'fail',
      `HTTP ${page.status} ${page.text.length} 字节`);

    // --- function calling 兼容层：tools 进 → tool_calls 出 ---
    let toolName = '';
    let sawToolFrame = false;
    try {
      const res = await fetch(`${srv.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...srv.auth },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '帮我生成一个社团招新报名表' }],
          tools: [{
            type: 'function',
            function: {
              name: 'build_form',
              description: '根据需求生成表单结构',
              parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
            },
          }],
          tool_choice: 'auto',
          stream: true,
        }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 2);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const tc = JSON.parse(payload)?.choices?.[0]?.delta?.tool_calls?.[0];
            if (tc) { sawToolFrame = true; toolName = tc.function?.name || ''; }
          } catch { /* ignore */ }
        }
      }
    } catch { /* 记为失败 */ }
    record(phase, 'function calling（tools 进 → tool_calls 出）',
      sawToolFrame && toolName === 'build_form' ? 'pass' : (expectModel === 'real' ? 'blocked' : 'fail'),
      sawToolFrame ? `工具名=${toolName}` : '未收到 tool_calls 帧');

    return srv.getLog();
  } finally {
    srv.stop();
  }
}

/**
 * 阶段 1b：mock 后端（JSON 破坏版）—— 验证"解析修复 + 重试"链路。
 *
 * 复刻的是线上真实故障：模型输出的 bridge_tool_calls JSON 括号多余、参数误放到
 * wrapper 层。旧实现在这种情况下会把半截 JSON 当正文吐回下游，表现为
 * "模型说改好了、其实什么都没执行"。这里断言它仍能被还原成 tool_calls。
 */
async function runBrokenJsonPhase() {
  const srv = await startBridge({ BRIDGE_PORT: '8793', BRIDGE_BACKEND: 'mock', BRIDGE_MOCK_MALFORMED: '1' });
  try {
    let toolName = '';
    let toolArgs = '';
    let leaked = '';
    const res = await fetch(`${srv.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...srv.auth },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '帮我生成一个社团招新报名表' }],
        tools: [{
          type: 'function',
          function: {
            name: 'build_form',
            description: '根据需求生成表单结构',
            parameters: { type: 'object', properties: { title: { type: 'string' } } },
          },
        }],
        tool_choice: 'auto',
        stream: true,
      }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload);
          const tc = evt?.choices?.[0]?.delta?.tool_calls?.[0];
          if (tc) { toolName = tc.function?.name || ''; toolArgs = tc.function?.arguments || ''; }
          leaked += evt?.choices?.[0]?.delta?.content || '';
        } catch { /* ignore */ }
      }
    }
    record('mock-broken', '非法 JSON 仍能还原 tool_calls',
      toolName === 'build_form' ? 'pass' : 'fail',
      toolName ? `工具名=${toolName}` : `未还原，正文泄漏 ${leaked.length} 字`);
    record('mock-broken', 'wrapper 层参数已并回 arguments',
      /"summarize"/.test(toolArgs) ? 'pass' : 'fail',
      toolArgs ? toolArgs.slice(0, 80) : '(空)');
  } finally {
    srv.stop();
  }
}

console.log('\n=== weflow-bridge 自测 ===');

// 阶段 0：纯单元 —— 解析/修复逻辑（不启服务、不消耗额度）
console.log('\n[阶段 0] 单元测试 —— toolcalls.mjs 解析与修复');
const UNIT_CASES = [
  ['合法 JSON', '{"bridge_tool_calls":[{"name":"t","arguments":{"a":1}}]}', 't'],
  ['多余 ]', '{"bridge_tool_calls":[{"name":"t","arguments":{"a":1}}]]}', 't'],
  ['少一个 }', '{"bridge_tool_calls":[{"name":"t","arguments":{"a":1}}]', 't'],
  ['尾逗号', '{"bridge_tool_calls":[{"name":"t","arguments":{"a":1,},}],}', 't'],
  ['前置自然语言', '我先调用工具：\n{"bridge_tool_calls":[{"name":"t","arguments":{"a":1}}]}', 't'],
  ['markdown 围栏', '```json\n{"bridge_tool_calls":[{"name":"t","arguments":{"a":1}}]}\n```', 't'],
  ['wrapper 层参数', '{"bridge_tool_calls":[{"name":"t","arguments":{"a":1}}],"summarize":"x"}', 't'],
  ['裸对象', '{"name":"t","arguments":{"a":1}}', 't'],
  ['普通回答不误判', '你好，我不需要调用工具。', null],
  ['空文本', '', null],
];
for (const [label, text, expect] of UNIT_CASES) {
  const calls = parseToolCalls(text);
  const got = calls ? calls[0].function.name : null;
  record('unit', label, got === expect ? 'pass' : 'fail', `-> ${got ?? 'null'}`);
}
record('unit', 'wrapper 参数并入 arguments', (() => {
  const c = parseToolCalls('{"bridge_tool_calls":[{"name":"t","arguments":{"a":1}}],"summarize":"x"}');
  return /"summarize"/.test(c?.[0]?.function?.arguments || '') ? 'pass' : 'fail';
})(), '');
record('unit', 'looksLikeToolCallAttempt 区分正常回答',
  looksLikeToolCallAttempt('你好') === false && looksLikeToolCallAttempt('{"bridge_tool_calls":[]}') === true ? 'pass' : 'fail', '');

console.log('\n[阶段 1] mock 后端 —— 验证适配层（不消耗额度）');
const mockLog = await runPhase('mock', { BRIDGE_PORT: '8791', BRIDGE_BACKEND: 'mock' }, { expectModel: 'mock' });

console.log('\n[阶段 1b] mock 后端（JSON 破坏版）—— 验证解析修复链路');
await runBrokenJsonPhase();

let realLog = '';
if (!MOCK_ONLY) {
  console.log(`\n[阶段 2] 真实后端 backend=${config.backend} —— 验证凭证与真实总结`);
  realLog = await runPhase('live', { BRIDGE_PORT: '8792' }, { expectModel: 'real' });
} else {
  console.log('\n[阶段 2] 已跳过（--mock）');
}

const hardFail = results.filter((r) => r.status === 'fail');
const blocked = results.filter((r) => r.status === 'blocked');
const passed = results.filter((r) => r.status === 'pass');

console.log(`\n=== 结果：通过 ${passed.length} / 失败 ${hardFail.length} / 阻塞 ${blocked.length} ===`);
if (hardFail.length) {
  console.log('\n失败项：');
  for (const f of hardFail) console.log(`  - [${f.phase}] ${f.name}: ${f.detail}`);
}
if (blocked.length) {
  console.log('\n阻塞项（适配层无问题，缺外部前置条件）：');
  for (const b of blocked) console.log(`  - [${b.phase}] ${b.name}: ${b.detail}`);
  console.log('\n  处理方式：让本机 CodeBuddy CLI 先登录 —— 在终端执行 `codebuddy` 后输入 /login，');
  console.log('  或为 bridge 进程提供 CODEBUDDY_AUTH_TOKEN / CODEBUDDY_API_KEY 环境变量。');
}
if (hardFail.length && realLog) console.log('\n真实后端服务日志（末 1200 字）：\n' + realLog.slice(-1200));

process.exit(hardFail.length ? 1 : 0);
