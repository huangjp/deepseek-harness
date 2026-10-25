/**
 * The Electron distribution step of desktop packaging: a file a running
 * process still holds must not stop the step.
 *
 * `ELECTRON_RUN_AS_NODE` makes Electron open `resources/default_app.asar` when
 * it starts, so a second packaging run inside the same process tree finds
 * that file locked for as long as the earlier tree lives. The step therefore
 * clears the directory best-effort and extracts through a staging directory:
 * the held file keeps the copy already in place, and everything else is
 * replaced.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearTreeBestEffort, extractElectron } from '../scripts/prepare-runtime.ts'

const roots: string[] = []
const holders: ChildProcess[] = []

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    holder.kill()
    await waitForExit(holder)
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fresh temporary directory the test owns. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-prepare-runtime-'))
  roots.push(root)
  return root
}

/** Write one file, creating the directories above it. */
function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** Resolve once the child process is gone, so its handle no longer holds a file. */
function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('exit', () => { resolve() })
  })
}

/**
 * Hold one file open with no sharing at all, the way a running Electron
 * process does, and wait until the hold is in place.
 *
 * Node's own file handles share deletion on Windows, so a Node-side handle
 * cannot reproduce the lock; a .NET `FileShare.None` stream can.
 *
 * @param path - the file to hold.
 * @returns the holder process, already holding the file.
 */
async function holdExclusively(path: string): Promise<ChildProcess> {
  const ready = `${path}.ready`
  const script = [
    `$fs = [System.IO.File]::Open('${path.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'None')`,
    `Set-Content -LiteralPath '${ready.replace(/'/g, "''")}' -Value 'held'`,
    'Start-Sleep -Seconds 60',
  ].join('; ')
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' })
  holders.push(holder)
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(ready)) return holder
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('the exclusive holder never took the file')
}

describe('clearTreeBestEffort', () => {
  it('clears a directory nothing holds', () => {
    const root = workspace()
    writeFile(join(root, 'electron.exe'), 'binary')
    expect(clearTreeBestEffort(root)).toBe(0)
    expect(() => readFileSync(join(root, 'electron.exe'))).toThrow()
  })

  it('keeps a held entry and clears the rest', async () => {
    const root = workspace()
    const held = join(root, 'resources', 'default_app.asar')
    writeFile(join(root, 'electron.exe'), 'binary')
    writeFile(held, 'asar')
    const holder = await holdExclusively(held)
    expect(clearTreeBestEffort(root)).toBe(1)
    expect(existsSync(held)).toBe(true)
    expect(() => readFileSync(join(root, 'electron.exe'))).toThrow()
    holder.kill()
    await waitForExit(holder)
    expect(readFileSync(held, 'utf8')).toBe('asar')
  })
})

describe('extractElectron', () => {
  it('replaces the previous distribution', async () => {
    const root = workspace()
    const destination = join(root, 'electron')
    writeFile(join(destination, 'electron.exe'), 'old')
    const archive = await stageArchive(root, { 'electron.exe': 'new', 'resources/default_app.asar': 'asar' })
    await extractElectron(archive, destination)
    expect(readFileSync(join(destination, 'electron.exe'), 'utf8')).toBe('new')
    expect(readFileSync(join(destination, 'resources', 'default_app.asar'), 'utf8')).toBe('asar')
  })

  it('keeps a held file in place and replaces everything else', async () => {
    const root = workspace()
    const destination = join(root, 'electron')
    const held = join(destination, 'resources', 'default_app.asar')
    writeFile(join(destination, 'electron.exe'), 'old')
    writeFile(held, 'held-by-the-running-process')
    const archive = await stageArchive(root, { 'electron.exe': 'new', 'resources/default_app.asar': 'fresh' })
    const holder = await holdExclusively(held)
    await expect(extractElectron(archive, destination)).resolves.toBeUndefined()
    expect(readFileSync(join(destination, 'electron.exe'), 'utf8')).toBe('new')
    expect(existsSync(held)).toBe(true)
    holder.kill()
    await waitForExit(holder)
    expect(readFileSync(held, 'utf8')).toBe('held-by-the-running-process')
  })
})

/**
 * Build a zip holding the given entries.
 *
 * The archive lists its top-level names explicitly: a zip written with a `.`
 * entry carries a root directory entry that `extract-zip` rejects.
 *
 * @param root - the temporary directory to build in.
 * @param entries - file paths inside the archive and their contents.
 * @returns the archive's absolute path.
 */
async function stageArchive(root: string, entries: Record<string, string>): Promise<string> {
  const source = join(root, 'source')
  for (const [path, content] of Object.entries(entries)) {
    writeFile(join(source, path), content)
  }
  const archive = join(root, 'electron.zip')
  const topLevel = [...new Set(Object.keys(entries).map(path => path.split('/')[0]!))]
  // The Windows tar that ships with the box writes zip archives.
  execFileSync('tar.exe', ['-a', '-c', '-f', archive, '-C', source, ...topLevel], { stdio: 'ignore' })
  return archive
}
