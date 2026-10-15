/**
 * The local-model-relay settings page: the two relays' listeners, the
 * applications behind them, the Copilot access token's age, the refresh
 * requirements, and the manual token refresh.
 *
 * A refresh changes the Windows system proxy for about a minute and drives the
 * Copilot window, so it is one confirmed action whose progress the page keeps
 * showing until the host reports a new token — never a silent background retry.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  Button, Modal, relativeTime, StateDot, writeClipboard,
  type RelativeTime, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  LocalBridgeAppStatus, LocalBridgeCopilotStatus, LocalBridgeLogPayload, LocalBridgePrerequisite,
  LocalBridgeRefreshPayload, LocalBridgeRefreshRefusal, LocalBridgeStatusPayload,
} from '@deepseek-ai/dsh-host-local-bridge/shared'
import { refreshInFlight, type LocalBridgeLogState, type LocalBridgePageState } from './controller.ts'
import type { LocalBridgeLocaleKey, LocalBridgeTranslate } from './locales.ts'
import styles from './LocalBridgeSection.module.css'

/** Dependencies the renderer binds for the local-model-relay page. */
export interface LocalBridgeSectionInjected {
  /** The page snapshot and the refresh transcripts, bound as `usePage`/`useLog`. */
  hooks: {
    page: SnapshotStore<LocalBridgePageState>
    log: SnapshotStore<LocalBridgeLogState>
  }
  /** Read the current snapshot and transcripts now. */
  load: () => Promise<void>
  /** Ask the host to refresh the Copilot token. */
  refresh: () => Promise<LocalBridgeRefreshPayload | null>
  /** Page copy, bound to this plugin's own dictionary. */
  t: LocalBridgeTranslate
}

/**
 * Props the renderer binds for the local-model-relay page. Only what the page
 * reads is named: it uses neither the section owner's `close` nor the global
 * standard hooks, so it declares neither.
 */
export type LocalBridgeSectionProps = Partial<InjectFace<LocalBridgeSectionInjected>>

/** What the page reports about the last refresh it asked for. */
type RefreshNotice =
  /** Nothing asked for in this page life. */
  | { readonly kind: 'none' }
  /** The host is harvesting; the token has not advanced yet. */
  | { readonly kind: 'running' }
  /** A newer token arrived. */
  | { readonly kind: 'done' }
  /** The attempt ended without a newer token. */
  | { readonly kind: 'failed' }
  /** The host refused before starting. */
  | { readonly kind: 'refused'; readonly refusal: LocalBridgeRefreshRefusal }
  /** The request itself never reached the host. */
  | { readonly kind: 'request-failed' }

/** The four refresh requirements, in the order the host reports them. */
const PREREQUISITES: readonly LocalBridgePrerequisite[] = ['mitmdump', 'harvester', 'upstream-proxy', 'ca']

/** Dictionary key naming one requirement. */
const PREREQUISITE_LABEL: Record<LocalBridgePrerequisite, LocalBridgeLocaleKey> = {
  mitmdump: 'prereqMitmdump',
  harvester: 'prereqHarvester',
  'upstream-proxy': 'prereqUpstreamProxy',
  ca: 'prereqCa',
}

/** Dictionary key carrying one requirement's remedy. */
const PREREQUISITE_GUIDANCE: Record<LocalBridgePrerequisite, LocalBridgeLocaleKey> = {
  mitmdump: 'guidanceMitmdump',
  harvester: 'guidanceHarvester',
  'upstream-proxy': 'guidanceUpstreamProxy',
  ca: 'guidanceCa',
}

/** Dictionary key naming one refusal. */
const REFUSAL_MESSAGE: Record<LocalBridgeRefreshRefusal, LocalBridgeLocaleKey> = {
  'unsupported-platform': 'refusalUnsupportedPlatform',
  'copilot-not-running': 'refusalCopilotNotRunning',
  'prerequisites-missing': 'refusalPrerequisitesMissing',
  'busy': 'refusalBusy',
  'script-missing': 'refusalScriptMissing',
  'spawn-failed': 'refusalSpawnFailed',
}

