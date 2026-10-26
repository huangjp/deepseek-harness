/**
 * 文本通道上的工具协议：清单渲染、工具轮次回放、输出判定、JSON 修复重试、流式闸门。
 *
 * 这些函数是两条内置通道（WorkBuddy 网关、Copilot chatHub）共用的唯一实现 ——
 * 它们都没有原生 function calling，工具调用只能靠文本往返。所以这里的每个分支都是
 * 线上行为：判定错了会把工具调用当正文下发，下游 agent 会以为任务已经完成。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildToolInstruction, completeWithToolCalls, createToolCallGate, EXTERNAL_TOOLING_NOTICE,
  resolveToolOutcome, toolCallFailureText, toolCallTurnText, toolResultTurnText, toolTurnText,
  TOOL_CALL_REPAIR_REMINDER,
} from '../bridge/toolprompt.mjs'

/** 一条 OpenAI 风格的工具定义。 */
function tool(name: string, description = '', parameters?: unknown) {
  return {
    type: 'function',
    function: { name, description, ...parameters === undefined ? {} : { parameters } },
  }
}

describe('buildToolInstruction', () => {
  it('没有工具时不给任何指令', () => {
    expect(buildToolInstruction(undefined)).toBe('')
    expect(buildToolInstruction([])).toBe('')
  })

  it('全是没名字的条目时也不给指令', () => {
    expect(buildToolInstruction([{ type: 'function', function: {} }])).toBe('')
  })

  it('渲染清单，并给缺失的描述与参数补默认值', () => {
    const text = buildToolInstruction([tool('read', '读取文件', { type: 'object' })])
    expect(text).toContain('"name": "read"')
    expect(text).toContain('"description": "读取文件"')
    expect(text).toContain('"type": "object"')
    // 键名约定是关键：用 tool_calls 会与上游 agent 的 JSON 解析器撞车。
    expect(text).toContain('bridge_tool_calls')
    expect(text).toContain('不要用 tool_calls')
  })

  it('缺 description 与 parameters 时给出空描述与空对象 schema', () => {
    const text = buildToolInstruction([tool('noop')])
    expect(text).toContain('"description": ""')
    expect(text).toContain('"properties": {}')
  })

  it('tool_choice 为 required 时要求必须表达一次调用', () => {
    expect(buildToolInstruction([tool('read')], 'required')).toContain('本次必须')
  })

  it('tool_choice 为 none 时禁止表达调用', () => {
    expect(buildToolInstruction([tool('read')], 'none')).toContain('本次不允许')
  })

  it('其它 tool_choice 不加那两句', () => {
    const text = buildToolInstruction([tool('read')], 'auto')
    expect(text).not.toContain('本次必须')
    expect(text).not.toContain('本次不允许')
  })
})

describe('工具轮次回放', () => {
  it('助手带 tool_calls 时连同正文一起回放', () => {
    const calls = [{ type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }]
    expect(toolCallTurnText('我看一下', calls)).toBe(
      '你上一轮调用了工具 read({"path":"a"})，并给出了这段说明：我看一下',
    )
  })

  it('助手正文为空时不留空档', () => {
    const calls = [{ type: 'function', function: { name: 'read', arguments: '{}' } }]
    expect(toolCallTurnText('', calls)).toBe('你上一轮调用了工具 read({})')
  })

  it('回放文本里不出现调用键名', () => {
    // 这段文本是我们自己塞进提示词的：写进 bridge_tool_calls，模型复述它时就会被
    // "看起来像工具调用"的判据命中，把一句正常回答替换成错误。
    const calls = [{ type: 'function', function: { name: 'read', arguments: '{}' } }]
    expect(toolCallTurnText('', calls)).not.toContain('bridge_tool_calls')
    expect(toolCallTurnText('正文', calls)).not.toContain('bridge_tool_calls')
  })

  it('调用缺少字段时用占位符，不抛错', () => {
    expect(toolCallTurnText('', [{}])).toContain('?({})')
  })

  it('多个调用按顺序列出', () => {
    const calls = [
      { function: { name: 'a', arguments: '{}' } },
      { function: { name: 'b', arguments: '{}' } },
    ]
    expect(toolCallTurnText('', calls)).toContain('a({})、b({})')
  })

  it('执行结果带上调用 id，并用开始/结束成对包住', () => {
    // 成对包住是必要的：工具输出本身多行，里面可能含有像对话的文本；只给前缀时模型
    // 分不清哪句是结果、哪句是新内容，线上表现就是回答里混进半截输出。
    expect(toolResultTurnText('call_1', '结果')).toBe(
      '【工具执行结果 call_1 开始】（这是你刚才那次调用的返回）\n结果\n【工具执行结果 call_1 结束】',
    )
  })

  it('没有 id 时也能回放', () => {
    expect(toolResultTurnText(undefined, '结果')).toBe(
      '【工具执行结果 开始】（这是你刚才那次调用的返回）\n结果\n【工具执行结果 结束】',
    )
  })
})

