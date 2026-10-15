import { describe, expect, it } from 'vitest'
import { resolveRealPath } from '../src/index.ts'

describe('resolveRealPath', () => {
  it('rewrites a packaged Windows ASAR path to the unpacked tree', () => {
    // The shape Electron produces: resources/app.asar/node_modules/<pkg>/bridge/refresh-token.ps1.
    expect(resolveRealPath(
      'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar\\node_modules'
      + '\\@deepseek-ai\\dsh-host-local-bridge\\bridge\\refresh-token.ps1',
    )).toBe(
      'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar.unpacked\\node_modules'
      + '\\@deepseek-ai\\dsh-host-local-bridge\\bridge\\refresh-token.ps1',
    )
  })

  it('accepts forward slashes so URLs and tests normalize the same way', () => {
    expect(resolveRealPath('/opt/app/resources/app.asar/dsh/bridge/token-harvester.py'))
      .toBe('/opt/app/resources/app.asar.unpacked/dsh/bridge/token-harvester.py')
  })

  it('preserves the separator style it found', () => {
    expect(resolveRealPath('D:/app/app.asar/dsh/bridge/chat_template.json'))
      .toBe('D:/app/app.asar.unpacked/dsh/bridge/chat_template.json')
  })

  it('leaves an already unpacked path untouched', () => {
    const unpacked = 'C:\\app\\resources\\app.asar.unpacked\\dsh\\bridge\\refresh-token.ps1'
    expect(resolveRealPath(unpacked)).toBe(unpacked)
  })

  it('leaves ordinary source-tree and temporary paths untouched', () => {
    expect(resolveRealPath('D:\\coding\\deepseek_harness\\packages\\host\\local-bridge\\bridge\\preflight.mjs'))
      .toBe('D:\\coding\\deepseek_harness\\packages\\host\\local-bridge\\bridge\\preflight.mjs')
    expect(resolveRealPath('/tmp/dsh-local-bridge')).toBe('/tmp/dsh-local-bridge')
  })

  it('does not rewrite a directory merely named like the archive', () => {
    // Only the real archive segment counts; "app.asarx" and bare "app.asar" prefixes must stay.
    expect(resolveRealPath('C:\\app\\resources\\app.asarx\\dsh\\bridge\\x.ps1'))
      .toBe('C:\\app\\resources\\app.asarx\\dsh\\bridge\\x.ps1')
  })
})
