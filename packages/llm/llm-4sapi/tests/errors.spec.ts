import { describe, expect, it } from 'vitest'
import { classifyFoursapiProviderError } from '../src/errors.ts'

describe('4SAPI error classification', () => {
  it('maps an exhausted balance to quota before a 403 becomes authentication', () => {
    expect(classifyFoursapiProviderError(
      '403 {"error":{"message":"用户额度不足, 剩余额度: ＄0","code":"insufficient_user_quota"}}',
    )).toBe('QUOTA')
    expect(classifyFoursapiProviderError('预扣费额度失败, 用户剩余额度不足')).toBe('QUOTA')
    expect(classifyFoursapiProviderError('insufficient_quota')).toBe('QUOTA')
    expect(classifyFoursapiProviderError('令牌额度已用尽')).toBe('QUOTA')
    expect(classifyFoursapiProviderError('余额不足')).toBe('QUOTA')
    expect(classifyFoursapiProviderError('pre_consume_token_quota_failed')).toBe('QUOTA')
  })

  it('maps a missing channel and upstream 5xx to a retryable server failure', () => {
    expect(classifyFoursapiProviderError('503 当前分组 default 下对于模型 demo 无可用渠道')).toBe('SERVER')
    expect(classifyFoursapiProviderError('no available channel for model demo')).toBe('SERVER')
    expect(classifyFoursapiProviderError('get_channel_failed')).toBe('SERVER')
    expect(classifyFoursapiProviderError('502 bad gateway')).toBe('SERVER')
    expect(classifyFoursapiProviderError('524 connection timed out')).toBe('SERVER')
  })

  it('maps a rejected token to authentication', () => {
    expect(classifyFoursapiProviderError('401 无效的令牌')).toBe('AUTH')
    expect(classifyFoursapiProviderError('令牌已过期')).toBe('AUTH')
    expect(classifyFoursapiProviderError('invalid_api_key')).toBe('AUTH')
    expect(classifyFoursapiProviderError('403 令牌分组已被禁用')).toBe('AUTH')
  })

  it('keeps a short 429 on the rate-limit path', () => {
    expect(classifyFoursapiProviderError('429 Too Many Requests')).toBe('RATE_LIMIT')
    expect(classifyFoursapiProviderError('当前分组上游负载已饱和，请稍后再试')).toBe('RATE_LIMIT')
  })

  it('leaves unrecognized failures to the shared map', () => {
    expect(classifyFoursapiProviderError('400 invalid request body')).toBeUndefined()
    expect(classifyFoursapiProviderError('')).toBeUndefined()
  })
})
