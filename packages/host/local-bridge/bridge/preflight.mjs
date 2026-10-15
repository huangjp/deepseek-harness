/**
 * 依赖预检与自愈。
 *
 * 本工具要跑通，需要两个**用户自己安装的第三方应用**在运行（本包不打包它们）：
 *   - WorkBuddy AI        —— 8787 反代的模型来源；
 *   - Microsoft Copilot   —— 8899 反代的模型来源。
 *
 * 所以这里做三件事：
 *   1. 检测「装没装 / 跑没跑」：没装就给出**安装指引**，装了没跑就（可选）自动拉起来；
 *   2. Copilot 的 access_token 约 1 小时过期，检测到陈旧且前置条件齐备时（可选）
 *      自动触发 `refresh-token.ps1`；
 *   3. 把结果结构化，供 `/health` 与浏览器测试页展示。
 *
 * 零依赖，仅用 Node 标准库。所有外部命令一律用**异步** spawn —— 同步 spawn 在受限
 * 环境里会被直接拦截（同 `backends.mjs` 顶部注释）。
 * @module @deepseek-ai/dsh-host-local-bridge/preflight
 */

import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, copyFileSync, statSync,
  appendFileSync, openSync, closeSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** 令牌超过这个秒数即视为陈旧（微软 access_token 约 1 小时有效）。 */
export const TOKEN_STALE_SEC = 45 * 60;

/** 自动刷新的并发保护窗口：这么长时间内的重复触发会被忽略。 */
export const REFRESH_LOCK_MS = 240_000;

/**
 * 刷新链路在收割目录里写下的两份转录（文件名，不含目录）。
 *
 * 由本模块拥有：写入方是 refreshCopilotToken()，读取方是宿主控制面 ——
 * 控制面要能把日志送到设置页，就不能自己再猜一遍文件名。transcript 是脚本内
 * Start-Transcript 的输出；spawn 是 PowerShell 自身这一层的痕迹，「进程压根
 * 没起来」只有它记得。两份职责不同，互不覆盖。
 */
export const REFRESH_LOG_FILES = {
  transcript: 'auto-refresh.log',
  spawn: 'auto-refresh.spawn.log',
};

/** 配套应用的检测与启动描述。 */
export const APPS = {
  workbuddy: {
    label: 'WorkBuddy AI',
    image: 'WorkBuddyAI.exe',
    candidates: [
      'D:/Program Files/WorkBuddyAI/WorkBuddyAI.exe',
      'C:/Program Files/WorkBuddyAI/WorkBuddyAI.exe',
      'C:/Program Files (x86)/WorkBuddyAI/WorkBuddyAI.exe',
    ],
    hint: [
      'WorkBuddy AI 未安装（或不在常见安装路径）。它是本工具 8787 反代的模型来源，请先装好并登录：',
      '  1. 到 https://www.workbuddy.cn 下载 Windows 客户端并安装；',
      '  2. 打开客户端登录你的账号；',
      '  3. 在客户端里随便发一条消息 —— 本地模型网关要等一次「对话意图」才会开始监听。',
    ].join('\n'),
  },
  copilot: {
    label: 'Microsoft Copilot',
    image: 'copilotapp.exe',
    // 注意：必须用 `copilotapp_proxy.exe` 启动 —— 直接跑 `copilotapp.exe`
    // 进程不会出现（实测 Start-Process 返回成功但一个进程都没起）。
    candidates: [
      'C:/Program Files (x86)/Microsoft/Copilot/Application/copilotapp_proxy.exe',
      'C:/Program Files/Microsoft/Copilot/Application/copilotapp_proxy.exe',
      // 兜底：个别版本可能没有 proxy 启动器
      'C:/Program Files (x86)/Microsoft/Copilot/Application/copilotapp.exe',
      'C:/Program Files/Microsoft/Copilot/Application/copilotapp.exe',
    ],
    hint: [
      'Microsoft Copilot 桌面端未安装（或不在常见安装路径）。它是本工具 8899 反代的模型来源，请先装好并登录：',
      '  1. 在 Microsoft Store 搜索「Copilot」安装（或到 https://copilot.microsoft.com 下载桌面版）；',
      '  2. 打开并登录你的 Microsoft 账号，确认能正常对话。',
    ].join('\n'),
  },
};

