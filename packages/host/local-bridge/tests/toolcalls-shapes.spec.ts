/**
 * WorkBuddy 云端模型的工具调用输出形状。
 *
 * 云端那个模型是 WorkBuddy 官方 agent 用的那一族，训练时就带原生工具调用格式（DSML），
 * 拿到 tools 之后**不一定**用原生 function calling，也可能退回自己的标记。实测同一条
 * 请求里它至少出现过下面 7 种形状 —— 工具名与参数都对，只是外壳不同。
 *
 * 这些形状都必须能还原成 OpenAI 的 tool_calls：认不出来，表现就是「模型明明要读文件，
 * 却什么都没发生」—— 整段标记被当成正文流给用户。
 */

import { describe, expect, it } from 'vitest'
import { parseToolCalls } from '../bridge/toolcalls.mjs'

const shapes: Array<[string, string]> = [
  ['DSML + 真实工具名 + parameter 标签', [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="read">',
    '<｜｜DSML｜｜ parameter name="path" string="true">D:/a.json</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n')],
  ['DSML + 元工具 + JSON{tool_calls:[]}', [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="bridge_tool_calls">',
    '{"tool_calls":[{"name":"read","arguments":{"path":"D:/a.json"}}]}',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n')],
  ['DSML + 元工具 + JSON{tool,arguments}', [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="bridge_tool_calls">',
    '{"tool":"read","arguments":{"path":"D:/a.json"}}',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n')],
  ['DSML + 元工具 + parameter(tool 与参数平铺)', [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="bridge_tool_calls">',
    '<｜｜DSML｜｜ parameter name="path" string="true">D:/a.json</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="tool" string="true">read</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n')],
  ['标签 + JSON{tool,args}', [
    '<bridge_tool_calls>',
    '{"tool":"read","args":{"path":"D:/a.json"}}',
    '</bridge_tool_calls>',
  ].join('\n')],
  ['标签 + JSON{tool,arguments}', [
    '<bridge_tool_calls>',
    '{"tool":"read","arguments":{"path":"D:/a.json"}}',
    '</bridge_tool_calls>',
  ].join('\n')],
  ['标准协议', '{"bridge_tool_calls":[{"name":"read","arguments":{"path":"D:/a.json"}}]}'],
]

describe('云端模型的工具调用输出形状', () => {
  for (const [label, text] of shapes) {
    it(`还原成 OpenAI tool_calls：${label}`, () => {
      const calls = parseToolCalls(text)
      expect(calls).not.toBeNull()
      expect(calls).toHaveLength(1)
      expect(calls?.[0]?.function.name).toBe('read')
      expect(JSON.parse(calls?.[0]?.function.arguments ?? '{}')).toEqual({ path: 'D:/a.json' })
    })
  }
})
