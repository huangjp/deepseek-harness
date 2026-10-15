// 后端适配层：把"一次对话请求"落到具体模型通道上。
//   CliBackend    —— 官方路线：无头调用本机 CodeBuddy CLI（共享客户端账号额度）
//   OpenAIBackend —— 第三方路线：任何 OpenAI 兼容网关（如 workbuddy2api）
//
// 关键工程细节都集中在 buildCleanEnv()：直接 spawn CLI 会因为继承了
// WorkBuddy 桌面端注入的环境变量而静默挂死。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本模块所在目录 —— 用作凭证缓存的默认落盘位置，避免依赖 cwd。 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 必须从子进程环境中剔除的变量。
 *
 * 最致命的是 SERVER__PORT：桌面端把它注入成自己的端口（实测 61092），
 * CLI 子进程启动时会去 bind 同一端口 -> EADDRINUSE -> 既不退出也不输出，
 * 表现为"无头调用永远不返回"。
 *
 * 其余变量会让子进程复用宿主会话、加载宿主的 MCP 服务器或技能目录，
 * 对一次纯总结调用既没必要，也会拖慢启动、污染会话。
 */
const POLLUTED_ENV = [
  'SERVER__PORT',
  'CODEBUDDY_SERVICE_PROXY_URL',
  'CODEBUDDY_SESSION_ID',
  'CODEBUDDY_MCP_CONFIG',
  'CODEBUDDY_HOST',
  'CODEBUDDY_HOST_CAPABILITIES',
  'CODEBUDDY_GATEWAY_AUTH',
  'CODEBUDDY_GATEWAY_PASSWORD',
  'CODEBUDDY_GATEWAY_DISABLE_API_DOCS',
  'CODEBUDDY_FORCE_HEADLESS_BUNDLE',
  'CODEBUDDY_FORCE_LITE_WB_BUNDLE',
  'CODEBUDDY_BUILTIN_SKILLS_DIR',
  'CODEBUDDY_CURRENT_MODEL_ID',
  'CODEBUDDY_SKILL_DESC_MAX_OVERRIDES',
  'CODEBUDDY_SKILL_TOOL_CHAR_BUDGET',
  'CODEBUDDY_PROMPT_SUGGESTION_DISABLED',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PROJECT_DIR',
];

// 前缀兜底：会话级/删除代理相关的一次性变量，逐版本可能增删。
const POLLUTED_PREFIX = [/^CODEBUDDY_CONVERSATION_/, /^CODEBUDDY_TOOL_CALL_/, /^CODEBUDDY_SAFE_DELETE_/];

/**
 * 异步执行命令并捕获 stdout。
 *
 * 为什么不用 `execFileSync`：在 WorkBuddy 的沙箱/进程代理下，**同步版 spawn 会被
 * 直接拦截**（实测 `spawnSync netstat EBUSY`，连 `cmd /c echo hi` 也一样）。
 * 异步 `spawn` 则正常。任何失败都静默返回空串，由调用方决定降级策略。
 */
export function runCapture(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = spawn(cmd, args, { windowsHide: true });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(''); }, timeoutMs);
      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.on('error', () => { clearTimeout(timer); finish(''); });
      child.on('close', () => { clearTimeout(timer); finish(out); });
    } catch {
      finish('');
    }
  });
}

/** 简易延时。 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 构造干净的子进程环境。
 * 注意：CODEBUDDY_CONFIG_DIR 故意保留 —— CLI 靠它读到与桌面端共享的登录态/额度。
 */
export function buildCleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of POLLUTED_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (POLLUTED_PREFIX.some((re) => re.test(key))) delete env[key];
  }
  return { ...env, ...extra };
}

/**
 * PowerShell 脚本：从本机**存活进程的环境块**里读出 WorkBuddy 网关凭证。
 *
 * 为什么需要它：网关密码由客户端按会话生成，只注入到它 spawn 出来的子进程里，
 * **从不落盘**。所以从资源管理器双击启动时，本进程继承不到它。
 * 但那些携带凭证的进程（MCP server、agent runtime、终端等）**还在跑**，
 * 于是我们可以像 Process Explorer 那样读它们的环境块把它取回来。
 *
 * 实现：NtQueryInformationProcess -> PEB -> ProcessParameters -> Environment。
 * 全程只读、只针对当前用户自己的进程；拿不到就静默降级。
 * 输出协议：每行 `CRED|<port>|<password>`，便于上层解析。
 */
const PS_DISCOVER_HEAD = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WbProcEnv {
    [StructLayout(LayoutKind.Sequential)]
    public struct PBI {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    public static string ReadEnv(int pid) {
        IntPtr h = OpenProcess(0x0410, false, pid);
        if (h == IntPtr.Zero) return null;
        try {
            var pbi = new PBI();
            int ret;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return null;
            byte[] p8 = new byte[8];
            IntPtr read;
            if (!ReadProcessMemory(h, (IntPtr)(pbi.PebBaseAddress.ToInt64() + 0x20), p8, 8, out read)) return null;
            IntPtr procParams = (IntPtr)BitConverter.ToInt64(p8, 0);
            if (!ReadProcessMemory(h, (IntPtr)(procParams.ToInt64() + 0x80), p8, 8, out read)) return null;
            IntPtr envPtr = (IntPtr)BitConverter.ToInt64(p8, 0);
            byte[] data = new byte[262144];
            if (!ReadProcessMemory(h, envPtr, data, data.Length, out read)) return null;
            int n = (int)read;
            if (n <= 0) return null;
            return Encoding.Unicode.GetString(data, 0, n);
        } catch { return null; }
        finally { CloseHandle(h); }
    }
}
'@
`;

/**
 * 只扫「有可能携带凭证」的进程名 —— 实测真正的携带者是 prewarm 网关
 * （`WorkBuddyAI.exe --prewarm`）spawn 出来的子进程：MCP server（node）、
 * 插件宿主（cmd/node）、agent 的沙箱与 shell（sandbox-cli / bash / powershell）。
 * 全量扫 150+ 个进程要 5 秒，限定名单后约 1 秒。
 */
const PS_CARRIER_NAMES = [
  'node', 'cmd', 'bash', 'sh', 'dash', 'zsh',
  'powershell', 'pwsh', 'conhost', 'WindowsTerminal', 'wezterm',
  'WorkBuddyAI', 'codebuddy', 'sandbox-cli', 'code',
  'python', 'python3', 'deno', 'bun', 'wsl',
];

/**
 * 生成发现脚本。scope='fast' 只扫候选进程名（约 1s）；
 * scope='all' 全量扫描（约 5s），作为 fast 无命中时的兜底。
 */
function buildDiscoverScript(scope = 'fast') {
  const select = scope === 'fast'
    ? `$names = @(${PS_CARRIER_NAMES.map((n) => `'${n}'`).join(',')})\n`
      + '$procs = Get-Process | Where-Object { $names -contains $_.ProcessName }\n'
    : '$procs = Get-Process\n';
  return PS_DISCOVER_HEAD + select
    + `foreach ($p in $procs) {
  $e = [WbProcEnv]::ReadEnv($p.Id)
  if ($e -and $e -match 'CODEBUDDY_GATEWAY_PASSWORD=') {
    $pw = [regex]::Match($e, 'CODEBUDDY_GATEWAY_PASSWORD=([^\\x00]+)').Groups[1].Value
    $pt = [regex]::Match($e, 'SERVER__PORT=([^\\x00]+)').Groups[1].Value
    if ($pw) { Write-Output ('CRED|' + $pt + '|' + $pw) }
  }
}
`;
}

/** 解析 `CRED|<port>|<password>` 行。 */
function parseDiscoveredCredentials(text) {
  const list = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^CRED\|(\d*)\|(\S+)$/);
    if (!m) continue;
    const key = `${m[1]}|${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 端口 "0" 是客户端的占位值：网关还没监听时，它给 prewarm 子进程的
    // SERVER__PORT 就是 0。当成"未知端口"处理，交给上层用已知端口池去配，
    // 否则会拿一个必然 unreachable 的 0 号端口白探一次。
    list.push({ port: (m[1] && m[1] !== '0') ? m[1] : null, password: m[2] });
  }
  return list;
}

