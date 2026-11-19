import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { observeTask } from '../src/observe.ts'

describe('model-router observation', () => {
  it('reads text, fences, and a step list from the claimed message', () => {
    const observed = observeTask(createUserMessage({
      content: [{ type: 'text', text: 'Title\n1. one\n2. two\n3. three\n```ts\nconst n = 1\n```' }],
      source: { kind: 'user' },
    }), [], 'high')
    expect(observed.promptChars).toBeGreaterThan(10)
    expect(observed.text.startsWith('title')).toBe(true)
    expect(observed.codeBlockCount).toBe(1)
    expect(observed.numberedStepCount).toBe(3)
    expect(observed.reasoningEffort).toBe('high')
  })

  it('folds tool history, plan tools, images, and the latest usage', () => {
    const observed = observeTask(createUserMessage({
      content: [{ type: 'text', text: 'next' }],
      source: { kind: 'user' },
    }), [
      { type: 'tool/call', data: { name: 'read' } },
      { type: 'tool/call', data: { name: 'todo_write' } },
      { type: 'tool/call', data: { name: 1 } },
      { type: 'user/message', data: { message: { content: [null, { type: 'image' }, { type: 'file' }, { type: 'text', text: 'kept' }, { type: 'text', text: 1 }, { type: 'tool-call' }] } } },
      { type: 'user/message', data: null },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'plain' }] } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } } },
      { type: 'assistant/message', data: { usage: { nope: true }, message: { content: 'text' } } },
      { type: 'user/message', data: { message: null } },
      { type: 'other', data: null },
    ], undefined)
    expect(observed.toolUseCount).toBe(2)
    expect(observed.planActive).toBe(true)
    expect(observed.hasAttachment).toBe(true)
    expect(observed.contextTokens).toBe(17)
  })

  it('reads an empty message as a quiet observation', () => {
    const observed = observeTask(createUserMessage({
      content: [],
      source: { kind: 'user' },
    }), [], undefined)
    expect(observed).toMatchObject({
      text: '',
      promptChars: 0,
      hasImage: false,
      toolUseCount: 0,
      planActive: false,
      codeBlockCount: 0,
    })
  })
})
