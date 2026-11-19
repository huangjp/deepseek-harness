import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one scheduled quota wait. */
export type QuotaWaitId = Branded<'QuotaWaitId'>

/**
 * Brand an implementation-minted quota-wait identity.
 * @param id - opaque wait identity.
 * @returns the same string, branded; no validation is performed.
 */
export function QuotaWaitId(id: string): QuotaWaitId {
  return id as QuotaWaitId
}
