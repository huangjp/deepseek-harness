import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, isInputRejected, normalizeReasoningEffort, isChannelRejection, PINNED_CLIENT_VERSION, repairToolPairing, trimMessages, WorkBuddyCloudBackend } from '../bridge/workbuddy-cloud.mjs'

/**
 * WorkBuddy 云端直连后端。
 *
 * 云端对请求有硬要求（实测，见 bridge/workbuddy-cloud.mjs 顶部说明）：
 * 必须 `stream: true`、messages 第一条必须是 system、必须带官方客户端的渠道头、
 * 工具调用与结果必须成对。这里把它们以及错误映射钉住 —— 它们都不是「能跑就行」
 * 的细节，错了会变成云端那句毫无线索的「request illegal」或「输入被拒」。
 */

/**
 * 一段消息序列在上游看来是否合法：每个 tool 结果都要有发起它的 assistant 消息，
 * 每个带 id 的调用都要有结果。
 * @param messages 待检查的消息序列。
 * @returns 成对时为 true。
 */
function pairingValid(messages: Array<{ role?: string; tool_calls?: Array<{ id?: string }>; tool_call_id?: string }>): boolean {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.tool_call_id === undefined || !calls.has(message.tool_call_id)) return false
      results.add(message.tool_call_id)
      continue
    }
    for (const call of message.tool_calls ?? []) {
      if (call.id === undefined) return false
      calls.add(call.id)
    }
  }
  for (const id of calls) if (!results.has(id)) return false
  return true
}

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

describe('repairToolPairing', () => {
  const call = (id: string) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }] })

  it('leaves a well-formed round trip alone', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      call('c1'),
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ]
    const repaired = repairToolPairing(messages)
    expect(repaired.messages).toEqual(messages)
    expect(repaired).toMatchObject({ dropped: 0, synthesized: 0 })
  })

  it('drops a tool result whose call was cut away, because the provider rejects the whole request', () => {
    // 裁短对话最容易切出来的形状：只剩工具结果，没有发起它的 assistant 消息。
    const repaired = repairToolPairing([
      { role: 'system', content: 'sys' },
      { role: 'tool', tool_call_id: 'gone', content: 'orphan' },
      { role: 'user', content: 'hi' },
    ])
    expect(repaired.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
    expect(repaired.dropped).toBe(1)
  })

  it('answers a call that never returned, so the rest of the conversation stays usable', () => {
    const repaired = repairToolPairing([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      call('c1'),
      { role: 'user', content: 'never mind' },
    ])
    expect(pairingValid(repaired.messages as never)).toBe(true)
    expect(repaired.synthesized).toBe(1)
    // 补的是说明，不是编造的工具输出。
    expect(repaired.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
    expect(String(repaired.messages[3]?.content)).toContain('No result was recorded')
  })

  it('keeps only the answered calls of a parallel call group', () => {
    const repaired = repairToolPairing([
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: 'ok' },
    ])
    expect(pairingValid(repaired.messages as never)).toBe(true)
    expect(repaired.synthesized).toBe(1)
  })

  it('drops a call without an id and a duplicated result', () => {
    const repaired = repairToolPairing([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read', arguments: '{}' } }] },
      call('c1'),
      { role: 'tool', tool_call_id: 'c1', content: 'first' },
      { role: 'tool', tool_call_id: 'c1', content: 'again' },
    ])
    // 没有 id 的调用配不上结果，留着只会让整条请求被拒。
    expect(repaired.messages[0]).toEqual({ role: 'assistant', content: '' })
    expect(repaired.dropped).toBe(1)
    expect(repaired.messages.filter(message => message.role === 'tool')).toHaveLength(1)
  })

  it('returns the input untouched when it is not a list', () => {
    const repaired = repairToolPairing(undefined as never)
    expect(repaired).toEqual({ messages: undefined, dropped: 0, synthesized: 0 })
  })

  it('writes structured arguments back as a JSON string, which is all the cloud parses', () => {
    const repaired = repairToolPairing([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: { path: 'a' } } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ])
    expect(repaired.messages[0]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
    })
  })
})

