// @vitest-environment jsdom
/**
 * The local-model-relay page as the settings shell renders it: both relay
 * cards, the token's age, the refresh requirements with their remedies, and the
 * one confirmed refresh action with its progress notices.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { LocalBridgeRefreshPayload, LocalBridgeStatusPayload } from '@deepseek-ai/dsh-host-local-bridge/shared'
import { LocalBridgeSection, type LocalBridgeSectionProps } from '../src/client/LocalBridgeSection.tsx'
import type { LocalBridgePageState } from '../src/client/controller.ts'
import { NS } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

// The page reads its copy through the real locale engine, so this spec also
// covers the dictionary's `{count}` templates as they are substituted.
const locale = new LocaleRuntime(new Context())
locale.setLocale('en')
locale.register(NS, { zh, en })
const t = locale.bind(NS)

/** One status snapshot the page renders, overridable per test. */
function status(overrides: {
  platform?: string
  checkedAt?: number
  refreshStartedAt?: number | null
  listening?: boolean
  appRunning?: boolean
  appInstalled?: boolean
  missing?: readonly ('mitmdump' | 'harvester' | 'upstream-proxy' | 'ca')[]
  mitmdump?: string | null
  token?: { present: boolean; harvestedAt: number | null; ageSec: number | null; stale: boolean }
} = {}): LocalBridgeStatusPayload {
  const app = { installed: overrides.appInstalled ?? true, running: overrides.appRunning ?? true }
  return {
    platform: overrides.platform ?? 'win32',
    checkedAt: overrides.checkedAt ?? 1_000_000,
    refreshStartedAt: overrides.refreshStartedAt ?? null,
    workbuddy: { relay: { port: 8787, listening: overrides.listening ?? true }, app },
    copilot: {
      relay: { port: 8899, listening: overrides.listening ?? true },
      app,
      token: overrides.token ?? { present: true, harvestedAt: 940_000, ageSec: 60, stale: false },
      missing: overrides.missing ?? [],
      mitmdump: overrides.mitmdump === undefined ? 'C:/python/Scripts/mitmdump.exe' : overrides.mitmdump,
    },
  }
}

/** The three actions the page calls, each a mock the test can inspect. */
function actions(overrides: {
  load?: () => Promise<void>
  refresh?: () => Promise<LocalBridgeRefreshPayload | null>
} = {}) {
  return {
    load: vi.fn(overrides.load ?? (() => Promise.resolve())),
    refresh: vi.fn(overrides.refresh ?? (() => Promise.resolve<LocalBridgeRefreshPayload | null>(null))),
    t,
  }
}

/** Render the page over one store, with actions the test can inspect. */
function renderPage(state: LocalBridgePageState, overrides: Parameters<typeof actions>[0] = {}) {
  const store = createSnapshotStore<LocalBridgePageState>(state)
  const bound = actions(overrides)
  render(<LocalBridgeSection {...bound} usePage={bindSnapshotSelector(store)} />)
  return { store, ...bound }
}

describe('LocalBridgeSection injection', () => {
  it('renders nothing until every injected member has arrived', () => {
    const store = createSnapshotStore<LocalBridgePageState>({ phase: 'loading' })
    const usePage = bindSnapshotSelector(store)
    const bound = actions()
    // Each partial omits exactly one member, so every guard operand decides once.
    const partials: readonly LocalBridgeSectionProps[] = [
      { load: bound.load, refresh: bound.refresh, t },
      { usePage, refresh: bound.refresh, t },
      { usePage, load: bound.load, t },
      { usePage, load: bound.load, refresh: bound.refresh },
    ]
    for (const partial of partials) {
      const { container, unmount } = render(<LocalBridgeSection {...partial} />)
      expect(container.innerHTML).toBe('')
      unmount()
    }
  })
})

describe('LocalBridgeSection states', () => {
  it('shows a bare loader while the first read is outstanding', () => {
    const { load } = renderPage({ phase: 'loading' })
    expect(load).toHaveBeenCalled()
    expect(screen.getByText(en.title)).toBeTruthy()
    expect(screen.queryByText(en.workbuddy)).toBeNull()
  })

  it('reports a read that never arrived, and re-reads on demand', () => {
    const { load } = renderPage({ phase: 'failed' })
    expect(screen.getByText(en.loadFailed)).toBeTruthy()
    load.mockClear()

    fireEvent.click(screen.getByRole('button', { name: en.recheck }))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('renders both relays with their listeners and applications', () => {
    renderPage({ phase: 'ready', status: status({ listening: false, appRunning: false }) })

    expect(screen.getByText(en.workbuddy)).toBeTruthy()
    expect(screen.getByText(en.copilot)).toBeTruthy()
    expect(screen.getByText('8787')).toBeTruthy()
    expect(screen.getByText('8899')).toBeTruthy()
    expect(screen.getAllByText(en.listeningOff)).toHaveLength(2)
    expect(screen.getAllByText(en.appStopped)).toHaveLength(2)
  })

  it('names an application that is not installed apart from one merely stopped', () => {
    renderPage({ phase: 'ready', status: status({ appInstalled: false, appRunning: false }) })
    expect(screen.getAllByText(en.appMissing)).toHaveLength(2)
  })

  it('warns that the relays are Windows-only elsewhere and offers no refresh', () => {
    renderPage({ phase: 'ready', status: status({ platform: 'darwin' }) })
    expect(screen.getByText(en.unsupported)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.refresh })).toHaveProperty('disabled', true)
  })
})

