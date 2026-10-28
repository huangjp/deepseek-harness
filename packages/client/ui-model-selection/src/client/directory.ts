/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and composer seat combine one shared Host catalog with the
 * Session's durable selection projection, then submit through the same
 * selectModel call. A switch made in either entry updates this shared state.
 */
import type { ModelSelectionProjection, RoutingMode } from '@deepseek-ai/dsh-agent/types'
import type { TrackProductEvent } from '@deepseek-ai/dsh-client-product-analytics/client'
import type {
  ModelCatalogFailure, ModelProviderGroup, ModelSelection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalogDirectory } from './catalog.ts'

/**
 * The change one selection request submitted, until the Host confirms it.
 *
 * A request either pins a route (the mode becomes `fixed`) or only changes the
 * routing mode (the mode becomes `auto` and the route stays as it was).
 */
export interface PendingModelChange {
  /** Routing mode the request applies. */
  readonly mode: RoutingMode
  /** Model the request pins; null when it only changes the routing mode. */
  readonly selection: ModelSelection | null
}

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Saved selection, retained even when its provider or model leaves the catalog. */
  current: ModelSelection | null
  /** Saved effort caption retained when the selected model is unavailable. */
  retainedEffort?: string
  /** Whether the current selection is present in the available catalog; null while unresolved. */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Change submitted by the latest `select` until it settles; null otherwise. */
  pending: PendingModelChange | null
  /** Whole-request or selection failure text; null when none. */
  error: string | null
  /**
   * Routing mode the session follows.
   *
   * `auto` lets the Host pick the route per task; `fixed` pins the session to
   * the model it selected, and no router may override it.
   */
  routingMode: RoutingMode
  /** Whether the deployment offers automatic routing, so the seat may offer it. */
  routingAvailable: boolean
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null,
    routingMode: 'auto', routingAvailable: false,
  })

  /** Latest selection operation wins; an older response never overwrites a newer one. */
  private generation = 0
  private disposed = false
  private readonly unsubscribeCatalog: () => void
  private readonly unsubscribeSelection: () => void

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   * @param catalog - Host-generation catalog shared by every Session.
   * @param projected - durable model selection projected from Session history.
   * @param isBlank - whether this Session has no first message yet.
   * @param track - desktop-only callback after a successful user selection.
   */
  constructor(
    private readonly sessions: Pick<TypertClientRemote['session'], 'selectModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
    private readonly catalog: ModelCatalogDirectory,
    private readonly projected: ObservableSnapshot<unknown>,
    private readonly isBlank: () => boolean,
    private readonly track?: TrackProductEvent,
  ) {
    this.unsubscribeCatalog = catalog.store.subscribe(() => { this.syncInputs() })
    this.unsubscribeSelection = projected.subscribe(() => { this.syncInputs() })
    this.syncInputs()
  }

  /**
   * Ensure the Host generation's shared available catalog is loaded.
   * @returns the fresh directory value.
   */
  async load(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    await this.catalog.load()
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /**
   * Select the complete provider/model/reasoning selection. The durable
   * projection frame updates the shared current; failures surface on the store
   * and return with the operation so each entry can present its own failure.
   *
   * Naming a route pins it: the session switches to the `fixed` routing mode,
   * so no router may answer with another route.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
   * @returns the selection outcome, including the original Remote failure.
   */
  async select(selection: ModelSelection): Promise<RemoteResult<void>> {
    this.assertAvailable()
    const previous = this.store.getSnapshot().current
    const previousEffort = previous?.reasoningEffort ?? (previous === null ? undefined : this.catalog.reasoningFor(previous)?.defaultEffort)
    const nextEffort = selection.reasoningEffort ?? this.catalog.reasoningFor(selection)?.defaultEffort
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'selecting'; s.pending = { mode: 'fixed', selection }; s.error = null })
    const result = await this.sessions.selectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    })
    if (this.disposed || generation !== this.generation) {
      return result.ok ? { ok: true, value: undefined } : result
    }
    if (!result.ok) {
      this.store.update((s) => {
        s.status = 'error'
        s.pending = null
        s.error = `${result.error.code}: ${result.error.message}`
      })
      return result
    }
    if (previous !== null) {
      const from = `${previous.provider}/${previous.model}`
      const to = `${selection.provider}/${selection.model}`
      if (from !== to) this.track?.('model_switch', { ...this.isBlank() ? {} : { session_id: this.sessionId }, switch_from: from, switch_to: to })
      if (from === to && previousEffort !== nextEffort) this.track?.('thinking_level_switch', {
        ...this.isBlank() ? {} : { session_id: this.sessionId }, model_name: to, switch_from: previousEffort ?? 'default', switch_to: nextEffort ?? 'default',
      })
    }
    this.store.update((s) => { s.status = 'ready'; s.pending = null; s.error = null })
    this.syncInputs()
    return { ok: true, value: undefined }
  }

  /**
   * Switch the session to automatic routing, where the Host picks the route
   * per task. The route the session already uses stays as the fallback for a
   * task no rule covers.
   * @returns the selection outcome, including the original Remote failure.
   */
  async selectAuto(): Promise<RemoteResult<void>> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'selecting'; s.pending = { mode: 'auto', selection: null }; s.error = null })
    const result = await this.sessions.selectModel({ sessionId: this.sessionId, routingMode: 'auto' })
    if (this.disposed || generation !== this.generation) {
      return result.ok ? { ok: true, value: undefined } : result
    }
    if (!result.ok) {
      this.store.update((s) => {
        s.status = 'error'
        s.pending = null
        s.error = `${result.error.code}: ${result.error.message}`
      })
      return result
    }
    this.store.update((s) => { s.status = 'ready'; s.pending = null; s.error = null })
    this.syncInputs()
    return { ok: true, value: undefined }
  }

  /**
   * Invalidate an in-flight selection response from the previous Host generation.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.store.update((state) => {
      if (state.status === 'selecting') state.status = 'idle'
      state.pending = null
      state.error = null
    })
    this.syncInputs()
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeSelection()
    this.unsubscribeCatalog()
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }

  private syncInputs(): void {
    if (this.disposed) return
    const catalog = this.catalog.store.getSnapshot()
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    const intended = projected?.next ?? catalog.value?.default
    const reasoning = intended === undefined ? undefined : this.catalog.reasoningFor(intended)
    const effort = intended?.reasoningEffort ?? reasoning?.defaultEffort
    const retainedEffort = effort === undefined ? undefined
      : reasoning?.efforts.find(level => level.id === effort)?.name ?? effort
    // The session's own mode wins; a session that recorded none follows the
    // deployment's default mode.
    const routingMode: RoutingMode = projected?.routingMode ?? catalog.value?.defaultRoutingMode ?? 'auto'
    const routingAvailable = catalog.value?.routingAvailable ?? false
    if (catalog.status !== 'ready' || catalog.value === null || projected === undefined) {
      this.store.set({
        current: catalog.value === null ? null : this.store.getSnapshot().current,
        ...retainedEffort === undefined ? {} : { retainedEffort },
        routable: null,
        groups: catalog.value?.groups ?? [],
        failures: catalog.value?.failures ?? [],
        status: catalog.status === 'error' ? 'error' : 'loading',
        pending: this.store.getSnapshot().pending,
        error: catalog.error,
        routingMode,
        routingAvailable,
      })
      return
    }
    const selection = projected.next ?? catalog.value.default
    const routable = catalog.value.groups.some(group => group.id === selection.provider
      && group.models.some(model => model.id === selection.model))
    this.store.set({
      current: selection,
      ...retainedEffort === undefined ? {} : { retainedEffort },
      routable,
      groups: catalog.value.groups,
      failures: catalog.value.failures,
      status: this.store.getSnapshot().status === 'selecting'
        ? 'selecting'
        : 'ready',
      pending: this.store.getSnapshot().pending,
      error: null,
      routingMode,
      routingAvailable,
    })
  }
}

function modelSelectionProjection(value: unknown): ModelSelectionProjection | undefined {
  return value === undefined ? undefined : value as ModelSelectionProjection
}