/**
 * Render the local-model-relay settings section.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function LocalBridgeSection(props: LocalBridgeSectionProps): ReactNode {
  const { usePage, useLog, load, refresh, t } = props
  if (usePage === undefined || useLog === undefined || load === undefined || refresh === undefined || t === undefined) {
    return null
  }
  return <Loaded usePage={usePage} useLog={useLog} load={load} refresh={refresh} t={t} />
}

/** The page body, with every injected member present. */
function Loaded({ usePage, useLog, load, refresh, t }: InjectFace<LocalBridgeSectionInjected>): ReactNode {
  const state = usePage(value => value)
  const logState = useLog(value => value)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [notice, setNotice] = useState<RefreshNotice>({ kind: 'none' })
  /**
   * The token this page saw before it asked for a refresh; `undefined` while
   * no attempt is being tracked, so a null token is a tracked value too.
   */
  const before = useRef<number | null | undefined>(undefined)

  useEffect(() => { void load() }, [load])

  const status = state.phase === 'ready' ? state.status : undefined
  const running = status !== undefined && refreshInFlight(status)

  useEffect(() => {
    if (status === undefined) return
    if (refreshInFlight(status)) {
      setNotice({ kind: 'running' })
      return
    }
    const seen = before.current
    if (seen === undefined) return
    before.current = undefined
    const now = status.copilot.token.harvestedAt
    setNotice({ kind: now === null || now === seen ? 'failed' : 'done' })
  }, [status])

  // An attempt that failed or never started is exactly when the transcripts
  // matter, so the log opens itself rather than waiting to be asked for.
  const failed = notice.kind === 'failed' || notice.kind === 'refused' || notice.kind === 'request-failed'
  useEffect(() => { if (failed) setLogOpen(true) }, [failed])

  const start = async (): Promise<void> => {
    setConfirmOpen(false)
    before.current = status === undefined ? null : status.copilot.token.harvestedAt
    const outcome = await refresh()
    if (outcome === null) {
      before.current = undefined
      setNotice({ kind: 'request-failed' })
      return
    }
    if (!outcome.started) {
      before.current = undefined
      // A refusal with no code contradicts the host's own contract; naming it
      // a start failure keeps the page from showing an empty notice.
      setNotice({ kind: 'refused', refusal: outcome.refusal ?? 'spawn-failed' })
      return
    }
    setNotice({ kind: 'running' })
  }

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>

      {state.phase === 'loading'
        ? <p className={styles['centered']}><StateDot state="ongoing" /></p>
        : null}
      {state.phase === 'failed' ? <p className={styles['error']}>{t('loadFailed')}</p> : null}

      {status === undefined
        ? null
        : (
          <div className={styles['body']}>
            {status.platform !== 'win32' ? <p className={styles['notice']}>{t('unsupported')}</p> : null}
            <RelayCard
              title={t('workbuddy')}
              t={t}
              port={status.workbuddy.relay.port}
              listening={status.workbuddy.relay.listening}
              app={status.workbuddy.app}
            />
            <RelayCard
              title={t('copilot')}
              t={t}
              port={status.copilot.relay.port}
              listening={status.copilot.relay.listening}
              app={status.copilot.app}
            >
              <TokenRow status={status} t={t} />
              <Requirements copilot={status.copilot} t={t} />
            </RelayCard>
          </div>
        )}

      <div className={styles['actions']}>
        <Button
          variant="primary"
          disabled={status === undefined || !refreshable(status, running)}
          onClick={() => { setConfirmOpen(true) }}
        >
          {running ? t('refreshing') : t('refresh')}
        </Button>
        <Button variant="outline" onClick={() => { void load() }}>{t('recheck')}</Button>
      </div>

      <Notice notice={notice} t={t} />

      <RefreshLog state={logState} open={logOpen} onToggle={setLogOpen} t={t} />

      <Modal
        open={confirmOpen}
        onClose={() => { setConfirmOpen(false) }}
        title={t('confirmTitle')}
        closeLabel={t('close')}
        description={t('confirmBody')}
        className={styles['dialog'] as string}
        footer={(
          <>
            <Button variant="outline" data-modal-autofocus onClick={() => { setConfirmOpen(false) }}>
              {t('cancel')}
            </Button>
            <Button variant="primary" onClick={() => { void start() }}>{t('confirm')}</Button>
          </>
        )}
      >
        {null}
      </Modal>
    </div>
  )
}

/**
 * Whether the page offers the refresh action. The host enforces the same
 * preconditions again when the request arrives; this only keeps a control the
 * host would refuse from looking available.
 * @param status - the current snapshot.
 * @param running - whether an attempt is already in flight.
 * @returns whether the action can proceed now.
 */
