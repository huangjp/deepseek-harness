/**
 * 工具调用在真实反代里的往返：`tools` 进得去、意图出得来。
 *
 * 走的是随包分发的 `bridge/bridge.mjs`，真实 HTTP 监听与真实 SSE 帧；模型那一侧换成
 * 它自带的 `MockBackend`（`backend: 'mock'`），所以整条链路不触达任何模型、也不消耗
 * 额度 —— 但它确实经过提示词组装、工具清单渲染、输出解析与帧格式这一整条路。
 *
 * 这两条内置通道都没有原生 function calling，工具调用只能靠文本协议往返；判定错了
 * 会把工具调用当正文下发，下游 agent 会以为任务已经完成，所以这里断言的是**真实帧**。
 */

import { mkdtemp } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startBridge, stopBridge } from '../bridge/bridge.mjs'

/** 一个 tool_call 的线上形状。 */
interface WireToolCall {
  id: string
  function: { name: string; arguments: string }
}

/** 非流式响应里本规格读到的那部分。 */
interface CompletionBody {
  choices: { message: { content: string; tool_calls?: WireToolCall[] }; finish_reason: string }[]
}

/** 一条 SSE 帧里本规格读到的那部分。 */
interface StreamFrame {
  choices: { delta?: { content?: string; tool_calls?: WireToolCall[] }; finish_reason: string | null }[]
}

let close: (() => Promise<void>) | undefined

afterEach(async () => {
  await stopBridge()
  if (close !== undefined) await close()
  close = undefined
})

