import { describe, expect, it } from 'vitest'
import { WorkBuddyCloudBackend } from '../bridge/workbuddy-cloud.mjs'

/**
 * WorkBuddy 云端直连后端。
 *
 * 云端对请求有三条硬要求（实测，见 bridge/workbuddy-cloud.mjs 顶部说明）：
 * 必须 `stream: true`、messages 第一条必须是 system、必须带官方客户端的渠道头。
 * 这里把这三条以及错误映射钉住 —— 它们都不是「能跑就行」的细节，错了会变成
 * 云端那句毫无线索的「request illegal」。
 */

const backend = () => new WorkBuddyCloudBackend({})

describe('WorkBuddyCloudBackend.normalizeMessages', () => {
  it('puts a system message first when the caller sent none', () => {
    const msgs = WorkBuddyCloudBackend.normalizeMessages({
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(msgs[0]?.role).toBe('system')
    expect(msgs[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('keeps an existing leading system message untouched', () => {
    const msgs = WorkBuddyCloudBackend.normalizeMessages({
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
    })
    expect(msgs[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(msgs).toHaveLength(2)
  })

  it('builds the pair from systemPrompt + prompt when no messages are given', () => {
    const msgs = WorkBuddyCloudBackend.normalizeMessages({ systemPrompt: 'sys', prompt: 'user' })
    expect(msgs).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ])
  })

  it('returns nothing for an empty request', () => {
    expect(WorkBuddyCloudBackend.normalizeMessages({})).toEqual([])
  })
})

describe('WorkBuddyCloudBackend.buildHeaders', () => {
  it('carries every official-client channel header', () => {
    const headers = backend().buildHeaders({ token: 'T', uid: 'U', model: 'deepseek-v4.1-flash' })
    // 渠道校验就是靠这些头过的，少一个就回 code 11128。
    expect(headers['X-Agent-Type']).toBe('main')
    expect(headers['X-User-Id']).toBe('U')
    expect(headers['X-Product']).toBe('WorkBuddy')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-Product-Version']).toBe('5.8.4')
    expect(headers['X-Model-ID']).toBe('deepseek-v4.1-flash')
    expect(headers.authorization).toBe('Bearer T')
  })

  it('gives the request-scoped ids the same UUIDv7 shape the cloud expects', () => {
    const headers = backend().buildHeaders({ token: 'T', uid: 'U', model: 'm' })
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    expect(headers['X-Request-ID']).toMatch(uuid)
    expect(headers['X-Trace-ID']).toMatch(uuid)
    expect(headers['X-Conversation-ID']).toMatch(uuid)
    expect(headers['X-Conversation-Request-ID']).toMatch(uuid)
    // 同一请求的这几个 id 必须是同一个值，否则云端拼不上链路。
    expect(headers['X-Request-ID']).toBe(headers['X-Trace-ID'])
    expect(headers['X-Request-ID']).toBe(headers['X-Root-Request-ID'])
  })
})

describe('WorkBuddyCloudBackend.mapError', () => {
  it('names the channel check when the cloud rejects the request shape', () => {
    const err = backend().mapError(400, JSON.stringify({ code: 11128, msg: 'request illegal' }))
    expect(err.message).toContain('渠道校验')
    expect(err.code).toBe('upstream_rejected')
    expect(err.retriable).toBe(false)
  })

  it('reports a non-stream request as a caller-side mistake', () => {
    const err = backend().mapError(400, JSON.stringify({ code: 11101, msg: 'Non-stream chat request is currently not supported' }))
    expect(err.message).toContain('非流式')
  })

  it('marks auth failures as non-retryable and rate limits as retryable', () => {
    expect(backend().mapError(401, '{}').code).toBe('upstream_auth')
    expect(backend().mapError(429, '{}').retriable).toBe(true)
    expect(backend().mapError(500, '{}').retriable).toBe(true)
  })
})

describe('WorkBuddyCloudBackend.consumeSse', () => {
  it('reads content deltas and skips the heartbeat comment', async () => {
    const body = [
      ': heartbeat',
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const res = new Response(new Blob([body]).stream())
    const chunks: string[] = []
    const usage: unknown[] = []
    await backend().consumeSse(res, (c) => {
      if (c.content) chunks.push(c.content)
      if (c.usage) usage.push(c.usage)
    })
    expect(chunks.join('')).toBe('你好')
    expect(usage).toHaveLength(0)
  })

  it('keeps reasoning content separate from the answer', async () => {
    const body = 'data: {"choices":[{"delta":{"reasoning_content":"想…","content":""}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"答"}}]}\n\n'
    const res = new Response(new Blob([body]).stream())
    let content = ''
    let reasoning = ''
    await backend().consumeSse(res, (c) => {
      content += c.content
      reasoning += c.reasoning
    })
    expect(content).toBe('答')
    expect(reasoning).toBe('想…')
  })
})
