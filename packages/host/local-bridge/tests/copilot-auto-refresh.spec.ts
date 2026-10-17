/**
 * Copilot 反代的运行时令牌自动刷新：陈旧令牌在请求进入前被换掉，新令牌落盘之后才
 * 真正建连。
 *
 * 走的是随包分发的 `bridge/copilot-bridge.mjs`，真实 HTTP 监听、真实令牌文件；只有
 * 刷新触发是宿主注入的替身 —— 真触发会改系统代理并驱动 UI 自动化。上游被指到一个
 * 没人监听的本地端口，所以建连必定失败，且失败信息本身带着判据：`withTokenAgeHint`
 * 只在令牌仍然陈旧时才补那句「很可能已失效」。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCopilotBridge, stopCopilotBridge } from '../bridge/copilot-bridge.mjs'

let root: string | undefined

afterEach(async () => {
  await stopCopilotBridge()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
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

/** 一份能被 `loadHarvest()` 接受的令牌；上游指向没人监听的端口。 */
function token(harvestedAgoSec: number): string {
  return JSON.stringify({
    access_token: 'fake-token',
    harvestedAt: Math.floor(Date.now() / 1000) - harvestedAgoSec,
    params: { host: '127.0.0.1:9', path: '/probe' },
  })
}

/**
 * 起一个 Copilot 反代，令牌文件按参数写死。
 * @param harvestedAgoSec - 令牌是多久以前收割的（秒）。
 * @param refreshToken - 注入给反代的刷新触发替身。
 * @returns 反代基址与令牌文件路径。
 */
async function boot(
  harvestedAgoSec: number,
  refreshToken: () => Promise<{ started: boolean; refusal: string | null; logFile: string | null }>,
): Promise<{ base: string; tokenFile: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-copilot-refresh-'))
  const tokenFile = join(root, 'token.json')
  await writeFile(tokenFile, token(harvestedAgoSec), 'utf8')
  const port = await freePort()
  await startCopilotBridge({
    server: { host: '127.0.0.1', port },
    harvest: { dir: root },
    // 建连必失败，所以只试一次：不重试就不必等退避。
    session: { connectRetries: 1, timeoutMs: 3000 },
    refreshToken,
  })
  return { base: `http://127.0.0.1:${port}`, tokenFile }
}

/** POST 一条最小对话，取回响应正文。 */
async function chat(base: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'copilot',
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    }),
  })
  return { status: response.status, body: await response.text() }
}

/** 一份 OpenAI 风格的工具定义。 */
const READ_TOOL = {
  type: 'function',
  function: {
    name: 'read',
    description: '读取文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
}

describe('Copilot 反代运行时自动刷新令牌', () => {
  it('令牌新鲜时不触发刷新', async () => {
    const refreshToken = vi.fn(async () => ({ started: true, refusal: null, logFile: null }))
    const { base } = await boot(60, refreshToken)

    await chat(base)

    expect(refreshToken).not.toHaveBeenCalled()
  })

  it('令牌陈旧时先换新再建连，请求拿到的已是新令牌', async () => {
    const { base, tokenFile } = await boot(3600, async () => {
      // 刷新脚本的成功表现为「token.json 里的 harvestedAt 前进」。
      await writeFile(tokenFile, token(0), 'utf8')
      return { started: true, refusal: null, logFile: null }
    })

    const { body } = await chat(base)

    // 建连仍然失败（上游是空端口），但错误里**没有**那句令牌陈旧提示 ——
    // 说明建连发生在换新之后，用的已经是新令牌。
    expect(body).toContain('连接 substrate 失败')
    expect(body).not.toContain('很可能已失效')
  })

  it('刷新没能启动时带着现有令牌继续，并在错误里说明令牌已陈旧', async () => {
    const refreshToken = vi.fn(async () => ({
      started: false, refusal: 'copilot-not-running', logFile: null,
    }))
    const { base } = await boot(3600, refreshToken)

    const { body } = await chat(base)

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(body).toContain('连接 substrate 失败')
    expect(body).toContain('很可能已失效')
  })

  it('/health 报告自动刷新是否接入与当前并发', async () => {
    const { base } = await boot(60, async () => ({ started: true, refusal: null, logFile: null }))

    const payload = await (await fetch(`${base}/health`)).json() as {
      refresh: { auto: boolean; inFlight: number; running: boolean }
      token: { stale: boolean }
    }

    expect(payload.refresh).toEqual({ auto: true, inFlight: 0, running: false })
    expect(payload.token.stale).toBe(false)
  })

  it('宿主没有注入刷新能力时，闸门整段不生效', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-copilot-norefresh-'))
    await writeFile(join(root, 'token.json'), token(3600), 'utf8')
    const port = await freePort()
    await startCopilotBridge({
      server: { host: '127.0.0.1', port },
      harvest: { dir: root },
      session: { connectRetries: 1, timeoutMs: 3000 },
    })

    const payload = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as {
      refresh: { auto: boolean }
    }
    expect(payload.refresh.auto).toBe(false)

    const { body } = await chat(`http://127.0.0.1:${port}`)
    // 没有刷新能力就照旧用陈旧令牌建连，提示照出。
    expect(body).toContain('很可能已失效')
  })
})

/**
 * 工具清单必须能进到这条通道里。
 *
 * 本通道没有原生 function calling，`tools` 只能渲染成提示词里的文本协议 —— 这一段
 * 证明请求带着工具时能一路走到上游（提示词组装、协议渲染都不抛），而不是在本地就
 * 失败。上游在这里是一个没人监听的端口，所以判据是"失败来自上游"。
 * 工具往返本身的判定与帧格式由 `toolprompt.spec.ts` 与 `bridge-tool-calls.spec.ts`
 * 覆盖：后者的 MockBackend 能在无网络、无凭证的条件下走完整条真实链路。
 */
describe('Copilot 反代的工具清单', () => {
  it('非流式带工具时照常走到上游，工具分支不自己抛错', async () => {
    const { base } = await boot(60, async () => ({ started: true, refusal: null, logFile: null }))

    const { status, body } = await chat(base, { tools: [READ_TOOL] })

    expect(status).toBe(502)
    expect(body).toContain('连接 substrate 失败')
  })

  it('流式带工具时同样走到上游，并把失败按 SSE 帧下发', async () => {
    const { base } = await boot(60, async () => ({ started: true, refusal: null, logFile: null }))

    const { body } = await chat(base, { tools: [READ_TOOL], stream: true })

    // 流式下的失败必须走帧：客户端可能只解析 choices，纯 HTTP 错误体会被吞掉。
    expect(body).toContain('[调用失败]')
    expect(body).toContain('[DONE]')
  })

  it('带工具的请求在历史里回放工具轮次时也不报错', async () => {
    const { base } = await boot(60, async () => ({ started: true, refusal: null, logFile: null }))

    const { status } = await chat(base, {
      tools: [READ_TOOL],
      messages: [
        { role: 'user', content: '读 a.txt' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
      ],
    })

    expect(status).toBe(502)
  })
})