describe('LocalBridgeSection token age', () => {
  it('reports a token that was never harvested', () => {
    renderPage({
      phase: 'ready',
      status: status({ token: { present: false, harvestedAt: null, ageSec: null, stale: true } }),
    })
    expect(screen.getByText(en.tokenMissing)).toBeTruthy()
  })

  it.each([
    ['moments', 30_000, en.ageJustNow],
    ['minutes', 30 * 60_000, en.ageMinutes.replace('{count}', '30')],
    ['hours', 5 * 3_600_000, en.ageHours.replace('{count}', '5')],
    ['days', 3 * 86_400_000, en.ageDays.replace('{count}', '3')],
    ['months', 60 * 86_400_000, en.ageMonths.replace('{count}', '2')],
    ['years', 400 * 86_400_000, en.ageYears.replace('{count}', '1')],
  ])('localizes the %s bucket', (_bucket, age, copy) => {
    const checkedAt = 500_000_000_000
    renderPage({
      phase: 'ready',
      status: status({ checkedAt, token: { present: true, harvestedAt: checkedAt - age, ageSec: age / 1000, stale: false } }),
    })
    expect(screen.getByText(new RegExp(copy, 'u'))).toBeTruthy()
  })

  it('reports an expired token beside its age', () => {
    renderPage({
      phase: 'ready',
      status: status({ token: { present: true, harvestedAt: 940_000, ageSec: 60, stale: true } }),
    })
    expect(screen.getByText(new RegExp(en.tokenStale, 'u'))).toBeTruthy()
  })

  it('reports a valid token beside its age', () => {
    renderPage({ phase: 'ready', status: status() })
    expect(screen.getByText(new RegExp(en.tokenFresh, 'u'))).toBeTruthy()
  })
})

describe('LocalBridgeSection requirements', () => {
  it('lists every requirement as ready when the host reports none missing', () => {
    renderPage({ phase: 'ready', status: status() })
    expect(screen.getAllByText(en.prereqReady)).toHaveLength(4)
    expect(screen.queryByText(en.prereqMissing)).toBeNull()
    expect(screen.getByText('C:/python/Scripts/mitmdump.exe')).toBeTruthy()
  })

  it('marks each unmet requirement and prints its remedy', () => {
    renderPage({
      phase: 'ready',
      status: status({ missing: ['mitmdump', 'harvester', 'upstream-proxy', 'ca'], mitmdump: null }),
    })
    expect(screen.getAllByText(en.prereqMissing)).toHaveLength(4)
    expect(screen.getByText(en.guidanceMitmdump)).toBeTruthy()
    expect(screen.getByText(en.guidanceHarvester)).toBeTruthy()
    expect(screen.getByText(en.guidanceUpstreamProxy)).toBeTruthy()
    expect(screen.getByText(en.guidanceCa)).toBeTruthy()
    // Without a resolved executable there is no path to show.
    expect(screen.queryByText('C:/python/Scripts/mitmdump.exe')).toBeNull()
  })
})