/**
 * 异步执行命令并捕获 stdout（同步 spawn 在受限环境会被拦截，所以统一走异步）。
 * @param {string} cmd 可执行文件。
 * @param {string[]} args 参数。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<string>} stdout；任何失败都返回空串。
 */
function runCapture(cmd, args, timeoutMs = 8000) {
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
    } catch { finish(''); }
  });
}

/**
 * 取当前所有进程的映像名集合。
 * @returns {Promise<Set<string>>} 小写映像名集合（如 `copilotapp.exe`）。
 */
async function runningImages() {
  // tasklist 的中文表头是 GBK，但 `/NH` 去掉表头后剩下的进程名是 ASCII，按行取首列即可。
  const out = await runCapture('tasklist', ['/FO', 'CSV', '/NH']);
  const names = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

/**
 * 检测一个配套应用是否已安装 / 在运行。
 * @param {keyof typeof APPS} kind 应用标识。
 * @param {Set<string>} [images] 预先取好的进程集合（批量检测时复用，省一次 tasklist）。
 * @returns {Promise<{key: string, label: string, installed: boolean, running: boolean, exePath: string|null, hint: string}>}
 */
export async function detectApp(kind, images) {
  const spec = APPS[kind];
  const running = (images ?? await runningImages()).has(spec.image.toLowerCase());
  const exePath = spec.candidates.find((p) => existsSync(p)) ?? null;
  return {
    key: kind,
    label: spec.label,
    // 已在运行也算「装了」—— 只是我们没能定位到它的可执行文件而已。
    installed: Boolean(exePath) || running,
    running,
    exePath,
    hint: spec.hint,
  };
}

/**
 * 批量检测两个配套应用。
 * @returns {Promise<Record<string, object>>} 以 kind 为键的检测结果。
 */
export async function detectAllApps() {
  const images = await runningImages();
  const [workbuddy, copilot] = await Promise.all([
    detectApp('workbuddy', images),
    detectApp('copilot', images),
  ]);
  return { workbuddy, copilot };
}

/** 启动一个已安装的应用（分离进程，不阻塞、不随本进程退出而结束）。 */
function launch(exePath) {
  const child = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child;
}

/**
 * 确保应用在运行：没跑就（可选）自动拉起来，并等它就绪。
 * @param {keyof typeof APPS} kind 应用标识。
 * @param {{autoStart?: boolean, waitMs?: number, images?: Set<string>}} [options] 行为开关。
 * @returns {Promise<object>} 检测结果 + `started` / `startError`。
 */
export async function ensureAppRunning(kind, options = {}) {
  const { autoStart = true, waitMs = 25_000 } = options;
  const before = await detectApp(kind, options.images);
  if (before.running) return { ...before, started: false, startError: null };
  if (!before.installed) return { ...before, started: false, startError: null };
  if (!autoStart || !before.exePath) return { ...before, started: false, startError: null };

  let startError = null;
  try {
    launch(before.exePath);
  } catch (error) {
    startError = error?.message ?? String(error);
    return { ...before, started: false, startError };
  }

  // 轮询等它起来：WorkBuddy 从双击到进程出现通常几秒，Copilot 稍慢。
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await detectApp(kind);
    if (now.running) return { ...now, started: true, startError: null };
  }
  return { ...before, started: true, startError: '启动后未在时限内检测到进程' };
}

/** 探测某个本地端口是否有服务在监听。 */
function portOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (v) => { try { socket.destroy(); } catch { /* ignore */ } resolve(v); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); done(true); });
    socket.once('error', () => { clearTimeout(timer); done(false); });
  });
}

