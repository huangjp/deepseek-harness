// @vitest-environment jsdom
/** The model-router page as the Plugins page renders it: its switch, its knobs, and its table. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelRouterCard, type ModelRouterCardProps } from '../src/client/ModelRouterCard.tsx'
import type { ModelRouterCardState, RouteRule } from '../src/client/model-router-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

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
  { id: 'gamma', name: 'Gamma', models: [] },
]

/** One rule the card renders. */
function rule(overrides: Partial<RouteRule> = {}): RouteRule {
  return { name: 'translation', keywords: ['translate'], provider: 'alpha', model: 'alpha-fast', ...overrides }
}

/** The card's actions, as the registration side injects them. */
function actions() {
  return {
    toggleEnabled: vi.fn(),
    setFailureThreshold: vi.fn(),
    setCooldownMinutes: vi.fn(),
    addRule: vi.fn(),
    removeRule: vi.fn(),
    moveRule: vi.fn(),
    updateRule: vi.fn(),
    retryCatalog: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
  }
}

/** Render the card over one state. */
function renderCard(state: Partial<ModelRouterCardState> = {}, view: 'summary' | 'page' = 'page') {
  const store = createSnapshotStore<ModelRouterCardState>({
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    enabled: false,
    failureThresholdText: '2',
    cooldownMinutesText: '5',
    rules: [],
    providers: GROUPS,
    catalogStatus: 'ready',
    conflicted: false,
    ...state,
  })
  const face = actions()
  const props = { ...face, view, t, useModelRouterCard: bindSnapshotSelector(store) } as ModelRouterCardProps
  render(<ModelRouterCard {...props} />)
  return face
}

/** The rule editor inputs of one row. */
function rowInputs(index = 0) {
  const element = (suffix: string): HTMLElement => {
    const found = document.getElementById(`model-router-rule-${index}-${suffix}`)
    if (found === null) throw new Error(`no rule input named ${suffix}`)
    return found
  }
  const input = (suffix: string): HTMLInputElement => {
    const found = element(suffix)
    if (!(found instanceof HTMLInputElement)) throw new Error(`rule input ${suffix} is not an input`)
    return found
  }
  const select = (suffix: string): HTMLSelectElement => {
    const found = element(suffix)
    if (!(found instanceof HTMLSelectElement)) throw new Error(`rule input ${suffix} is not a select`)
    return found
  }
  return {
    name: input('name'),
    keywords: input('keywords'),
    condition: select('condition'),
    provider: select('provider'),
    model: select('model'),
    effort: select('effort'),
  }
}