/**
 * 扫描本机存活进程，取回网关凭证（仅 Windows；失败静默返回 []）。
 * @param {{scope?: 'fast'|'all', timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{port: string|null, password: string}>>}
 */
export function discoverProcessCredentials(opts = {}) {
  const { scope = 'fast', timeoutMs = 30000 } = opts;
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const encoded = Buffer.from(buildDiscoverScript(scope), 'utf16le').toString('base64');
      const child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true });
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish(parseDiscoveredCredentials(out));
      }, timeoutMs);
      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.on('error', () => { clearTimeout(timer); finish([]); });
      child.on('close', () => { clearTimeout(timer); finish(parseDiscoveredCredentials(out)); });
    } catch {
      finish([]);
    }
  });
}

/**
 * 探测 WorkBuddy 桌面端**是否在运行**。
 *
 * 用客户端自己暴露的 LocalProbe 端点（`GET 127.0.0.1:18488/workbuddy/probe`，只读、
 * 不消耗任何额度、无副作用），返回 `{ok:true,app:"workbuddy-desktop",version}`。
 *
 * 为什么要区分这两种失败：「客户端没运行」要你去开客户端；「客户端在运行但网关没释放」
 * 只要你发一条消息。两者的自救动作完全不同，而旧版把二者都写成"客户端没在运行"，
 * 会让人白白去重启客户端。
 */
export async function probeWorkBuddyClient({ timeoutMs = 800 } = {}) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch('http://127.0.0.1:18488/workbuddy/probe', { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return { running: false };
    const j = await res.json().catch(() => null);
    if (j && j.app === 'workbuddy-desktop') return { running: true, version: j.version || null };
    return { running: false };
  } catch {
    return { running: false };
  }
}

/**
 * 把当前进程的环境变量就地净化。
 *
 * 为什么必须做：`SERVER__PORT` / `CODEBUDDY_SERVICE_PROXY_URL` 这类变量是桌面端
 * 给**它自己启动的会话**注入的，里面带着那一轮会话的端口号。当本服务在
 * WorkBuddy 终端里被启动时，会原样继承它们；而客户端重启后那些端口早已失效，
 * 于是网关在转发 LLM 请求时会连到一个死端口，抛出
 * `upstream connect failed ... (os error 10061)` —— 这个报错来自客户端内部（Rust 侧），
 * 本服务代码里根本搜不到，极易被误判成"端口填错"。
 *
 * 实测证据：健康时 `CODEBUDDY_SERVICE_PROXY_URL=http://127.0.0.1:60242/...`，
 * 而 60242 已无监听；直接 curl 网关（不带该变量）正常返回，经本服务调用则失败。
 *
 * @returns {string[]} 实际清除的变量名，便于启动日志打印。
 */
export function sanitizeOwnEnv() {
  const removed = [];
  for (const key of POLLUTED_ENV) {
    if (process.env[key] !== undefined) {
      delete process.env[key];
      removed.push(key);
    }
  }
  for (const key of Object.keys(process.env)) {
    if (POLLUTED_PREFIX.some((re) => re.test(key))) {
      delete process.env[key];
      removed.push(key);
    }
  }
  return removed;
}

/** 从 CLI 的 stderr / 输出里识别失败原因，映射成统一的错误分类。 */
export function classifyCliFailure(text) {
  const s = (text || '').toLowerCase();
  if (/authentication required|please use \/login|not logged in|unauthori[sz]ed|401/.test(s)) {
    return { code: 'upstream_auth', httpStatus: 401, retriable: false, message: 'CLI 未登录：请先执行 codebuddy /login' };
  }
  if (/quota|insufficient|balance|额度|余额|超出限制|exceeded your current/.test(s)) {
    return { code: 'upstream_quota', httpStatus: 429, retriable: false, message: '账号额度不足' };
  }
  if (/rate ?limit|too many requests|429|overloaded/.test(s)) {
    return { code: 'upstream_rate_limit', httpStatus: 429, retriable: true, message: '上游限流' };
  }
  if (/eaddrinuse/.test(s)) {
    return { code: 'port_conflict', httpStatus: 500, retriable: false, message: '端口被占用：子进程环境未净化（SERVER__PORT 未剔除）' };
  }
  if (/etimedout|timeout/.test(s)) {
    return { code: 'upstream_timeout', httpStatus: 504, retriable: true, message: '上游超时' };
  }
  return { code: 'upstream_error', httpStatus: 502, retriable: false, message: '上游调用失败' };
}

/** 把 CLI 的 --output-format json 结果统一成内部结构。 */
function normalizeCliResult(payload, fallbackText) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  let text = typeof raw.result === 'string' ? raw.result : '';
  if (!text && typeof raw.text === 'string') text = raw.text;
  if (!text) text = fallbackText || '';
  const errors = Array.isArray(raw.errors) ? raw.errors.filter(Boolean) : [];
  return {
    text,
    errors,
    subtype: raw.subtype || null,
    sessionId: raw.session_id || raw.sessionId || null,
    usage: raw.usage || null,
    costUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : null,
    numTurns: raw.num_turns ?? null,
    durationMs: raw.duration_ms ?? null,
    isError: raw.is_error === true || (typeof raw.subtype === 'string' && raw.subtype.startsWith('error')),
  };
}