/**
 * 读取 Copilot 令牌与收割前置条件的状态（只读）。
 * @param {string} harvestDir 收割目录。
 * @param {{upstreamPort?: number, mitmPort?: number}} [options] 端口。
 * @returns {Promise<object>} 令牌年龄、是否陈旧，以及刷新所需的前置条件是否齐备。
 */
export async function detectHarvest(harvestDir, options = {}) {
  const tokenFile = path.join(harvestDir, 'token.json');
  const templateFile = path.join(harvestDir, 'chat_template.json');
  const harvester = path.join(harvestDir, 'token-harvester.py');

  let harvestedAt = null;
  if (existsSync(tokenFile)) {
    try {
      const j = JSON.parse(readFileSync(tokenFile, 'utf8'));
      if (j?.harvestedAt) harvestedAt = Number(j.harvestedAt);
    } catch { /* 半截文件，按无令牌处理 */ }
  }
  const ageSec = harvestedAt ? Math.round(Date.now() / 1000 - harvestedAt) : null;

  const mitmdump = resolveMitmdump(options.mitmdump);
  const upstreamPort = options.upstreamPort ?? 7890;
  const mitmPort = options.mitmPort ?? 8082;

  const upstreamProxyUp = await portOpen('127.0.0.1', upstreamPort);
  const mitmUp = await portOpen('127.0.0.1', mitmPort);

  const missing = [];
  if (!mitmdump) missing.push('mitmdump（pip install mitmproxy）');
  if (!existsSync(harvester)) missing.push(`收割插件 ${harvester}`);
  if (!upstreamProxyUp) missing.push(`上游代理 127.0.0.1:${upstreamPort}（FlClash 的混合端口）`);

  return {
    harvestDir,
    tokenFile,
    templateFile,
    hasToken: existsSync(tokenFile),
    hasTemplate: existsSync(templateFile),
    harvestedAt: harvestedAt ? new Date(harvestedAt * 1000).toISOString() : null,
    ageSec,
    stale: ageSec === null ? true : ageSec > TOKEN_STALE_SEC,
    mitmdump,
    // 下面三项与 missing 表达同一批事实，但形式不同：控制面（src/control.ts）只读
    // 结构化字段，把「缺哪个前置」翻译成线上代码，页面再去查自己的文案字典。
    // missing 是给人看的操作提示，仅供日志与 /health。
    harvester: existsSync(harvester) ? harvester : null,
    upstreamProxyUp,
    mitmRunning: mitmUp,
    missing,
    // 自动刷新需要的前置条件齐备（Copilot 是否在跑由调用方另行判断）。
    canAutoRefresh: missing.length === 0,
  };
}

// ------------------------------------------------------------------ 自举部署
//
// 安装包只能带**程序本身**，带不了 mitmproxy / CA 证书 / 已登录的 Copilot。
// 但其中「把收割器与请求模板放到收割目录」这一步完全可以自动化 ——
// 就在这里做，用户装完直接启动 DSH 即可，不必单独跑部署脚本。
//
// 剩下两件 Windows/微软强制要求人工的事，脚本只能检测并明确告知：
//   1. 导入 mitmproxy CA 到「受信任的根证书」—— 会弹一次系统确认框；
//   2. 在 Copilot 里登录微软账号。

/** 随包分发的部署文件（相对 bridge 目录）。 */
const PAYLOAD_FILES = ['token-harvester.py', 'refresh-token.ps1', 'chat_template.json'];

/**
 * 把随包分发的部署文件自举到收割目录。
 *
 * 幂等、只增不减：目标已存在且完好就不动它（用户在收割目录里的自定义不会被覆盖）。
 * 唯一的例外是**缺 UTF-8 BOM 的 .ps1** —— Windows PowerShell 5.1 会把这种文件按
 * ANSI(GBK) 解析，中文被拆坏后连引号都被吞掉，脚本解析直接失败且毫无声息（实测踩过），
 * 所以检测到就备份并换成本包自带的完好版本。
 *
 * @param {{bridgeDir: string, harvestDir: string, log?: (m: string) => void}} options 目录。
 * @returns {{copied: string[], repaired: string[], skipped: string[]}} 结果。
 */
