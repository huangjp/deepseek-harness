/**
 * The WorkBuddy account's model catalogue, read from the product config the
 * WorkBuddy client caches.
 *
 * The catalogue is not served by a public HTTP endpoint: the daemon spills the
 * product config to a local file and the client reads it from there. The relay
 * reads the same file, so `/v1/models` shows what the account actually has
 * rather than a list frozen in code.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCatalogModels } from '../bridge/workbuddy-cloud.mjs'

/** 一份只含文本模型与媒体模型的产品配置。 */
function config(models: unknown[]): string {
  return JSON.stringify({ models })
}

describe('WorkBuddy 模型目录', () => {
  it('读出账号的文本模型', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-catalog-'))
    try {
      writeFileSync(join(dir, 'acc-product-config-v3.json'), config([
        { id: 'gpt-6-astra', name: 'GPT-6-Astra', credits: 'x6.67', supportsImages: true, supportsToolCall: true },
        { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', credits: 'x0.08', supportsImages: true, supportsToolCall: true },
      ]), 'utf8')
      const models = readCatalogModels(dir)
      expect(models.map(model => model.id)).toEqual(['gpt-6-astra', 'minimax-m3.1-flash'])
      expect(models[0]).toMatchObject({ name: 'GPT-6-Astra', credits: 'x6.67', supportsImages: true, supportsToolCall: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('读出每个模型的推理档位与输出上限', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-catalog-'))
    try {
      writeFileSync(join(dir, 'acc-product-config-v3.json'), config([
        {
          id: 'gpt-6-astra',
          name: 'GPT-6-Astra',
          maxOutputTokens: 128000,
          reasoning: { canDisableThinking: true, defaultEffort: 'high', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        },
        { id: 'default-model', name: 'Auto', maxOutputTokens: 24000 },
      ]), 'utf8')
      const [astra, auto] = readCatalogModels(dir)
      expect(astra).toMatchObject({
        maxOutputTokens: 128000,
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        canDisableThinking: true,
      })
      // 没有 reasoning 字段的模型（Auto 别名）没有档位，输出上限照旧读得到。
      expect(auto).toMatchObject({ maxOutputTokens: 24000, supportedEfforts: [], canDisableThinking: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('跳过带 tags 的媒体与代理模型', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-catalog-'))
    try {
      writeFileSync(join(dir, 'acc-product-config-v3.json'), config([
        { id: 'gpt-6-sol', name: 'GPT-6-Sol' },
        { id: 'hy-image-3.5', name: 'HY-Image-3.5', tags: ['text-to-image'] },
        { id: 'balanced-model', name: 'Balanced', tags: ['craft'] },
      ]), 'utf8')
      expect(readCatalogModels(dir).map(model => model.id)).toEqual(['gpt-6-sol'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录或文件读不到时返回空清单，不抛错', () => {
    expect(readCatalogModels(join(tmpdir(), 'dsh-wb-catalog-missing'))).toEqual([])
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-catalog-'))
    try {
      writeFileSync(join(dir, 'acc-product-config-v3.json'), 'not json', 'utf8')
      expect(readCatalogModels(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
