/**
 * Deterministic difficulty classification for one routing decision.
 *
 * The default classifier reads the observation the router already has: text,
 * size, attachments, tool history, and explicit effort hints. It does not call
 * a model. A later classifier can implement {@link TaskClassifier} and register
 * under the `modelRouterClassifier` service; the decision reads that service
 * when it is present and otherwise uses {@link KeywordTaskClassifier}.
 *
 * @module @deepseek-ai/dsh-model-router/classify
 */

/** Difficulty tiers a rule or a tier route list can name, from lightest to heaviest. */
export const DIFFICULTY_TIERS = ['simple', 'standard', 'hard'] as const

/** One difficulty tier. */
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number]

/** Numeric rank of a tier. A larger rank is a harder task. */
export const TIER_RANK: Readonly<Record<DifficultyTier, number>> = {
  simple: 0,
  standard: 1,
  hard: 2,
}

/** Points each tier accumulated for one observation. */
export interface TierScores {
  /** Points toward a short or mechanical task. */
  readonly simple: number
  /** Points toward an ordinary task. */
  readonly standard: number
  /** Points toward a task that needs a stronger route. */
  readonly hard: number
}

/** The classifier's answer, including the points a debug log can print. */
export interface TaskClassification {
  /** Winning tier. */
  readonly tier: DifficultyTier
  /** Points per tier. The winner is derived from these, not stored separately. */
  readonly scores: TierScores
  /** Short labels of the signals that added points. */
  readonly reasons: readonly string[]
}

/**
 * Facts the classifier may read. The router fills this from the claimed
 * message and the session log; a test can construct it directly.
 */
export interface TaskObservation {
  /** Claimed message text, already lowercased. */
  readonly text: string
  /** Character length of the claimed message before case folding. */
  readonly promptChars: number
  /** Latest provider-reported context size, when the session has one. */
  readonly contextTokens: number | undefined
  /** Whether the claimed message carries an image. */
  readonly hasImage: boolean
  /** Whether the claimed message or the session carries an image or a file. */
  readonly hasAttachment: boolean
  /** `tool/call` events already in the session. */
  readonly toolUseCount: number
  /** Whether a `todo_write` or `plan` tool call is in the session. */
  readonly planActive: boolean
  /** Fenced code blocks (pairs of ``` ) in the claimed message. */
  readonly codeBlockCount: number
  /** Leading numbered or bulleted lines in the claimed message. */
  readonly numberedStepCount: number
  /** Reasoning effort already selected for the session, when it has one. */
  readonly reasoningEffort: string | undefined
}

/** Knobs for {@link KeywordTaskClassifier}. Omitted lists use the built-in sets. */
export interface ClassifierOptions {
  /** Substrings that add hard points. Matched case-insensitively. */
  readonly hardKeywords: readonly string[]
  /** Substrings that add simple points. Matched case-insensitively. */
  readonly simpleKeywords: readonly string[]
  /** Phrases that ask for a harder answer by themselves. */
  readonly hardHints: readonly string[]
  /** Phrases that ask for a shorter answer by themselves. */
  readonly simpleHints: readonly string[]
  /** Prompt length, in characters, that adds a standard point. */
  readonly promptCharsStandard: number
  /** Prompt length, in characters, that adds a hard point. */
  readonly promptCharsHard: number
  /** Context size, in tokens, that adds a standard point. */
  readonly contextTokensStandard: number
  /** Context size, in tokens, that adds a hard point. */
  readonly contextTokensHard: number
  /** Tool-call count that adds a standard point. */
  readonly toolUseStandard: number
  /** Tool-call count that adds a hard point. */
  readonly toolUseHard: number
  /** Hard points required to select `hard`, and the point a strong signal adds. */
  readonly hardMark: number
  /** Simple points required to select `simple` when hard did not win. */
  readonly simpleMark: number
}

/** Built-in hard keywords, Chinese and English. */
export const DEFAULT_HARD_KEYWORDS: readonly string[] = [
  '推理', '架构', '根因', '排查', '重构', '证明',
  'architect', 'refactor', 'root cause', 'investigate', 'debug',
]

/** Built-in simple keywords, Chinese and English. */
export const DEFAULT_SIMPLE_KEYWORDS: readonly string[] = [
  '翻译', '摘要', '总结', '概括', '你好', '谢谢',
  'translate', 'summarize', 'summarise', 'tldr', 'tl;dr', 'hello', 'thanks',
]

/** Phrases that ask the model to think harder. */
export const DEFAULT_HARD_HINTS: readonly string[] = [
  '深度思考', '仔细想', '认真想', '一步一步',
  'think hard', 'think harder', 'ultrathink', 'step by step',
]

/** Phrases that ask for a short answer. */
export const DEFAULT_SIMPLE_HINTS: readonly string[] = [
  '简短', '一句话', '简单回答',
  'be brief', 'keep it short', 'quick answer',
]

