import { describe, expect, it } from 'vitest'
import { errorText, ModelRouterStats, noticeReason, type DecisionObservation } from '../src/stats.ts'

function observation(overrides: Partial<DecisionObservation> = {}): DecisionObservation {
  return {
    at: 1,
    logs: [],
    kind: 'select',
    target: { provider: 'p1', model: 'm1' },
    candidates: [{ provider: 'p1', model: 'm1' }],
    classification: undefined,
    score: () => 1,
    estimatedCost: 0,
    ...overrides,
  }
}

describe('error text', () => {
  it('reads an Error message and stringifies anything else', () => {
    expect(errorText(new Error('clock down'))).toBe('clock down')
    expect(errorText('clock')).toBe('clock')
  })
})

describe('notice reasons', () => {
  it('maps each sticky-break sentence onto a stable code', () => {
    expect(noticeReason('held until a quota window opens')).toBe('held')
    expect(noticeReason('over its budget')).toBe('budget')
    expect(noticeReason('remaining quota is exhausted')).toBe('quota')
    expect(noticeReason('carries an image')).toBe('vision')
    expect(noticeReason('until its configuration changes')).toBe('unavailable')
    expect(noticeReason('the task rose from simple to hard')).toBe('tier-upgrade')
    expect(noticeReason('cooling down')).toBe('unhealthy')
  })
})

describe('route stats', () => {
  it('counts selections, switches, fallbacks, tokens, and the latest latency', () => {
    const stats = new ModelRouterStats()
    stats.noteDecision(observation({
      logs: [
        { message: 'model-router: rule "%s" routes this task to %s/%s', args: ['long-form', 'p1', 'm1'] },
      ],
      classification: { tier: 'simple', scores: { simple: 3, standard: 0, hard: 0 } },
      estimatedCost: 1.5,
    }))
    stats.noteDecision(observation({
      at: 2,
      logs: [
        { message: 'model-router: leaving %s/%s because %s', args: ['p1', 'm1', 'cooling down'] },
        { message: 'model-router: rule "%s" routes this task to %s/%s', args: [12, 'p2', 'm2'] },
      ],
      target: { provider: 'p2', model: 'm2' },
      candidates: [{ provider: 'p2', model: 'm2' }],
    }))
    stats.noteDecision(observation({ kind: 'unchanged', target: undefined, logs: [{ message: 'leaving', args: [] }] }))
    stats.noteFallback('p2', 'm2')
    stats.noteUsage('p2', 'm2', 10, 4, 0.2)
    stats.noteTiming('p2', 80, 20)
    stats.noteTiming('p2', 90, undefined)
    stats.noteTiming('absent', 5, 1)

    const decisions = stats.decisions()
    expect(decisions[0]).toMatchObject({
      rule: 'long-form',
      tier: 'simple',
      estimatedCost: 1.5,
      candidates: [{ provider: 'p1', model: 'm1', health: 1 }],
    })
    expect(decisions[1]).toMatchObject({ rule: undefined, reason: 'cooling down' })
    expect(decisions[1]?.latencyMs).toBe(80)
    expect(decisions[1]?.ttftMs).toBe(20)
    expect(decisions[2]?.chosen).toBeUndefined()
    expect(stats.snapshot()).toEqual([
      {
        provider: 'p1', model: 'm1', selections: 1, switches: 0, fallbacks: 0,
        inputTokens: 0, outputTokens: 0, estimatedCost: 0, latencyMs: undefined, ttftMs: undefined,
      },
      {
        provider: 'p2', model: 'm2', selections: 1, switches: 1, fallbacks: 1,
        inputTokens: 10, outputTokens: 4, estimatedCost: 0.2, latencyMs: 90, ttftMs: undefined,
      },
    ])
  })

  it('keeps only the newest fifty decisions', () => {
    const stats = new ModelRouterStats()
    for (let at = 0; at < 51; at += 1) stats.noteDecision(observation({ at, kind: 'unchanged', target: undefined }))
    expect(stats.decisions()).toHaveLength(50)
    expect(stats.decisions()[0]?.at).toBe(1)
  })
})
