/**
 * Staged editor for the model router's rule table, over the `model-router`
 * settings namespace the router plugin owns.
 *
 * The rule table is an array of objects, so the shared scalar form model does
 * not carry it: the card keeps its own draft of the table and writes the whole
 * array in one revision-fenced mutation. The two health knobs travel in the
 * same write.
 *
 * The card stages text rather than parsed numbers, so a half-typed value stays
 * on screen instead of being reformatted under the cursor. A knob the user did
 * not touch is written back unchanged, which keeps a cooldown the deployment
 * stored in an unusual unit from being rounded into a round one.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormScope, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespace of the model router's user-owned settings. Spelled here rather
 * than imported: a client package must not depend on a Host package.
 */
export const MODEL_ROUTER_NS = 'model-router'

/** Milliseconds in one minute, the unit the card shows the cooldown in. */
export const MS_PER_MINUTE = 60_000

/** Consecutive failures after which a provider route is skipped, when unset. */
export const DEFAULT_FAILURE_THRESHOLD = 2

/** How long a skipped provider route stays skipped, when unset. */
export const DEFAULT_COOLDOWN_MS = 300_000

/** One rule as the Host stores it: a task shape and the route that answers it. */
export interface RouteRule {
  /** Stable identifier the deployment reads in diagnostics. */
  name: string
  /** Keywords that must appear in the message text; empty ignores the text. */
  keywords: string[]
  /** Required image condition; absent ignores attachments. */
  hasImage?: boolean
  /** Target provider route. */
  provider: string
  /** Target model id on that provider. */
  model: string
  /** Reasoning effort to request; absent leaves the provider default. */
  reasoningEffort?: string
}

/** One edit to a rule. An optional field set to undefined is removed. */
export interface RouteRulePatch {
  /** New rule name. */
  name?: string
  /** New keyword list. */
  keywords?: string[]
  /** New provider route. */
  provider?: string
  /** New model id. */
  model?: string
  /** New image condition; undefined removes the condition. */
  hasImage?: boolean | undefined
  /** New reasoning effort; undefined leaves the provider default. */
  reasoningEffort?: string | undefined
}

/** Settings the router stores for the deployment. */
export interface ModelRouterSettings {
  /** Whether routing may change the route a step uses. */
  enabled?: boolean
  /** The rule table, evaluated in declaration order. */
  rules?: RouteRule[]
  /** Consecutive failures after which a provider route is skipped. */
  failureThreshold?: number
  /** How long a skipped provider route stays skipped, in milliseconds. */
  cooldownMs?: number
}

/** What the model-router page renders. */
export interface ModelRouterCardState extends SettingsFormShell {
  /** Whether routing may change the route a step uses. */
  enabled: boolean
  /** Draft text of the failure threshold. */
  failureThresholdText: string
  /** Draft text of the cooldown, in minutes. */
  cooldownMinutesText: string
  /** The staged rule table, in evaluation order. */
  rules: readonly RouteRule[]
  /** The live adapter directory, so the target route can be picked from it. */
  providers: readonly ModelProviderGroup[]
  /** Adapter-directory request state. */
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Whether the Host document changed under a draft that was not saved. */
  conflicted: boolean
}

/** The registration-side face the model-router page's slot entry injects. */
export interface ModelRouterCardFace {
  hooks: {
    /** Page snapshot bound by the renderer as useModelRouterCard. */
    modelRouterCard: SnapshotStore<ModelRouterCardState>
  }
  toggleEnabled: () => void
  setFailureThreshold: (text: string) => void
  setCooldownMinutes: (text: string) => void
  addRule: () => void
  removeRule: (index: number) => void
  moveRule: (index: number, delta: number) => void
  updateRule: (index: number, patch: RouteRulePatch) => void
  retryCatalog: () => void
  save: () => void
  discard: () => void
}

/** The rule the page starts a new row from. */
function emptyRule(): RouteRule {
  return { name: '', keywords: [], provider: '', model: '' }
}

