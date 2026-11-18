/**
 * The MiniMax video client over a real local endpoint: request shapes, polling,
 * bounded download, and the understanding turn.
 *
 * The two capabilities sit on different base URLs (`/v2/...` on the native
 * host, `/v1/messages` under the Anthropic root), and MiniMax rejects a
 * disabled-thinking request on `MiniMax-M3.1-Flash`; both facts are pinned here
 * because a wrong one only shows up as a provider error at runtime.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  cancelVideoTask,
  createVideoTask,
  downloadVideo,
  generationRequest,
  listVideoTasks,
  understandVideo,
  waitForVideoTask,
} from '../src/index.ts'
import type { MiniMaxVideoOptions } from '../src/index.ts'

/** One request the endpoint received. */
interface Received {
  readonly method: string
  readonly path: string
  readonly headers: IncomingMessage['headers']
  readonly body: Record<string, unknown>
}

/** A local endpoint answering by path from a queue of bodies. */
async function endpoint(
  handler: (received: Received, index: number) => { body: unknown; status?: number },
): Promise<{ api: string; chat: string; received: Received[] }> {
  const received: Received[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const entry: Received = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: raw.length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>,
      }
      received.push(entry)
      const answer = handler(entry, received.length - 1)
      // Each fixture server closes with its test, so a pooled keep-alive socket
      // would be dead by the next call; closing the connection keeps the
      // client's pool from reusing it.
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify(answer.body))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(async () => {
    const closed = once(server, 'close')
    server.closeAllConnections()
    server.close()
    await closed
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing endpoint address')
  const root = `http://127.0.0.1:${String(address.port)}`
  return { api: root, chat: `${root}/anthropic`, received }
}

/** Resolved options against one local endpoint. */
function options(server: { api: string; chat: string }, overrides: Partial<MiniMaxVideoOptions> = {}): MiniMaxVideoOptions {
  return {
    apiBaseURL: server.api,
    chatBaseURL: server.chat,
    apiKey: 'test-key',
    videoModel: 'MiniMax-H3',
    resolution: '768P',
    durationSeconds: 6,
    ratio: '16:9',
    pollIntervalMs: 1,
    pollTimeoutMs: 5_000,
    maxDownloadBytes: 1024,
    maxTokens: 4096,
    understandingModel: 'MiniMax-M3.1-Flash',
    ...overrides,
  }
}

/** A task body in the state MiniMax reports. */
function task(status: string, extra: Record<string, unknown> = {}) {
  return { task: { id: 'task-1', status, ...extra } }
}

describe('MiniMax video client', () => {
  it('builds a creation request from deployment defaults and an optional first frame', () => {
    const base = generationRequest(options({ api: 'http://x', chat: 'http://x' }), { prompt: 'a cat' })
    expect(base).toEqual({
      model: 'MiniMax-H3',
      resolution: '768P',
      duration: 6,
      ratio: '16:9',
      content: [{ type: 'text', text: 'a cat' }],
    })

    const withFrame = generationRequest(options({ api: 'http://x', chat: 'http://x' }), {
      prompt: 'a cat',
      // 2K belongs to MiniMax-H3 alone; the Max model stops at 768P.
      model: 'MiniMax-H3',
      resolution: '2K',
      durationSeconds: 10,
      ratio: '9:16',
      firstFrameImageUrl: 'https://example.test/first.png',
    })
    expect(withFrame.content).toEqual([
      { type: 'text', text: 'a cat' },
      { type: 'image_url', image_url: { url: 'https://example.test/first.png' }, role: 'first_frame' },
    ])
    expect(withFrame).toMatchObject({ model: 'MiniMax-H3', resolution: '2K', duration: 10, ratio: '9:16' })
  })

  it('carries a last frame alongside the first one', () => {
    const request = generationRequest(options({ api: 'http://x', chat: 'http://x' }), {
      prompt: 'a cat',
      firstFrameImageUrl: 'https://example.test/first.png',
      lastFrameImageUrl: 'https://example.test/last.png',
    })

    expect(request.content).toEqual([
      { type: 'text', text: 'a cat' },
      { type: 'image_url', image_url: { url: 'https://example.test/first.png' }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: 'https://example.test/last.png' }, role: 'last_frame' },
    ])
  })

  it('carries reference media with the roles MiniMax expects', () => {
    const request = generationRequest(options({ api: 'http://x', chat: 'http://x' }), {
      prompt: 'a cat',
      referenceImageUrls: ['https://example.test/ref.png'],
      referenceVideoUrl: 'https://example.test/ref.mp4',
      referenceAudioUrl: 'https://example.test/ref.mp3',
    })

    expect(request.content).toEqual([
      { type: 'text', text: 'a cat' },
      { type: 'image_url', image_url: { url: 'https://example.test/ref.png' }, role: 'reference_image' },
      { type: 'video_url', video_url: { url: 'https://example.test/ref.mp4' }, role: 'reference_video' },
      { type: 'audio_url', audio_url: { url: 'https://example.test/ref.mp3' }, role: 'reference_audio' },
    ])
  })

  it('refuses a request that mixes frames with reference media', () => {
    expect(() => generationRequest(options({ api: 'http://x', chat: 'http://x' }), {
      prompt: 'a cat',
      firstFrameImageUrl: 'https://example.test/first.png',
      referenceImageUrls: ['https://example.test/ref.png'],
    })).toThrow(/either image-to-video or reference-based/u)
  })

  it('refuses a resolution the chosen model does not serve', () => {
    expect(() => generationRequest(options({ api: 'http://x', chat: 'http://x' }), {
      prompt: 'a cat',
      model: 'MiniMax-H3-Highspeed',
      resolution: '2K',
    })).toThrow(/does not produce 2K; it serves 480P, 768P/u)
  })

  it('refuses a clip length the chosen model does not serve', () => {
    expect(() => generationRequest(options({ api: 'http://x', chat: 'http://x' }), {
      prompt: 'a cat',
      model: 'MiniMax-H3-Max',
      durationSeconds: 4,
    })).toThrow(/does not produce a 4-second clip/u)
  })

  it('passes the prompt-expansion switch only for the model that accepts it', () => {
    const expanded = generationRequest(options({ api: 'http://x', chat: 'http://x' }), {
      prompt: 'a cat',
      model: 'MiniMax-H3-Max',
      promptExpansionMode: 'quality',
    })
    expect(expanded.extra).toEqual({ prompt_expansion_mode: 'quality' })

    const other = generationRequest(options({ api: 'http://x', chat: 'http://x' }), {
      prompt: 'a cat',
      model: 'MiniMax-H3',
      promptExpansionMode: 'quality',
    })
    expect(other.extra).toBeUndefined()
  })

  it('creates a task and reads its id', async () => {
    const server = await endpoint(() => ({ body: { task_id: 'task-9' } }))

    const taskId = await createVideoTask(options(server), generationRequest(options(server), { prompt: 'a cat' }))

    expect(taskId).toBe('task-9')
    expect(server.received[0]?.method).toBe('POST')
    expect(server.received[0]?.path).toBe('/v2/video_generation')
    expect(server.received[0]?.headers['authorization']).toBe('Bearer test-key')
    expect(server.received[0]?.body).toMatchObject({ model: 'MiniMax-H3', duration: 6 })
  })

  it('fails loudly when creation returns no task id', async () => {
    const server = await endpoint(() => ({ body: {} }))

    await expect(createVideoTask(options(server), generationRequest(options(server), { prompt: 'a cat' })))
      .rejects.toThrow(/no task_id/u)
  })

  it('polls a running task until it succeeds', async () => {
    const server = await endpoint((_received, index) => ({
      body: index === 0 ? task('queued') : index === 1 ? task('running') : task('succeeded', { content: { url: 'https://cdn.test/v.mp4' } }),
    }))

    const settled = await waitForVideoTask(options(server), 'task-1')

    expect(settled.status).toBe('succeeded')
    expect(settled.content?.url).toBe('https://cdn.test/v.mp4')
    expect(server.received.map(entry => entry.path)).toEqual([
      '/v2/query/video_generation/task-1',
      '/v2/query/video_generation/task-1',
      '/v2/query/video_generation/task-1',
    ])
    expect(server.received[0]?.method).toBe('GET')
  })

  it('reports a failed task instead of polling forever', async () => {
    const server = await endpoint(() => ({ body: task('failed', { error: { code: 1026, message: 'sensitive content' } }) }))

    const settled = await waitForVideoTask(options(server), 'task-1')

    expect(settled.status).toBe('failed')
    expect(settled.error?.message).toBe('sensitive content')
  })

  it('gives up at the deadline with an actionable message', async () => {
    const server = await endpoint(() => ({ body: task('running') }))

    await expect(waitForVideoTask(options(server, { pollTimeoutMs: 20 }), 'task-1'))
      .rejects.toThrow(/still running after/u)
  })

  it('lists the tasks of the last week with its filters', async () => {
    const server = await endpoint(() => ({
      body: { total: 2, items: [{ id: 'task-1', status: 'succeeded', model: 'MiniMax-H3' }] },
    }))

    const listed = await listVideoTasks(options(server), {
      status: 'succeeded', model: 'MiniMax-H3', taskIds: ['task-1'], pageNum: 2, pageSize: 20,
    })

    expect(listed.total).toBe(2)
    expect(listed.tasks[0]?.id).toBe('task-1')
    const path = server.received[0]?.path ?? ''
    expect(path).toContain('/v2/query/video_generation?')
    expect(path).toContain('page_num=2')
    expect(path).toContain('page_size=20')
    expect(path).toContain('filter.status=succeeded')
    expect(path).toContain('filter.model=MiniMax-H3')
    expect(path).toContain('filter.task_ids=task-1')
  })

  it('cancels a task and reports what MiniMax did with it', async () => {
    const server = await endpoint(() => ({ body: { task_id: 'task-1', action: 'cancelled', status: 'cancelled' } }))

    const outcome = await cancelVideoTask(options(server), 'task-1')

    expect(outcome).toEqual({ action: 'cancelled', status: 'cancelled' })
    expect(server.received[0]?.method).toBe('DELETE')
    expect(server.received[0]?.path).toBe('/v2/video_generation/task-1')
  })

  it('streams the finished video and enforces the byte limit', async () => {
    const payload = new Uint8Array(64).fill(7)
    const binary = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(payload.byteLength) })
      response.end(payload)
    })
    binary.listen(0, '127.0.0.1')
    await once(binary, 'listening')
    onTestFinished(async () => {
      const closed = once(binary, 'close')
      binary.closeAllConnections()
      binary.close()
      await closed
    })
    const address = binary.address()
    if (address === null || typeof address === 'string') throw new Error('missing download address')
    const downloadUrl = `http://127.0.0.1:${String(address.port)}/v.mp4`

    const chunks: Uint8Array[] = []
    for await (const chunk of downloadVideo(downloadUrl, 1024)) chunks.push(chunk)
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).byteLength).toBe(64)

    await expect(async () => {
      for await (const _chunk of downloadVideo(downloadUrl, 4)) { /* consume */ }
    }).rejects.toThrow(/download limit/u)
  })

  it('asks the model about a video without disabling thinking', async () => {
    const server = await endpoint(() => ({
      body: {
        content: [
          { type: 'thinking', thinking: 'looks like a cat', signature: 'sig' },
          { type: 'text', text: 'A cat walks on a diving board.' },
          { type: 'text', text: 'Then it jumps.' },
        ],
        stop_reason: 'end_turn',
      },
    }))

    const answer = await understandVideo(options(server), {
      videoUrl: 'https://cdn.test/v.mp4',
      prompt: 'What happens?',
      fps: 2,
    })

    expect(answer).toBe('A cat walks on a diving board.\nThen it jumps.')
    const request = server.received[0]
    expect(request?.path).toBe('/anthropic/v1/messages')
    expect(request?.body).toMatchObject({
      model: 'MiniMax-M3.1-Flash',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      max_tokens: 4096,
    })
    expect(request?.body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'What happens?' },
        { type: 'video', source: { type: 'url', url: 'https://cdn.test/v.mp4', fps: 2 } },
      ],
    }])
  })

  it('fails when the understanding turn returns no text', async () => {
    const server = await endpoint(() => ({ body: { content: [{ type: 'thinking', thinking: 'hmm' }], stop_reason: 'max_tokens' } }))

    await expect(understandVideo(options(server), { videoUrl: 'https://cdn.test/v.mp4', prompt: 'What happens?' }))
      .rejects.toThrow(/no text for the video \(stop_reason max_tokens\)/u)
  })

  it('names the endpoint when the provider answers an error status', async () => {
    const server = await endpoint(() => ({ body: { error: { message: 'nope' } }, status: 500 }))

    await expect(createVideoTask(options(server), generationRequest(options(server), { prompt: 'a cat' })))
      .rejects.toThrow(/HTTP 500/u)
  })
})
