/** The model router card's staged editor: what it shows, and what a save writes. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { RemoteError, stubConfigForm, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelCatalog, ModelProviderGroup, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import {
  ModelRouterCardController, type ModelRouterSettings, type RouteRule,
} from '../src/client/model-router-card-controller.ts'

/** One provider route the deployment registers. */
const GROUPS: ModelProviderGroup[] = [
  {
    id: 'alpha',
    name: 'Alpha',
    models: [
      { id: 'alpha-fast', name: 'Alpha Fast' },
      { id: 'alpha-think', name: 'Alpha Think', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
    ],
  },
  { id: 'beta', name: 'Beta', models: [{ id: 'beta-one', name: 'Beta One' }] },
]

/** A Host that accepts every write and republishes the accepted section. */
function acceptWrites<T>(host: ReturnType<typeof stubConfigForm<T>>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.mutate.mockImplementation((ops) => {
    const value = section()
    const user = layer()
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') {
        value[field] = op.value
        user[field] = op.value
      } else {
        Reflect.deleteProperty(user, field)
      }
    }
    host.publish({ value: value as T, user })
    return Promise.resolve(true)
  })
}

/** The controller under test, over a Host that already serves the namespace. */
function controller(value?: Partial<ModelRouterSettings>, writable = true) {
  const host = stubConfigForm<ModelRouterSettings>()
  acceptWrites(host)
  const ctx = new Context()
  const modelCatalog = vi.fn<() => Promise<RemoteResult<ModelCatalog>>>(() => Promise.resolve({
    ok: true,
    value: {
      default: { provider: 'alpha', model: 'alpha-fast' },
      defaultRoutingMode: 'auto',
      routingAvailable: true,
      routableProviders: ['alpha', 'beta'],
      groups: GROUPS,
      failures: [],
    },
  }))
  new TestRemote(ctx, { session: { modelCatalog } })
  const card = new ModelRouterCardController(host.scope, ctx)
  host.publish({ status: 'ready', writable, value: value ?? {}, base: value ?? {}, user: value ?? {}, revision: 7 })
  return { host, card, face: card.inject(), modelCatalog }
}

/** One stored rule the Host hands the card. */
function storedRule(overrides: Partial<RouteRule> = {}): RouteRule {
  return {
    name: 'translation',
    keywords: ['translate'],
    provider: 'alpha',
    model: 'alpha-fast',
    ...overrides,
  }
}

