/**
 * The model router's settings page: the rule table that sends each kind of
 * task to the model that answers it, plus the health knobs that let the
 * router step aside from a route that keeps failing.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { ModelRouterCardFace, ModelRouterCardState, RouteRule } from './model-router-card-controller.ts'
import { ruleComplete, ruleHasCondition } from './model-router-card-controller.ts'
import css from './ModelRouterCard.module.css'

/** Props the renderer binds for the model-router page. */
export type ModelRouterCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.modelRouter'>
  & InjectFace<ModelRouterCardFace>

/** One route option: the id the router stores, and the label the page shows. */
interface RouteOption {
  id: string
  label: string
}

/**
 * The provider routes the deployment registers.
 * @param state - the card snapshot.
 * @returns one option per registered provider route.
 */
function providerOptions(state: ModelRouterCardState): RouteOption[] {
  return state.providers.map(group => ({ id: group.id, label: group.name }))
}

/**
 * The models one provider route offers.
 *
 * A model the table names but the directory no longer lists stays in the list:
 * dropping it would silently retarget the rule.
 * @param state - the card snapshot.
 * @param provider - the provider route to read.
 * @param current - the model the rule names today.
 * @returns one option per model the route offers.
 */
function modelOptions(state: ModelRouterCardState, provider: string, current: string): RouteOption[] {
  const group = state.providers.find(entry => entry.id === provider)
  const options = (group?.models ?? []).map(model => ({ id: model.id, label: model.name }))
  if (current !== '' && !options.some(option => option.id === current)) {
    options.push({ id: current, label: current })
  }
  return options
}

/**
 * The reasoning efforts one model offers.
 * @param state - the card snapshot.
 * @param provider - the provider route to read.
 * @param model - the model to read.
 * @returns one option per effort the model offers.
 */
function effortOptions(state: ModelRouterCardState, provider: string, model: string): RouteOption[] {
  const group = state.providers.find(entry => entry.id === provider)
  const entry = group?.models.find(candidate => candidate.id === model)
  return (entry?.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, label: effort.name }))
}

/**
 * Read the image condition one rule states.
 * @param rule - the rule to read.
 * @returns the option value the condition select shows.
 */
function conditionValue(rule: RouteRule): string {
  if (rule.hasImage === undefined) return 'any'
  return rule.hasImage ? 'required' : 'forbidden'
}

/**
 * Read the keyword list one rule states.
 * @param rule - the rule to read.
 * @returns the keywords as one comma-separated string.
 */
function keywordText(rule: RouteRule): string {
  return rule.keywords.join(', ')
}

/**
 * Render the model router's rule table and its health knobs.
 * @param props - the view asked for, locale copy, the card snapshot, and its actions.
 * @returns the one-liner, or the page.
 */