export function bootstrapPayload(options) {
  const { bridgeDir, harvestDir } = options;
  const log = options.log ?? (() => {});
  const copied = [];
  const repaired = [];
  const skipped = [];

  try {
    mkdirSync(harvestDir, { recursive: true });
  } catch (error) {
    log(`[预检] 收割目录不可用：${error?.message ?? error}`);
    return { copied, repaired, skipped };
  }

  for (const name of PAYLOAD_FILES) {
    const src = path.join(bridgeDir, name);
    const dst = path.join(harvestDir, name);
    if (!existsSync(src)) { skipped.push(name); continue; }

    try {
      if (!existsSync(dst)) {
        copyFileSync(src, dst);
        copied.push(name);
        log(`[预检] 已部署 ${name} → ${dst}`);
        continue;
      }

      // .ps1 缺 BOM 是已知的致命故障，就地修复
      if (name.endsWith('.ps1')) {
        const head = readFileSync(dst).subarray(0, 3);
        const hasBom = head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF;
        if (!hasBom) {
          copyFileSync(dst, `${dst}.bak-${Date.now()}`);
          copyFileSync(src, dst);
          repaired.push(name);
          log(`[预检] ${name} 缺少 UTF-8 BOM（会导致脚本静默解析失败），已替换为本包自带版本`);
          continue;
        }
      }

      // 目标比包内的旧（例如装包升级后），用包内的覆盖
      if (statSync(src).mtimeMs > statSync(dst).mtimeMs) {
        copyFileSync(src, dst);
        repaired.push(name);
        log(`[预检] ${name} 已更新为本包自带版本`);
        continue;
      }

      skipped.push(name);
    } catch (error) {
      log(`[预检] 部署 ${name} 失败：${error?.message ?? error}`);
    }
  }
  return { copied, repaired, skipped };
}

/**
 * 解析 mitmdump 路径。
 *
 * 不能写死 Python 版本 —— 换台机器版本号就可能不同。依次尝试：
 * 环境变量 → 各 Python 安装根的 Scripts 目录。
 * @param {string} [override] 显式指定。
 * @returns {string|null} 可执行文件路径。
 */
export function resolveMitmdump(override) {
  if (override && existsSync(override)) return override;
  const envPath = process.env.DSH_MITMDUMP;
  if (envPath && existsSync(envPath)) return envPath;

  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs/Python'),
    path.join(process.env.APPDATA || '', 'Python'),
    'C:/',
  ];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(root, e.name, 'Scripts', 'mitmdump.exe');
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 解析 Windows PowerShell 的**绝对路径**。
 *
 * 不能只写 `'powershell.exe'` 让系统去 PATH 里找：本模块跑在 Electron 的 Host
 * 进程里，那个进程的 PATH 由启动它的父进程决定，并不保证包含
 * `%SystemRoot%\System32\WindowsPowerShell\v1.0`。找不到时 `spawn` 走的是
 * **异步**的 ENOENT 事件 —— 调用方看不到，只会以为「已经触发成功」。
 *
 * @returns {string} 绝对路径；极端情况下回退到裸名，让 PATH 再试一次。
 */
export function resolvePowerShell() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const absolute = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(absolute) ? absolute : 'powershell.exe';
}

/**
 * 检测 mitmproxy 的 CA 是否已装入「当前用户 → 受信任的根证书」。
 *
 * 必须查证书存储，不能只看 `~/.mitmproxy/*.cer` 是否存在 —— 文件存在但没导入时，
 * TLS 拦截会失败，表现为收割拿不到任何握手，非常难查。
 * @returns {Promise<{installed: boolean, notAfter: string|null}>} 检测结果。
 */
