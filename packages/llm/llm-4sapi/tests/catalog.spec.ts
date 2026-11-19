import { describe, expect, it } from 'vitest'
import {
  FOURSAPI_BASE_URLS,
  FOURSAPI_DEFAULT_BASE_URL,
  FOURSAPI_RATIO_USD_PER_MILLION,
  foursapiAnthropicBaseURL,
  foursapiModelAcceptsImages,
  foursapiModelsUrl,
  foursapiOpenAIBaseURL,
  foursapiUrl,
  foursapiUsesAnthropic,
  mergeFoursapiPricing,
  readFoursapiModelList,
  readFoursapiPricing,
  readFoursapiRemainingRatio,
} from '../src/catalog.ts'

describe('4SAPI catalog helpers', () => {
  it('normalizes the OpenAI root and the Messages root from either spelling', () => {
    expect(foursapiOpenAIBaseURL('https://4sapi.com')).toBe('https://4sapi.com/v1')
    expect(foursapiOpenAIBaseURL('https://4sapi.org/v1/')).toBe('https://4sapi.org/v1')
    expect(foursapiAnthropicBaseURL('https://4sapi.com/v1')).toBe('https://4sapi.com')
    expect(foursapiAnthropicBaseURL('https://4sapi.net')).toBe('https://4sapi.net')
    expect(FOURSAPI_BASE_URLS[0]).toBe(FOURSAPI_DEFAULT_BASE_URL)
  })

  it('builds absolute listing and billing URLs, and refuses a root that is not a URL', () => {
    expect(foursapiModelsUrl('https://4sapi.com')).toBe('https://4sapi.com/v1/models')
    expect(foursapiUrl('https://4sapi.org/v1', '/api/pricing')).toBe('https://4sapi.org/api/pricing')
    expect(foursapiUrl('https://4sapi.com/v1', '/v1/dashboard/billing/usage'))
      .toBe('https://4sapi.com/v1/dashboard/billing/usage')
    expect(foursapiModelsUrl('not a url')).toBeUndefined()
    expect(foursapiUrl('/relative', '/api/pricing')).toBeUndefined()
  })

  it('uses Messages only for claude ids when the deployment asks for that wire', () => {
    expect(foursapiUsesAnthropic('claude-sonnet-4-5', 'anthropic')).toBe(true)
    expect(foursapiUsesAnthropic('Claude-Opus-4', 'anthropic')).toBe(true)
    expect(foursapiUsesAnthropic('gpt-4o', 'anthropic')).toBe(false)
    expect(foursapiUsesAnthropic('claude-sonnet-4-5', 'openai')).toBe(false)
  })

  it('infers image input conservatively and lets a row override the inference', () => {
    expect(foursapiModelAcceptsImages('gpt-4o')).toBe(true)
    expect(foursapiModelAcceptsImages('claude-sonnet-4-5')).toBe(true)
    expect(foursapiModelAcceptsImages('gemini-2.5-pro')).toBe(true)
    expect(foursapiModelAcceptsImages('qwen2.5-vl-72b')).toBe(true)
    expect(foursapiModelAcceptsImages('grok-4.7')).toBe(true)
    expect(foursapiModelAcceptsImages('deepseek-chat')).toBe(false)
    expect(foursapiModelAcceptsImages('gpt-4o', false)).toBe(false)
    expect(foursapiModelAcceptsImages('deepseek-chat', true)).toBe(true)
  })

  it('reads a model listing and skips rows that have no id', () => {
    expect(readFoursapiModelList({
      data: [
        { id: 'demo', name: 'Demo', context_window: 200_000 },
        { id: 'demo' },
        { id: '' },
        { name: 'nameless' },
        'nope',
        { id: 'plain', context_length: 1.5 },
        { id: 'sized', contextWindow: 4096 },
      ],
    })).toEqual([
      { id: 'demo', name: 'Demo', contextWindow: 200_000 },
      { id: 'plain' },
      { id: 'sized', contextWindow: 4096 },
    ])
    expect(readFoursapiModelList({ models: [] })).toEqual([])
    expect(readFoursapiModelList(null)).toEqual([])
  })

  it('converts token ratios and skips per-call prices', () => {
    expect(readFoursapiPricing({
      success: true,
      data: [
        { model_name: 'demo', quota_type: 0, model_ratio: 1, completion_ratio: 4 },
        { model_name: 'once', quota_type: 1, model_price: 0.02 },
        { model_name: 'free', quota_type: 0, model_ratio: 0 },
        { model_name: 'bad', model_ratio: -1 },
        { quota_type: 0, model_ratio: 1 },
        { model_name: 'drop', completion_ratio: -1, model_ratio: 1 },
      ],
    })).toEqual([
      {
        model: 'demo',
        inputPerMillion: FOURSAPI_RATIO_USD_PER_MILLION,
        outputPerMillion: 8,
        currency: 'USD',
      },
      { model: 'free', inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
    ])
    expect(readFoursapiPricing({ success: false, data: [] })).toEqual([])
    expect(readFoursapiPricing({ data: 'nope' })).toEqual([])
  })

  it('lets configured prices replace endpoint rows and appends the rest', () => {
    expect(mergeFoursapiPricing(
      [{ model: 'demo', inputPerMillion: 2, outputPerMillion: 8, currency: 'USD' }],
      [
        { model: 'demo', inputPerMillion: 3, outputPerMillion: 9, currency: 'CNY' },
        { model: 'extra', inputPerMillion: 1, outputPerMillion: 1 },
      ],
    )).toEqual([
      { model: 'demo', inputPerMillion: 3, outputPerMillion: 9, currency: 'CNY' },
      { model: 'extra', inputPerMillion: 1, outputPerMillion: 1 },
    ])
  })

  it('reads a remaining fraction and ignores an unusable billing pair', () => {
    expect(readFoursapiRemainingRatio(
      { object: 'billing_subscription', hard_limit_usd: 10 },
      { object: 'list', total_usage: 250 },
    )).toBe(0.75)
    expect(readFoursapiRemainingRatio({ hard_limit_usd: 1e8 }, { total_usage: 0 })).toBe(1)
    expect(readFoursapiRemainingRatio({ hard_limit_usd: 1 }, { total_usage: 500 })).toBe(0)
    expect(readFoursapiRemainingRatio({ error: { message: 'nope' } }, { total_usage: 0 })).toBeUndefined()
    expect(readFoursapiRemainingRatio({ hard_limit_usd: 0 }, { total_usage: 0 })).toBeUndefined()
    expect(readFoursapiRemainingRatio({ hard_limit_usd: 1 }, null)).toBeUndefined()
    expect(readFoursapiRemainingRatio([], { total_usage: 0 })).toBeUndefined()
  })
})
