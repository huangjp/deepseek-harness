/** What the browser half registers, when, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS } from '../src/client/index.ts'
import type { ModelRouterCardFace } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

/** One Host view of a served namespace. */
function view(ns: string, revision = 0) {
  return { ns, schema: {}, value: {}, applies: 'live', secrets: [], revision }
}

/** @param served - namespaces the Host describes; omitted answers a failed read. */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : { ok: true, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) } }))
  const modelCatalog = vi.fn(() => Promise.resolve({ ok: true, value: { groups: [], failures: [] } }))
  const remote = new TestRemote(ctx, {
    settings: { describe: describeSettings },
    session: { modelCatalog: modelCatalog },
  })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeSettings, remote, modelCatalog }
}

/** The Plugins page's item slot, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'plugins.item': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-model-router apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.session', 'configForms'])
  })

  it('registers the page while the Host serves the namespace, titled in the active locale', async () => {
    const { ctx, slots } = await bench(['model-router', 'shell'])
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const entry = slots.entries('plugins.item')[0]!
    expect(entry.options).toMatchObject({ id: 'model-router', order: 40 })
    expect(resolveSlotLabel(entry.options.label)).toBe('模型路由')
    expect(entry.locale).toBe(NS)
    const face = (entry.inject as () => Pick<ModelRouterCardFace, 'hooks'>)()
    expect(Object.keys(face.hooks)).toEqual(['modelRouterCard'])
  })

  it('registers nothing while the namespace is not served, and withdraws the page when the Host stops serving it', async () => {
    const { ctx, slots, describeSettings, remote } = await bench(['shell'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    expect(slots.entries('plugins.item')).toHaveLength(0)

    describeSettings.mockResolvedValue({
      ok: true, value: { writable: true, hasDocument: true, namespaces: [view('model-router', 1)] },
    })
    remote.emit('settings/document-updated', ['model-router', 1])
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })

    describeSettings.mockResolvedValue({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })
    remote.emit('settings/document-updated', ['model-router', 2])
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(0) })
  })

  it('collapses the page on teardown', async () => {
    const { ctx, slots } = await bench(['model-router'])
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })

    await fiber.dispose()

    expect(slots.entries('plugins.item')).toHaveLength(0)
  })

  it('reads the model directory again when the Host reports that the routes changed', async () => {
    const { ctx, remote, modelCatalog } = await bench(['model-router'])
    declareRoot(ctx.get('slots') as SlotRegistry)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(modelCatalog).toHaveBeenCalled() })
    const reads = modelCatalog.mock.calls.length

    remote.emit('llm/adapters-updated', [])
    remote.emit('settings/document-updated', ['model-router', 1])

    await vi.waitFor(() => { expect(modelCatalog.mock.calls.length).toBeGreaterThan(reads) })
  })
})