export async function detectCa() {
  const script = "$c = Get-ChildItem Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue | "
    + "Where-Object { $_.Subject -match 'mitmproxy' } | Select-Object -First 1; "
    + "if ($c) { $c.NotAfter.ToString('yyyy-MM-dd') } else { 'NONE' }";
  const out = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const v = (out ?? '').trim();
  return { installed: Boolean(v) && v !== 'NONE', notAfter: v && v !== 'NONE' ? v : null };
}

/**
 * 生成（如需要）并导入 mitmproxy CA。
 *
 * 会弹出一次 Windows 安全警告 —— 这是导入根证书的系统强制确认，无法静默绕过。
 * @param {{mitmdump: string, mitmPort?: number, log?: (m: string) => void}} options 参数。
 * @returns {Promise<{installed: boolean, action: string}>} 结果。
 */
export async function ensureCa(options) {
  const { mitmdump } = options;
  const log = options.log ?? (() => {});
  const caDir = path.join(process.env.USERPROFILE || '', '.mitmproxy');
  const caFile = path.join(caDir, 'mitmproxy-ca-cert.cer');

  const before = await detectCa();
  if (before.installed) return { installed: true, action: 'already-installed' };

  // mitmdump 首次启动会生成 CA；用一个临时端口跑一下即可，不碰系统代理
  if (!existsSync(caFile) && mitmdump && existsSync(mitmdump)) {
    const tmpPort = (options.mitmPort ?? 8082) + 1000;
    try {
      const child = spawn(mitmdump, ['--listen-port', String(tmpPort)], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
      for (let i = 0; i < 25 && !existsSync(caFile); i += 1) {
        await new Promise((r) => { setTimeout(r, 600); });
      }
      spawn('taskkill', ['/F', '/IM', 'mitmdump.exe'], { stdio: 'ignore', windowsHide: true });
      await new Promise((r) => { setTimeout(r, 1000); });
    } catch (error) {
      log(`[预检] 生成 CA 失败：${error?.message ?? error}`);
    }
  }

  if (!existsSync(caFile)) {
    return { installed: false, action: `ca-file-missing:${caFile}` };
  }

  const script = `Import-Certificate -FilePath '${caFile}' -CertStoreLocation 'Cert:\\CurrentUser\\Root' | Out-Null; 'OK'`;
  log('[预检] 正在导入 mitmproxy CA —— 会弹出 Windows 安全警告，请点「是」');
  await runCapture('powershell.exe', ['-NoProfile', '-Command', script], 60_000);

  const after = await detectCa();
  return { installed: after.installed, action: after.installed ? 'imported' : 'import-failed' };
}

/**
 * 后台（非阻塞）尝试安装 mitmproxy。
 *
 * 刻意不阻塞启动：pip 安装可能要好几分钟。装完下次启动生效。
 * @param {{log?: (m: string) => void}} [options] 参数。
 * @returns {Promise<{started: boolean, reason?: string}>} 是否已触发。
 */
export async function installMitmproxy(options = {}) {
  const log = options.log ?? (() => {});
  const findPython = () => {
    const cands = [];
    for (const root of [path.join(process.env.LOCALAPPDATA || '', 'Programs/Python'), 'C:/']) {
      if (!root || !existsSync(root)) continue;
      try {
        for (const e of readdirSync(root, { withFileTypes: true })) {
          if (e.isDirectory()) cands.push(path.join(root, e.name, 'python.exe'));
        }
      } catch { /* ignore */ }
    }
    return cands.find((p) => existsSync(p)) ?? null;
  };
  const python = findPython();
  if (!python) return { started: false, reason: '未找到 Python，无法自动安装 mitmproxy（请先装 Python 3.11+）' };

  try {
    const child = spawn(python, ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', 'mitmproxy'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    log('[预检] 已在后台安装 mitmproxy（可能需要几分钟，装完下次启动生效）');
    return { started: true, reason: `via ${python}` };
  } catch (error) {
    return { started: false, reason: `启动 pip 失败：${error?.message ?? error}` };
  }
}

/**
 * 触发 Copilot 令牌刷新（`refresh-token.ps1`）。
 *
 * 该脚本会临时把系统代理指向 mitmdump、用 UI 自动化让 Copilot 建一次连接，
 * 然后在 `finally` 里还原代理。这里做三层保护：
 *   - 锁文件：`REFRESH_LOCK_MS` 内的重复触发直接忽略（多个 DSH 实例/重复启动）；
 *   - 只在令牌确实陈旧、且前置条件齐备时调用（由调用方判断）；
 *   - 输出落到日志文件，失败不抛。
 *
 * @param {{scriptPath: string, harvestDir: string, logFile?: string}} options 路径。
 * @returns {Promise<{started: boolean, reason?: string, logFile?: string}>} 是否已触发。
 */
export async function refreshCopilotToken(options) {
  const { scriptPath, harvestDir } = options;
  if (!existsSync(scriptPath)) return { started: false, reason: `找不到刷新脚本：${scriptPath}` };

  const lockFile = path.join(harvestDir, '.auto-refresh.lock');
  try {
    mkdirSync(harvestDir, { recursive: true });
    if (existsSync(lockFile)) {
      const stamp = Number(readFileSync(lockFile, 'utf8').trim()) || 0;
      if (Date.now() - stamp < REFRESH_LOCK_MS) {
        return { started: false, reason: '已有一次刷新在进行中（锁未过期）' };
      }
    }
    writeFileSync(lockFile, String(Date.now()), 'utf8');
  } catch (error) {
    return { started: false, reason: `锁文件不可用：${error?.message ?? error}` };
  }

  const logFile = options.logFile ?? path.join(harvestDir, REFRESH_LOG_FILES.transcript);
  // PowerShell 自身这一层的痕迹单独落一份：Start-Transcript 只能覆盖脚本内部的
  // Write-Host，抓不到「进程压根没起来」这种更早的失败。两个文件分工明确、互不覆盖。
  const spawnLog = path.join(harvestDir, REFRESH_LOG_FILES.spawn);
  // 脚本所在目录：scriptblock 方式执行时 $PSScriptRoot 为空，得显式传进去，
  // 否则脚本里的收割插件路径（token-harvester.py）会解析错。
  const bridgeDir = path.dirname(scriptPath);
  const powershell = resolvePowerShell();

  const note = (message) => {
    try { appendFileSync(spawnLog, `${new Date().toISOString()} ${message}\n`, 'utf8'); } catch { /* 日志写不进去不阻断刷新 */ }
  };
  note(`触发刷新：powershell=${powershell}`);
  note(`脚本=${scriptPath}`);

  // 三个关键点：
  //   1. 用 `Get-Content -Encoding UTF8` + `[scriptblock]::Create` 执行，而不是
  //      `-File`。Windows PowerShell 5.1 对**没有 UTF-8 BOM** 的 .ps1 会按 ANSI(GBK)
  //      解析，脚本里的中文会被拆坏、连引号都可能被吞掉，导致整个脚本解析失败 ——
  //      而且失败得毫无声息（实测就是这么静默失效的）。按 UTF-8 读进来再执行，
  //      编码就再也不会成为故障源。
  //   2. 用 `Start-Transcript` 包住：脚本通篇是 `Write-Host`，它不走 stdout，
  //      直接重定向 stdio 是抓不到的。转录才能把失败原因留下来。
  //   3. 把脚本目录与收割目录显式传给脚本（见上）。
  const command = [
    "$ErrorActionPreference='Continue'",
    `$DshBridgeDir='${bridgeDir}'`,
    `$env:COPILOT_HARVEST_DIR='${harvestDir}'`,
    `Start-Transcript -Path '${logFile}' -Force | Out-Null`,
    `try { $src = Get-Content -Raw -Encoding UTF8 '${scriptPath}'; & ([scriptblock]::Create($src)) }`,
    "catch { Write-Host ('SCRIPT ERROR: ' + $_.Exception.Message) }",
    'finally { Stop-Transcript | Out-Null }',
  ].join('; ');

  let out = null;
  try { out = openSync(spawnLog, 'a'); } catch { /* 打不开就退化成丢弃输出，不阻断 */ }

  let child;
  try {
    child = spawn(
      powershell,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        detached: true,
        // stdio 不能用 'ignore'：那样「进程没起来」和「脚本跑了但失败」在外部看来
        // 一模一样 —— 都什么痕迹都不留。重定向到文件后，PowerShell 的原生输出
        // 与错误才有去处。
        stdio: ['ignore', out ?? 'ignore', out ?? 'ignore'],
        windowsHide: true,
      },
    );
  } catch (error) {
    if (out !== null) { try { closeSync(out); } catch { /* ignore */ } }
    note(`启动失败（同步抛错）：${error?.message ?? error}`);
    try { unlinkSync(lockFile); } catch { /* ignore */ }
    return { started: false, reason: `启动失败：${error?.message ?? error}` };
  }

  child.on('exit', (code, signal) => {
    note(`PowerShell 退出：code=${code} signal=${signal}`);
    if (out !== null) { try { closeSync(out); } catch { /* ignore */ } }
  });

  // spawn 的失败是**异步**的：ENOENT 之类不会在 spawn() 里抛，而是走 error 事件。
  // 不监听它，started:true 就会骗过调用方 —— 这正是「刷新显示已触发、但 mitmdump
  // 从未启动、也没有任何日志」的成因。这里短暂等一次，把「立即失败」变成可见结果，
  // 而不是让它烂在后台。
  const failure = await new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(null); }, 500);
    child.once('error', (error) => { clearTimeout(timer); resolve(error); });
  });
  if (failure) {
    if (out !== null) { try { closeSync(out); } catch { /* ignore */ } }
    note(`PowerShell 启动失败：${failure?.code ?? ''} ${failure?.message ?? failure}`);
    try { unlinkSync(lockFile); } catch { /* ignore */ }
    return { started: false, reason: `PowerShell 启动失败（${failure?.code ?? '未知'}）：${failure?.message ?? failure}` };
  }
  child.unref();

  // 锁由定时器自然过期：脚本最长约 2 分钟（起 mitmdump + 切代理 + 多轮「激活窗口→发消息→等收割」，
  // 每轮最多 25 秒、总计上限 100 秒），留足余量；进程被强杀时也不会把锁永久留下。
  setTimeout(() => { try { unlinkSync(lockFile); } catch { /* ignore */ } }, REFRESH_LOCK_MS).unref?.();
  return { started: true, logFile };
}

