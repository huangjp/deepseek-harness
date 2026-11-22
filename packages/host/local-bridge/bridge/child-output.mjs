// Python 子进程输出的解码。
//
// 为什么单独成文件：这个模块**不能有任何 import**。
// backends.mjs 顶层有一个 `await import('./workbuddy-cloud.mjs')`，而 workbuddy-cloud.mjs
// 又要收割器的输出解码 —— 两者互相 import 会让那个顶层 await 永远挂起
// （Node 报 "unsettled top-level await"，独立启动的反代直接起不来）。

/**
 * 解码 Python 子进程的输出。
 *
 * Windows 上 Python 把 stdout/stderr 写成**控制台代码页**（简体中文系统是 cp936/GBK），
 * 按 UTF-8 解会得到一片乱码。收割器的报错是给人看的，必须读得懂。
 * 先按 UTF-8 解；出现替换字符（U+FFFD）说明不是 UTF-8，再用 GBK 重解一次。
 *
 * @param {Buffer|string} raw 子进程 stdout/stderr 的原始字节。
 * @returns {string} 解码后的文本。
 */
export function decodeChildOutput(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    return gbk.includes('\uFFFD') ? utf8 : gbk;
  } catch {
    return utf8;
  }
}

/**
 * Python 子进程的 UTF-8 环境变量。
 *
 * `PYTHONIOENCODING` 决定 stdout/stderr 写用什么编码，`PYTHONUTF8` 让解释器整体进入
 * UTF-8 模式。两个都设上，收割器的输出就是 UTF-8；`decodeChildOutput` 的 GBK 兜底
 * 是给改不动的脚本用的。
 *
 * @returns {NodeJS.ProcessEnv} 附加了 UTF-8 设置的环境变量。
 */
export function pythonUtf8Env() {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}
