/**
 * 把模型的工具调用意图还原成 OpenAI tool_calls。
 *
 * 两种输入都要认：
 *   1. 我们约定的 `{"bridge_tool_calls":[…]}` JSON —— 模型按提示词输出时是这种；
 *   2. 模型**自带的**调用标记（DeepSeek DSML：`<｜DSML｜tool_calls>` 那一族）——
 *      训练时就带原生格式的模型常常无视约定直接吐它。
 *
 * 第 2 种不认的后果很具体：整段尖括号被当成正文流给用户，工具一次都没执行。
 * 所以这里的重点是"标记写得不规范也要认出来"：分隔符可能被中转成半角、可能叠成多个，
 * 闭合标签可能缺失。
 */

import { describe, expect, it } from 'vitest'
import { looksLikeToolCallAttempt, parseDsmlToolCalls, parseToolCalls } from '../bridge/toolcalls.mjs'

/** 用全角竖线拼一段 DSML 标记。 */
function dsml(...lines: string[]): string {
  return lines.join('\n')
}

/** 取第一个调用的参数对象。 */
function argsOf(text: string): Record<string, unknown> {
  const calls = parseToolCalls(text)
  expect(calls).not.toBeNull()
  return JSON.parse(calls?.[0]?.function.arguments ?? '{}') as Record<string, unknown>
}

describe('DSML 标记解析', () => {
  it('解析一个 invoke 与一个字符串参数', () => {
    const text = dsml(
      '<｜DSML｜tool_calls>',
      '<｜DSML｜invoke name="pwsh">',
      '<｜DSML｜parameter name="command" string="true">Get-Date</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '</｜DSML｜tool_calls>',
    )
    const calls = parseToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls?.[0]?.function.name).toBe('pwsh')
    expect(argsOf(text)).toEqual({ command: 'Get-Date' })
    expect(calls?.[0]?.type).toBe('function')
    expect(calls?.[0]?.id).toMatch(/^call_/u)
  })

  it('按类型属性还原数字、布尔与 null', () => {
    const text = dsml(
      '<｜DSML｜invoke name="t">',
      '<｜DSML｜parameter name="n" integer="true">120000</｜DSML｜parameter>',
      '<｜DSML｜parameter name="ratio" number="true">0.5</｜DSML｜parameter>',
      '<｜DSML｜parameter name="flag" boolean="true">true</｜DSML｜parameter>',
      '<｜DSML｜parameter name="none" null="true"></｜DSML｜parameter>',
      '</｜DSML｜invoke>',
    )
    expect(argsOf(text)).toEqual({ n: 120000, ratio: 0.5, flag: true, none: null })
  })

  it('按类型属性还原数组与对象', () => {
    const text = dsml(
      '<｜DSML｜invoke name="t">',
      '<｜DSML｜parameter name="list" array="true">[1,2]</｜DSML｜parameter>',
      '<｜DSML｜parameter name="obj" object="true">{"a":1}</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
    )
    expect(argsOf(text)).toEqual({ list: [1, 2], obj: { a: 1 } })
  })

  it('数组/对象的 JSON 写坏时退回原始文本，不丢参数', () => {
    const text = dsml(
      '<｜DSML｜invoke name="t">',
      '<｜DSML｜parameter name="obj" object="true">{oops</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
    )
    expect(argsOf(text)).toEqual({ obj: '{oops' })
  })

  it('没有类型属性时先按 JSON 试，失败就当字符串', () => {
    const text = dsml(
      '<｜DSML｜invoke name="t">',
      '<｜DSML｜parameter name="a">123</｜DSML｜parameter>',
      '<｜DSML｜parameter name="b">hello</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
    )
    expect(argsOf(text)).toEqual({ a: 123, b: 'hello' })
  })

  it('数字类型的值不是数字时保留原文', () => {
    const text = dsml(
      '<｜DSML｜invoke name="t">',
      '<｜DSML｜parameter name="n" integer="true">不是数字</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
    )
    expect(argsOf(text)).toEqual({ n: '不是数字' })
  })

  it('解析多个 invoke', () => {
    const text = dsml(
      '<｜DSML｜invoke name="a">',
      '<｜DSML｜parameter name="x" string="true">1</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '<｜DSML｜invoke name="b">',
      '<｜DSML｜parameter name="y" string="true">2</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
    )
    const calls = parseToolCalls(text)
    expect(calls?.map(call => call.function.name)).toEqual(['a', 'b'])
  })

  it('分隔符叠成多个或换成半角时照样认', () => {
    // 中转一层之后，全角竖线常变成半角或叠成两个 —— 你贴回来的那份就是这个形态。
    for (const open of ['<｜｜DSML｜｜', '<|DSML|', '< | DSML | ']) {
      const close = open.replace('<', '</')
      const text = `${open}invoke name="t">\n${open}parameter name="k" string="true">v${close}parameter>\n${close}invoke>`
      expect(parseToolCalls(text)?.[0]?.function.name).toBe('t')
      expect(argsOf(text)).toEqual({ k: 'v' })
    }
  })

  it('缺闭合标签时按下一个 invoke 或文本末尾切', () => {
    const text = dsml(
      '<｜DSML｜invoke name="t">',
      '<｜DSML｜parameter name="a" string="true">1',
      '<｜DSML｜parameter name="b" string="true">2',
    )
    expect(argsOf(text)).toEqual({ a: '1', b: '2' })
  })

  it('标记前面有正文时照样解析', () => {
    const text = dsml(
      '我先看一下时间：',
      '<｜DSML｜invoke name="t">',
      '<｜DSML｜parameter name="a" string="true">1</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
    )
    expect(parseToolCalls(text)?.[0]?.function.name).toBe('t')
  })

  it('没有 invoke 时不算调用', () => {
    expect(parseDsmlToolCalls('<｜DSML｜tool_calls></｜DSML｜tool_calls>')).toBeNull()
  })

  it('没有 DSML 标记时直接返回 null', () => {
    expect(parseDsmlToolCalls('普通回答')).toBeNull()
    expect(parseDsmlToolCalls(undefined)).toBeNull()
  })

  it('invoke 缺名字时跳过', () => {
    const text = dsml('<｜DSML｜invoke>', '<｜DSML｜parameter name="a">1</｜DSML｜parameter>')
    expect(parseDsmlToolCalls(text)).toBeNull()
  })

  it('parameter 缺名字时跳过', () => {
    const text = dsml('<｜DSML｜invoke name="t">', '<｜DSML｜parameter>1</｜DSML｜parameter>')
    expect(argsOf(text)).toEqual({})
  })
})