function refreshable(status: LocalBridgeStatusPayload, running: boolean): boolean {
  return status.platform === 'win32'
    && status.copilot.app.running
    && status.copilot.missing.length === 0
    && !running
}

/**
 * Name one companion application's state.
 * @param status - the detection result.
 * @param t - the page's locale reader.
 * @returns the state dot's semantic and its label.
 */
function appState(status: LocalBridgeAppStatus, t: LocalBridgeTranslate): { dot: StateDotState; label: string } {
  if (status.running) return { dot: 'done', label: t('appRunning') }
  return status.installed ? { dot: 'warning', label: t('appStopped') } : { dot: 'error', label: t('appMissing') }
}

/**
 * Localize one token age bucket.
 * @param age - the bucket the shared relative-time helper produced.
 * @param t - the page's locale reader.
 * @returns the localized age phrase.
 */
function ageText(age: RelativeTime, t: LocalBridgeTranslate): string {
  switch (age.unit) {
    case 'now': return t('ageJustNow')
    case 'minutes': return t('ageMinutes', { count: age.n })
    case 'hours': return t('ageHours', { count: age.n })
    case 'days': return t('ageDays', { count: age.n })
    case 'months': return t('ageMonths', { count: age.n })
    case 'years': return t('ageYears', { count: age.n })
    /* v8 ignore next -- every current relative-time bucket is handled above */
    default: return assertNever(age.unit, 'local-bridge token age')
  }
}

/** One relay card: its listener and the application behind it. */
function RelayCard({ title, t, port, listening, app, children }: {
  title: string
  t: LocalBridgeTranslate
  port: number
  listening: boolean
  app: LocalBridgeAppStatus
  children?: ReactNode
}): ReactNode {
  const application = appState(app, t)
  return (
    <section className={styles['card']}>
      <h3 className={styles['cardTitle']}>{title}</h3>
      <dl className={styles['facts']}>
        <Fact label={t('port')} value={String(port)} />
        <Fact
          label={t('listening')}
          value={listening ? t('listeningOn') : t('listeningOff')}
          dot={listening ? 'done' : 'error'}
        />
        <Fact label={t('app')} value={application.label} dot={application.dot} />
      </dl>
      {children}
    </section>
  )
}

/** One label/value row of a relay card. */
function Fact({ label, value, dot }: {
  label: string
  value: string
  dot?: StateDotState
}): ReactNode {
  return (
    <>
      <dt className={styles['factLabel']}>{label}</dt>
      <dd className={styles['factValue']}>
        {dot === undefined ? null : <StateDot state={dot} />}
        {value}
      </dd>
    </>
  )
}

/** The Copilot token's age and freshness. */
function TokenRow({ status, t }: {
  status: LocalBridgeStatusPayload
  t: LocalBridgeTranslate
}): ReactNode {
  const { token } = status.copilot
  const harvestedAt = token.harvestedAt
  if (harvestedAt === null) {
    return (
      <dl className={styles['facts']}>
        <Fact label={t('token')} value={t('tokenMissing')} dot="error" />
      </dl>
    )
  }
  const age = ageText(relativeTime(harvestedAt, status.checkedAt), t)
  return (
    <dl className={styles['facts']}>
      <Fact
        label={t('token')}
        value={`${t('tokenAge', { age })} · ${token.stale ? t('tokenStale') : t('tokenFresh')}`}
        dot={token.stale ? 'warning' : 'done'}
      />
    </dl>
  )
}

/** The refresh requirements, each with its remedy while unmet. */
function Requirements({ copilot, t }: {
  copilot: LocalBridgeCopilotStatus
  t: LocalBridgeTranslate
}): ReactNode {
  return (
    <div className={styles['requirements']}>
      <p className={styles['requirementsTitle']}>{t('prerequisites')}</p>
      <ul className={styles['requirementList']}>
        {PREREQUISITES.map((code) => {
          const unmet = copilot.missing.includes(code)
          return (
            <li key={code} className={styles['requirement']}>
              <span className={styles['requirementHead']}>
                <StateDot state={unmet ? 'error' : 'done'} />
                <span>{t(PREREQUISITE_LABEL[code])}</span>
                <span className={styles['requirementState']}>
                  {unmet ? t('prereqMissing') : t('prereqReady')}
                </span>
              </span>
              {unmet ? <span className={styles['guidance']}>{t(PREREQUISITE_GUIDANCE[code])}</span> : null}
            </li>
          )
        })}
      </ul>
      {copilot.mitmdump === null ? null : <p className={styles['pathHint']}>{copilot.mitmdump}</p>}
    </div>
  )
}