describe('LocalBridgeSection refresh action', () => {
  it.each([
    ['a ready machine', status(), true],
    ['a stopped Copilot', status({ appRunning: false }), false],
    ['an unmet requirement', status({ missing: ['ca'] }), false],
    ['a listener that is down', status({ listening: false }), true],
    [
      'an attempt already running',
      status({ refreshStartedAt: 1_000_000, token: { present: true, harvestedAt: 940_000, ageSec: 60, stale: false } }),
      false,
    ],
  ])('offers the action on %s only when the host would accept it', (_case, state, enabled) => {
    renderPage({ phase: 'ready', status: state })
    // Only a running attempt renames the action; a blocked one keeps its name.
    const running = state.refreshStartedAt !== null
    expect(screen.getByRole('button', { name: running ? en.refreshing : en.refresh }))
      .toHaveProperty('disabled', !enabled)
  })

  it('describes a running attempt on the page', () => {
    renderPage({
      phase: 'ready',
      status: status({
        refreshStartedAt: 1_000_000,
        token: { present: true, harvestedAt: 940_000, ageSec: 60, stale: false },
      }),
    })
    expect(screen.getByText(en.refreshRunning)).toBeTruthy()
  })

  it('asks for confirmation before starting, and starts nothing on cancel', async () => {
    const refresh = vi.fn(() => Promise.resolve<LocalBridgeRefreshPayload | null>(null))
    renderPage({ phase: 'ready', status: status() }, { refresh })

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(screen.getByText(en.confirmBody)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(refresh).not.toHaveBeenCalled()
    await waitFor(() => { expect(screen.queryByText(en.confirmBody)).toBeNull() })
  })

  it('closes the confirmation from the modal\'s own control', async () => {
    const refresh = vi.fn(() => Promise.resolve<LocalBridgeRefreshPayload | null>(null))
    renderPage({ phase: 'ready', status: status() }, { refresh })

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(refresh).not.toHaveBeenCalled()
    await waitFor(() => { expect(screen.queryByText(en.confirmBody)).toBeNull() })
  })

  it('starts nothing when the snapshot fails while the confirmation is open', async () => {
    const refresh = vi.fn(() => Promise.resolve<LocalBridgeRefreshPayload | null>(null))
    const { store } = renderPage({ phase: 'ready', status: status() }, { refresh })

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    // A background re-read can fail while the dialog is open; confirming then
    // has no token to compare against, and must not invent one.
    store.set({ phase: 'failed' })
    await waitFor(() => { expect(screen.queryByText(en.workbuddy)).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })
  })

  it('reports a started attempt, then its success once a newer token lands', async () => {
    const refresh = vi.fn(() => Promise.resolve<LocalBridgeRefreshPayload | null>({
      started: true, refusal: null, logFile: '/probe/auto-refresh.log',
    }))
    const { store } = renderPage({ phase: 'ready', status: status() }, { refresh })

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(screen.getByText(en.refreshRunning)).toBeTruthy() })

    store.set({
      phase: 'ready',
      status: status({
        refreshStartedAt: null,
        token: { present: true, harvestedAt: 1_030_000, ageSec: 0, stale: false },
      }),
    })
    await waitFor(() => { expect(screen.getByText(en.refreshDone)).toBeTruthy() })
  })

  it('reports a started attempt that produced no new token', async () => {
    const refresh = vi.fn(() => Promise.resolve<LocalBridgeRefreshPayload | null>({
      started: true, refusal: null, logFile: null,
    }))
    const { store } = renderPage({ phase: 'ready', status: status() }, { refresh })

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })

    store.set({ phase: 'ready', status: status({ refreshStartedAt: null }) })
    await waitFor(() => { expect(screen.getByText(en.refreshFailed)).toBeTruthy() })
  })

  it('reports an attempt started where the page never had a token at all', async () => {
    const absent = { present: false, harvestedAt: null, ageSec: null, stale: true }
    const refresh = vi.fn(() => Promise.resolve<LocalBridgeRefreshPayload | null>({
      started: true, refusal: null, logFile: null,
    }))
    const { store } = renderPage({ phase: 'ready', status: status({ token: absent }) }, { refresh })

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })

    store.set({ phase: 'ready', status: status({ refreshStartedAt: null, token: absent }) })
    await waitFor(() => { expect(screen.getByText(en.refreshFailed)).toBeTruthy() })
  })

  it.each([
    ['copilot-not-running', en.refusalCopilotNotRunning],
    ['prerequisites-missing', en.refusalPrerequisitesMissing],
    ['busy', en.refusalBusy],
    ['script-missing', en.refusalScriptMissing],
    ['spawn-failed', en.refusalSpawnFailed],
    ['unsupported-platform', en.refusalUnsupportedPlatform],
  ] as const)('names the %s refusal', async (refusal, copy) => {
    const refresh = vi.fn(() => Promise.resolve<LocalBridgeRefreshPayload | null>({
      started: false, refusal, logFile: null,
    }))
    renderPage({ phase: 'ready', status: status() }, { refresh })

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await waitFor(() => { expect(screen.getByText(copy)).toBeTruthy() })
  })

  it('treats a refusal with no code as a process that would not start', async () => {
    const refresh = vi.fn(() => Promise.resolve<LocalBridgeRefreshPayload | null>({
      started: false, refusal: null, logFile: null,
    }))
    renderPage({ phase: 'ready', status: status() }, { refresh })

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await waitFor(() => { expect(screen.getByText(en.refusalSpawnFailed)).toBeTruthy() })
  })

  it('reports a request that never reached the host', async () => {
    const refresh = vi.fn(() => Promise.resolve<LocalBridgeRefreshPayload | null>(null))
    renderPage({ phase: 'ready', status: status() }, { refresh })

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await waitFor(() => { expect(screen.getByText(en.loadFailed)).toBeTruthy() })
  })
})
