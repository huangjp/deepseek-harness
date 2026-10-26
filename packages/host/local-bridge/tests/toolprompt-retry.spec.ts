/**
 * 文本协议通道上的两类重试。
 *
 * 1. **拒答**：模型带着「我没有工具 / 我不能访问你的文件」的先验，直接回「我无法读取
 *    你本机上的 xxx」。它不是不会写 JSON，是不认为该写 —— 换一种说法让它重来。
 * 2. **假完成**：模型声称「已创建文件 docs/v2/100-test.md」，但**一次工具都没调**。
 *    这比拒答更隐蔽：对话里已经有一句「已完成」，下游却什么都没发生，用户看到的就是
 *    「模型说做完了，磁盘上什么都没有」。
 *
 * 两者都要重试一次 —— 不重试的话，agent 就会把「模型自己说的」当成事实。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  completeWithToolCalls, looksLikeFalseCompletion, looksLikeToolRefusal,
} from '../bridge/toolprompt.mjs'

describe('拒答与假完成的判据', () => {
  it('认得出「我无法访问你本机上的文件」这类拒答', () => {
    expect(looksLikeToolRefusal('我无法直接读取你设备上的 `D:/a.json` 文件。')).toBe(true)
    expect(looksLikeToolRefusal('抱歉，我暂时无法调用本地文件读取工具。')).toBe(true)
  })

  it('不把正常回答误判成拒答', () => {
    expect(looksLikeToolRefusal('这个架构分三层：领域层、应用层、基础设施层。')).toBe(false)
    expect(looksLikeToolRefusal('')).toBe(false)
  })

  it('认得出「已创建文件」这类假完成', () => {
    expect(looksLikeFalseCompletion('已创建文件 `docs/v2/100-test.md`，内容为：…')).toBe(true)
    expect(looksLikeFalseCompletion('已经保存好了。')).toBe(true)
    expect(looksLikeFalseCompletion('这个架构分三层。')).toBe(false)
  })
})

describe('completeWithToolCalls 的重试', () => {
  it('模型拒答时重试一次并强制给出工具意图', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ text: '我无法直接读取你设备上的 `D:/a.json` 文件。' })
      .mockResolvedValueOnce({ text: '{"bridge_tool_calls":[{"name":"read","arguments":{"path":"D:/a.json"}}]}' })
    const out = await completeWithToolCalls({
      invoke,
      systemPrompt: 'SYS',
      hasTools: true,
    })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(out.outcome.calls?.[0]?.function?.name).toBe('read')
    expect(String(invoke.mock.calls[1]?.[0])).toContain('确实拥有')
  })

  it('模型声称完成却没调工具时，重试一次并强制调用工具', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ text: '已创建文件 `docs/v2/100-test.md`，内容为：这是工作的内容。' })
      .mockResolvedValueOnce({ text: '{"bridge_tool_calls":[{"name":"write","arguments":{"file_path":"docs/v2/100-test.md","content":"x"}}]}' })
    const out = await completeWithToolCalls({
      invoke,
      systemPrompt: 'SYS',
      hasTools: true,
    })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(out.outcome.calls?.[0]?.function?.name).toBe('write')
    expect(String(invoke.mock.calls[1]?.[0])).toContain('一次工具都没有调用')
  })

  it('正常回答不重试', async () => {
    const invoke = vi.fn().mockResolvedValue({ text: '这个架构分三层。' })
    const out = await completeWithToolCalls({ invoke, systemPrompt: 'SYS', hasTools: true })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(out.outcome.content).toBe('这个架构分三层。')
  })
})
