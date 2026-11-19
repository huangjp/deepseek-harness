import { describe, expect, it } from 'vitest'
import { classifyXaiProviderError } from '../src/errors.ts'

describe('xAI error classification', () => {
  it('treats a bad key as authentication, including a bare 401 or 403', () => {
    expect(classifyXaiProviderError('401 Incorrect API key provided')).toBe('AUTH')
    expect(classifyXaiProviderError('403 permission denied')).toBe('AUTH')
    expect(classifyXaiProviderError('invalid authentication token')).toBe('AUTH')
  })

  it('keeps a short 429 on the rate-limit path', () => {
    expect(classifyXaiProviderError('429 Too Many Requests')).toBe('RATE_LIMIT')
    expect(classifyXaiProviderError('rate limit exceeded for this team')).toBe('RATE_LIMIT')
  })

  it('maps exhausted credits or a spending cap to quota even when the status is 429 or 403', () => {
    expect(classifyXaiProviderError(
      '429 Your team has either used all available credits or reached its monthly spending limit.',
    )).toBe('QUOTA')
    expect(classifyXaiProviderError('403 spend limit reached for this organization')).toBe('QUOTA')
    expect(classifyXaiProviderError('insufficient credits for this request')).toBe('QUOTA')
  })

  it('leaves unrecognized failures to the shared map', () => {
    expect(classifyXaiProviderError('500 internal error')).toBeUndefined()
    expect(classifyXaiProviderError('')).toBeUndefined()
  })
})