/** 绑一个临时回环端口再放掉，交给反代独占。 */
async function freePort(): Promise<number> {
  const sockets = new Set<Socket>()
  const server = createServer((socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fixture bound no port')
  const port = address.port
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

/** 一份工具定义。 */
function tool(name: string) {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} 的说明`,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  }
}

/**
 * 起一个走 MockBackend 的 WorkBuddy 反代。
 * @param options - 模型那一侧要模拟的故障形态。
 * @returns 一个发送对话请求的函数。
 */
async function boot(
  options: { malformed?: boolean; unparseable?: boolean; dsml?: boolean } = {},
): Promise<{
  post: (body: Record<string, unknown>) => Promise<Response>
}> {
  const cacheDir = await mkdtemp(join(tmpdir(), 'dsh-bridge-tools-'))
  const port = await freePort()
  await startBridge({
    server: { host: '127.0.0.1', port },
    backend: 'mock',
    mock: {
      delayMs: 20,
      malformed: options.malformed ?? false,
      unparseable: options.unparseable ?? false,
      dsml: options.dsml ?? false,
    },
    serve: { cacheDir },
  })
  return {
    post: body => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: '看看 a.txt' }], ...body }),
    }),
  }
}

/**
 * 把一条 SSE 响应切成已解析的帧。
 * @param text - 响应正文。
 * @returns 解析后的帧。
 */
function framesOf(text: string): StreamFrame[] {
  return text
    .split('\n\n')
    .filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map(line => JSON.parse(line.slice(6)) as StreamFrame)
}

/**
 * 取所有帧里出现过的收尾原因。
 * @param frames - 解析后的帧。
 * @returns 非空的 finish_reason 列表。
 */
function finishesOf(frames: StreamFrame[]): string[] {
  return frames
    .map(frame => frame.choices[0]?.finish_reason)
    .filter((reason): reason is string => typeof reason === 'string')
}

/**
 * 取所有帧里下发过的正文。
 * @param frames - 解析后的帧。
 * @returns 拼起来的正文。
 */
function contentOf(frames: StreamFrame[]): string {
  return frames.map(frame => frame.choices[0]?.delta?.content ?? '').join('')
}

describe('WorkBuddy 反代的工具调用往返', () => {
  it('非流式：带工具时把模型的文本意图还原成 tool_calls', async () => {
    const bridge = await boot()
    const response = await bridge.post({ tools: [tool('read')], messages: [{ role: 'user', content: '读 a.txt' }] })
    expect(response.status).toBe(200)

    const payload = await response.json() as CompletionBody
    const choice = payload.choices[0]
    expect(choice?.finish_reason).toBe('tool_calls')
    expect(choice?.message.tool_calls).toHaveLength(1)
    expect(choice?.message.tool_calls?.[0]?.function.name).toBe('read')
    // 参数必须是 JSON 字符串（OpenAI 线上格式），不是对象。
    expect(JSON.parse(choice?.message.tool_calls?.[0]?.function.arguments ?? '{}')).toMatchObject({ mock: true })
    expect(choice?.message.tool_calls?.[0]?.id).toMatch(/^call_/u)
  })

  it('流式：tool_calls 走增量帧，并以 tool_calls 收尾', async () => {
    const bridge = await boot()
    const response = await bridge.post({
      tools: [tool('read')],
      stream: true,
      messages: [{ role: 'user', content: '读 a.txt' }],
    })
    expect(response.status).toBe(200)

    const frames = framesOf(await response.text())
    const calls = frames.flatMap(frame => frame.choices[0]?.delta?.tool_calls ?? [])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.function.name).toBe('read')
    expect(finishesOf(frames)).toContain('tool_calls')
  })

  it('不带工具时照常回答，不会被工具链路拦下', async () => {
    const bridge = await boot()
    const response = await bridge.post({ messages: [{ role: 'user', content: '你好' }] })

    const payload = await response.json() as CompletionBody
    expect(payload.choices[0]?.finish_reason).toBe('stop')
    expect(payload.choices[0]?.message.content).toContain('（mock）可用')
  })

  it('JSON 写坏但可修复时，把 wrapper 层误放的参数并回 arguments', async () => {
    // 线上最常见的故障形态：多一个 ]、参数误放到 wrapper 层。修复链路必须把它救回来，
    // 而不是当成"不是工具调用"丢给下游。
    const bridge = await boot({ malformed: true })
    const response = await bridge.post({ tools: [tool('read')], messages: [{ role: 'user', content: '读 a.txt' }] })

    const payload = await response.json() as CompletionBody
    const choice = payload.choices[0]
    expect(choice?.finish_reason).toBe('tool_calls')
    expect(choice?.message.tool_calls?.[0]?.function.name).toBe('read')
    expect(JSON.parse(choice?.message.tool_calls?.[0]?.function.arguments ?? '{}'))
      .toMatchObject({ mock: true, summarize: 'mock 破坏版' })
  })

  it('JSON 彻底写坏时不冒充最终回答，而是下发明确的错误文本', async () => {
    // 这是最要紧的一条：把半截 JSON 当正文下发，下游 agent 会以为任务已完成。
    const bridge = await boot({ unparseable: true })
    const response = await bridge.post({ tools: [tool('read')], messages: [{ role: 'user', content: '读 a.txt' }] })
    expect(response.status).toBe(200)

    const payload = await response.json() as CompletionBody
    const choice = payload.choices[0]
    expect(choice?.finish_reason).toBe('stop')
    expect(choice?.message.tool_calls).toBeUndefined()
    expect(choice?.message.content).toContain('未执行任何工具')
  })

  it('流式下 JSON 彻底写坏同样下发错误帧', async () => {
    const bridge = await boot({ unparseable: true })
    const response = await bridge.post({
      tools: [tool('read')],
      stream: true,
      messages: [{ role: 'user', content: '读 a.txt' }],
    })

    const frames = framesOf(await response.text())
    expect(contentOf(frames)).toContain('未执行任何工具')
    expect(finishesOf(frames)).toContain('stop')
    expect(finishesOf(frames)).not.toContain('tool_calls')
  })

  it('模型吐出自带的 DSML 标记时，还原成 tool_calls 而不是当正文', async () => {
    // 训练时带原生调用格式的模型常常无视我们约定的 JSON，直接输出 DSML 标记。
    // 认不出它，整段尖括号就会被当成正文流给用户 —— 线上报回来的就是这个形态。
    const bridge = await boot({ dsml: true })
    const response = await bridge.post({ tools: [tool('read')], messages: [{ role: 'user', content: '读 a.txt' }] })

    const payload = await response.json() as CompletionBody
    const choice = payload.choices[0]
    expect(choice?.finish_reason).toBe('tool_calls')
    expect(choice?.message.tool_calls?.[0]?.function.name).toBe('read')
    expect(JSON.parse(choice?.message.tool_calls?.[0]?.function.arguments ?? '{}'))
      .toEqual({ mock: true, source: 'MockBackend' })
    // 标记一个字符都不该漏进正文。
    expect(choice?.message.content).toBe('')
  })

  it('流式下同样还原，标记不会漏进 SSE 正文帧', async () => {
    const bridge = await boot({ dsml: true })
    const response = await bridge.post({
      tools: [tool('read')],
      stream: true,
      messages: [{ role: 'user', content: '读 a.txt' }],
    })

    const frames = framesOf(await response.text())
    expect(contentOf(frames)).not.toContain('DSML')
    expect(frames.flatMap(frame => frame.choices[0]?.delta?.tool_calls ?? [])).toHaveLength(1)
    expect(finishesOf(frames)).toContain('tool_calls')
  })

  it('没有任何可用工具名时退回普通回答', async () => {
    // tools 里全是没名字的条目：清单渲染为空，于是不进入工具链路。
    const bridge = await boot()
    const response = await bridge.post({
      tools: [{ type: 'function', function: {} }],
      messages: [{ role: 'user', content: '你好' }],
    })

    const payload = await response.json() as CompletionBody
    expect(payload.choices[0]?.finish_reason).toBe('stop')
    expect(payload.choices[0]?.message.content).toContain('（mock）可用')
  })
})