describe('约定格式解析（bridge_tool_calls）', () => {
  it('解析标准 JSON', () => {
    expect(argsOf('{"bridge_tool_calls":[{"name":"read","arguments":{"path":"a"}}]}')).toEqual({ path: 'a' })
  })

  it('包在代码围栏里也能解析', () => {
    const text = '```json\n{"bridge_tool_calls":[{"name":"read","arguments":{}}]}\n```'
    expect(parseToolCalls(text)?.[0]?.function.name).toBe('read')
  })

  it('括号多写一个时靠修复救回来', () => {
    const text = '{"bridge_tool_calls":[{"name":"t","arguments":{"a":1}}]]}'
    expect(argsOf(text)).toEqual({ a: 1 })
  })

  it('参数误放到 wrapper 层时并回 arguments', () => {
    const text = '{"bridge_tool_calls":[{"name":"t","arguments":{"a":1}}],"summarize":"x"}'
    expect(argsOf(text)).toEqual({ a: 1, summarize: 'x' })
  })

  it('arguments 是字符串时原样保留', () => {
    const text = '{"bridge_tool_calls":[{"name":"t","arguments":"{\\"a\\":1}"}]}'
    const call = parseToolCalls(text)?.[0]
    expect(call?.function.arguments).toBe('{"a":1}')
  })

  it('不是工具调用时返回 null', () => {
    expect(parseToolCalls('普通回答')).toBeNull()
    expect(parseToolCalls('')).toBeNull()
  })
})

describe('looksLikeToolCallAttempt', () => {
  it('认 DSML 标记', () => {
    // 这条决定了"写坏的标记"会不会被当最终回答下发 —— 必须认得出。
    expect(looksLikeToolCallAttempt('<｜DSML｜invoke name="t">')).toBe(true)
    expect(looksLikeToolCallAttempt('<|DSML|tool_calls>')).toBe(true)
  })

  it('认约定的键名与 arguments', () => {
    expect(looksLikeToolCallAttempt('{"bridge_tool_calls":[')).toBe(true)
    expect(looksLikeToolCallAttempt('{"arguments":')).toBe(true)
    expect(looksLikeToolCallAttempt('{"tool_calls":')).toBe(true)
  })

  it('普通回答不算', () => {
    expect(looksLikeToolCallAttempt('这是一段回答')).toBe(false)
    expect(looksLikeToolCallAttempt(undefined)).toBe(false)
  })
})