describe('ModelRouterCardController', () => {
  it('shows the stored table and the registered routes', async () => {
    const { face } = controller({ enabled: true, rules: [storedRule()], failureThreshold: 3, cooldownMs: 600_000 })

    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().catalogStatus).toBe('ready') })

    const state = face.hooks.modelRouterCard.getSnapshot()
    expect(state.enabled).toBe(true)
    expect(state.rules).toHaveLength(1)
    expect(state.failureThresholdText).toBe('3')
    expect(state.cooldownMinutesText).toBe('10')
    expect(state.providers.map(group => group.id)).toEqual(['alpha', 'beta'])
    expect(state.dirty).toBe(false)
  })

  it('stages the enabled toggle without writing', () => {
    const { host, face } = controller({ enabled: false })

    face.toggleEnabled()

    expect(face.hooks.modelRouterCard.getSnapshot().enabled).toBe(true)
    expect(face.hooks.modelRouterCard.getSnapshot().dirty).toBe(true)
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('adds, reorders, and removes rows in the draft', () => {
    const { face } = controller({ rules: [storedRule({ name: 'first' }), storedRule({ name: 'second' })] })

    face.addRule()
    expect(face.hooks.modelRouterCard.getSnapshot().rules).toHaveLength(3)

    face.moveRule(2, -1)
    expect(face.hooks.modelRouterCard.getSnapshot().rules.map(rule => rule.name)).toEqual(['first', '', 'second'])

    face.removeRule(1)
    expect(face.hooks.modelRouterCard.getSnapshot().rules.map(rule => rule.name)).toEqual(['first', 'second'])
  })

  it('edits one row and drops the condition the edit clears', () => {
    const { face } = controller({ rules: [storedRule({ hasImage: true, reasoningEffort: 'high' })] })

    face.updateRule(0, { name: 'renamed' })
    face.updateRule(0, { hasImage: undefined })
    face.updateRule(0, { reasoningEffort: undefined })

    const rule = face.hooks.modelRouterCard.getSnapshot().rules[0]
    expect(rule?.name).toBe('renamed')
    expect(rule).not.toHaveProperty('hasImage')
    expect(rule).not.toHaveProperty('reasoningEffort')
  })

  it('edits the route, the model, and the effort of one row', () => {
    const { face } = controller({ rules: [storedRule()] })

    face.updateRule(0, { provider: 'beta' })
    face.updateRule(0, { model: 'beta-one' })
    face.updateRule(0, { reasoningEffort: 'high' })
    face.updateRule(0, { hasImage: true })

    expect(face.hooks.modelRouterCard.getSnapshot().rules[0]).toEqual({
      name: 'translation',
      keywords: ['translate'],
      provider: 'beta',
      model: 'beta-one',
      reasoningEffort: 'high',
      hasImage: true,
    })
  })

  it('writes the whole table and the health knobs in one revision-fenced mutation', async () => {
    const { host, face } = controller({ enabled: false, rules: [storedRule()] })

    face.toggleEnabled()
    face.setFailureThreshold('5')
    face.setCooldownMinutes('3')
    face.updateRule(0, { keywords: ['translate', 'traduire'] })
    face.save()

    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalled() })
    expect(host.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['failureThreshold'], value: 5 },
      { op: 'set', path: ['cooldownMs'], value: 180_000 },
      {
        op: 'set',
        path: ['rules'],
        value: [{ name: 'translation', keywords: ['translate', 'traduire'], provider: 'alpha', model: 'alpha-fast' }],
      },
    ], 7)
    expect(face.hooks.modelRouterCard.getSnapshot().dirty).toBe(false)
  })

  it('keeps a cooldown the deployment stored in an unusual unit', async () => {
    const { host, face } = controller({ cooldownMs: 90_000 })

    face.toggleEnabled()
    face.save()

    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalled() })
    expect(host.mutate).toHaveBeenCalledWith(expect.arrayContaining([
      { op: 'set', path: ['cooldownMs'], value: 90_000 },
    ]), 7)
  })

  it('writes nothing when the card holds no edit', async () => {
    const { host, face } = controller({ rules: [storedRule()] })

    face.save()

    await Promise.resolve()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('blocks the save while a rule names no route or states no condition', () => {
    const { host, face } = controller({ rules: [{ name: '', keywords: [], provider: '', model: '' }] })

    expect(face.hooks.modelRouterCard.getSnapshot().invalid).toBe(true)
    face.save()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('accepts a rule that states only an attachment condition', () => {
    const { face } = controller({ rules: [storedRule({ keywords: [], hasImage: true })] })

    expect(face.hooks.modelRouterCard.getSnapshot().invalid).toBe(false)
  })

  it('blocks the save while a health knob is not a whole number', () => {
    const { host, face } = controller()

    face.setFailureThreshold('many')
    expect(face.hooks.modelRouterCard.getSnapshot().invalid).toBe(true)
    face.save()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('blocks the save while a health knob is empty', () => {
    const { host, face } = controller()

    face.setFailureThreshold('')
    expect(face.hooks.modelRouterCard.getSnapshot().invalid).toBe(true)
    face.save()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('blocks the save while the cooldown is not a whole number of minutes', () => {
    const { host, face } = controller()

    face.setCooldownMinutes('')
    expect(face.hooks.modelRouterCard.getSnapshot().invalid).toBe(true)
    face.save()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('reports a read-only document so the card can disable its controls', () => {
    const { face } = controller({}, false)

    expect(face.hooks.modelRouterCard.getSnapshot().writable).toBe(false)
  })

  it('refuses every edit while the document is read-only', () => {
    const { host, face } = controller({ rules: [storedRule()] }, false)

    face.toggleEnabled()
    face.setFailureThreshold('4')
    face.setCooldownMinutes('4')
    face.addRule()
    face.removeRule(0)
    face.moveRule(0, 1)
    face.updateRule(0, { name: 'renamed' })
    face.save()

    const state = face.hooks.modelRouterCard.getSnapshot()
    expect(state.dirty).toBe(false)
    expect(state.rules).toHaveLength(1)
    expect(state.rules[0]?.name).toBe('translation')
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('ignores a row the table does not hold', () => {
    const { face } = controller({ rules: [storedRule()] })

    face.removeRule(5)
    face.removeRule(-1)
    face.moveRule(5, 1)
    face.moveRule(0, -1)
    face.updateRule(5, { name: 'renamed' })

    expect(face.hooks.modelRouterCard.getSnapshot().rules).toHaveLength(1)
    expect(face.hooks.modelRouterCard.getSnapshot().rules[0]?.name).toBe('translation')
  })

  it('keeps the draft and says so when the Host changes underneath it', () => {
    const { host, face } = controller({ rules: [storedRule()] })

    face.updateRule(0, { name: 'mine' })
    host.publish({ revision: 8, value: { rules: [storedRule({ name: 'theirs' })] }, user: { rules: [storedRule({ name: 'theirs' })] } })

    const state = face.hooks.modelRouterCard.getSnapshot()
    expect(state.conflicted).toBe(true)
    expect(state.rules[0]?.name).toBe('mine')
  })

  it('drops the draft when the Host stored the same table', () => {
    const { host, face } = controller({ rules: [storedRule()] })

    face.updateRule(0, { name: 'translation' })
    host.publish({ revision: 8 })

    expect(face.hooks.modelRouterCard.getSnapshot().conflicted).toBe(false)
    expect(face.hooks.modelRouterCard.getSnapshot().dirty).toBe(false)
  })

  it('drops the draft when the user discards it', () => {
    const { face } = controller({ rules: [storedRule()] })

    face.updateRule(0, { name: 'mine' })
    face.discard()

    const state = face.hooks.modelRouterCard.getSnapshot()
    expect(state.dirty).toBe(false)
    expect(state.rules[0]?.name).toBe('translation')
  })

  it('reads the model directory again when asked', async () => {
    const { face, modelCatalog } = controller()

    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().catalogStatus).toBe('ready') })
    const reads = modelCatalog.mock.calls.length

    face.retryCatalog()

    await vi.waitFor(() => { expect(modelCatalog.mock.calls.length).toBeGreaterThan(reads) })
  })

  it('says the model directory could not be read', async () => {
    const { modelCatalog, face } = controller()
    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().catalogStatus).toBe('ready') })
    modelCatalog.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) })

    face.retryCatalog()

    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().catalogStatus).toBe('error') })
  })

  it('says the model directory failed', async () => {
    const { modelCatalog, face } = controller()
    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().catalogStatus).toBe('ready') })
    modelCatalog.mockRejectedValue(new RemoteError('gateway/internal', 'no provider', {}))

    face.retryCatalog()

    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().catalogStatus).toBe('error') })
  })

  it('keeps the last directory when a refresh is overtaken by a newer one', async () => {
    const { card, face, modelCatalog } = controller()
    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().catalogStatus).toBe('ready') })

    face.retryCatalog()
    card.refreshCatalog()

    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().catalogStatus).toBe('ready') })
    expect(modelCatalog.mock.calls.length).toBeGreaterThan(1)
  })

  it('does not read the directory twice at once', async () => {
    const { face, modelCatalog } = controller()

    face.retryCatalog()

    expect(modelCatalog.mock.calls.length).toBe(1)
    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().catalogStatus).toBe('ready') })
  })

  it('drops a directory read that outlives the card', async () => {
    const { card, face, modelCatalog } = controller()
    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().catalogStatus).toBe('ready') })
    modelCatalog.mockRejectedValue(new RemoteError('gateway/internal', 'no provider', {}))

    face.retryCatalog()
    card.dispose()

    await Promise.resolve()
    await Promise.resolve()
    expect(face.hooks.modelRouterCard.getSnapshot().catalogStatus).not.toBe('error')
  })

  it('drops a save that outlives the card when the write fails', async () => {
    const { card, face, host } = controller({ rules: [storedRule()] })
    host.mutate.mockRejectedValue(new Error('transport'))

    face.updateRule(0, { name: 'mine' })
    face.save()
    card.dispose()

    await Promise.resolve()
    await Promise.resolve()
    expect(face.hooks.modelRouterCard.getSnapshot().failed).toBe(false)
  })

  it('edits one row and leaves the others alone', () => {
    const { face } = controller({ rules: [storedRule({ name: 'first' }), storedRule({ name: 'second' })] })

    face.updateRule(0, { name: 'renamed' })

    expect(face.hooks.modelRouterCard.getSnapshot().rules.map(rule => rule.name)).toEqual(['renamed', 'second'])
  })

  it('reports a save the Host refused', async () => {
    const { host, face } = controller({ rules: [storedRule()] })
    host.mutate.mockResolvedValue(false)

    face.updateRule(0, { name: 'mine' })
    face.save()

    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().failed).toBe(true) })
    expect(face.hooks.modelRouterCard.getSnapshot().dirty).toBe(true)
  })

  it('reports a save that could not be sent', async () => {
    const { host, face } = controller({ rules: [storedRule()] })
    host.mutate.mockRejectedValue(new Error('transport'))

    face.updateRule(0, { name: 'mine' })
    face.save()

    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().failed).toBe(true) })
  })

  it('reads a rule the Host stored in a shape the card does not expect', () => {
    const { face } = controller({
      rules: [{ name: 5, keywords: 'translate', provider: 7, model: 9, reasoningEffort: 'high' }] as unknown as RouteRule[],
    })

    expect(face.hooks.modelRouterCard.getSnapshot().rules[0]).toEqual({
      name: '',
      keywords: [],
      provider: '',
      model: '',
      reasoningEffort: 'high',
    })
  })

  it('keeps the draft while a save is in flight', async () => {
    const { host, face } = controller({ rules: [storedRule()] })
    let settle: ((accepted: boolean) => void) | undefined
    host.mutate.mockImplementation(() => new Promise<boolean>((resolve) => { settle = resolve }))

    face.updateRule(0, { name: 'mine' })
    face.save()
    face.discard()

    expect(face.hooks.modelRouterCard.getSnapshot().rules[0]?.name).toBe('mine')
    settle?.(true)
    await vi.waitFor(() => { expect(face.hooks.modelRouterCard.getSnapshot().saving).toBe(false) })
  })

  it('stops observing the settings once it is disposed', async () => {
    const { card, face, modelCatalog } = controller()
    const reads = modelCatalog.mock.calls.length

    card.dispose()
    card.refreshCatalog()
    face.addRule()

    await Promise.resolve()
    expect(modelCatalog.mock.calls.length).toBe(reads)
    expect(face.hooks.modelRouterCard.getSnapshot().rules).toHaveLength(0)
  })

  it('drops a save that outlives the card', async () => {
    const { card, face, host } = controller({ rules: [storedRule()] })
    let settle: ((accepted: boolean) => void) | undefined
    host.mutate.mockImplementation(() => new Promise<boolean>((resolve) => { settle = resolve }))

    face.updateRule(0, { name: 'mine' })
    face.save()
    card.dispose()
    settle?.(true)

    await Promise.resolve()
    expect(face.hooks.modelRouterCard.getSnapshot().failed).toBe(false)
  })
})
