import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { signalsOf } from '../src/signals.ts'

/** A user message carrying the given content blocks. */
function message(content: readonly unknown[]): UserMessage {
  return { role: 'user', content, source: { kind: 'user' }, id: 'm1' } as unknown as UserMessage
}

describe('model-router signals', () => {
  it('reads the text of a message and folds its case', () => {
    expect(signalsOf(message([{ type: 'text', text: 'Write A Novel' }]))).toEqual({
      text: 'write a novel',
      hasImage: false,
    })
  })

  it('joins the text of every text block', () => {
    const signals = signalsOf(message([
      { type: 'text', text: 'first ' },
      { type: 'text', text: 'second' },
    ]))
    expect(signals.text).toBe('first second')
  })

  it('notices an image block', () => {
    expect(signalsOf(message([{ type: 'image', attachment: { id: 'a1' } }])).hasImage).toBe(true)
  })

  it('reports no image for a message that carries none', () => {
    expect(signalsOf(message([{ type: 'text', text: 'plain' }])).hasImage).toBe(false)
  })

  it('ignores blocks that carry neither text nor an image', () => {
    const signals = signalsOf(message([
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
      { type: 'text', text: 'after' },
    ]))
    expect(signals).toEqual({ text: 'after', hasImage: false })
  })

  it('reads an empty message as no text and no image', () => {
    expect(signalsOf(message([]))).toEqual({ text: '', hasImage: false })
  })
})