/** The one notice the page shows about the last refresh. */
function Notice({ notice, t }: {
  notice: RefreshNotice
  t: LocalBridgeTranslate
}): ReactNode {
  if (notice.kind === 'none') return null
  switch (notice.kind) {
    case 'running':
      return <p className={styles['notice']}><StateDot state="ongoing" />{t('refreshRunning')}</p>
    case 'done':
      return <p className={styles['ok']}>{t('refreshDone')}</p>
    case 'failed':
      return <p className={styles['error']}>{t('refreshFailed')}</p>
    case 'request-failed':
      return <p className={styles['error']}>{t('loadFailed')}</p>
    case 'refused':
      return <p className={styles['notice']}>{t(REFUSAL_MESSAGE[notice.refusal])}</p>
    /* v8 ignore next -- every current notice variant is handled above */
    default:
      return assertNever(notice, 'local-bridge refresh notice')
  }
}

/** The two transcripts, in the order the host writes them. */
const TRANSCRIPT_KINDS = ['transcript', 'spawn'] as const

/** Dictionary key naming one transcript. */
const TRANSCRIPT_LABEL: Record<(typeof TRANSCRIPT_KINDS)[number], LocalBridgeLocaleKey> = {
  transcript: 'logTranscript',
  spawn: 'logSpawn',
}

/**
 * The text one copy gesture places on the clipboard: every transcript that has
 * content, each under the path it was read from, so a pasted log identifies
 * itself.
 * @param log - the transcripts the host served.
 * @returns the text to copy.
 */
function copyText(log: LocalBridgeLogPayload): string {
  return TRANSCRIPT_KINDS
    .filter(kind => log[kind].text !== '')
    .map(kind => `${log[kind].path}\n${log[kind].text}`)
    .join('\n\n')
}

/**
 * The refresh transcripts, collapsed until a failure opens them.
 *
 * A refresh that produces no token leaves its cause only in these files — the
 * script's own transcript, or the PowerShell trace when the process never
 * started — so the page shows them where the user already is instead of naming
 * a path to go and read.
 * @param props.state - the transcripts' read state.
 * @param props.open - whether the disclosure is expanded.
 * @param props.onToggle - received with the requested open state.
 * @param props.t - the page's locale reader.
 * @returns the disclosure, or null while there is nothing to show.
 */
function RefreshLog({ state, open, onToggle, t }: {
  state: LocalBridgeLogState
  open: boolean
  onToggle: (open: boolean) => void
  t: LocalBridgeTranslate
}): ReactNode {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  const log = state.phase === 'ready' ? state.log : undefined
  const texts = log === undefined ? [] : TRANSCRIPT_KINDS.filter(kind => log[kind].text !== '')
  if (log === undefined || texts.length === 0) return null

  const copy = async (): Promise<void> => {
    setCopied(await writeClipboard(copyText(log)) ? 'done' : 'failed')
  }

  return (
    <details
      className={styles['log']}
      open={open}
      onToggle={(event) => { onToggle(event.currentTarget.open) }}
    >
      <summary className={styles['logSummary']}>{t('logTitle')}</summary>
      <div className={styles['logBody']}>
        {texts.map(kind => (
          <div key={kind} className={styles['logBlock']}>
            <p className={styles['logHeading']}>{t(TRANSCRIPT_LABEL[kind])}</p>
            <p className={styles['logPath']}>{log[kind].path}</p>
            <pre className={styles['logText']}>{log[kind].text}</pre>
            {log[kind].truncated ? <p className={styles['logTruncated']}>{t('logTruncated')}</p> : null}
          </div>
        ))}
        <div className={styles['logActions']}>
          <Button variant="outline" onClick={() => { void copy() }}>{t('logCopy')}</Button>
          <span className={styles['logStatus']} role="status" aria-live="polite">
            {copied === 'idle' ? '' : t(copied === 'done' ? 'logCopied' : 'logCopyFailed')}
          </span>
        </div>
      </div>
    </details>
  )
}