/** Built-in classifier knobs. */
export const DEFAULT_CLASSIFIER_OPTIONS: ClassifierOptions = {
  hardKeywords: DEFAULT_HARD_KEYWORDS,
  simpleKeywords: DEFAULT_SIMPLE_KEYWORDS,
  hardHints: DEFAULT_HARD_HINTS,
  simpleHints: DEFAULT_SIMPLE_HINTS,
  promptCharsStandard: 1_200,
  promptCharsHard: 4_000,
  contextTokensStandard: 8_000,
  contextTokensHard: 32_000,
  toolUseStandard: 1,
  toolUseHard: 6,
  hardMark: 4,
  simpleMark: 3,
}

/** Efforts that ask for a stronger answer. */
const HARD_EFFORTS = new Set(['high', 'max', 'xhigh'])

/** Efforts that ask for a lighter answer. */
const SIMPLE_EFFORTS = new Set(['none', 'minimal', 'min', 'low'])

/**
 * A synchronous classifier. The routing decision cannot wait for a model
 * call: an LLM classifier has to have its answer ready before the claim,
 * or it misses the step's model selection.
 */
export interface TaskClassifier {
  /**
   * Classify one observation.
   * @param observation - facts the router collected for this claim.
   * @returns the tier, the points, and the signal labels.
   */
  classify(observation: TaskObservation): TaskClassification
}

/**
 * Whether a value can classify an observation.
 * @param value - a service the context may or may not provide.
 * @returns true when `value` has a `classify` function.
 */
export function isTaskClassifier(value: unknown): value is TaskClassifier {
  return typeof value === 'object'
    && value !== null
    && 'classify' in value
    && typeof value.classify === 'function'
}

/** Mutable points while one observation is scored. */
interface ScoreDraft {
  simple: number
  standard: number
  hard: number
  reasons: string[]
}

/**
 * Whether `text` contains `needle` after both are lowercased.
 * @param text - already lowercased haystack.
 * @param needle - keyword or hint, any case.
 * @returns true when the needle occurs in the text.
 */
function includesFolded(text: string, needle: string): boolean {
  const folded = needle.toLowerCase()
  return folded.length > 0 && text.includes(folded)
}

/**
 * Add points when any phrase in `needles` occurs in the text.
 * @param draft - points being accumulated.
 * @param text - lowercased message text.
 * @param needles - phrases to look for.
 * @param tier - which score receives the points.
 * @param points - points to add once, however many phrases hit.
 * @param reason - label recorded when a phrase hits.
 */
function addPhrase(
  draft: ScoreDraft,
  text: string,
  needles: readonly string[],
  tier: DifficultyTier,
  points: number,
  reason: string,
): void {
  if (!needles.some(needle => includesFolded(text, needle))) return
  draft[tier] += points
  draft.reasons.push(reason)
}

/**
 * Score one observation. Points are integers; the tier is chosen afterwards.
 * @param observation - facts for this claim.
 * @param options - keyword lists and thresholds.
 * @returns the mutable score draft.
 */
function scoreObservation(observation: TaskObservation, options: ClassifierOptions): ScoreDraft {
  const draft: ScoreDraft = { simple: 0, standard: 0, hard: 0, reasons: [] }
  addPhrase(draft, observation.text, options.hardHints, 'hard', options.hardMark, 'hint-hard')
  addPhrase(draft, observation.text, options.simpleHints, 'simple', options.simpleMark, 'hint-simple')
  addPhrase(draft, observation.text, options.hardKeywords, 'hard', options.hardMark, 'keyword-hard')
  addPhrase(draft, observation.text, options.simpleKeywords, 'simple', options.simpleMark, 'keyword-simple')
  if (observation.promptChars >= options.promptCharsHard) {
    draft.hard += options.hardMark
    draft.reasons.push('prompt-long')
  } else if (observation.promptChars >= options.promptCharsStandard) {
    draft.standard += 1
    draft.reasons.push('prompt-medium')
  }
  if (observation.contextTokens !== undefined && observation.contextTokens >= options.contextTokensHard) {
    draft.hard += options.hardMark
    draft.reasons.push('context-large')
  } else if (observation.contextTokens !== undefined && observation.contextTokens >= options.contextTokensStandard) {
    draft.standard += 1
    draft.reasons.push('context-medium')
  }
  if (observation.hasImage || observation.hasAttachment) {
    draft.standard += 1
    draft.reasons.push(observation.hasImage ? 'image' : 'attachment')
  }
  if (observation.toolUseCount >= options.toolUseHard) {
    draft.hard += options.hardMark
    draft.reasons.push('tools-many')
  } else if (observation.toolUseCount >= options.toolUseStandard) {
    draft.standard += 1
    draft.reasons.push('tools')
  }
  if (observation.planActive) {
    draft.hard += options.hardMark
    draft.reasons.push('plan')
  }
  if (observation.codeBlockCount >= 3) {
    draft.hard += options.hardMark
    draft.reasons.push('code-heavy')
  } else if (observation.codeBlockCount >= 1) {
    draft.standard += 1
    draft.reasons.push('code')
  }
  if (observation.numberedStepCount >= 3) {
    draft.hard += options.hardMark
    draft.reasons.push('steps')
  }
  const effort = observation.reasoningEffort?.toLowerCase()
  if (effort !== undefined && HARD_EFFORTS.has(effort)) {
    draft.hard += options.hardMark
    draft.reasons.push('effort-hard')
  } else if (effort !== undefined && SIMPLE_EFFORTS.has(effort)) {
    draft.simple += options.simpleMark
    draft.reasons.push('effort-simple')
  }
  return draft
}

