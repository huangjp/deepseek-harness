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

describe('WorkBuddyCloudBackend.postWithRetry', () => {
  it('retries a network-layer failure and returns the eventual response', async () => {
    const b = backend()
    let calls = 0
    b.post = async () => {
      calls += 1
      if (calls < 3) throw Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
      return new Response('ok')
    }
    const res = await b.postWithRetry({}, {})
    expect(res.status).toBe(200)
    expect(calls).toBe(3)
  })

  it('gives up after the attempts and reports the network cause', async () => {
    const b = backend()
    b.post = async () => {
      throw Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
    }
    // 报错里必须能看到真正的网络原因，而不是一句没有信息量的「上游调用失败」。
    await expect(b.postWithRetry({}, {}, undefined, 2)).rejects.toMatchObject({
      code: 'upstream_network',
      httpStatus: 502,
      retriable: true,
    })
    await expect(b.postWithRetry({}, {}, undefined, 2)).rejects.toThrow(/ECONNRESET/)
  })

  it('does not retry an aborted request', async () => {
    const b = backend()
    let calls = 0
    b.post = async () => {
      calls += 1
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    await expect(b.postWithRetry({}, {})).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(1)
  })
})

describe('WorkBuddyCloudBackend.mapNetworkError', () => {
  it('pulls the error code out of an AggregateError cause', () => {
    const cause = Object.assign(new AggregateError([]), {
      errors: [Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
    })
    const err = backend().mapNetworkError(Object.assign(new Error('fetch failed'), { cause }))
    expect(err.message).toContain('ETIMEDOUT')
    expect(err.code).toBe('upstream_network')
  })

  it('still produces a readable error when there is no cause at all', () => {
    const err = backend().mapNetworkError(new Error('fetch failed'))
    expect(err.message).toContain('fetch failed')
    expect(err.httpStatus).toBe(502)
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

describe('WorkBuddyCloudBackend.complete with native tools', () => {
  /** 装一个假的云端：只回放给定的 SSE 帧，并记录发出去的请求体。 */
  function fakeCloud(sse: string) {
    const b = new WorkBuddyCloudBackend({})
    b.ensureToken = async () => ({ ok: true, token: 'T', uid: 'U', expiresAt: 0 })
    const sent: Record<string, unknown>[] = []
    b.post = async (body: unknown) => {
      sent.push(body as Record<string, unknown>)
      return new Response(new Blob([sse]).stream())
    }
    return { b, sent }
  }

  it('sends the tools through and returns the native tool_calls', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":""},"index":0}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"","arguments":"{\\"path\\":"},"index":0}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"","arguments":"\\"a\\"}"},"index":0}]}}]}',
      'data: [DONE]',
    ].join('\n\n')
    const { b, sent } = fakeCloud(sse)
    const tools = [{ type: 'function', function: { name: 'read', description: 'd', parameters: {} } }]
    const out = await b.complete({
      messages: [{ role: 'user', content: 'x' }],
      tools,
      model: 'm',
    })
    // 请求体必须带 tools —— 云端靠它走原生 function calling。
    expect(sent[0]?.tools).toEqual(tools)
    expect(out.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
    ])
  })

  it('omits tools when the caller passes none, so the text protocol stays in charge', async () => {
    const { b, sent } = fakeCloud('data: [DONE]\n\n')
    const out = await b.complete({ messages: [{ role: 'user', content: 'x' }], model: 'm' })
    expect(sent[0]?.tools).toBeUndefined()
    expect(out.toolCalls).toBeNull()
  })
})
