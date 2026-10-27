import { describe, expect, it } from 'vitest'
import { firstMatchingRule, matchesRule, type RouteRule } from '../src/rules.ts'

/** One rule with every field stated, so a test changes only what it names. */
function rule(overrides: Partial<RouteRule> = {}): RouteRule {
  return {
    name: 'default-rule',
    keywords: [],
    hasImage: undefined,
    provider: 'dpv41f',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: undefined,
    ...overrides,
  }
}

describe('model-router rules', () => {
  it('matches a keyword the text carries, whatever its case', () => {
    const signals = { text: 'write a novel', hasImage: false }
    expect(matchesRule(rule({ keywords: ['novel'] }), signals)).toBe(true)
    expect(matchesRule(rule({ keywords: ['NOVEL'] }), signals)).toBe(true)
    expect(matchesRule(rule({ keywords: ['小说'] }), { text: '写一部小说', hasImage: false })).toBe(true)
  })

  it('declines a keyword the text does not carry', () => {
    expect(matchesRule(rule({ keywords: ['报告'] }), { text: '写一部小说', hasImage: false })).toBe(false)
  })

  it('matches an image condition on its own', () => {
    const withImage = rule({ hasImage: true })
    expect(matchesRule(withImage, { text: '看这张图', hasImage: true })).toBe(true)
    expect(matchesRule(withImage, { text: '看这张图', hasImage: false })).toBe(false)
  })

  it('declines a rule that states no condition at all', () => {
    expect(matchesRule(rule(), { text: '任何内容', hasImage: false })).toBe(false)
  })

  it('requires every stated condition to hold', () => {
    const both = rule({ keywords: ['小说'], hasImage: true })
    expect(matchesRule(both, { text: '写小说', hasImage: true })).toBe(true)
    expect(matchesRule(both, { text: '写小说', hasImage: false })).toBe(false)
    expect(matchesRule(both, { text: '写报告', hasImage: true })).toBe(false)
  })

  it('returns the first matching rule in declaration order', () => {
    const rules = [
      rule({ name: 'first', keywords: ['小说'] }),
      rule({ name: 'second', keywords: ['小说'] }),
    ]
    expect(firstMatchingRule(rules, { text: '写小说', hasImage: false })?.name).toBe('first')
  })

  it('returns undefined when no rule matches', () => {
    const rules = [rule({ name: 'only', keywords: ['报告'] })]
    expect(firstMatchingRule(rules, { text: '写小说', hasImage: false })).toBeUndefined()
    expect(firstMatchingRule([], { text: '写小说', hasImage: false })).toBeUndefined()
  })
})
