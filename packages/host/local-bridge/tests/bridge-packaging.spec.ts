import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 打包期陷阱：bridge/ 里的模块是**相对 import** 互相引用的，而打包后本模块的 URL 在
 * `app.asar/` 里。新加一个模块文件却忘了写进 package.json 的 `files`，它就不会进包 ——
 * 静态 import 在开发机上照常工作，装到用户机器上却是「模块找不到」，整个反代起不来。
 *
 * 这类问题在开发期完全看不出来（源码树里文件就在那儿），所以在这里钉住：
 * **任何被静态 import 的 bridge 模块，都必须出现在打包清单里。**
 */

const bridgeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bridge')
const pkg = JSON.parse(readFileSync(resolve(bridgeDir, '..', 'package.json'), 'utf8')) as {
  files: string[]
}

/** 从一个 bridge 模块里抽出所有相对静态 import 的目标。 */
function staticRelativeImports(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const found: string[] = []
  // 只认 `import ... from './x.mjs'` 这种静态形式；动态 import 走的是另一条路（见下）。
  const pattern = /\bfrom\s+['"](\.\/[^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) found.push(match[1]!)
  return found
}

describe('bridge module packaging', () => {
  it('lists every bridge module that is statically imported in the package files', () => {
    const listed = new Set(pkg.files)
    const missing: string[] = []
    for (const name of readdirSync(bridgeDir).filter(f => f.endsWith('.mjs'))) {
      for (const specifier of staticRelativeImports(join(bridgeDir, name))) {
        const target = specifier.replace(/^\.\//, '')
        if (!listed.has(`bridge/${target}`)) {
          missing.push(`${name} -> ${specifier}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('loads the diagnostic module through an absolute path, because it is not in the asar header', () => {
    const source = readFileSync(join(bridgeDir, 'copilot-bridge.mjs'), 'utf8')
    // 新文件不进 asar 头，所以只能按绝对路径 + asar→unpacked 映射动态导入。
    expect(source).not.toMatch(/from\s+['"]\.\/netdiag\.mjs['"]/)
    expect(source).toContain('resolveUnpackedPath')
    expect(source).toMatch(/await import\([\s\S]*netdiag\.mjs/)
  })
})
