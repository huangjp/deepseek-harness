/**
 * 工具清单的两种形状。
 *
 * DSH 那边发过来的是**扁平**的 tools：`{name, description, parameters}` —— 没有
 * `type:'function'` 也没有 `function` 包装。OpenAI 的标准形状则是
 * `{type:'function', function:{name, description, parameters}}`。
 *
 * 这个差别曾让 27 个真实工具渲染出**空清单**：模型压根不知道自己有工具，于是只会说
 * 「我无法访问你本机上的文件」，一次调用都不会发。所以两种形状必须都认。
 */

import { describe, expect, it } from 'vitest'
import {
  buildCompactToolInstruction, buildToolCallFormatHint, buildToolInstruction, normalizeToolSpecs,
} from '../bridge/toolprompt.mjs'

const FLAT = [
  { name: 'read', description: 'Read a file from the local filesystem.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'write', description: 'Write content into a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]
const NESTED = FLAT.map(t => ({ type: 'function', function: t }))

describe('tools 形状归一化', () => {
  it('两种形状归一化出同样的清单', () => {
    expect(normalizeToolSpecs(FLAT)).toEqual(normalizeToolSpecs(NESTED))
    expect(normalizeToolSpecs(FLAT)).toHaveLength(2)
    expect(normalizeToolSpecs(FLAT)[0]?.name).toBe('read')
  })

  it('空输入返回空清单', () => {
    expect(normalizeToolSpecs(undefined)).toEqual([])
    expect(normalizeToolSpecs([])).toEqual([])
    expect(normalizeToolSpecs([{ type: 'function' }])).toEqual([])
  })

  it('扁平形状能渲染出工具清单（这是 DSH 实际发的形状）', () => {
    const text = buildToolInstruction(FLAT)
    expect(text).toContain('"name": "read"')
    expect(text).toContain('"name": "write"')
    expect(text).toContain('bridge_tool_calls')
  })

  it('扁平形状的精简清单也有内容', () => {
    const text = buildCompactToolInstruction(FLAT)
    expect(text).toContain('- read(path)')
    expect(text).toContain('- write(path)')
  })

  it('扁平形状的格式提示列出真实工具名', () => {
    const text = buildToolCallFormatHint(FLAT)
    expect(text).toContain('read')
    expect(text).toContain('write')
  })

  it('没有工具时三处都返回空串', () => {
    expect(buildToolInstruction([])).toBe('')
    expect(buildCompactToolInstruction([])).toBe('')
    expect(buildToolCallFormatHint([])).toBe('')
  })
})
