/**
 * Clearing the previous electron-builder output before a packaging run.
 *
 * electron-builder replaces the `resources/app.asar` the previous run left in
 * that directory, so the directory has to be clear before it runs. A file a
 * running process still holds makes the recursive delete fail, and
 * electron-builder then reports a bare `EBUSY` stack; clearing first turns
 * that into a message naming what is held.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPreviousElectronOutput } from '../scripts/package-target.ts'
import type { DesktopPackageTarget } from '../scripts/package-target.ts'

const roots: string[] = []
const holders: ChildProcess[] = []

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    holder.kill()
    await new Promise<void>((resolve) => {
      if (holder.exitCode !== null || holder.signalCode !== null) {
        resolve()
        return
      }
      holder.once('exit', () => { resolve() })
    })
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fresh temporary directory the test owns. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-output-'))
  roots.push(root)
  return root
}

/** Write one file, creating the directories above it. */
function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** The Windows target the output path is derived from. */
const WINDOWS_TARGET: DesktopPackageTarget = {
  name: 'win-x64', platform: 'win32', arch: 'x64', builderPlatform: '--win', builderArch: '--x64',
}

describe('clearPreviousElectronOutput', () => {
  it('leaves a missing output directory alone', () => {
    const root = workspace()
    expect(() => clearPreviousElectronOutput(root, WINDOWS_TARGET)).not.toThrow()
  })

  it('removes the previous output directory', () => {
    const root = workspace()
    const appOutDir = join(root, 'win-unpacked')
    writeFile(join(appOutDir, 'DeepSeek Harness.exe'), 'binary')
    clearPreviousElectronOutput(root, WINDOWS_TARGET)
    expect(existsSync(appOutDir)).toBe(false)
  })

  it('names the entries a running process still holds', async () => {
    const root = workspace()
    const appOutDir = join(root, 'win-unpacked')
    const held = join(appOutDir, 'resources', 'app.asar')
    writeFile(join(appOutDir, 'DeepSeek Harness.exe'), 'binary')
    writeFile(held, 'asar')
    const ready = `${held}.ready`
    const script = [
      `$fs = [System.IO.File]::Open('${held.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'None')`,
      `Set-Content -LiteralPath '${ready.replace(/'/g, "''")}' -Value 'held'`,
      'Start-Sleep -Seconds 60',
    ].join('; ')
    const holder = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' })
    holders.push(holder)
    for (let attempt = 0; attempt < 100; attempt++) {
      if (existsSync(ready)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(existsSync(ready)).toBe(true)
    expect(() => clearPreviousElectronOutput(root, WINDOWS_TARGET)).toThrow(/删不掉/)
  })
})
