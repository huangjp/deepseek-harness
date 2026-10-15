/**
 * What the browser half registers, the copy it registers under, and that the
 * whole contribution — including the status store's polling — leaves with the
 * fiber.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { LocalBridgeSectionInjected } from '../src/client/LocalBridgeSection.tsx'
import { LocalBridgeSection } from '../src/client/LocalBridgeSection.tsx'
import { apply as hostApply } from '../src/index.ts'

/**
 * The face members this spec drives. Picked from the injected face because the
 * registry erases `inject` to a record-returning function, and a mapped type is
 * the one shape an assertion from that erasure accepts.
 */
type SectionFace = Pick<LocalBridgeSectionInjected, 'hooks' | 'load' | 'refresh' | 't'>

/** Read the registered page's inject face. */
function faceOf(slots: SlotRegistry): SectionFace {
  const entry = slots.entries('settings.section')[0]
  if (entry === undefined) throw new Error('the settings section is not registered')
  return (entry.inject as (() => SectionFace) | undefined)!()
}

/** One status snapshot the stubbed transport answers. */
const status = {
  platform: 'win32',
  checkedAt: 1_000_000,
  refreshStartedAt: null,
  workbuddy: { relay: { port: 8787, listening: true }, app: { installed: true, running: true } },
  copilot: {
    relay: { port: 8899, listening: true },
    app: { installed: true, running: true },
    token: { present: true, harvestedAt: 940_000, ageSec: 60, stale: false },
    missing: [],
    mitmdump: null,
  },
}

afterEach(() => { vi.unstubAllGlobals() })

/** A client root carrying the slot registry and a locale at one language. */
async function bench(language: 'zh' | 'en' = 'zh') {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale(language)
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

/** The settings shell's page ledger, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-local-bridge apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers one page after the Models page, titled in the active locale', async () => {
    const { ctx, slots } = await bench('zh')
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const entries = slots.entries('settings.section')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.options).toMatchObject({ id: 'local-bridge', order: 20 })
    expect(resolveSlotLabel(entry.options.label)).toBe('本地模型服务')
    expect(entry.component).toBe(LocalBridgeSection)
  })

  it('retitles the page when the locale changes', async () => {
    const { ctx, slots, locale } = await bench('en')
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const label = (): string | undefined => resolveSlotLabel(slots.entries('settings.section')[0]!.options.label)
    expect(label()).toBe('Local model services')
    locale.setLocale('zh')
    await vi.waitFor(() => { expect(label()).toBe('本地模型服务') })
  })

  it('injects the page store, its two actions, and its copy', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify(status), { status: 200 })))
    vi.stubGlobal('fetch', fetcher)
    const face = faceOf(slots)
    expect(Object.keys(face).sort()).toEqual(['hooks', 'load', 'refresh', 't'])
    expect(face.t('title')).toBe('本地模型服务')

    await face.load()
    expect(fetcher).toHaveBeenCalledWith('local-bridge/status', { headers: { accept: 'application/json' } })
  })

  it('posts a refresh request through the same face', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      started: true, refusal: null, logFile: '/probe/auto-refresh.log',
    }), { status: 200 })))
    vi.stubGlobal('fetch', fetcher)
    const face = faceOf(slots)

    expect(await face.refresh()).toEqual({ started: true, refusal: null, logFile: '/probe/auto-refresh.log' })
    expect(fetcher).toHaveBeenNthCalledWith(1, 'local-bridge/refresh', { method: 'POST' })
  })

  it('collapses the page and stops its polling on teardown', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.section')).toHaveLength(1)
    const face = faceOf(slots)

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
    // The disposed store accepts no further read, so the page cannot resurrect
    // itself through a face a caller still holds.
    const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify(status), { status: 200 })))
    vi.stubGlobal('fetch', fetcher)
    await face.load()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
