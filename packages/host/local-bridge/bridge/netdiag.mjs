// 出站连接诊断：把「连不上」翻译成「为什么连不上」
//
// 为什么需要它
// -----------
// Copilot 通道用 WebSocket 连 substrate.office.com。失败时 Node 只给一句
// "WebSocket 连接失败"（Electron 宿主里是 Chromium 实现），这句话不指向任何原因：
// 令牌过期？服务端限流？本机代理客户端挂了？——全都说得通。
//
// 而这条通道**特别**容易被本机代理拖死：装在 Electron 宿主里时，WebSocket 走的是
// Chromium 的网络栈，会自动读 Windows 系统代理（WinINET）。用户的代理客户端一旦没在
// 工作（GUI 在、内核没起，7890 无人监听），通道立刻 502，而错误里一个字都看不出来。
//
// 所以这里只做一件事：把**当前进程实际用的出站路径**说清楚。
//   1. WebSocket 是谁实现的（Node 的 undici 直连，还是 Chromium 的、会读系统代理）；
//   2. 进程环境里有没有代理变量；
//   3. Windows 系统代理指向哪里、那个端口现在通不通。
//
// 只读、不改任何配置；探测失败一律返回「未知」而不是抛错 —— 诊断本身不能成为故障源。

import { execFileSync } from 'node:child_process';
import net from 'node:net';

/**
 * 认出当前进程里的 WebSocket 是谁实现的。
 *
 * Node 自带的 undici 实现上带 `Symbol(nodejs.util.inspect.custom)` 之类不好认的标记，
 * 但最可靠的判据是**错误消息的语言**：Chromium 的 WebSocket 错误走系统 locale
 * （中文系统上是「WebSocket 连接失败」），Node 的 undici 是英文固定串。
 * 用构造函数的源码片段来分，更稳：Chromium 的 `WebSocket.toString()` 是一坨原生绑定，
 * undici 的是可读的 JS 类。
 *
 * @returns {{impl: string, proxyEnv: Record<string, string>}} 实现来源与代理环境变量。
 */
export function describeSocketStack() {
  const proxyEnv = {};
  for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']) {
    const value = process.env[name];
    if (value) proxyEnv[name] = value;
  }
  let impl = 'unknown';
  try {
    const src = Function.prototype.toString.call(WebSocket);
    // undici 的实现带 class 关键字；Chromium 的原生绑定会被打印成 "function WebSocket() { [native code] }"。
    impl = /class\s/.test(src) ? 'node-undici' : 'chromium';
  } catch {
    impl = 'unknown';
  }
  return { impl, proxyEnv };
}

/**
 * 读 Windows 系统代理设置（WinINET）。
 *
 * 只在 Windows 上有意义；别的平台返回 enabled=false。
 *
 * @returns {{enabled: boolean, server: string, bypass: string}} 系统代理配置。
 */
export function readSystemProxy() {
  const result = { enabled: false, server: '', bypass: '' };
  if (process.platform !== 'win32') return result;
  try {
    const out = execFileSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    );
    const enable = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    result.enabled = Boolean(enable && Number.parseInt(enable[1], 16) !== 0);
    const server = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(out);
    if (server) result.server = server[1].trim();
    const bypass = /ProxyOverride\s+REG_SZ\s+(.+)/i.exec(out);
    if (bypass) result.bypass = bypass[1].trim();
  } catch {
    // 读不到就当没有 —— 诊断不该制造新故障。
  }
  return result;
}

/**
 * 探测一个 host:port 现在通不通。
 *
 * @param {string} host - 主机名或地址。
 * @param {number} port - 端口。
 * @param {number} [timeoutMs] - 超时（毫秒）。
 * @returns {Promise<boolean>} 通就 true。
 */
export function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 把系统代理里的 `host:port` 拆开。
 *
 * 系统代理串可能是 `127.0.0.1:7890`、`127.0.0.1:8080;http=127.0.0.1:8081` 或
 * `socks=127.0.0.1:1080`。这里取**第一个**看起来像端口的条目 —— 诊断只需要知道
 * 「用户把流量指向哪儿」，不需要完整解析 PAC 语义。
 *
 * @param {string} server - 系统代理服务器串。
 * @returns {{host: string, port: number}|null} 拆出来的地址，拆不出返回 null。
 */
export function parseProxyEndpoint(server) {
  const m = /([\w.:-]+):(\d{2,5})/.exec(String(server || ''));
  if (!m) return null;
  const port = Number.parseInt(m[2], 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host: m[1], port };
}

/**
 * 生成一句人话，说明这次失败可能是什么造成的。
 *
 * @param {{impl: string, proxyEnv: Record<string, string>}} stack - 出站栈信息。
 * @param {Awaited<ReturnType<typeof probeSystemProxy>>} proxy - 系统代理探测结果。
 * @returns {string} 诊断文本；没有任何线索时返回空串。
 */
export function formatProxyDiagnosis(stack, proxy) {
  const parts = [];
  if (stack?.impl === 'chromium') {
    parts.push('本进程的 WebSocket 由 Chromium 实现，它会自动使用 Windows 系统代理');
  } else if (stack?.impl === 'node-undici') {
    parts.push('本进程的 WebSocket 由 Node 直连实现（不读系统代理）');
  }
  if (proxy?.enabled && proxy.server) {
    const endpoint = parseProxyEndpoint(proxy.server);
    if (endpoint) {
      parts.push(
        `Windows 系统代理指向 ${endpoint.host}:${endpoint.port}`
        + (proxy.reachable === false ? '，但该端口现在无人监听（代理客户端可能没在工作）' : ''),
      );
    } else {
      parts.push(`Windows 系统代理指向 ${proxy.server}`);
    }
  }
  const envKeys = Object.keys(stack?.proxyEnv || {});
  if (envKeys.length) {
    parts.push(`进程代理环境变量：${envKeys.join('、')}`);
  }
  return parts.length ? `出站诊断：${parts.join('；')}。` : '';
}

/**
 * 探测 Windows 系统代理是否真的可达。
 *
 * @returns {Promise<{enabled: boolean, server: string, bypass: string, reachable: boolean|null, endpoint: {host: string, port: number}|null}>} 探测结果。
 */
export async function probeSystemProxy() {
  const base = readSystemProxy();
  const endpoint = parseProxyEndpoint(base.server);
  let reachable = null;
  if (base.enabled && endpoint) {
    reachable = await probeTcp(endpoint.host, endpoint.port);
  }
  return { ...base, reachable, endpoint };
}