/**
 * Pick the tier from the points.
 *
 * Hard wins when it reaches its mark and is at least the other two scores.
 * Simple wins when it reaches its mark and strictly exceeds hard. Everything
 * else, including a tie that did not reach a mark, is standard.
 * @param scores - points per tier.
 * @param options - marks that select a tier.
 * @returns the selected tier.
 */
export function tierFromScores(scores: TierScores, options: Pick<ClassifierOptions, 'hardMark' | 'simpleMark'>): DifficultyTier {
  if (scores.hard >= options.hardMark && scores.hard >= scores.simple && scores.hard >= scores.standard) return 'hard'
  if (scores.simple >= options.simpleMark && scores.simple > scores.hard && scores.simple >= scores.standard) return 'simple'
  return 'standard'
}

/**
 * Keyword and size classifier. Construct it with {@link DEFAULT_CLASSIFIER_OPTIONS}
 * or a deployment's overrides; missing list fields should already be filled.
 */
export class KeywordTaskClassifier implements TaskClassifier {
  /**
   * @param options - keyword lists and thresholds. Defaults to the built-in sets.
   */
  constructor(private readonly options: ClassifierOptions = DEFAULT_CLASSIFIER_OPTIONS) {}

  /**
   * Classify one observation.
   * @param observation - facts the router collected for this claim.
   * @returns the tier, the points, and the signal labels.
   */
  classify(observation: TaskObservation): TaskClassification {
    const draft = scoreObservation(observation, this.options)
    const scores: TierScores = { simple: draft.simple, standard: draft.standard, hard: draft.hard }
    return {
      tier: tierFromScores(scores, this.options),
      scores,
      reasons: draft.reasons,
    }
  }
}

/**
 * Classify with the built-in keyword classifier, applying any overrides.
 * @param observation - facts for this claim.
 * @param overrides - fields that replace the built-in knobs.
 * @returns the classification.
 */
export function classifyTask(
  observation: TaskObservation,
  overrides: Partial<ClassifierOptions> = {},
): TaskClassification {
  return new KeywordTaskClassifier({ ...DEFAULT_CLASSIFIER_OPTIONS, ...overrides }).classify(observation)
}

/**
 * Fill omitted classifier lists and thresholds from the built-in knobs.
 * @param overrides - deployment fields; an omitted list keeps the built-in one.
 * @returns a complete options object.
 */
export function resolveClassifierOptions(
  overrides?: { [K in keyof ClassifierOptions]?: ClassifierOptions[K] | undefined },
): ClassifierOptions {
  const defined = stripUndefined(overrides)
  return {
    ...DEFAULT_CLASSIFIER_OPTIONS,
    ...defined,
    hardKeywords: listOrDefault(defined.hardKeywords, DEFAULT_HARD_KEYWORDS),
    simpleKeywords: listOrDefault(defined.simpleKeywords, DEFAULT_SIMPLE_KEYWORDS),
    hardHints: listOrDefault(defined.hardHints, DEFAULT_HARD_HINTS),
    simpleHints: listOrDefault(defined.simpleHints, DEFAULT_SIMPLE_HINTS),
  }
}

/**
 * Keep a built-in list when configuration omitted it or stored an empty array.
 *
 * The settings schema materializes an omitted array as `[]`. An empty list
 * therefore means "use the built-in phrases"; a non-empty list replaces them.
 * @param value - the configured list, when present.
 * @param fallback - the built-in list.
 * @returns the list the classifier should use.
 */
function listOrDefault(value: readonly string[] | undefined, fallback: readonly string[]): readonly string[] {
  return value !== undefined && value.length > 0 ? value : fallback
}

/**
 * Copy defined fields so an explicit `undefined` does not erase a default.
 * @param overrides - partial options from configuration.
 * @returns only the fields the configuration actually set.
 */
function stripUndefined(
  overrides: { [K in keyof ClassifierOptions]?: ClassifierOptions[K] | undefined } | undefined,
): Partial<ClassifierOptions> {
  if (overrides === undefined) return {}
  const defined: Partial<ClassifierOptions> = {}
  for (const key of Object.keys(overrides) as (keyof ClassifierOptions)[]) {
    const value = overrides[key]
    if (value !== undefined) Object.assign(defined, { [key]: value })
  }
  return defined
}
