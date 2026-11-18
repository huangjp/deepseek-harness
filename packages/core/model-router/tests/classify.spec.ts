import { describe, expect, it } from 'vitest'
import {
  classifyTask, DEFAULT_HARD_KEYWORDS, isTaskClassifier, KeywordTaskClassifier, resolveClassifierOptions, tierFromScores,
  type TaskObservation,
} from '../src/classify.ts'

/** An observation with every signal quiet, so a test sets only what it names. */
function observation(overrides: Partial<TaskObservation> = {}): TaskObservation {
  return {
    text: 'hello there',
    promptChars: 11,
    contextTokens: undefined,
    hasImage: false,
    hasAttachment: false,
    toolUseCount: 0,
    planActive: false,
    codeBlockCount: 0,
    numberedStepCount: 0,
    reasoningEffort: undefined,
    ...overrides,
  }
}

describe('model-router classifier', () => {
  it('treats a short greeting as simple and a hard hint as hard', () => {
    expect(classifyTask(observation({ text: '你好' })).tier).toBe('simple')
    const hard = classifyTask(observation({ text: '请深度思考' }))
    expect(hard.tier).toBe('hard')
    expect(hard.reasons).toContain('hint-hard')
    expect(hard.scores.hard).toBeGreaterThanOrEqual(hard.scores.simple)
  })

  it('treats an ordinary sentence as standard', () => {
    const result = classifyTask(observation({ text: '帮我看看这个函数', promptChars: 8 }))
    expect(result.tier).toBe('standard')
    expect(result.reasons).toEqual([])
  })

  it('raises the tier for length, context, tools, plans, code, steps, and effort', () => {
    expect(classifyTask(observation({ promptChars: 1_200 })).reasons).toContain('prompt-medium')
    expect(classifyTask(observation({ promptChars: 4_000 })).tier).toBe('hard')
    expect(classifyTask(observation({ contextTokens: 8_000 })).reasons).toContain('context-medium')
    expect(classifyTask(observation({ contextTokens: 32_000 })).tier).toBe('hard')
    expect(classifyTask(observation({ toolUseCount: 1 })).reasons).toContain('tools')
    expect(classifyTask(observation({ toolUseCount: 6 })).tier).toBe('hard')
    expect(classifyTask(observation({ planActive: true })).tier).toBe('hard')
    expect(classifyTask(observation({ codeBlockCount: 1 })).reasons).toContain('code')
    expect(classifyTask(observation({ codeBlockCount: 3 })).tier).toBe('hard')
    expect(classifyTask(observation({ numberedStepCount: 3 })).tier).toBe('hard')
    expect(classifyTask(observation({ hasImage: true })).reasons).toContain('image')
    expect(classifyTask(observation({ hasAttachment: true })).reasons).toContain('attachment')
    expect(classifyTask(observation({ reasoningEffort: 'max' })).tier).toBe('hard')
    expect(classifyTask(observation({ reasoningEffort: 'LOW' })).tier).toBe('simple')
  })

  it('lets a hard keyword beat a simple one', () => {
    const mixed = classifyTask(observation({ text: '请 debug 这段并翻译' }))
    expect(mixed.tier).toBe('hard')
  })

  it('accepts keyword overrides and a custom classifier object', () => {
    const overridden = classifyTask(observation({ text: 'ship it' }), { hardKeywords: ['ship it'] })
    expect(overridden.tier).toBe('hard')
    const classifier = new KeywordTaskClassifier()
    expect(isTaskClassifier(classifier)).toBe(true)
    expect(isTaskClassifier(null)).toBe(false)
    expect(isTaskClassifier({ classify: 'nope' })).toBe(false)
    expect(tierFromScores({ simple: 1, standard: 1, hard: 1 }, { hardMark: 4, simpleMark: 3 })).toBe('standard')
    expect(resolveClassifierOptions(undefined).hardKeywords).toEqual(DEFAULT_HARD_KEYWORDS)
    expect(resolveClassifierOptions({ hardKeywords: undefined, hardMark: 5 }).hardKeywords).toEqual(DEFAULT_HARD_KEYWORDS)
    expect(resolveClassifierOptions({ hardKeywords: [] }).hardKeywords).toEqual(DEFAULT_HARD_KEYWORDS)
    expect(resolveClassifierOptions({ hardKeywords: ['ship'], simpleKeywords: ['yo'], hardHints: ['ponder'], simpleHints: ['short'] }).hardKeywords).toEqual(['ship'])
    expect(resolveClassifierOptions({ hardMark: 5 }).hardMark).toBe(5)
  })
})
