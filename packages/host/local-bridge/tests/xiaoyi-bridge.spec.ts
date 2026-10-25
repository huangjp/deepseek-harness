import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPrompt, startXiaoyiBridge, stopXiaoyiBridge } from '../bridge/xiaoyi-bridge.mjs'

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

/**
 * 提示词收敛。
 *
 * 小艺的 `textRecognize` 通道有两个硬约束（实测，见 bridge/xiaoyi-protocol-notes.md）：
 * 输入超过约 8000 字符，上游**不报错**，只把答案换成一句固定英文模板
 * 「Sorry, I don't know the answer to that.」；而且它是单轮通道，整段对话历史喂进去
 * 它会照着第一条用户输入回答。
 *
 * DSH 一次真实请求的 messages 有 4.4 万~6.3 万字符，所以 buildPrompt() 必须自己收敛。
 */
describe('buildPrompt', () => {
  it('passes a plain single-turn question through unchanged', () => {
    expect(buildPrompt([{ role: 'user', content: '你好' }])).toBe('你好')
  })

  it('keeps a short system prompt in the 要求 wrapper', () => {
    expect(buildPrompt([
      { role: 'system', content: '用中文简短回答。' },
      { role: 'user', content: '你好' },
    ])).toBe('（要求：用中文简短回答。）\n\n你好')
  })

  it('drops a long system prompt — Celia has no tools and cannot follow one', () => {
    const system = 'A'.repeat(201)
    expect(buildPrompt([
      { role: 'system', content: system },
      { role: 'user', content: '你好' },
    ])).toBe('你好')
  })

  it('ignores assistant history so Celia answers the latest turn', () => {
    expect(buildPrompt([
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '助手答' },
      { role: 'user', content: '最后一句' },
    ])).toBe('最后一句')
  })

  it('skips the harness blocks DSH injects into user turns', () => {
    expect(buildPrompt([
      { role: 'user', content: '真实问题' },
      { role: 'user', content: '<system-reminder>\nworkspace instructions' },
      { role: 'user', content: 'Current runtime context. This snapshot supersedes earlier ones.' },
      { role: 'user', content: '[model changed: dpv41f/deepseek-v4.1-flash → hwcelia/xiaoyi-chat]' },
    ])).toBe('真实问题')
  })

  it('falls back to the last raw user turn when every turn is harness noise', () => {
    expect(buildPrompt([
      { role: 'user', content: '<system-reminder>\nonly noise' },
    ])).toBe('<system-reminder>\nonly noise')
  })

  it('caps the prompt below the upstream length ceiling', () => {
    const prompt = buildPrompt([{ role: 'user', content: '长'.repeat(50_000) }])
    expect(prompt.length).toBeLessThanOrEqual(4000)
    expect(prompt.endsWith('…')).toBe(true)
  })

  it('reads array-shaped content parts', () => {
    expect(buildPrompt([
      { role: 'user', content: [{ type: 'text', text: '你好' }, { type: 'text', text: '世界' }] },
    ])).toBe('你好世界')
  })

  it('returns an empty prompt when there is no user turn', () => {
    expect(buildPrompt([])).toBe('')
    expect(buildPrompt([{ role: 'system', content: '只有系统提示' }])).toBe('')
    expect(buildPrompt([{ role: 'assistant', content: '只有助手回话' }])).toBe('')
  })

  it('replays the tool turns that follow the current question', () => {
    const prompt = buildPrompt([
      { role: 'user', content: '读一下 package.json' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"package.json"}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"name":"deepseek-harness"}' },
    ])
    // agent 多轮要接上：小艺必须看见上一轮要了什么工具、工具返回了什么。
    expect(prompt).toContain('读一下 package.json')
    expect(prompt).toContain('read(')
    expect(prompt).toContain('【外部执行结果 call_1 开始】')
    expect(prompt).toContain('deepseek-harness')
  })

  it('drops the harness noise that follows the question but keeps the tool turns', () => {
    const prompt = buildPrompt([
      { role: 'user', content: '真实问题' },
      { role: 'user', content: '<system-reminder>\nworkspace instructions' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_1', content: '结果' },
    ])
    expect(prompt).not.toContain('system-reminder')
    expect(prompt).toContain('【外部执行结果 call_1 开始】')
  })

  it('truncates an oversized tool result so the prompt stays within the ceiling', () => {
    const prompt = buildPrompt([
      { role: 'user', content: '读文件' },
      { role: 'tool', tool_call_id: 'call_1', content: 'x'.repeat(5000) },
    ])
    expect(prompt.length).toBeLessThanOrEqual(4000)
    expect(prompt).toContain('…')
  })
})