/** 容错地在一行 NDJSON 里抽取增量文本。 */
function extractDelta(evt) {
  if (!evt || typeof evt !== 'object') return '';
  // stream_event：转发模型 SSE，正文在 event.delta.text
  if (evt.type === 'stream_event' && evt.event) {
    const e = evt.event;
    if (e.type === 'content_block_delta' && e.delta) {
      return e.delta.text || e.delta.partial_json || '';
    }
  }
  // assistant：整段消息，取 text block
  if (evt.type === 'assistant' && evt.message?.content) {
    return (Array.isArray(evt.message.content) ? evt.message.content : [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

export class CliBackend {
  constructor(cfg) {
    this.cfg = cfg;
  }

  /** 启动前自检，供 /health 使用。 */
  check() {
    const binOk = existsSync(this.cfg.binPath);
    const nodeOk = !this.cfg.nodePath || existsSync(this.cfg.nodePath);
    return { ok: binOk && nodeOk, binPath: this.cfg.binPath, nodePath: this.cfg.nodePath || 'node', binOk, nodeOk };
  }

  #buildArgs({ stream, model, systemPrompt, prompt }) {
    // 注意：必须用 stream-json。实测本版本的 --output-format json（单次结果模式）
    // 恒返回 "Authentication required"，而 stream-json 才能正常鉴权。
    const args = ['-p', '--output-format', stream ? 'stream-json' : 'json'];

    // 纯总结任务：关掉所有内置工具，避免模型去读写文件。
    args.push('--tools', '', '--max-turns', String(this.cfg.maxTurns ?? 1), '--no-session-persistence');
    // 非交互场景下不能弹权限询问。
    args.push('--permission-mode', 'dontAsk');

    // 不加载用户/客户端配置里的 MCP 服务器（如 weixinpay、sheetagent）：
    // 每次总结都去拉起这些 sidecar 既慢又有副作用。
    if (this.cfg.strictMcp !== false) {
      args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
    }

    const m = model || this.cfg.model;
    if (m) args.push('--model', m);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);

    // 不使用 --json-schema：实测该参数会让进程挂死（90s 无任何输出）。
    // 结构化输出改为在 systemPrompt 里用文字约束 JSON，再由 parseJsonLoose 解析。

    if (this.cfg.extraArgs?.length) args.push(...this.cfg.extraArgs);

    // 长文本走 argv 会撞命令行长度上限，默认改走 stdin。
    if (this.cfg.promptTransport !== 'stdin') args.push(prompt);
    return args;
  }

  /**
   * 执行一次无头调用。
   * @returns {Promise<{text,usage,sessionId,costUsd,durationMs,raw}>}
   */
  async complete({ prompt, systemPrompt, model, timeoutMs, signal, onDelta }) {
    const cfg = this.cfg;
    const timeout = timeoutMs ?? cfg.timeoutMs ?? 180000;
    const useStdin = cfg.promptTransport !== 'argv';
    const args = this.#buildArgs({ stream: true, model, systemPrompt, prompt });

    // 独立工作目录：避免子进程读取当前工程的 CLAUDE.md / settings，保证调用可复现。
    const cwd = cfg.scratchDir || mkdtempSync(path.join(tmpdir(), 'weflow-bridge-'));
    const cleanupCwd = !cfg.scratchDir;

    return await new Promise((resolve, reject) => {
      const child = spawn(cfg.nodePath || 'node', [cfg.binPath, ...args], {
        cwd,
        env: buildCleanEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      let streamedText = '';
      let finalResult = null;
      let settled = false;

      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        if (cleanupCwd) { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ } }
        fn(arg);
      };

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish(reject, Object.assign(new Error(`CLI 调用超时（${timeout}ms）`), { code: 'upstream_timeout', httpStatus: 504 }));
      }, timeout);

      const onAbort = () => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish(reject, Object.assign(new Error('请求已取消'), { code: 'client_closed', httpStatus: 499 }));
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });

      child.stdout.on('data', (buf) => {
        stdoutBuf += buf.toString('utf8');
        // 逐行消费 NDJSON，实时吐出增量
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === 'result') { finalResult = evt; continue; }
          const delta = extractDelta(evt);
          if (delta) { streamedText += delta; onDelta?.(delta); }
        }
      });

      child.stderr.on('data', (buf) => { stderrBuf += buf.toString('utf8'); });

      child.on('error', (err) => finish(reject, Object.assign(err, { code: 'spawn_failed', httpStatus: 500 })));

      child.on('close', (code) => {
        // 收尾：stdout 可能没有以换行结束
        const tail = stdoutBuf.trim();
        if (tail) {
          try {
            const evt = JSON.parse(tail);
            if (evt.type === 'result') finalResult = evt;
            else { const d = extractDelta(evt); if (d) streamedText += d; }
          } catch { /* 非 JSON 尾巴忽略 */ }
        }

        if (finalResult) {
          const norm = normalizeCliResult(finalResult, streamedText);
          // is_error 必须无条件判失败：CLI 会把 "Authentication required" 这类
          // 错误当成 assistant 文本吐出来，若只看文本非空就会误判成功。
          if (norm.isError) {
            const c = classifyCliFailure(`${norm.errors.join(' ')}\n${stderrBuf}\n${norm.text}`);
            return finish(reject, Object.assign(new Error(c.message), c));
          }
          return finish(resolve, { ...norm, text: norm.text || streamedText, raw: finalResult });
        }

        if (streamedText) {
          return finish(resolve, { text: streamedText, usage: null, sessionId: null, costUsd: null, durationMs: null, raw: null });
        }

        const c = classifyCliFailure(`${stderrBuf}\n${stdoutBuf}`);
        finish(reject, Object.assign(new Error(`${c.message}${stderrBuf ? `：${stderrBuf.trim().slice(0, 300)}` : ''}`), c));
      });

      if (useStdin) {
        child.stdin.write(prompt, 'utf8');
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    });
  }
}

export class OpenAIBackend {
  constructor(cfg) {
    this.cfg = cfg;
  }

  check() {
    return { ok: Boolean(this.cfg.baseUrl), baseUrl: this.cfg.baseUrl };
  }

