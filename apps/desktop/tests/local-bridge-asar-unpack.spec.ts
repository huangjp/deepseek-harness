import { describe, expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

/**
 * local-bridge 的 bridge/ 必须留在 ASAR 之外。
 *
 * 那里有一批文件是由**外部进程**读取的：powershell.exe 用 Get-Content 读
 * refresh-token.ps1，mitmdump 用 --scripts 加载 token-harvester.py。这些进程不认识
 * ASAR，给它们一条 app.asar 里的路径只会静默失败 —— refreshCopilotToken 的 spawn()
 * 照样返回成功，于是预检报 refresh.started=true，但 mitmdump 从未启动、
 * token.json 也永远不会出现。packages/host/local-bridge 的 resolveRealPath() 与这条
 * 规则是成对的：它把 app.asar 前缀改写成 app.asar.unpacked。
 */
describe('local-bridge ASAR unpack', () => {
  const config = createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: 'com.example.installer',
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://harness-test.deepseek.com',
    DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    DSH_DESKTOP_TARGET_PLATFORM: 'win32',
    DSH_DESKTOP_TARGET_ARCH: 'x64',
    DSH_DESKTOP_UNSIGNED: '1',
  }, 'win32', 'x64')

  const patterns: readonly string[] = config.asarUnpack ?? []

  // The rule has to reach the bridge directory no matter where the dsh tree is
  // mounted, so it is anchored on the package rather than on a build path.
  it('unpacks the whole bridge directory', () => {
    expect(patterns).toContain('**/node_modules/@deepseek-ai/dsh-host-local-bridge/bridge/**')
  })

  it('keeps the existing native-code rules', () => {
    // Narrowing the list would silently start packing native binaries again.
    expect(patterns).toContain('**/*.{node,dylib,dll,so,exe}')
    expect(patterns).toContain('**/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/**/*')
  })

  it('does not widen the bridge rule to the whole package', () => {
    // lib/index.js is imported through Electron's asar-aware loader and must stay packed.
    expect(patterns).not.toContain('**/node_modules/@deepseek-ai/dsh-host-local-bridge/**')
  })
})