export function ModelRouterCard(props: ModelRouterCardProps) {
  const { t } = props
  const state = props.useModelRouterCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const locked = !state.writable || state.saving
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <div className={css.toggleRow}>
        <div className={css.toggleText}>
          <span className={css.toggleLabel}>{t('enabled')}</span>
          <span className={css.hint}>{t('enabledHint')}</span>
        </div>
        <Switch
          checked={state.enabled}
          label={t('enabled')}
          disabled={locked}
          onChange={() => { props.toggleEnabled() }}
        />
      </div>
      <div className={css.knobs}>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="model-router-failure-threshold">{t('failureThreshold')}</label>
          <input
            id="model-router-failure-threshold"
            className={css.number}
            type="number"
            min={0}
            step={1}
            value={state.failureThresholdText}
            disabled={locked}
            onChange={(event) => { props.setFailureThreshold(event.target.value) }}
          />
          <span className={css.hint}>{t('failureThresholdHint')}</span>
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="model-router-cooldown">{t('cooldownMinutes')}</label>
          <input
            id="model-router-cooldown"
            className={css.number}
            type="number"
            min={0}
            step={1}
            value={state.cooldownMinutesText}
            disabled={locked}
            onChange={(event) => { props.setCooldownMinutes(event.target.value) }}
          />
          <span className={css.hint}>{t('cooldownMinutesHint')}</span>
        </div>
      </div>
      {state.catalogStatus === 'loading'
        ? <p className={css.notice} role="status">{t('catalogLoading')}</p>
        : null}
      {state.catalogStatus === 'error'
        ? (
          <div className={css.catalogError} role="alert">
            <span>{t('catalogFailed')}</span>
            <Button variant="ghost" size="sm" disabled={state.saving} onClick={props.retryCatalog}>
              {t('catalogRetry')}
            </Button>
          </div>
        )
        : null}
      {state.catalogStatus === 'ready' && state.providers.length === 0
        ? <p className={css.notice}>{t('catalogEmpty')}</p>
        : null}
      <div className={css.rulesHead}>
        <div>
          <span className={css.rulesTitle}>{t('rulesTitle')}</span>
          <span className={css.hint}>{t('rulesHint')}</span>
        </div>
        <Button variant="outline" size="sm" disabled={locked} onClick={props.addRule}>
          {t('addRule')}
        </Button>
      </div>
      <div className={css.rules}>
        {state.rules.map((rule, index) => {
          const providers = providerOptions(state)
          if (rule.provider !== '' && !providers.some(option => option.id === rule.provider)) {
            providers.push({ id: rule.provider, label: rule.provider })
          }
          const models = modelOptions(state, rule.provider, rule.model)
          const efforts = effortOptions(state, rule.provider, rule.model)
          const incomplete = !ruleComplete(rule) || !ruleHasCondition(rule)
          return (
            <fieldset key={index} className={css.rule}>
              <div className={css.ruleHead}>
                <span className={css.ruleIndex}>{index + 1}</span>
                <div className={css.ruleActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked || index === 0}
                    title={t('moveUp')}
                    onClick={() => { props.moveRule(index, -1) }}
                  >
                    {t('moveUp')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked || index === state.rules.length - 1}
                    title={t('moveDown')}
                    onClick={() => { props.moveRule(index, 1) }}
                  >
                    {t('moveDown')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    title={t('removeRule')}
                    onClick={() => { props.removeRule(index) }}
                  >
                    {t('removeRule')}
                  </Button>
                </div>
              </div>
              <div className={css.ruleGrid}>
                <div className={css.field}>
                  <label className={css.fieldLabel} htmlFor={`model-router-rule-${index}-name`}>{t('ruleName')}</label>
                  <input
                    id={`model-router-rule-${index}-name`}
                    className={css.text}
                    type="text"
                    value={rule.name}
                    placeholder={t('ruleNamePlaceholder')}
                    disabled={locked}
                    onChange={(event) => { props.updateRule(index, { name: event.target.value }) }}
                  />
                </div>
                <div className={css.field}>
                  <label className={css.fieldLabel} htmlFor={`model-router-rule-${index}-keywords`}>{t('ruleKeywords')}</label>
                  <input
                    id={`model-router-rule-${index}-keywords`}
                    className={css.text}
                    type="text"
                    value={keywordText(rule)}
                    placeholder={t('ruleKeywordsPlaceholder')}
                    disabled={locked}
                    onChange={(event) => {
                      props.updateRule(index, {
                        keywords: event.target.value.split(',').map(keyword => keyword.trim()).filter(keyword => keyword !== ''),
                      })
                    }}
                  />
                </div>
                <div className={css.field}>
                  <label className={css.fieldLabel} htmlFor={`model-router-rule-${index}-condition`}>{t('ruleCondition')}</label>
                  <select
                    id={`model-router-rule-${index}-condition`}
                    className={css.select}
                    value={conditionValue(rule)}
                    disabled={locked}
                    onChange={(event) => {
                      const value = event.target.value
                      props.updateRule(index, {
                        hasImage: value === 'required' ? true : value === 'forbidden' ? false : undefined,
                      })
                    }}
                  >
                    <option value="any">{t('conditionAny')}</option>
                    <option value="required">{t('conditionRequired')}</option>
                    <option value="forbidden">{t('conditionForbidden')}</option>
                  </select>
                </div>
                <div className={css.field}>
                  <label className={css.fieldLabel} htmlFor={`model-router-rule-${index}-provider`}>{t('ruleProvider')}</label>
                  <select
                    id={`model-router-rule-${index}-provider`}
                    className={css.select}
                    value={rule.provider}
                    disabled={locked}
                    onChange={(event) => {
                      const provider = event.target.value
                      const first = state.providers.find(group => group.id === provider)?.models[0]
                      props.updateRule(index, { provider, model: first?.id ?? '', reasoningEffort: undefined })
                    }}
                  >
                    <option value="">{t('ruleProvider')}</option>
                    {providers.map(option => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className={css.field}>
                  <label className={css.fieldLabel} htmlFor={`model-router-rule-${index}-model`}>{t('ruleModel')}</label>
                  <select
                    id={`model-router-rule-${index}-model`}
                    className={css.select}
                    value={rule.model}
                    disabled={locked}
                    onChange={(event) => {
                      props.updateRule(index, { model: event.target.value, reasoningEffort: undefined })
                    }}
                  >
                    <option value="">{t('ruleModel')}</option>
                    {models.map(option => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className={css.field}>
                  <label className={css.fieldLabel} htmlFor={`model-router-rule-${index}-effort`}>{t('ruleEffort')}</label>
                  <select
                    id={`model-router-rule-${index}-effort`}
                    className={css.select}
                    value={rule.reasoningEffort ?? ''}
                    disabled={locked || efforts.length === 0}
                    onChange={(event) => {
                      const value = event.target.value
                      props.updateRule(index, { reasoningEffort: value === '' ? undefined : value })
                    }}
                  >
                    <option value="">{t('effortDefault')}</option>
                    {efforts.map(option => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              {incomplete ? <p className={css.ruleHint}>{t('invalidTable')}</p> : null}
            </fieldset>
          )
        })}
      </div>
      {state.invalid ? <p className={css.invalid} role="status">{t('invalidTable')}</p> : null}
      {state.conflicted ? <p className={css.conflict} role="status">{t('conflict')}</p> : null}
    </SettingsForm>
  )
}