  async complete({ messages, model, timeoutMs, signal, onDelta }) {
    const timeout = timeoutMs ?? this.cfg.timeoutMs ?? 120000;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    signal?.addEventListener?.('abort', () => ctl.abort(), { once: true });

    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: model || this.cfg.model, messages, stream: false }),
        signal: ctl.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const c = classifyCliFailure(`${res.status} ${body}`);
        const status = res.status === 401 || res.status === 429 ? res.status : c.httpStatus;
        throw Object.assign(new Error(`${c.message}（HTTP ${res.status}）`), { ...c, httpStatus: status });
      }

      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content ?? '';
      onDelta?.(text);
      return { text, usage: json.usage || null, sessionId: null, costUsd: null, durationMs: null, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * ServeBackend：调用 WorkBuddy 客户端常驻的本地 HTTP 服务。
 *
 * 这是最省事的一条路：客户端本身就以 `--serve --auth password` 模式在 127.0.0.1
 * 上常驻（实测端口 61092，密码由客户端注入 CODEBUDDY_GATEWAY_PASSWORD），
 * 它暴露了 POST /api/v1/llm/completions，可以直接用客户端已登录的账号跑模型。
 *
 * 好处：不需要终端登录、不需要 CLI 凭证、不消耗额外进程，直接用客户端当前
 * 选中的那个模型（含免费额度）。
 *
 * 接口契约（从 CLI bundle 里反查得到）：
 *   POST /api/v1/llm/completions
 *   { agentName, userPrompt, systemPrompt?, model?, temperature?, maxTurns? }
 *   -> { text: string, success: boolean, error?: string, code?: string }
 *
 * 注意 agentName 必须是该版本真实注册过的 agent 名（实测可用：create / ptc /
 * multitask / minimal；默认的 "pulse" 在本版本不存在，会报 Failed find agent）。
 */
export class ServeBackend {
  constructor(cfg = {}) {
    this.cfg = cfg;
  }

  /** 端点解析优先级：环境变量（由客户端注入） > 配置文件。 */
  resolveEndpoint() {
    const port = process.env.SERVER__PORT || this.cfg.port;
    const password = process.env.CODEBUDDY_GATEWAY_PASSWORD || this.cfg.password;
    const host = this.cfg.host || '127.0.0.1';
    return { port: port ? String(port) : null, password: password || '', host };
  }

  /**
   * 凭证缓存文件路径。
   *
   * 为什么要缓存：实测**密码在会话内是稳定的**（端口会变，密码不变），
   * 且端口在同一会话内也稳定。所以把「最后一次成功用过的 (端口, 密码)」落盘，
   * 下一次即使没有继承到 env（典型场景：从资源管理器双击 start.cmd），
   * 也能直接用上次那组；只有换会话导致它失效时，才回退到全端口扫描。
   */
  credentialsCachePath() {
    const dir = this.cfg.cacheDir || MODULE_DIR;
    return path.join(dir, '.gateway-credentials.json');
  }

  /** 读缓存（带 10s 内存缓存，避免每个请求都读盘）。失败静默返回空结构。 */
  loadCachedCredentials() {
    const now = Date.now();
    if (this._credCache && this._credCache.expire > now) return this._credCache.value;
    let value = { password: null, port: null, passwords: [], ports: [] };
    try {
      const obj = JSON.parse(readFileSync(this.credentialsCachePath(), 'utf8'));
      value = {
        password: obj.password || null,
        port: obj.port ? String(obj.port) : null,
        passwords: [...new Set([obj.password, ...(obj.passwords || [])].filter(Boolean))],
        ports: [...new Set([obj.port, ...(obj.ports || [])].filter(Boolean).map(String))],
      };
    } catch { /* 无缓存或损坏，用默认空结构 */ }
    this._credCache = { value, expire: now + 10000 };
    return value;
  }

  loadCachedPasswords() { return this.loadCachedCredentials().passwords; }
  loadCachedPorts() { return this.loadCachedCredentials().ports; }

  /** 把实测可用的 (端口, 密码) 写入缓存，供下次无 env 启动时秒连。 */
  saveCachedCredentials(port, password) {
    if (!password) return;
    try {
      const prev = this.loadCachedCredentials();
      const passwords = [...new Set([password, ...prev.passwords])].slice(0, 5);
      const ports = [...new Set([port ? String(port) : null, ...prev.ports].filter(Boolean))].slice(0, 5);
      writeFileSync(
        this.credentialsCachePath(),
        JSON.stringify({ port: port ? String(port) : prev.port, password, passwords, ports, updatedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
      this._credCache = null; // 让下一次读取拿到新值
    } catch { /* 缓存写失败不影响主流程 */ }
  }

  /** 候选凭证（去重）：配置文件 > 会话 env > 落盘缓存。 */
  candidatePasswords() {
    return [...new Set([
      this.cfg.password,
      this.cfg.envPassword,
      process.env.CODEBUDDY_GATEWAY_PASSWORD,
      ...this.loadCachedPasswords(),
    ].filter(Boolean))];
  }

  /**
   * 候选端口（去重）：配置 > 环境变量 > 动态扫描结果 > 历史观测值。
   *
   * 关键教训：客户端**每个会话都会新起一个网关**（实测同机同时存在 4 个），
   * 端口从临时端口段随机分配、会话结束即销毁。任何硬编码或缓存下来的端口
   * 到下一个会话必然失效 —— 所以必须**主动扫描**，不能靠猜。
   */
  candidatePorts() {
    const list = [
      this.cfg.port,
      process.env.SERVER__PORT,
      ...(this.cfg.portFallbacks || []),
      ...this.loadCachedPorts(),
      ...(this._scannedPorts || []),
      61092, 60242, 57438,
    ];
    return [...new Set(list.filter(Boolean).map(String))];
  }

  /**
   * 扫描本机所有监听端口，找出真正的 WorkBuddy 网关。
   *
   * 判据（实测唯一可靠）：不带凭证 `POST /api/v1/llm/completions` 时返回
   * `{"error":{"code":"AUTH_REQUIRED",...}}`。这个请求**不消耗模型调用**，极廉价；
   * 而本机其它服务（实测 4310/9210/9901 等）对任意路径的响应形态各不相同，
   * 没有任何一个会命中这个指纹 —— 用它做筛选，误判率极低。
   *
   * @returns {Promise<string[]>} 命中网关的端口列表
   */
  async scanGatewayPorts() {
    const now = Date.now();
    if (this._scanCache && this._scanCache.expire > now) return this._scanCache.ports;

    const host = this.cfg.host || '127.0.0.1';
    const out = await runCapture('netstat', ['-ano']);
    if (!out) return [];

    const set = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/i);
      if (m) set.add(m[1]);
    }
    // 排除自己（本服务监听的端口）——否则每轮扫描都会打到自己身上，
    // 在日志里刷出「POST /api/v1/llm/completions 404 (未匹配路由)」的噪音。
    const selfPorts = new Set(
      [this.cfg.selfPort, this.cfg.port].filter(Boolean).map(String),
    );
    const ports = [...set].filter((p) => !selfPorts.has(p));

    const hits = [];
    await Promise.all(ports.map(async (port) => {
      const ctl = new AbortController();
      // 本机端口正常响应都在 10ms 内；只有极少数只推流不结束的端口会拖满超时。
      // 800ms 足够区分，且把整轮扫描从 ~2.7s 压到 ~0.9s（自愈轮询要跑很多次，这个很关键）。
      const timer = setTimeout(() => ctl.abort(), 800);
      try {
        const res = await fetch(`http://${host}:${port}/api/v1/llm/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: ctl.signal,
        });
        const text = await res.text();
        if (/AUTH_REQUIRED/.test(text)) hits.push(port);
      } catch { /* 该端口不是网关，忽略 */ }
      finally { clearTimeout(timer); }
    }));

    this._scanCache = { ports: hits, expire: now + 15000 };
    this._scannedPorts = hits;
    return hits;
  }

  /**
   * 从本机存活进程的环境块里读出网关凭证（带 120s 缓存）。
   *
   * 这条通道解决了最关键的一个场景：**从资源管理器双击启动**。
   * 那种启动方式拿不到客户端注入的 env，也没有历史缓存，
   * 但只要客户端还在跑，携带凭证的进程就还在，读出来即可。
   */
  async discoveredCredentials({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this._discovered && this._discovered.expire > now) return this._discovered.value;
    let value = [];
    try {
      // 先扫候选进程名（~1s）；一个都没命中再全量扫（~5s），兼顾速度与不漏。
      value = await discoverProcessCredentials({ scope: 'fast' });
      if (!value.length) value = await discoverProcessCredentials({ scope: 'all' });
    } catch { value = []; }
    this._discovered = { value, expire: now + 120000 };
    return value;
  }

  /**
   * 探测某个 (host, port, password) 是否真的是 WorkBuddy 网关。
   *
   * 判据必须足够严格：本机有大量服务对任意路径都返回 200（实测 4310/9210/9901
   * 都会命中），所以不能只看状态码。这里要求响应体能被解析成
   * `{ success: true, text: ... }` —— 这是该接口的真实契约。
   */
  async probePort(port, password, host) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(`http://${host}:${port}/api/v1/llm/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${password}` },
        body: JSON.stringify({
          agentName: this.agentCandidates()[0] || 'terminalTitleGenerator',
          userPrompt: 'ok',
          model: this.cfg.model || undefined,
          maxTurns: 1,
        }),
        signal: ctl.signal,
      });

      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      const text = await res.text();
      let obj = null;
      try { obj = JSON.parse(text); } catch { /* 非 JSON，判定为非目标服务 */ }
      if (obj && typeof obj === 'object' && ('text' in obj || obj.success === true)) {
        return { ok: true };
      }
      return { ok: false, reason: 'not-a-gateway' };
    } catch (e) {
      return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 带探测的端点解析：穷举「端口 × 密码」组合，锁定真正能通的那一组。
   *
   * 为什么必须两项都探测：实测中 `SERVER__PORT` / `CODEBUDDY_GATEWAY_PASSWORD`
   * 是桌面端按**会话**生成并注入子进程的，客户端一重启就换一组；
   * 只信环境变量（或只信配置）都会踩空，所以这里分层穷举 + 实测，能用者为王。
   *
   * 三级降级（每级失败才付下一级的成本）：
   *   1) 廉价候选 —— env / 配置 / 落盘缓存里的 (端口, 密码) 精确对，命中即 0 额外开销；
   *   2) 进程环境块扫描 —— 从本机存活的 WorkBuddy 相关进程里直接读出 (端口, 密码)，
   *      这是「从资源管理器双击、既没 env 也没缓存」时的决定性通道；
   *   3) 全端口扫描 × 已知密码 —— 最后的兜底。
   *
   * 结果缓存 60s，避免每个请求都打一遍探测。
   *
   * @param {{retryMs?: number}} [opts] retryMs > 0 时会在失败后重试到该时限为止。
   *   为什么需要：重启客户端后，网关（`--prewarm` 进程）虽然已经起来，
   *   但携带密码的**子进程**要等你真正用一次 WorkBuddy 才会被 spawn。
   *   这时硬失败会让调用方直接拿到 503；改成等一会儿，它往往就自己好了。
   */
  async resolveEndpointLive({ retryMs = 0 } = {}) {
    const deadline = Date.now() + Math.max(0, retryMs);
    for (;;) {
      try {
        return await this._resolveOnce();
      } catch (e) {
        // 关键：无论还要不要重试，都必须清掉两级缓存。
        // 否则「进程扫描 120s 缓存」会把「凭证刚刚出现」这件事挡在外面 ——
        // 实测这一条就能凭空多等两分钟（用户重启后看到的那 4 分钟里，大半是它）。
        this._scanCache = null;
        this._discovered = null;
        this._probed = null;
        if (Date.now() >= deadline) throw e;
        await sleep(1200);
      }
    }
  }

  async _resolveOnce() {
    const host = this.cfg.host || '127.0.0.1';
    const now = Date.now();
    if (this._probed && this._probed.expire > now) return this._probed.value;

    const failures = [];
    const tryPairs = async (pairs, source) => {
      for (const { port, password } of pairs) {
        if (!port || !password) continue;
        const r = await this.probePort(port, password, host);
        if (r.ok) return { port, password, host, source };
        failures.push({ port, reason: r.reason, pw: password.slice(0, 6) });
      }
      return null;
    };

    // ---- 第 1 级：env / 配置 / 缓存里的精确对 ----
    const cached = this.loadCachedCredentials();
    const cheapPairs = [
      { port: process.env.SERVER__PORT, password: process.env.CODEBUDDY_GATEWAY_PASSWORD },
      { port: this.cfg.port, password: this.cfg.password },
      { port: this.cfg.port, password: this.cfg.envPassword },
      { port: cached.port, password: cached.password },
    ];
    let value = await tryPairs(cheapPairs, 'probe');

    // ---- 第 2 级：从本机存活进程的环境块里直接读凭证 ----
    let discovered = [];
    if (!value) {
      discovered = await this.discoveredCredentials().catch(() => []);
      if (discovered.length) {
        const pws = this.candidatePasswords();
        const pairs = [];
        for (const d of discovered) {
          if (d.port) pairs.push({ port: d.port, password: d.password });
          // 该进程没带 SERVER__PORT 时，拿它的密码去试所有已知端口
          else for (const port of this.candidatePorts()) pairs.push({ port, password: d.password });
        }
        value = await tryPairs(pairs, 'process');
        // 进程里读到的密码也并入候选池，供第 3 级复用
        for (const d of discovered) if (!pws.includes(d.password)) pws.push(d.password);
      }
    }

    // ---- 第 3 级：全端口扫描 × 全部已知密码 ----
    let scanned = [];
    if (!value) {
      scanned = await this.scanGatewayPorts().catch(() => []);
      const pws = this.candidatePasswords();
      for (const d of discovered) if (!pws.includes(d.password)) pws.push(d.password);
      const pairs = [];
      for (const port of scanned) for (const password of pws) pairs.push({ port, password });
      value = await tryPairs(pairs, 'scan');
    }

    if (value) {
      this._probed = { value, expire: now + 60000 };
      // 实测 (端口, 密码) 在会话内稳定，落盘后下次即使没继承到 env
      // （典型场景：从资源管理器双击 start.cmd）也能直接秒连。
      this.saveCachedCredentials(value.port, value.password);
      return value;
    }

    this._probed = null;
    const detail = failures.map((f) => `${f.port}/${f.pw}…(${f.reason})`).join(', ');

    // 分情况给出真正有用的提示，而不是一句笼统的"找不到网关"。
    //
    // 关键实测事实（2026-10-08，用 Get-NetTCPConnection 的 CreationTime 取证）：
    //   网关端口的**套接字创建时间 == 你在 WorkBuddy 里发出消息的那一刻**。
    //   --prewarm 子进程可以提前几十秒就被 spawn（进程确实在跑），但在对话真正
    //   跑起来之前它**不监听任何端口**（此时客户端给它的 SERVER__PORT 就是 0）。
    //   取证：pid 29928 于 09:18:24 启动，其 62667 端口创建于 09:24:11 —— 而
    //   09:24:11 正是用户发出消息、对话被 acquire 的瞬间。
    //
    // 所以「开机 → 打开 WorkBuddy → 双击 start.cmd」这个顺序下，网关**必然**还不存在。
    // 这不是本服务的故障，必须把话说清楚，否则用户只会反复重启客户端。
    const client = await probeWorkBuddyClient();
    let headline;
    let advice;
    if (!client.running) {
      headline = 'WorkBuddy 客户端没在运行。';
      advice = '\n  → 请先启动 WorkBuddy 桌面端。';
    } else if (!scanned.length) {
      headline = 'WorkBuddy 在运行，但本地网关还没被释放（启动时序，不是故障）。';
      advice = '\n  网关只在**对话真正跑起来**时才监听端口：实测套接字创建时间'
        + '\n  正好等于你发出消息的时刻。只打开 WorkBuddy、只点开一个对话，都还不会监听。'
        + '\n  → 在 WorkBuddy 里发一条消息（或点一下输入框），几秒后本服务会自动连上。';
    } else if (!discovered.length) {
      headline = `已发现网关（端口 ${scanned.join(', ')}），但拿不到密码。`;
      advice = '\n  网关进程（--prewarm）已经起来了，但**携带密码的是它的子进程**'
        + '\n  （MCP server / 插件宿主），要 agent 真正跑起来才会被 spawn。'
        + '\n  → 在 WorkBuddy 里随便发一条消息、或让它调一次工具，几秒后就会自动连上。';
    } else {
      headline = '发现了网关凭证，但没有任何一组能通过鉴权。';
      advice = '\n  → 通常是客户端刚重启、缓存和 env 都过期了；'
        + '\n    在 WorkBuddy 里发一条消息让新的子进程出现即可。';
    }
    throw Object.assign(
      new Error(
        headline
        + `\n  WorkBuddy 客户端：${client.running ? `在运行（v${client.version || '?'}）` : '未检测到'}`
        + `\n  进程凭证发现：${discovered.length} 组`
        + `\n  探测明细：${detail || '（无）'}`
        + '\n'
        + advice
        + '\n  本服务会**继续在后台自动重试**，一旦可用会打印「端点就绪」，无需重启。'
        + '\n缓存文件：' + this.credentialsCachePath(),
      ),
      { code: 'serve_unreachable', httpStatus: 503, clientRunning: client.running },
    );
  }

  get baseUrl() {
    const { host, port } = this.resolveEndpoint();
    return port ? `http://${host}:${port}` : null;
  }

  /**
   * 诊断信息。默认做一次**实时解析**（含探测/扫描，结果缓存 60s），
   * 这样 /health 报的 ok / baseUrl 是真实连通性，而不是配置里写死的值。
   */
  async check({ live = true } = {}) {
    const cached = this.loadCachedCredentials();
    const base = {
      agentName: this.agentCandidates().join(' → '),
      candidatePorts: this.candidatePorts(),
      candidatePasswordCount: this.candidatePasswords().length,
      portSource: process.env.SERVER__PORT ? 'env' : (this.cfg.port ? 'config' : (cached.port ? 'cache' : 'missing')),
      passwordSource: process.env.CODEBUDDY_GATEWAY_PASSWORD ? 'env' : (this.cfg.password ? 'config' : (cached.password ? 'cache' : 'missing')),
      credentialCache: {
        path: this.credentialsCachePath(),
        hasCachedPort: Boolean(cached.port),
        hasCachedPassword: Boolean(cached.password),
      },
      // 客户端是否在运行 —— 用来把"没开客户端"和"客户端在跑但网关没释放"分开。
      client: await probeWorkBuddyClient(),
    };
    if (!live) {
      const { port, password } = this.resolveEndpoint();
      return { ...base, ok: Boolean(port), baseUrl: this.baseUrl, hasPassword: Boolean(password) };
    }
    try {
      const { host, port, password, source } = await this.resolveEndpointLive();
      const discovered = await this.discoveredCredentials().catch(() => []);
      return {
        ...base,
        ok: true,
        baseUrl: `http://${host}:${port}`,
        hasPassword: Boolean(password),
        resolvedVia: source,
        processDiscovery: {
          found: discovered.length,
          pairs: discovered.map((d) => `${d.port || '?'}/${d.password.slice(0, 6)}…`),
        },
      };
    } catch (e) {
      const discovered = await this.discoveredCredentials().catch(() => []);
      return {
        ...base,
        ok: false,
        baseUrl: null,
        hasPassword: false,
        error: String(e?.message || e).split('\n')[0],
        processDiscovery: { found: discovered.length },
      };
    }
  }

  /**
   * 候选 agent 列表：主选 + 备选。
   *
   * 为什么主选不是 create：`/api/v1/llm/completions` 背后是 AgentService，
   * agent 自带原生工具集且 overrides 覆盖不了 agent.tools。create / general-purpose /
   * Explore 这类"干活型"agent 只要提示词里出现工具相关措辞（上游项目自带的业务提示词
   * 里遍地都是），模型就会发起原生工具调用，轻则 `Max turns (N) exceeded`，
   * 重则 `Tool xxx not found in agent create.`，**且提示词级禁令压不住**
   * （实测：禁令前置 0/4、后置 1/4、前后都放 0/4，与不加禁令无差别）。
   *
   * 解法是换用 bundle 里那批**纯文本任务型内部 agent**（summaryGenerator /
   * promptSuggestion / terminalTitleGenerator / memorySelector / insightsAnalyzer /
   * autoModeClassifier 等）。它们没有原生工具集，实测 45/45 全通过，
   * 且长输出不受限（实测单次 13k~20k 字符无截断）。
   */
  agentCandidates(preferred) {
    // 带图时必须优先用**带 Read 工具**的 agent：图片只能落盘后由 agent 自己读，
    // 而上面那些纯文本任务型 agent（terminalTitleGenerator / memorySelector /
    // insightsAnalyzer）**工具集为空**，模型会直接回「我没有文件读取工具」。
    // preferred 由调用方按「本次是否带图」决定（见 serve.imageAgent 配置）。
    const list = preferred
      ? [preferred, ...(this.cfg.imageAgentFallbacks || []), this.cfg.agentName, ...(this.cfg.agentFallbacks || [])]
      : [this.cfg.agentName, ...(this.cfg.agentFallbacks || [])];
    return [...new Set(list.filter(Boolean))];
  }

  async complete({ prompt, systemPrompt, model, timeoutMs, signal, onDelta, maxTurns, imageAgent }) {
    if (!this.candidatePorts().length) {
      throw Object.assign(new Error('未找到 WorkBuddy 本地服务端口：请在 bridge.config.json 的 serve.port 填写，或从客户端环境启动本服务'), {
        code: 'serve_not_configured', httpStatus: 503,
      });
    }

    // 探测锁定真正可用的「端口 + 密码」组合（客户端重启会换端口，环境变量也可能残留旧值）。
    // retryMs 给一个等待窗口：客户端刚重启、携带密码的子进程还没被 spawn 出来时，
    // 等它几秒往往就通了，比直接甩 503 给调用方友好得多。
    const { password, host, port } = await this.resolveEndpointLive({ retryMs: this.cfg.endpointRetryMs ?? 20000 });

    let lastErr = null;
    for (const agentName of this.agentCandidates(imageAgent)) {
      // 同一 agent 上，agent 层错误最多重试 3 次：模型行为有随机性，重试常能翻盘。
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await this.tryOnce({ agentName, prompt, systemPrompt, model, timeoutMs, signal, onDelta, password, host, port, maxTurns });
        } catch (err) {
          lastErr = err;
          if (err.code === 'bad_agent') break;   // 该 agent 名在本版本不存在 → 换下一个候选
          const retriable = err.code === 'agent_tool_loop' || err.code === 'agent_tool_not_found';
          if (!retriable || attempt === 3) {
            if (!retriable) throw err;
            break;                              // 重试已用尽 → 换下一个候选
          }
          await new Promise((r) => setTimeout(r, 150 * attempt));
        }
      }
    }
    // lastErr 可能仍为 null（agent 候选为空时整个循环没跑过）——
    // 直接 throw null 会让上层的 `err.httpStatus` 抛 TypeError，掩盖真实原因。
    if (!lastErr) {
      throw Object.assign(new Error(
        `没有可用的 agent 候选（serve.agentName=${this.cfg.agentName ?? '未配置'}）。` +
        '请在 bridge.config.json 里配置 serve.agentName（如 terminalTitleGenerator）并给出 agentFallbacks 兜底。'
      ), { code: 'serve_no_agent', httpStatus: 503, retriable: false });
    }
    throw lastErr;
  }

  /** 单次调用（不做重试/降级）。 */
  async tryOnce({ agentName, prompt, systemPrompt, model, timeoutMs, signal, onDelta, password, host, port, maxTurns }) {
    const timeout = timeoutMs ?? this.cfg.timeoutMs ?? 180000;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const onAbort = () => ctl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    try {
      const res = await fetch(`http://${host}:${port}/api/v1/llm/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(password ? { authorization: `Bearer ${password}` } : {}),
        },
        body: JSON.stringify({
          agentName,
          userPrompt: prompt,
          systemPrompt: systemPrompt || undefined,
          model: model || this.cfg.model || undefined,
          maxTurns: maxTurns ?? this.cfg.maxTurns ?? 1,
        }),
        signal: ctl.signal,
      });

      if (res.status === 401 || res.status === 403) {
        throw Object.assign(new Error('WorkBuddy 本地服务鉴权失败：网关密码不正确或已变化'), {
          code: 'upstream_auth', httpStatus: 401, retriable: false,
        });
      }

      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }

      if (!res.ok) {
        throw Object.assign(new Error(`WorkBuddy 本地服务返回 HTTP ${res.status}：${text.slice(0, 200)}`), {
          code: 'upstream_error', httpStatus: 502, retriable: res.status >= 500,
        });
      }

      if (json && json.success === false) {
        const msg = json.error || '未知错误';
        if (json.code === 'auth_required' || /authentication required/i.test(msg)) {
          throw Object.assign(new Error('WorkBuddy 客户端未登录，请先在客户端完成登录'), {
            code: 'upstream_auth', httpStatus: 401, retriable: false,
          });
        }
        if (/failed find agent/i.test(msg)) {
          throw Object.assign(new Error(
            `agent 名无效：${msg}。可用值参考 bundle 里的内置 agent：terminalTitleGenerator / memorySelector / ` +
            'insightsAnalyzer / promptSuggestion / autoModeClassifier / summaryGenerator（这些是纯文本任务型，无原生工具集）'
          ), { code: 'bad_agent', httpStatus: 400, retriable: false });
        }
        // 下面两类是"agent 层"特有报错：agent 自带原生工具集，提示词一诱导就发起原生调用。
        // 桥接会自动重试并降级到无工具 agent，正常不该冒到调用方；冒出来说明候选全挂了。
        if (/^max turns\s*\(\d+\)\s*exceeded/i.test(msg)) {
          throw Object.assign(new Error(
            `WorkBuddy agent 陷入工具调用循环（${msg}）。agent=${agentName} 自带原生工具集，` +
            '提示词里出现工具相关措辞时模型会发起原生调用并耗尽轮次（调大 maxTurns 无效，是死循环）。' +
            '请确认 bridge.config.json 的 serve.agentName 指向纯文本任务型 agent（如 terminalTitleGenerator），' +
            '并已配置 serve.agentFallbacks 兜底。'
          ), { code: 'agent_tool_loop', httpStatus: 502, retriable: true });
        }
        if (/tool .+? not found in agent/i.test(msg)) {
          throw Object.assign(new Error(
            `WorkBuddy agent 工具白名单校验失败（${msg}）。agent=${agentName} 自带原生工具集，` +
            '模型被提示词诱导发起了**原生**工具调用，而该工具不在 agent 的工具集里。' +
            '请确认 serve.agentName 指向纯文本任务型 agent（如 terminalTitleGenerator）。'
          ), { code: 'agent_tool_not_found', httpStatus: 502, retriable: true });
        }
        throw Object.assign(new Error(`WorkBuddy 本地服务报错：${msg}`), {
          code: 'upstream_error', httpStatus: 502, retriable: false,
        });
      }

      const out = json?.text ?? (typeof text === 'string' ? text : '');
      // 该接口不支持流式，一次性回吐，由上层决定如何分帧
      if (out) onDelta?.(out);
      return { text: out, usage: json?.usage || null, sessionId: json?.sessionId || null, costUsd: null, durationMs: null, raw: json };
    } catch (err) {
      if (err.name === 'AbortError') {
        throw Object.assign(new Error(`调用 WorkBuddy 本地服务超时（${timeout}ms）`), {
          code: 'upstream_timeout', httpStatus: 504, retriable: true,
        });
      }
      if (err.code) throw err;
      throw Object.assign(new Error(`无法连接 WorkBuddy 本地服务（${this.baseUrl}）：${err.message}`), {
        code: 'serve_unreachable', httpStatus: 502, retriable: true,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
}

/**
 * MockBackend：不触达任何模型，用于在没有凭证/不想消耗额度时验证适配层本身
 * （路由、SSE 帧格式、JSON 契约、并发与错误映射）。
 * 如果提示词里要求输出总结 JSON，它会返回一份结构合法的样例。
 */
export class MockBackend {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.delayMs = cfg.delayMs ?? 120;
    // 破坏版：模拟线上真实故障形态 —— 模型输出的 bridge_tool_calls JSON 括号多余、
    // 且把参数误放到 wrapper 层。用于回归"解析修复链路"。
    this.malformed = cfg.malformed ?? process.env.BRIDGE_MOCK_MALFORMED === '1';
  }

  check() {
    return { ok: true, binPath: '(mock)', mock: true };
  }

  async complete({ prompt, systemPrompt, onDelta }) {
    // 工具说明在 systemPrompt 里，两处都要看
    const full = `${systemPrompt || ''}\n${prompt || ''}`;
    // 带工具说明时，模拟一次工具调用，便于验证 tool_calls 还原链路。
    // 标记与输出键名都跟随 bridge.mjs 的新协议（bridge_tool_calls）。
    if (/【可用工具清单】|【工具调用能力】/.test(full)) {
      const name = (full.match(/"name"\s*:\s*"([^"]+)"/) || [])[1] || 'mock_tool';
      const text = this.malformed
        ? `我先表达工具调用意图：\n{"bridge_tool_calls":[{"name":"${name}","arguments":{"mock":true,"source":"MockBackend"}}],"summarize":"mock 破坏版"}}]}`
        : JSON.stringify({ bridge_tool_calls: [{ name, arguments: { mock: true, source: 'MockBackend' } }] });
      onDelta?.(text);
      await new Promise((r) => setTimeout(r, this.delayMs / 5));
      return { text, usage: null, sessionId: 'mock', costUsd: 0, durationMs: this.delayMs, raw: null };
    }

    const wantsJson = /JSON Schema|输出.*JSON|总结/.test(full);
    const text = wantsJson
      ? JSON.stringify({
        headline: '（mock）评审会安排与测试环境故障',
        overview: '张伟与李娜确认参加明天下午三点的评审会，李娜负责讲解登录鉴权部分；测试环境数据库故障需在中午前恢复。',
        topics: [
          { topic: '评审会安排', detail: '明天 15:00，李娜主讲登录鉴权' },
          { topic: '测试环境故障', detail: '数据库昨日宕机，运维承诺中午前恢复' },
        ],
        keyPoints: ['评审会时间：明天下午三点', '演示假数据已准备完毕'],
        actionItems: [
          { owner: '张伟', task: '与运维确认数据库恢复进度', deadline: '今天中午前' },
          { owner: '李娜', task: '顺一遍接口文档并准备登录鉴权讲解', deadline: '明天评审会前' },
        ],
        sentiment: { tone: '务实、配合', notes: '双方沟通顺畅，无明显冲突' },
        notableQuotes: [{ speaker: '张伟', quote: '别影响评审演示' }],
      }, null, 2)
      : '（mock）可用';

    // 分片吐出，便于验证 SSE 增量链路
    const step = Math.max(1, Math.ceil(text.length / 5));
    for (let i = 0; i < text.length; i += step) {
      const chunk = text.slice(i, i + step);
      onDelta?.(chunk);
      await new Promise((r) => setTimeout(r, this.delayMs / 5));
    }

    return { text, usage: { input_tokens: 0, output_tokens: 0 }, sessionId: 'mock', costUsd: 0, durationMs: this.delayMs, raw: null };
  }
}

export function createBackend(config) {
  if (config.backend === 'mock') return new MockBackend(config.mock || {});
  if (config.backend === 'openai') return new OpenAIBackend(config.openai || {});
  if (config.backend === 'serve') return new ServeBackend(config.serve || {});
  return new CliBackend(config.cli || {});
}

/** 并发闸门：CLI 每次冷启动约 150MB+ 内存、数秒开销，必须限流。 */
export class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max | 0);
    this.active = 0;
    this.queue = [];
  }

  get pending() { return this.queue.length; }

  async acquire() {
    if (this.active < this.max) { this.active += 1; return; }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