describe('trimMessages', () => {
  it('cuts to the requested tail when that keeps the request coherent', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]
    expect(trimMessages(messages, 2)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ])
  })

  it('keeps a tool result together with the message that asked for it', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'user', content: 'u2' },
    ]
    const trimmed = trimMessages(messages, 2)
    // 起点原本落在工具结果上：往回退一条，工具调用整组留下。
    expect(trimmed.map(message => message.role)).toEqual(['system', 'assistant', 'tool', 'user'])
    expect(pairingValid(trimmed as never)).toBe(true)
  })

  it('returns the input untouched when it is short enough', () => {
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }]
    expect(trimMessages(messages, 8)).toBe(messages)
  })
})

describe('WorkBuddyCloudBackend.buildHeaders', () => {
  it('carries every official-client channel header', () => {
    const headers = backend().buildHeaders({ token: 'T', uid: 'U', model: 'deepseek-v4.1-flash' })
    // 渠道校验就是靠这些头过的，少一个就回 code 11128。
    expect(headers['X-Agent-Intent']).toBe('craft')
    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-Private-Data']).toBe('true')
    expect(headers['X-Product']).toBe('SaaS')
    expect(headers['x-requested-with']).toBe('XMLHttpRequest')
    expect(headers['x-codebuddy-request']).toBe('1')
    expect(headers['X-User-Id']).toBe('U')
    expect(headers.authorization).toBe('Bearer T')
    // 客户端从不发这三个头（它们来自一份更老的常量表）。
    expect(headers['X-Agent-Type']).toBeUndefined()
    expect(headers['X-Product-Version']).toBeUndefined()
    expect(headers['X-Root-Request-ID']).toBeUndefined()
  })

  it('carries the link-trace headers the client sends', () => {
    const headers = backend().buildHeaders({ token: 'T', uid: 'U', model: 'm' })
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(headers['b3']).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/)
    expect(headers['X-B3-TraceId']).toMatch(/^[0-9a-f]{32}$/)
    expect(headers['X-B3-SpanId']).toMatch(/^[0-9a-f]{16}$/)
    expect(headers['X-B3-Sampled']).toBe('1')
    expect(headers['X-Trace-ID']).toMatch(/^[0-9a-f]{32}$/)
  })

  it('gives the request-scoped ids the same UUIDv7 shape the cloud expects', () => {
    const headers = backend().buildHeaders({ token: 'T', uid: 'U', model: 'm' })
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    expect(headers['X-Request-ID']).toMatch(uuid)
    expect(headers['X-Conversation-ID']).toMatch(uuid)
    expect(headers['X-Conversation-Request-ID']).toMatch(uuid)
    expect(headers['X-Conversation-Message-ID']).toMatch(uuid)
    expect(headers['acp-connection-id']).toMatch(uuid)
  })

  it('takes the client version and deployment type from the account product config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-identity-'))
    try {
      writeFileSync(join(dir, 'acc-product-config-v3.json'), JSON.stringify({
        deploymentType: 'SaaS', genieVersion: '5.9.3', endpoint: 'https://www.workbuddy.ai', enterpriseId: '',
        models: [],
      }), 'utf8')
      const b = new WorkBuddyCloudBackend({ catalogDir: dir })
      const headers = b.buildHeaders({ token: 'T', uid: 'U', model: 'm' })
      // 客户端版本与部署形态跟官方客户端同源：产品配置里的那一份。
      expect(headers['X-IDE-Version']).toBe('5.9.3')
      expect(headers['X-Product']).toBe('SaaS')
      expect(headers['user-agent']).toBe('WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.161.0')
      // 个人账号没有企业 id，也就不发那两个头。
      expect(headers['X-Enterprise-Id']).toBeUndefined()
      expect(headers['X-Tenant-Id']).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sends the enterprise headers when the account has one', () => {
    const headers = new WorkBuddyCloudBackend({ enterpriseId: 'ent-1' }).buildHeaders({ token: 'T', uid: 'U', model: 'm' })
    expect(headers['X-Enterprise-Id']).toBe('ent-1')
    expect(headers['X-Tenant-Id']).toBe('ent-1')
  })
})

