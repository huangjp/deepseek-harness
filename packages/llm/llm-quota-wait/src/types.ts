import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { QuotaWindowKind } from '@deepseek-ai/dsh-llm'
import type { QuotaWaitId } from './brand.ts'

export type { QuotaWaitId }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable record that the open step is paused until a replenishing quota
     * window opens. Written before the wait. `resumeAtMs` is absolute so a
     * reconnected client can show the same instant.
     */
    'llm/quota-wait': LlmQuotaWaitEventData
    /** Durable transition written after the wait and before the same step retries. */
    'llm/quota-wait-started': LlmQuotaWaitStartedEventData
  }
}

/** Durable payload recorded before one quota-window wait. */
export interface LlmQuotaWaitEventData {
  waitId: QuotaWaitId
  turn: number
  step: number
  provider: string
  /** Exhausted window, or `unknown` when the wait is a probe. */
  window: QuotaWindowKind
  /** Epoch milliseconds when this wait ends and the same step retries. */
  resumeAtMs: number
  /** How long this wait sleeps, in milliseconds. */
  delayMs: number
  failure: LlmFailure
}

/** Durable transition recorded after one quota wait completes. */
export interface LlmQuotaWaitStartedEventData {
  waitId: QuotaWaitId
  turn: number
  step: number
}