/** Whether one rule names a route the router could act on. */
export function ruleComplete(rule: RouteRule): boolean {
  return rule.name.trim() !== '' && rule.provider.trim() !== '' && rule.model.trim() !== ''
}

/** Whether one rule states a condition the matcher can use. */
export function ruleHasCondition(rule: RouteRule): boolean {
  return rule.keywords.length > 0 || rule.hasImage !== undefined
}

/** Read the rules the Host stores, tolerating a section that carries none yet. */
function storedRules(value: ModelRouterSettings | undefined): RouteRule[] {
  const rules = value?.rules
  if (!Array.isArray(rules)) return []
  return rules.map(rule => ({
    name: typeof rule.name === 'string' ? rule.name : '',
    keywords: Array.isArray(rule.keywords) ? [...rule.keywords] : [],
    ...(rule.hasImage === undefined ? {} : { hasImage: rule.hasImage }),
    provider: typeof rule.provider === 'string' ? rule.provider : '',
    model: typeof rule.model === 'string' ? rule.model : '',
    ...(rule.reasoningEffort === undefined ? {} : { reasoningEffort: rule.reasoningEffort }),
  }))
}

/** A comparable form of one rule, so two tables can be compared in one step. */
function ruleKey(rule: RouteRule): string {
  return JSON.stringify([
    rule.name,
    rule.provider,
    rule.model,
    rule.reasoningEffort ?? null,
    rule.hasImage ?? null,
    rule.keywords,
  ])
}

/** Whether two rule tables would write the same bytes. */
function sameRules(left: readonly RouteRule[], right: readonly RouteRule[]): boolean {
  return JSON.stringify(left.map(ruleKey)) === JSON.stringify(right.map(ruleKey))
}

