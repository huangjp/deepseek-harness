/**
 * Copilot 通道的工具清单收敛。
 *
 * 这条通道没有原生 function calling，工具只以提示词里的清单存在 —— 清单里有什么，
 * 模型就有什么。因此「哪些工具被交给这条通道」是这里唯一能管住的地方：清单之外的
 * 工具既不会被模型提到，也不会出现在下游收到的 tool_calls 里。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOL_ALLOW, filterTools } from '../bridge/copilot-bridge.mjs'
/** 一份 OpenAI 风格的工具定义。 */
function tool(name: string) {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} 的说明`,
      parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
    },
  }
}

/** DSH 的扁平形状（没有 function 包装）。 */
function flat(name: string) {
  return { name, description: `${name} 的说明`, parameters: { type: 'object', properties: {} } }
}

describe('Copilot 通道的工具清单', () => {
  it('默认只放行读文档与写文档', () => {
    expect(DEFAULT_TOOL_ALLOW).toEqual(['read', 'write'])
  })

  it('只留下清单里的工具', () => {
    const filtered = filterTools([tool('read'), tool('write'), tool('bash'), tool('web_search')], ['read', 'write'])

    expect(filtered.map(t => (t as { function: { name: string } }).function.name)).toEqual(['read', 'write'])
  })

  it('认 DSH 的扁平形状', () => {
    const filtered = filterTools([flat('read'), flat('bash')], ['read', 'write'])

    expect(filtered.map(t => (t as { name: string }).name)).toEqual(['read'])
  })

  it('允许清单为空时一个工具都不给', () => {
    expect(filterTools([tool('read'), tool('write')], [])).toEqual([])
  })
})
