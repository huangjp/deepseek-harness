/**
 * Wire-compatibility switches for a pi-ai model row or route.
 *
 * An endpoint that does not speak the dialect the adapter expects fails in
 * ways the rest of this card cannot express: a rejected `temperature`, a tool
 * result the endpoint wants named, a reasoning block it never sends back.
 * Those differences are llm-pi-ai's `compat` profile, and until now they
 * could only be written by hand into `cordis.patch.yml`.
 *
 * The switches offered here are the ones a third-party endpoint actually
 * differs on, and every one of them defaults to off — what the adapter
 * assumes of a well-behaved OpenAI- or Anthropic-compatible endpoint — so an
 * untouched row writes nothing at all. The remaining fields of `compat`, the
 * wire spellings and the numeric budgets, are carried through untouched:
 * this card must not drop what it does not show.
 */

import type { ReactNode } from 'react'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** One offered switch and the copy that names it. */
interface CompatSwitch {
  /** The `compat` field the switch writes. */
  key: string
  /** Copy key naming the switch. */
  label: ModelsKey
}

/**
 * The switches this card offers, in reading order. The keys are llm-pi-ai's
 * own `compat` field names; a key the adapter does not know would simply be
 * ignored at runtime, so only real ones are listed.
 */
const SWITCHES: readonly CompatSwitch[] = [
  { key: 'supportsTemperature', label: 'modelCompatSupportsTemperature' },
  { key: 'forceAdaptiveThinking', label: 'modelCompatForceAdaptiveThinking' },
  { key: 'supportsReasoningEffort', label: 'modelCompatSupportsReasoningEffort' },
  { key: 'supportsDeveloperRole', label: 'modelCompatSupportsDeveloperRole' },
  { key: 'requiresThinkingAsText', label: 'modelCompatRequiresThinkingAsText' },
  { key: 'requiresToolResultName', label: 'modelCompatRequiresToolResultName' },
  { key: 'supportsStrictTools', label: 'modelCompatSupportsStrictTools' },
  { key: 'supportsStore', label: 'modelCompatSupportsStore' },
  { key: 'supportsUsageInStreaming', label: 'modelCompatSupportsUsageInStreaming' },
  { key: 'supportsFinishReason', label: 'modelCompatSupportsFinishReason' },
]

/**
 * Read the stored `compat` object, or an empty one when nothing declares it.
 * @param value - the stored value.
 * @returns the object form, or an empty object.
 */
function compatObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** How one stored compatibility object is read and replaced. */
export interface ModelCompatBinding {
  /** The stored `compat` object, or undefined when nothing declares one. */
  value: unknown
  /** Replace the stored object, or clear it when undefined. */
  onChange: (compat: Record<string, unknown> | undefined) => void
}

/** Props of {@link ModelCompat}. */
export interface ModelCompatProps extends ModelCompatBinding {
  /** One-based row position for the accessible group label; absent on a route-level group. */
  position?: number | undefined
  /** Prevent changes while read-only or saving. */
  disabled: boolean
  /** Section copy. */
  t: (key: ModelsKey) => string
}

/**
 * Render the wire-compatibility switches of one model row or route.
 * @param props - the stored compatibility object and the replacement action.
 * @returns the labeled switch group.
 */
export function ModelCompat({ value, position, disabled, t, onChange }: ModelCompatProps): ReactNode {
  const stored = compatObject(value)
  const label = position === undefined ? t('modelCompat') : `${t('modelCompat')} ${String(position)}`
  const toggle = (key: string, checked: boolean): void => {
    // The object is spread rather than rebuilt, so a field this card does not
    // show — the wire spellings, the numeric budgets — survives the edit.
    const next = { ...stored, [key]: checked }
    // The object survives while it carries something this card does not
    // describe. Once every offered switch is off and nothing else is stored,
    // the object itself goes: an absent `compat` and an all-off `compat`
    // resolve the same way, and the profile reads better without the noise.
    const enabled = SWITCHES.some(option => next[option.key] === true)
    const carried = Object.entries(next).some(([field, entry]) =>
      !SWITCHES.some(option => option.key === field) && entry !== undefined)
    onChange(enabled || carried ? next : undefined)
  }
  return (
    <fieldset className={styles['modelInputTypes']} aria-label={label}>
      <legend className={styles['modelFieldLabel']}>{t('modelCompat')}</legend>
      <div className={styles['modelInputChoices']}>
        {SWITCHES.map(option => (
          <Checkbox
            key={option.key}
            label={t(option.label)}
            checked={stored[option.key] === true}
            disabled={disabled}
            onChange={(checked) => { toggle(option.key, checked) }}
          />
        ))}
      </div>
      <p className={styles['advancedHint']}>{t('modelCompatHint')}</p>
    </fieldset>
  )
}