/** Parse a whole number the card accepts, rejecting anything else. */
function parseCount(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

/** Render a stored cooldown in the minutes the card edits. */
function minutesText(ms: number): string {
  const minutes = ms / MS_PER_MINUTE
  return Number.isInteger(minutes) ? String(minutes) : String(Math.round(minutes * 10) / 10)
}

/**
 * Merge one edit into one rule.
 *
 * An optional field the edit clears is removed rather than stored as
 * `undefined`, so the rule keeps carrying the field only while it says
 * something.
 * @param rule - the rule being edited.
 * @param patch - the edit to merge.
 * @returns the merged rule.
 */
function mergeRule(rule: RouteRule, patch: RouteRulePatch): RouteRule {
  const merged: RouteRule = { ...rule, keywords: [...rule.keywords] }
  if (patch.name !== undefined) merged.name = patch.name
  if (patch.keywords !== undefined) merged.keywords = [...patch.keywords]
  if (patch.provider !== undefined) merged.provider = patch.provider
  if (patch.model !== undefined) merged.model = patch.model
  if (patch.hasImage !== undefined) merged.hasImage = patch.hasImage
  else if ('hasImage' in patch) delete merged.hasImage
  if (patch.reasoningEffort !== undefined) merged.reasoningEffort = patch.reasoningEffort
  else if ('reasoningEffort' in patch) delete merged.reasoningEffort
  return merged
}

/**
 * Bridges the `model-router` scope and the live adapter directory onto a
 * staged card.
 */
export class ModelRouterCardController {
  private catalogGroups: readonly ModelProviderGroup[] = []
  private catalogStatus: ModelRouterCardState['catalogStatus'] = 'idle'
  private draftEnabled: boolean | undefined
  private draftThresholdText: string | undefined
  private draftCooldownText: string | undefined
  private draftRules: RouteRule[] | undefined
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private saveGeneration = 0
  private catalogGeneration = 0
  private readonly store: SnapshotStore<ModelRouterCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - bound `model-router` configuration form.
   * @param ctx - the card plugin's context, whose `remote.session` namespace
   *   answers the Host model catalog.
   */
  constructor(
    private readonly scope: SettingsFormScope<ModelRouterSettings>,
    private readonly ctx: ClientContext,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      const snapshot = scope.getSnapshot()
      if (!this.saving && this.draftRules !== undefined && snapshot.revision !== this.draftRevision) {
        if (this.sameAsStored()) this.clearDraft()
        else this.conflicted = true
      }
      this.publish()
    })
    void this.loadCatalog()
  }

  /** Stop observing settings and suppress late catalog settlements. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.catalogGeneration += 1
    this.unsubscribe()
  }

  /**
   * Build the renderer face for this card.
   * @returns The snapshot and staged card actions injected into the renderer.
   */
  inject(): ModelRouterCardFace {
    return {
      hooks: { modelRouterCard: this.store },
      toggleEnabled: () => { this.toggleEnabled() },
      setFailureThreshold: (text: string) => { this.setFailureThreshold(text) },
      setCooldownMinutes: (text: string) => { this.setCooldownMinutes(text) },
      addRule: () => { this.addRule() },
      removeRule: (index: number) => { this.removeRule(index) },
      moveRule: (index: number, delta: number) => { this.moveRule(index, delta) },
      updateRule: (index: number, patch: RouteRulePatch) => { this.updateRule(index, patch) },
      retryCatalog: () => { void this.loadCatalog() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  /** Drop the cached adapter directory and read it again. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.catalogStatus = 'idle'
    void this.loadCatalog()
  }

  private stored(): ModelRouterSettings | undefined {
    return this.scope.getSnapshot().value
  }

  private enabled(): boolean {
    return this.draftEnabled ?? this.stored()?.enabled ?? false
  }

  private threshold(): number | undefined {
    if (this.draftThresholdText !== undefined) return parseCount(this.draftThresholdText)
    return this.stored()?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
  }

  private cooldownMs(): number | undefined {
    if (this.draftCooldownText !== undefined) {
      const minutes = parseCount(this.draftCooldownText)
      return minutes === undefined ? undefined : minutes * MS_PER_MINUTE
    }
    return this.stored()?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  }

  private thresholdText(): string {
    if (this.draftThresholdText !== undefined) return this.draftThresholdText
    return String(this.stored()?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)
  }

  private cooldownText(): string {
    if (this.draftCooldownText !== undefined) return this.draftCooldownText
    return minutesText(this.stored()?.cooldownMs ?? DEFAULT_COOLDOWN_MS)
  }

  private rules(): RouteRule[] {
    return this.draftRules ?? storedRules(this.stored())
  }

  private sameAsStored(): boolean {
    const stored = this.stored()
    const threshold = this.threshold()
    const cooldown = this.cooldownMs()
    if (threshold === undefined || cooldown === undefined) return false
    return this.enabled() === (stored?.enabled ?? false)
      && threshold === (stored?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)
      && cooldown === (stored?.cooldownMs ?? DEFAULT_COOLDOWN_MS)
      && sameRules(this.rules(), storedRules(stored))
  }

  /** Whether a save would write anything the deployment does not already hold. */
  private dirty(): boolean {
    return !this.sameAsStored()
  }

  private clearDraft(): void {
    this.draftEnabled = undefined
    this.draftThresholdText = undefined
    this.draftCooldownText = undefined
    this.draftRules = undefined
    this.draftRevision = undefined
    this.failed = false
    this.conflicted = false
  }

  private beginDraft(): void {
    if (this.draftRules !== undefined) return
    this.draftRules = storedRules(this.stored())
    this.draftEnabled = this.stored()?.enabled ?? false
    this.draftRevision = this.scope.getSnapshot().revision
  }

  private toggleEnabled(): void {
    if (!this.writable()) return
    this.beginDraft()
    this.draftEnabled = !this.enabled()
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  private setFailureThreshold(text: string): void {
    if (!this.writable()) return
    this.beginDraft()
    this.draftThresholdText = text
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  private setCooldownMinutes(text: string): void {
    if (!this.writable()) return
    this.beginDraft()
    this.draftCooldownText = text
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  private addRule(): void {
    if (!this.writable()) return
    this.beginDraft()
    this.draftRules = [...this.rules(), emptyRule()]
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  private removeRule(index: number): void {
    if (!this.writable()) return
    const rules = this.rules()
    if (index < 0 || index >= rules.length) return
    this.beginDraft()
    this.draftRules = rules.filter((_rule, position) => position !== index)
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  private moveRule(index: number, delta: number): void {
    if (!this.writable()) return
    const rules = [...this.rules()]
    const target = index + delta
    const moved = rules[index]
    const other = rules[target]
    if (moved === undefined || other === undefined) return
    rules[index] = other
    rules[target] = moved
    this.beginDraft()
    this.draftRules = rules
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  private updateRule(index: number, patch: RouteRulePatch): void {
    if (!this.writable()) return
    const rules = this.rules()
    const rule = rules[index]
    if (rule === undefined) return
    this.beginDraft()
    this.draftRules = rules.map((entry, position) => position === index
      ? mergeRule(entry, patch)
      : entry)
    this.failed = false
    this.conflicted = false
    this.publish()
  }

  private writable(): boolean {
    const snapshot = this.scope.getSnapshot()
    return snapshot.status === 'ready' && snapshot.writable && !this.saving && !this.disposed
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.publish()
    try {
      const response = await this.ctx.remote.session.modelCatalog()
      if (generation !== this.catalogGeneration) return
      if (response.ok) {
        this.catalogGroups = response.value.groups
        this.catalogStatus = 'ready'
      } else {
        this.catalogStatus = 'error'
      }
    } catch {
      if (generation !== this.catalogGeneration) return
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private async save(): Promise<void> {
    if (!this.writable()) return
    const rules = this.rules()
    const threshold = this.threshold()
    const cooldown = this.cooldownMs()
    if (threshold === undefined || cooldown === undefined
      || rules.some(rule => !ruleComplete(rule)) || rules.some(rule => !ruleHasCondition(rule))) {
      this.publish()
      return
    }
    // A save writes the whole section, so one that changes nothing would
    // rewrite every field the deployment already holds.
    if (!this.dirty()) {
      this.publish()
      return
    }
    const generation = ++this.saveGeneration
    this.saving = true
    this.failed = false
    this.publish()
    const ops = [
      { op: 'set' as const, path: ['enabled'], value: this.enabled() },
      { op: 'set' as const, path: ['failureThreshold'], value: threshold },
      { op: 'set' as const, path: ['cooldownMs'], value: cooldown },
      { op: 'set' as const, path: ['rules'], value: rules },
    ]
    try {
      const accepted = await this.scope.mutate(ops, this.draftRevision)
      if (generation !== this.saveGeneration) return
      if (accepted) this.clearDraft()
      else this.failed = true
    } catch {
      if (generation !== this.saveGeneration) return
      this.failed = true
    } finally {
      if (!this.disposed && generation === this.saveGeneration) {
        this.saving = false
        this.publish()
      }
    }
  }

  private discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  private projection(): ModelRouterCardState {
    const snapshot = this.scope.getSnapshot()
    const rules = this.rules()
    const threshold = this.threshold()
    const cooldown = this.cooldownMs()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.dirty(),
      invalid: threshold === undefined
        || cooldown === undefined
        || rules.some(rule => !ruleComplete(rule))
        || rules.some(rule => !ruleHasCondition(rule)),
      saving: this.saving,
      failed: this.failed,
      enabled: this.enabled(),
      failureThresholdText: this.thresholdText(),
      cooldownMinutesText: this.cooldownText(),
      rules,
      providers: this.catalogGroups,
      catalogStatus: this.catalogStatus,
      conflicted: this.conflicted,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