describe('toolTurnText', () => {
  it('工具结果消息走结果格式', () => {
    expect(toolTurnText({ role: 'tool', tool_call_id: 'c1' }, 'ok')).toBe(
      '【工具执行结果 c1 开始】（这是你刚才那次调用的返回）\nok\n【工具执行结果 c1 结束】',
    )
  })

  it('助手带 tool_calls 走调用格式，即使正文为空', () => {
    const message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'x', arguments: '{}' } }] }
    expect(toolTurnText(message, '')).toContain('你上一轮调用了工具')
  })

  it('助手没有 tool_calls 时不算工具轮次', () => {
    expect(toolTurnText({ role: 'assistant', content: 'hi' }, 'hi')).toBeNull()
  })

  it('空 tool_calls 数组不算工具轮次', () => {
    expect(toolTurnText({ role: 'assistant', tool_calls: [] }, '')).toBeNull()
  })

  it('普通用户消息不算工具轮次', () => {
    expect(toolTurnText({ role: 'user', content: 'hi' }, 'hi')).toBeNull()
  })
})

describe('resolveToolOutcome', () => {
  it('没带工具时原样当正文，判据是"根本没问工具"', () => {
    // 不带工具却出现 bridge_tool_calls 也只当正文：调用方从来没提供过工具清单。
    const outcome = resolveToolOutcome({ text: '{"bridge_tool_calls":[]}', hasTools: false })
    expect(outcome).toEqual({ calls: null, content: '{"bridge_tool_calls":[]}', broken: false })
  })

  it('解析出工具调用时正文为空', () => {
    const outcome = resolveToolOutcome({
      text: '{"bridge_tool_calls":[{"name":"read","arguments":{"path":"a"}}]}',
      hasTools: true,
    })
    expect(outcome.broken).toBe(false)
    expect(outcome.content).toBe('')
    expect(outcome.calls).toHaveLength(1)
    expect(outcome.calls?.[0]?.function?.name).toBe('read')
  })

  it('写坏了但明显在表达调用时标记 broken', () => {
    const outcome = resolveToolOutcome({ text: '{"bridge_tool_calls":[{"name":', hasTools: true })
    expect(outcome).toEqual({ calls: null, content: '', broken: true })
  })

  it('正常文字回答不算 broken', () => {
    expect(resolveToolOutcome({ text: '这是回答', hasTools: true })).toEqual({
      calls: null, content: '这是回答', broken: false,
    })
  })

  it('空输出不炸', () => {
    expect(resolveToolOutcome({ text: undefined, hasTools: true }))
      .toEqual({ calls: null, content: '', broken: false })
  })
})

describe('completeWithToolCalls', () => {
  it('第一次就拿到调用时不重试', async () => {
    const invoke = vi.fn(() => Promise.resolve({ text: '{"bridge_tool_calls":[{"name":"read","arguments":{}}]}' }))
    const result = await completeWithToolCalls({ invoke, systemPrompt: 'sys', hasTools: true })

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(result.outcome.calls).toHaveLength(1)
  })

  it('正常文字回答不重试', async () => {
    const invoke = vi.fn(() => Promise.resolve({ text: '你好' }))
    const result = await completeWithToolCalls({ invoke, systemPrompt: 'sys', hasTools: true })

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(result.outcome.content).toBe('你好')
  })

  it('JSON 写坏时带修复提示重试一次', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ text: '{"bridge_tool_calls":[{"name":' })
      .mockResolvedValueOnce({ text: '{"bridge_tool_calls":[{"name":"read","arguments":{}}]}' })
    const result = await completeWithToolCalls({ invoke, systemPrompt: 'sys', hasTools: true })

    expect(invoke).toHaveBeenCalledTimes(2)
    // 第二次必须带着修复提示，否则模型会原样再错一次。
    expect(invoke.mock.calls[1]?.[0]).toContain(TOOL_CALL_REPAIR_REMINDER)
    expect(result.outcome.calls).toHaveLength(1)
    expect(result.text).toContain('bridge_tool_calls')
  })

  it('重试后仍写坏时交给调用方报错', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ text: '{"bridge_tool_calls":[' })
      .mockResolvedValueOnce({ text: '{"bridge_tool_calls":[' })
    const result = await completeWithToolCalls({ invoke, systemPrompt: 'sys', hasTools: true })

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(result.outcome.broken).toBe(true)
  })

  it('重试没报用量时沿用第一次的', async () => {
    const usage = { input_tokens: 7 }
    const invoke = vi.fn()
      .mockResolvedValueOnce({ text: '{"bridge_tool_calls":[', usage })
      .mockResolvedValueOnce({ text: '{"bridge_tool_calls":[{"name":"a","arguments":{}}]}' })
    const result = await completeWithToolCalls({ invoke, systemPrompt: 'sys', hasTools: true })

    expect(result.usage).toEqual(usage)
  })

  it('过程日志记下重试', async () => {
    const logs: string[] = []
    const invoke = vi.fn()
      .mockResolvedValueOnce({ text: '{"bridge_tool_calls":[' })
      .mockResolvedValueOnce({ text: '{"bridge_tool_calls":[{"name":"a","arguments":{}}]}' })
    await completeWithToolCalls({ invoke, systemPrompt: 'sys', hasTools: true, log: (m) => { logs.push(m) } })

    expect(logs.join('\n')).toContain('重试一次')
  })
})

