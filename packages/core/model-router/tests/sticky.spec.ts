import { describe, expect, it } from 'vitest'
import type { RouteTarget } from '../src/catalog.ts'
import { evaluateSticky, stickyBreakText, stickyFromTarget, type StickyRecord } from '../src/sticky.ts'

/** A held route on p1. */
function sticky(overrides: Partial<StickyRecord> = {}): StickyRecord {
  return {
    provider: 'p1',
    model: 'm1',
    reasoningEffort: undefined,
    tier: 'simple',
    acceptsImage: false,
    ruleName: 'simple',
    ...overrides,
  }
}

describe('model-router stickiness', () => {
  it('keeps the route on a downgrade and on a rise below the step', () => {
    expect(evaluateSticky(sticky({ tier: 'hard' }), 'simple', false, { kind: 'open' }, 1)).toEqual({ action: 'keep' })
    expect(evaluateSticky(sticky(), 'standard', false, { kind: 'open' }, 2)).toEqual({ action: 'keep' })
    expect(evaluateSticky(sticky({ tier: undefined }), 'hard', false, { kind: 'probe' }, 1)).toEqual({ action: 'keep' })
  })

  it('breaks on a meaningful rise, a skip, and a missing vision route', () => {
    expect(evaluateSticky(sticky(), 'hard', false, { kind: 'open' }, 1)).toEqual({
      action: 'break', reason: 'tier-upgrade', detail: 'simple to hard',
    })
    expect(evaluateSticky(sticky(), 'simple', false, { kind: 'skip', cause: 'held' }, 1)).toMatchObject({ reason: 'route-held' })
    expect(evaluateSticky(sticky(), 'simple', false, { kind: 'skip', cause: 'unavailable' }, 1)).toMatchObject({ reason: 'route-unavailable' })
    expect(evaluateSticky(sticky(), 'simple', false, { kind: 'skip', cause: 'cooldown' }, 1)).toMatchObject({ reason: 'route-unhealthy' })
    expect(evaluateSticky(sticky(), 'simple', true, { kind: 'open' }, 1)).toMatchObject({ reason: 'needs-vision' })
    expect(evaluateSticky(sticky(), 'simple', false, { kind: 'skip', cause: 'budget' }, 1)).toMatchObject({ reason: 'budget' })
    expect(evaluateSticky(sticky(), 'simple', false, { kind: 'skip', cause: 'quota' }, 1)).toMatchObject({ reason: 'quota' })
  })

  it('names each break in a log clause and copies a selected target', () => {
    expect(stickyBreakText('tier-upgrade', 'simple to hard')).toContain('simple to hard')
    expect(stickyBreakText('route-unhealthy', 'p1/m1')).toContain('cooling down')
    expect(stickyBreakText('route-held', 'p1/m1')).toContain('quota')
    expect(stickyBreakText('route-unavailable', 'p1/m1')).toContain('configuration')
    expect(stickyBreakText('needs-vision', 'p1/m1')).toContain('image')
    expect(stickyBreakText('budget', 'p1/m1')).toContain('budget')
    expect(stickyBreakText('quota', 'p1/m1')).toContain('quota')
    const target: RouteTarget = { provider: 'p2', model: 'm2' }
    expect(stickyFromTarget(target, 'hard', true, 'hard').tier).toBe('hard')
  })
})