describe('ModelRouterCard', () => {
  it('renders its one-liner alone in the summary view', () => {
    renderCard({}, 'summary')

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('says the plugin is not loaded while its namespace is unavailable', () => {
    renderCard({ available: false })

    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
  })

  it('disables every control while the document is read-only', () => {
    renderCard({ writable: false, rules: [rule()] })

    expect(screen.getByRole('status').textContent).toBe(en.readOnly)
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
    expect(rowInputs().name).toHaveProperty('disabled', true)
  })

  it('turns routing on and off', () => {
    const face = renderCard()

    fireEvent.click(screen.getByRole('switch'))

    expect(face.toggleEnabled).toHaveBeenCalledOnce()
  })

  it('stages the two health knobs', () => {
    const face = renderCard()

    fireEvent.change(screen.getByLabelText(en.failureThreshold), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText(en.cooldownMinutes), { target: { value: '9' } })

    expect(face.setFailureThreshold).toHaveBeenCalledWith('4')
    expect(face.setCooldownMinutes).toHaveBeenCalledWith('9')
  })

  it('reads the model directory while it loads, and offers a retry when it fails', () => {
    renderCard({ catalogStatus: 'loading' })

    expect(screen.getByRole('status').textContent).toBe(en.catalogLoading)
    cleanup()

    const face = renderCard({ catalogStatus: 'error' })
    fireEvent.click(screen.getByRole('button', { name: en.catalogRetry }))

    expect(face.retryCatalog).toHaveBeenCalledOnce()
  })

  it('says the deployment registers no route', () => {
    renderCard({ providers: [] })

    expect(screen.getByText(en.catalogEmpty)).toBeTruthy()
  })

  it('adds a row to the table', () => {
    const face = renderCard()

    fireEvent.click(screen.getByRole('button', { name: en.addRule }))

    expect(face.addRule).toHaveBeenCalledOnce()
  })

  it('edits the name and the keywords of one row', () => {
    const face = renderCard({ rules: [rule()] })

    fireEvent.change(rowInputs().name, { target: { value: 'renamed' } })
    fireEvent.change(rowInputs().keywords, { target: { value: 'translate, traduire , ' } })

    expect(face.updateRule).toHaveBeenCalledWith(0, { name: 'renamed' })
    expect(face.updateRule).toHaveBeenCalledWith(0, { keywords: ['translate', 'traduire'] })
  })

  it('states the attachment condition a row asks for', () => {
    const face = renderCard({ rules: [rule()] })

    fireEvent.change(rowInputs().condition, { target: { value: 'required' } })
    fireEvent.change(rowInputs().condition, { target: { value: 'forbidden' } })
    fireEvent.change(rowInputs().condition, { target: { value: 'any' } })

    expect(face.updateRule).toHaveBeenCalledWith(0, { hasImage: true })
    expect(face.updateRule).toHaveBeenCalledWith(0, { hasImage: false })
    expect(face.updateRule).toHaveBeenCalledWith(0, { hasImage: undefined })
  })

  it('picks the route and the model a row names', () => {
    const face = renderCard({ rules: [rule()] })

    fireEvent.change(rowInputs().provider, { target: { value: 'beta' } })
    fireEvent.change(rowInputs().model, { target: { value: 'alpha-think' } })

    expect(face.updateRule).toHaveBeenCalledWith(0, { provider: 'beta', model: 'beta-one', reasoningEffort: undefined })
    expect(face.updateRule).toHaveBeenCalledWith(0, { model: 'alpha-think', reasoningEffort: undefined })
  })

  it('leaves the model empty for a route that offers none', () => {
    const face = renderCard({ rules: [rule()] })

    fireEvent.change(rowInputs().provider, { target: { value: 'gamma' } })

    expect(face.updateRule).toHaveBeenCalledWith(0, { provider: 'gamma', model: '', reasoningEffort: undefined })
  })

  it('states the attachment condition a stored row asks for', () => {
    renderCard({ rules: [rule({ hasImage: true })] })
    expect(rowInputs().condition.value).toBe('required')
    cleanup()

    renderCard({ rules: [rule({ hasImage: false })] })
    expect(rowInputs().condition.value).toBe('forbidden')
    cleanup()

    renderCard({ rules: [rule()] })
    expect(rowInputs().condition.value).toBe('any')
  })

  it('keeps a route the directory no longer lists', () => {
    renderCard({ rules: [rule({ provider: 'gone', model: 'gone-one' })] })

    expect(screen.getByRole('option', { name: 'gone' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'gone-one' })).toBeTruthy()
  })

  it('picks the reasoning effort a model offers', () => {
    const face = renderCard({ rules: [rule({ model: 'alpha-think' })] })

    fireEvent.change(rowInputs().effort, { target: { value: 'high' } })
    fireEvent.change(rowInputs().effort, { target: { value: '' } })

    expect(face.updateRule).toHaveBeenCalledWith(0, { reasoningEffort: 'high' })
    expect(face.updateRule).toHaveBeenCalledWith(0, { reasoningEffort: undefined })
  })

  it('offers no effort when the model advertises none', () => {
    renderCard({ rules: [rule()] })

    expect(rowInputs().effort).toHaveProperty('disabled', true)
  })

  it('reorders and removes rows', () => {
    const face = renderCard({ rules: [rule({ name: 'first' }), rule({ name: 'second' })] })

    fireEvent.click(screen.getAllByRole('button', { name: en.moveUp })[1]!)
    fireEvent.click(screen.getAllByRole('button', { name: en.moveDown })[0]!)
    fireEvent.click(screen.getAllByRole('button', { name: en.removeRule })[0]!)

    expect(face.moveRule).toHaveBeenCalledWith(1, -1)
    expect(face.moveRule).toHaveBeenCalledWith(0, 1)
    expect(face.removeRule).toHaveBeenCalledWith(0)
  })

  it('says what a row still needs, and what a conflict is', () => {
    renderCard({ rules: [{ name: '', keywords: [], provider: '', model: '' }], invalid: true })

    expect(screen.getAllByText(en.invalidTable).length).toBeGreaterThan(0)
    cleanup()

    renderCard({ conflicted: true })
    expect(screen.getByText(en.conflict)).toBeTruthy()
  })

  it('saves the card', () => {
    const face = renderCard({ dirty: true })

    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(face.save).toHaveBeenCalledOnce()
  })
})