/**
 * 跑一次完整预检：检测两个应用 + 令牌状态，并按开关自动启动 / 自动刷新。
 * @param {object} options 配置与路径。
 * @param {boolean} [options.autoStartDeps] 装了没跑时是否自动启动（默认 true）。
 * @param {boolean} [options.autoRefreshToken] 令牌陈旧时是否自动刷新（默认 true）。
 * @param {boolean} [options.bootstrap] 启动时把随包分发的部署文件自举到收割目录（默认 true）。
 * @param {boolean} [options.autoInstallCa] CA 未装时自动导入（会弹一次系统确认框，默认 true）。
 * @param {boolean} [options.autoInstallMitm] mitmdump 缺失时后台尝试 pip 安装（默认 true）。
 * @param {string} options.bridgeDir 随包分发的 bridge 目录（自举来源）。
 * @param {string} options.harvestDir 收割目录。
 * @param {string} options.refreshScript 刷新脚本路径。
 * @param {(msg: string) => void} [options.log] 日志函数。
 * @returns {Promise<object>} 结构化预检结果，供 /health 展示。
 */
export async function runPreflight(options) {
  const {
    harvestDir, refreshScript, bridgeDir,
    autoStartDeps = true, autoRefreshToken = true,
    bootstrap = true, autoInstallCa = true, autoInstallMitm = true,
  } = options;
  const log = options.log ?? (() => {});
  const images = await runningImages();

  // ---- 0. 自举：把随包分发的部署文件放好（安装包带不了 mitmproxy/CA，但这步能自动化）----
  let boot = { copied: [], repaired: [], skipped: [] };
  if (bootstrap && bridgeDir) {
    boot = bootstrapPayload({ bridgeDir, harvestDir, log });
  }

  const apps = {};
  for (const kind of ['workbuddy', 'copilot']) {
    const result = await ensureAppRunning(kind, { autoStart: autoStartDeps, images });
    apps[kind] = result;
    if (result.started) log(`[预检] 已自动启动 ${result.label}${result.startError ? `（${result.startError}）` : ''}`);
    else if (!result.installed) log(`[预检] ${result.label} 未检测到，相关反代将不可用：\n${result.hint}`);
    else if (!result.running) log(`[预检] ${result.label} 已安装但未运行，且未自动启动（autoStartDeps=false）`);
  }

  const harvest = await detectHarvest(harvestDir, options);

  // ---- mitmdump 缺失：后台尝试装（不阻塞启动）----
  let mitmInstall = null;
  if (!harvest.mitmdump) {
    if (autoInstallMitm) mitmInstall = await installMitmproxy({ log });
    else mitmInstall = { started: false, reason: 'autoInstallMitm=false' };
    if (mitmInstall.started) harvest.missing.push('mitmdump（正在后台安装，装完下次启动生效）');
  }

  // ---- CA 证书：这是「装完还得手工做一步」的那一步，尽量自动 ----
  let ca = await detectCa();
  if (!ca.installed) {
    if (autoInstallCa && harvest.mitmdump) {
      ca = await ensureCa({ mitmdump: harvest.mitmdump, mitmPort: options.mitmPort, log });
      if (ca.installed) log('[预检] mitmproxy CA 已导入，后续收割可用');
      else log(`[预检] CA 未能导入（${ca.action}）—— Copilot 通道在导入前无法工作`);
    } else if (!autoInstallCa) {
      log('[预检] mitmproxy CA 未装入受信任根证书区（autoInstallCa=false）');
    }
  }
  if (!ca.installed) harvest.missing.push('mitmproxy CA 证书（需导入到「受信任的根证书」）');
  harvest.caInstalled = ca.installed;
  harvest.caNotAfter = ca.notAfter;
  harvest.canAutoRefresh = harvest.missing.length === 0;

  let refresh = { started: false, reason: '令牌仍然新鲜，无需刷新' };

  if (harvest.stale) {
    if (!autoRefreshToken) {
      refresh = { started: false, reason: '令牌陈旧，但 autoRefreshToken=false' };
    } else if (!apps.copilot.running) {
      refresh = { started: false, reason: '令牌陈旧，但 Copilot 未在运行 —— 刷新需要它在运行' };
    } else if (!harvest.canAutoRefresh) {
      refresh = { started: false, reason: `令牌陈旧，但刷新前置条件缺失：${harvest.missing.join('、')}` };
    } else {
      refresh = await refreshCopilotToken({ scriptPath: refreshScript, harvestDir });
    }
    if (!refresh.started) log(`[预检] 未自动刷新 Copilot 令牌：${refresh.reason}`);
    else log(`[预检] 已触发 Copilot 令牌刷新（约 1 分钟；日志 ${refresh.logFile}）`);
  }

  return { bootstrap: boot, apps, harvest, ca, mitmInstall, refresh, checkedAt: new Date().toISOString() };
}