describe('toolCallFailureText', () => {
  it('带上原始输出片段，便于判断是哪个模型不适合本通道', () => {
    const text = toolCallFailureText('x'.repeat(900))
    expect(text).toContain('未执行任何工具')
    // 预览要足够长才看得见触发点：300 字实测不够。
    expect(text).toContain('x'.repeat(600))
    expect(text).not.toContain('x'.repeat(601))
  })

  it('空输出不炸', () => {
    expect(toolCallFailureText('')).toContain('未执行任何工具')
  })
})

describe('createToolCallGate', () => {
  it('开头就是正文时逐段直发', () => {
    const gate = createToolCallGate()
    expect(gate.push('你')).toBe('你')
    expect(gate.push('好')).toBe('好')
    expect(gate.settle(false)).toBe('')
  })

  it('开头的空白先扣住，确定是正文后一起补发', () => {
    const gate = createToolCallGate()
    expect(gate.push('\n ')).toBe('')
    expect(gate.push('你好')).toBe('\n 你好')
  })

  it('开头是 { 时整段扣住，判定为调用后丢弃', () => {
    const gate = createToolCallGate()
    expect(gate.push('{"bridge_tool_calls":')).toBe('')
    expect(gate.push('[{"name":"a","arguments":{}}]}')).toBe('')
    expect(gate.settle(true)).toBe('')
  })

  it('开头像调用但其实不是时，收尾把扣住的文本交出来', () => {
    // 例如模型直接输出一段 JSON 正文：不能凭空丢内容。
    const gate = createToolCallGate()
    expect(gate.push('{"a":1}')).toBe('')
    expect(gate.settle(false)).toBe('{"a":1}')
  })

  it('代码围栏开头同样扣住', () => {
    const gate = createToolCallGate()
    expect(gate.push('```json\n')).toBe('')
    expect(gate.settle(true)).toBe('')
  })

  it('原生标记开头时扣住，不让尖括号先流出去', () => {
    // 模型自带的调用标记以 `<｜DSML｜…` 开头：首段可能只有一个 `<`，这时不能判成正文。
    const gate = createToolCallGate()
    expect(gate.push('<')).toBe('')
    expect(gate.push('｜DSML｜invoke name="pwsh">')).toBe('')
    expect(gate.push('<｜DSML｜parameter name="a" string="true">v</｜DSML｜parameter>')).toBe('')
    expect(gate.settle(true)).toBe('')
  })

  it('半角竖线的标记开头也扣住', () => {
    const gate = createToolCallGate()
    expect(gate.push('<|DSML|invoke name="t">')).toBe('')
    expect(gate.settle(true)).toBe('')
  })

  it('尖括号后不是标记时立刻放行', () => {
    // HTML 之类的回答不该被标记判定拖住。
    const gate = createToolCallGate()
    expect(gate.push('<')).toBe('')
    expect(gate.push('div>hi')).toBe('<div>hi')
    expect(gate.push('</div>')).toBe('</div>')
  })

  it('正文中间出现的尖括号不受影响', () => {
    const gate = createToolCallGate()
    expect(gate.push('a ')).toBe('a ')
    expect(gate.push('< b')).toBe('< b')
  })

  it('只收到一个尖括号就结束时把它交出来', () => {
    const gate = createToolCallGate()
    expect(gate.push('<')).toBe('')
    expect(gate.settle(false)).toBe('<')
  })

  it('已经判定为正文后，后面出现的 { 也照常直发', () => {
    // 代码类回答里到处是花括号，不能因此重新扣住。
    const gate = createToolCallGate()
    expect(gate.push('示例：')).toBe('示例：')
    expect(gate.push('function f() { }')).toBe('function f() { }')
  })

  it('只有空白就结束时把空白交出来', () => {
    const gate = createToolCallGate()
    expect(gate.push('  ')).toBe('')
    expect(gate.settle(false)).toBe('  ')
  })
})

describe('EXTERNAL_TOOLING_NOTICE', () => {
  it('声明里明确禁止原生函数调用格式', () => {
    expect(EXTERNAL_TOOLING_NOTICE).toContain('最高优先级')
    expect(EXTERNAL_TOOLING_NOTICE).toContain('tool_calls')
    // 关键在于"工具由外部执行"，否则模型会以为自己能直接调。
    expect(EXTERNAL_TOOLING_NOTICE).toContain('外部调用方')
  })
})
