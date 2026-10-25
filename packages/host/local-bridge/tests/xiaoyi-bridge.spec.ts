import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startXiaoyiBridge, stopXiaoyiBridge } from '../bridge/xiaoyi-bridge.mjs'

/**
 * 小艺反代的 HTTP 表面与生命周期。
 *
 * 这里只测**不需要华为「AI空间」**的部分：路由、模型清单、错误映射、CORS、启停。
 * 真正的对话要连 `wss://xiaoyi.huawei.com`，还要从 AI空间 的进程内存里收割 cookie，
 * 不适合放进单元测试 —— 那部分靠 `node bridge/xiaoyi-bridge.mjs` 手动验证，
 * 协议细节见 `bridge/xiaoyi-protocol-notes.md`。
 *
 * 缓存文件指向临时目录，避免读到开发机上的真实凭证（那会让「缺凭证」的断言随机失败）。
 */

let cacheDir: string | undefined

afterEach(async () => {
  await stopXiaoyiBridge()
  if (cacheDir !== undefined) await rm(cacheDir, { recursive: true, force: true })
  cacheDir = undefined
})

/** 拿一个当前空闲的端口：先监听 0，再放掉。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => { resolve(port) })
    })
  })
}

async function boot() {
  cacheDir = await mkdtemp(join(tmpdir(), 'xiaoyi-bridge-'))
  const port = await freePort()
  const bridge = await startXiaoyiBridge({
    server: { host: '127.0.0.1', port, apiKey: '', cors: '*' },
    auth: { cacheFile: join(cacheDir, 'auth.json') },
    chat: { timeoutMs: 5000 },
  })
  return { bridge, base: `http://127.0.0.1:${port}` }
}

describe('xiaoyi bridge', () => {
  it('exports the start/stop pair the host imports', () => {
    expect(typeof startXiaoyiBridge).toBe('function')
    expect(typeof stopXiaoyiBridge).toBe('function')
  })

  it('lists the models the relay serves', async () => {
    const { base } = await boot()
    const res = await fetch(`${base}/v1/models`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { id: string }[] }
    expect(body.data.map(m => m.id)).toEqual(['xiaoyi-chat', 'xiaoyi'])
  })

  it('reports every required cookie as missing when nothing is cached', async () => {
    const { base } = await boot()
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; missing: string[] }
    // 5 个核心 cookie 少一个都会被上游 400，所以这里要求全都点出来。
    expect(body.ok).toBe(false)
    expect(body.missing).toEqual(['xy_token', 'xy_deviceId', 'xy_appName', 'JSID', 'xyxp'])
  })

  it('rejects an empty messages array instead of calling upstream', async () => {
    const { base } = await boot()
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xiaoyi-chat', messages: [] }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('messages')
  })

  it('answers CORS preflight and 404s an unknown route', async () => {
    const { base } = await boot()
    const preflight = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')

    const missing = await fetch(`${base}/v1/nope`)
    expect(missing.status).toBe(404)
  })

  it('releases the port on stop', async () => {
    const { base } = await boot()
    await stopXiaoyiBridge()
    await expect(fetch(`${base}/health`)).rejects.toThrow()
  })
})