describe('WorkBuddyCloudBackend.mapError', () => {
  it('names the channel check when the cloud rejects the request shape', () => {
    const err = backend().mapError(400, JSON.stringify({ code: 11128, msg: 'request illegal' }))
    // 这个码实测是账号侧的频率/额度上限，不是反代少发了参数 —— 提示要写清楚，
    // 否则每次都会被人当成「渠道头没传对」去查。
    expect(err.message).toContain('频率/额度上限')
    expect(err.code).toBe('upstream_rejected')
    // 这类拒绝可能只是一次性状态（实测同 token 十几分钟后就通过），所以标成可重试。
    expect(err.retriable).toBe(true)
  })

  it('reports a non-stream request as a caller-side mistake', () => {
    const err = backend().mapError(400, JSON.stringify({ code: 11101, msg: 'Non-stream chat request is currently not supported' }))
    expect(err.message).toContain('非流式')
  })

  it('names the rejected parameter when the cloud points at one', () => {
    // 推理强度写错时云端会点名 reasoning.effort；不点名就只剩一句「参数不合法」。
    const err = backend().mapError(400, JSON.stringify({
      code: 11133,
      msg: 'Invalid request parameters',
      extError: { param: 'reasoning.effort' },
    }))
    expect(err.message).toContain('reasoning.effort')
    expect(err.message).toContain('low/medium/high/xhigh/max')
    expect(err.retriable).toBe(false)
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

describe('WorkBuddyCloudBackend 推理强度', () => {
  /** 装一个假的云端：只记录发出去的请求体。 */
  function fakeCloud() {
    const b = new WorkBuddyCloudBackend({})
    b.ensureToken = async () => ({ ok: true, token: 'T', uid: 'U', expiresAt: 0 })
    const sent: Record<string, unknown>[] = []
    b.post = async (body: unknown) => {
      sent.push(body as Record<string, unknown>)
      return new Response(new Blob(['data: [DONE]\n\n']).stream())
    }
    return { b, sent }
  }

  it('把推理强度原样写进请求体的 reasoning_effort', async () => {
    const { b, sent } = fakeCloud()
    await b.complete({ messages: [{ role: 'user', content: 'x' }], model: 'gpt-6-astra', reasoningEffort: 'xhigh' })
    // 云端认的就是这个字段（实测写 xhigh 返回 200，写错的值返回 400）。
    expect(sent[0]?.reasoning_effort).toBe('xhigh')
  })

  it('没给强度时不写这个字段，让云端按模型自己的默认档位走', async () => {
    const { b, sent } = fakeCloud()
    await b.complete({ messages: [{ role: 'user', content: 'x' }], model: 'gpt-6-astra' })
    expect(sent[0]?.reasoning_effort).toBeUndefined()
  })

  it('off 翻成云端认的 none', async () => {
    // 云端拒收字面量 "off"（400，参数名 reasoning.effort）；"none" 才是「不思考」。
    expect(normalizeReasoningEffort('off')).toBe('none')
    expect(normalizeReasoningEffort('high')).toBe('high')
    expect(normalizeReasoningEffort(undefined)).toBeUndefined()
    expect(normalizeReasoningEffort('')).toBeUndefined()
  })

  it('输出上限取账号目录里这个模型的额度，给高档位思维留出写答案的地方', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-output-'))
    try {
      writeFileSync(join(dir, 'acc-product-config-v3.json'), JSON.stringify({
        models: [{ id: 'gpt-6-astra', name: 'GPT-6-Astra', maxOutputTokens: 128000, maxInputTokens: 1000000 }],
      }), 'utf8')
      const b = new WorkBuddyCloudBackend({ catalogDir: dir })
      expect(b.outputTokensFor('gpt-6-astra')).toBe(128000)
      // 目录里没有的模型退回默认值，而不是 0。
      expect(b.outputTokensFor('unknown-model')).toBe(32000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('提示词占满窗口时把输出预算收小，不让预留的输出把请求顶出窗口', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-budget-'))
    try {
      writeFileSync(join(dir, 'acc-product-config-v3.json'), JSON.stringify({
        models: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna', maxOutputTokens: 128000, maxInputTokens: 1000000 }],
      }), 'utf8')
      const b = new WorkBuddyCloudBackend({ catalogDir: dir })
      // 提示词短的时候按模型自己的额度预留。
      expect(b.outputTokensFor('gpt-6-luna', 1000)).toBe(128000)
      // 提示词占了 90 万 token 时，只给剩下的位置留输出预算。
      const room = b.outputTokensFor('gpt-6-luna', 3_000_000)
      expect(room).toBeLessThan(128000)
      expect(room).toBeGreaterThan(0)
      // 提示词已经装不下时给最小预算，让云端去报「输入被拒」。
      expect(b.outputTokensFor('gpt-6-luna', 30_000_000)).toBe(1024)
      // 粗估按每 3 个字符一个 token。
      expect(estimateTokens(3000)).toBe(1000)
      expect(estimateTokens(0)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('认得出「输入被拒」并把对话裁短后重试', async () => {
    expect(isInputRejected(JSON.stringify({
      code: 11133, msg: 'Invalid request parameters',
      extError: { code: '400002', param: 'input' },
    }))).toBe(true)
    expect(isInputRejected(JSON.stringify({ code: 11133, extError: { code: 'other', param: 'reasoning.effort' } }))).toBe(false)
    const b = new WorkBuddyCloudBackend({})
    b.ensureToken = async () => ({ ok: true, token: 'T', uid: 'U', expiresAt: 0 })
    const sent: Array<{ messages: unknown[] }> = []
    b.post = async (body: unknown) => {
      const typed = body as { messages: unknown[] }
      sent.push(typed)
      if (typed.messages.length > 5) {
        return new Response(JSON.stringify({
          code: 11133, msg: 'Invalid request parameters',
          extError: { code: '400002', param: 'input' },
        }), { status: 400 })
      }
      return new Response(new Blob(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n']).stream())
    }
    const messages = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 12 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: `m${index}` })),
    ]
    const out = await b.complete({ messages, model: 'gpt-6-luna' })
    expect(out.text).toBe('OK')
    // 裁短之后的消息明显更少，agent 才能继续往前走。
    expect(sent[sent.length - 1]?.messages.length).toBeLessThan(messages.length)
  }, 15_000)
})

describe('WorkBuddyCloudBackend 工具配对', () => {
  /**
   * 装一个只记录请求体的后端。
   * @param respond 每次请求的答复。
   * @returns 后端与它收到的请求体。
   */
  function recording(respond: () => Response) {
    const b = new WorkBuddyCloudBackend({})
    b.ensureToken = async () => ({ ok: true, token: 'T', uid: 'U', expiresAt: 0 })
    const sent: Array<{ messages: Array<{ role?: string }> }> = []
    b.post = async (body: unknown) => {
      sent.push(body as { messages: Array<{ role?: string }> })
      return respond()
    }
    return { b, sent }
  }

  const ok = () => new Response(new Blob(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n']).stream())
  const inputRejected = () => new Response(JSON.stringify({
    code: 11133, msg: 'Invalid request parameters',
    extError: { code: '400002', param: 'input' },
  }), { status: 400 })

  it('把「只有调用、没有结果」的历史补成对再发出去', async () => {
    // 用户中断过一轮工具调用之后，历史里就只剩调用没有结果；原样发出去必然被拒。
    const { b, sent } = recording(ok)
    const out = await b.complete({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
      ],
      model: 'gpt-6-luna',
    })
    expect(out.text).toBe('OK')
    expect(sent[0]?.messages).toHaveLength(4)
    expect(pairingValid(sent[0]?.messages as never)).toBe(true)
  })

  it('对象形态的 tool_choice 不写进请求体 —— 云端只收字符串', async () => {
    // 云端 `tool_choice` 是 string 字段；写对象会回 11101 "cannot unmarshal object"。
    const b = new WorkBuddyCloudBackend({})
    b.ensureToken = async () => ({ ok: true, token: 'T', uid: 'U', expiresAt: 0 })
    const sent: Array<Record<string, unknown>> = []
    b.post = async (body: unknown) => {
      sent.push(body as Record<string, unknown>)
      return new Response(new Blob(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n']).stream())
    }
    await b.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'd', parameters: {} } }],
      toolChoice: { type: 'function', function: { name: 'read' } },
      model: 'gpt-6-luna',
    })
    expect(sent[0]?.tool_choice).toBeUndefined()
  })

  it('裁短后按新的大小重新预留输出预算', async () => {
    // 超长对话裁到几条消息之后仍然只给最小预算，模型想完就没地方写答案 ——
    // 所以裁短后的重试必须按裁短后的大小重新算 max_tokens。
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-trim-budget-'))
    try {
      writeFileSync(join(dir, 'acc-product-config-v3.json'), JSON.stringify({
        models: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna', maxOutputTokens: 128000, maxInputTokens: 200000 }],
      }), 'utf8')
      const b = new WorkBuddyCloudBackend({ catalogDir: dir })
      b.ensureToken = async () => ({ ok: true, token: 'T', uid: 'U', expiresAt: 0 })
      const sent: Array<{ messages: unknown[]; max_tokens?: number }> = []
      b.post = async (body: unknown) => {
        const typed = body as { messages: Array<{ role?: string }>; max_tokens?: number }
        sent.push(typed)
        return typed.messages.length > 4 ? inputRejected() : ok()
      }
      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'x'.repeat(900_000) },
        { role: 'user', content: 'small' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
        { role: 'user', content: 'd' },
        { role: 'assistant', content: 'e' },
        { role: 'user', content: 'last' },
      ]
      const out = await b.complete({ messages, model: 'gpt-6-luna' })
      expect(out.text).toBe('OK')
      // 90 万字符 ≈ 30 万 token，已经超过 20 万窗口：首试只给最小预算。
      expect(sent[0]?.max_tokens).toBe(1024)
      expect(sent[sent.length - 1]?.max_tokens).toBeGreaterThan(1024)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('裁短重试时不会把工具调用和它的结果切开', async () => {
    // 输入被拒时的裁短重试最容易切出「只有结果、没有调用」的切片；
    // 那种切片云端回的仍是同一个 400002，重试永远救不回来。
    const { b, sent } = recording(inputRejected)
    const messages: Array<Record<string, unknown>> = [{ role: 'system', content: 'sys' }]
    for (let round = 0; round < 8; round += 1) {
      const id = `c${round}`
      messages.push({ role: 'user', content: `round ${round}` })
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }],
      })
      messages.push({ role: 'tool', tool_call_id: id, content: `result ${round}` })
    }
    messages.push({ role: 'user', content: 'last' })
    await expect(b.complete({ messages, model: 'gpt-6-luna' }))
      .rejects.toMatchObject({ code: 'upstream_input_rejected' })
    // 首试、原样重试、两次裁短重试 —— 每一次发出去的消息都必须成对。
    expect(sent.length).toBe(4)
    for (const attempt of sent) expect(pairingValid(attempt.messages as never)).toBe(true)
    // 裁短确实减小了请求。
    expect(sent[sent.length - 1]?.messages.length).toBeLessThan(messages.length)
  }, 15_000)
})

describe('WorkBuddyCloudBackend 渠道校验', () => {
  it('认得出 400 + code 11128 的渠道拒绝', () => {
    const envelope = JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' })
    expect(isChannelRejection(envelope)).toBe(true)
    // 其它 400 不是渠道问题，不能被当成可重试。
    expect(isChannelRejection(JSON.stringify({ code: 11101, msg: 'Non-stream' }))).toBe(false)
    expect(isChannelRejection('')).toBe(false)
    // 截断的响应体（读完之前连接就断了）同样能认出来。
    expect(isChannelRejection('{"code":11128,"msg":"Illegal API invocation')).toBe(true)
  })

  it('渠道拒绝时重新收割令牌并重试一次，第二次成功就照常返回', async () => {
    const b = new WorkBuddyCloudBackend({})
    let harvests = 0
    b.ensureToken = async (force) => {
      if (force === true) harvests += 1
      return { ok: true, token: force === true ? 'fresh' : 'stale', uid: 'U', expiresAt: 0 }
    }
    const sent: Record<string, unknown>[] = []
    let calls = 0
    b.post = async (body: unknown) => {
      calls += 1
      sent.push(body as Record<string, unknown>)
      if (calls === 1) {
        return new Response(JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }), { status: 400 })
      }
      return new Response(new Blob(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n']).stream())
    }
    const out = await b.complete({ messages: [{ role: 'user', content: 'x' }], model: 'gpt-6-luna' })
    expect(out.text).toBe('OK')
    expect(calls).toBe(2)
    // 重试前必须重新收割令牌：一次性拒绝常常是令牌/客户端状态的问题。
    expect(harvests).toBe(1)
  }, 15_000)

  it('重试仍被拒时报告渠道版本与模型，并把这次失败标成可重试', async () => {
    const b = new WorkBuddyCloudBackend({ clientVersion: '5.9.3' })
    b.ensureToken = async () => ({ ok: true, token: 'T', uid: 'U', expiresAt: 0 })
    b.post = async () => new Response(
      JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel', requestId: '01a1d9cf' }),
      { status: 400 },
    )
    const err = await b.complete({ messages: [{ role: 'user', content: 'x' }], model: 'gpt-6-luna' })
      .then(() => undefined, (error: unknown) => error as Error & { retriable?: boolean; code?: string })
    expect(err?.message).toContain('5.9.3')
    expect(err?.message).toContain('gpt-6-luna')
    // 云端的 requestId 是他们工单要的那个号。
    expect(err?.message).toContain('01a1d9cf')
    expect(err?.retriable).toBe(true)
  }, 15_000)

  it('渠道拒绝时原样重试，不裁对话 —— 那个码与请求内容无关，裁了只会丢上下文', async () => {
    const b = new WorkBuddyCloudBackend({})
    b.ensureToken = async () => ({ ok: true, token: 'T', uid: 'U', expiresAt: 0 })
    const sent: Array<{ messages: unknown[] }> = []
    b.post = async (body: unknown) => {
      const typed = body as { messages: unknown[] }
      sent.push(typed)
      return new Response(JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }), { status: 400 })
    }
    const messages = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 12 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: `m${index}` })),
    ]
    await expect(b.complete({ messages, model: 'gpt-6-luna' })).rejects.toMatchObject({ code: 'upstream_rejected' })
    // 重试发了两次，两次都是完整对话：模型不能因为账号限流而丢掉前面做的事。
    expect(sent).toHaveLength(2)
    for (const attempt of sent) expect(attempt.messages).toHaveLength(messages.length)
  }, 15_000)

  it('渠道头里的客户端版本跟着解析到的版本走，而不是写死的 5.8.4', () => {
    const headers = new WorkBuddyCloudBackend({ clientVersion: '5.9.3' }).buildHeaders({ token: 'T', uid: 'U', model: 'm' })
    expect(headers['X-IDE-Version']).toBe('5.9.3')
    expect(headers['user-agent']).toContain('WorkBuddy/5.9.3')
    // 产品配置读不到时退回兜底版本，请求照发。
    const fallback = new WorkBuddyCloudBackend({ catalogDir: join(tmpdir(), 'dsh-wb-no-config') })
      .buildHeaders({ token: 'T', uid: 'U', model: 'm' })
    expect(fallback['X-IDE-Version']).toBe(PINNED_CLIENT_VERSION)
  })
})
