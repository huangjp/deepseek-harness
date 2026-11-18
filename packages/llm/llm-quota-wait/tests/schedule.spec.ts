import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  QUOTA_PROBE_INITIAL_MS,
  QUOTA_PROBE_MAX_MS,
  QUOTA_RESET_GRACE_MS,
  cancellableDelay,
  scheduleQuotaWait,
} from '../src/schedule.ts'

const NOW = 1_000_000
const FIVE_HOURS = 5 * 60 * 60 * 1000
const WEEK = 7 * 24 * 60 * 60 * 1000

describe('scheduleQuotaWait', () => {
  it('waits until a 5-hour reset plus a short grace', () => {
    const resetAtMs = NOW + FIVE_HOURS
    expect(scheduleQuotaWait({ window: 'interval', resetAtMs }, NOW, 1)).toEqual({
      delayMs: FIVE_HOURS + QUOTA_RESET_GRACE_MS,
      window: 'interval',
      resumeAtMs: resetAtMs + QUOTA_RESET_GRACE_MS,
      probed: false,
    })
  })

  it('waits until a weekly reset when that window is binding', () => {
    const resetAtMs = NOW + WEEK
    expect(scheduleQuotaWait({ window: 'weekly', resetAtMs }, NOW, 4)).toEqual({
      delayMs: WEEK + QUOTA_RESET_GRACE_MS,
      window: 'weekly',
      resumeAtMs: resetAtMs + QUOTA_RESET_GRACE_MS,
      probed: false,
    })
  })

  it('retries immediately when the reported window opened inside the grace', () => {
    expect(scheduleQuotaWait({ window: 'interval', resetAtMs: NOW - QUOTA_RESET_GRACE_MS - 500 }, NOW, 1)).toMatchObject({
      delayMs: 0,
      window: 'interval',
      probed: false,
    })
  })

  it('probes with capped backoff when the clock is missing, stale, or absurd', () => {
    expect(scheduleQuotaWait(undefined, NOW, 1)).toEqual({
      delayMs: QUOTA_PROBE_INITIAL_MS,
      window: 'unknown',
      resumeAtMs: NOW + QUOTA_PROBE_INITIAL_MS,
      probed: true,
    })
    expect(scheduleQuotaWait({ window: 'unknown' }, NOW, 3).delayMs).toBe(QUOTA_PROBE_INITIAL_MS * 4)
    expect(scheduleQuotaWait({ window: 'unknown' }, NOW, 20).delayMs).toBe(QUOTA_PROBE_MAX_MS)
    expect(scheduleQuotaWait({ window: 'interval', resetAtMs: NOW - 10 * 60_000 }, NOW, 1).probed).toBe(true)
    expect(scheduleQuotaWait({
      window: 'weekly',
      resetAtMs: NOW + 30 * 24 * 60 * 60 * 1000,
    }, NOW, 2)).toMatchObject({ probed: true, delayMs: QUOTA_PROBE_INITIAL_MS * 2, window: 'unknown' })
  })
})

describe('cancellableDelay', () => {
  it('resolves after the delay and immediately for a zero delay', async () => {
    await expect(cancellableDelay(0, new AbortController().signal)).resolves.toBe(true)
    await expect(cancellableDelay(15, new AbortController().signal)).resolves.toBe(true)
  })

  it('returns false when the signal is already aborted or aborts during the wait', async () => {
    const aborted = new AbortController()
    aborted.abort()
    await expect(cancellableDelay(60_000, aborted.signal)).resolves.toBe(false)

    const live = new AbortController()
    const pending = cancellableDelay(60_000, live.signal)
    live.abort()
    await expect(pending).resolves.toBe(false)
  })

  it('splits a wait longer than one timer and replaces a non-positive cap', async () => {
    await expect(cancellableDelay(25, new AbortController().signal, 10)).resolves.toBe(true)
    await expect(cancellableDelay(5, new AbortController().signal, 0)).resolves.toBe(true)
    expect(MAX_TIMER_DELAY_MS).toBeGreaterThan(QUOTA_PROBE_MAX_MS)
  })
})
