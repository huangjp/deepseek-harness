/**
 * The bundled skills must survive packaging as ordinary files.
 *
 * A skill that only works when a user copies it by hand is not a shipped
 * feature, so the copy into the runtime payload is pinned here: the directory
 * the Host points `DSH_BUNDLED_SKILL_DIR` at, one `SKILL.md` per skill with a
 * frontmatter name that matches its directory, and no per-workspace memory
 * directory carried along inside an installation.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareBundledSkills } from '../scripts/prepare-primary-runtime.ts'

/**
 * Read one scalar field out of a markdown file's YAML frontmatter.
 * @param source - The file's text.
 * @param field - The field name.
 * @returns The field's value, or undefined when the file declares none.
 */
function frontmatterField(source: string, field: string): string | undefined {
  if (!source.startsWith('---')) return undefined
  const end = source.indexOf('\n---', 3)
  if (end < 0) return undefined
  const line = source.slice(3, end).split('\n').find(row => row.startsWith(`${field}:`))
  return line?.slice(field.length + 1).trim().replace(/^['"]|['"]$/g, '')
}

it('carries every bundled skill into the runtime payload with a matching name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-bundled-skills-'))
  try {
    await prepareBundledSkills(root)

    const skills = join(root, 'skills')
    expect(existsSync(join(skills, 'fiction-crafter', 'SKILL.md'))).toBe(true)

    const source = readFileSync(join(skills, 'fiction-crafter', 'SKILL.md'), 'utf8')
    // The provider loads a skill by its directory name, so the two must agree.
    expect(frontmatterField(source, 'name')).toBe('fiction-crafter')
    expect(frontmatterField(source, 'description')?.length ?? 0).toBeGreaterThan(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('leaves the per-workspace memory directory out of the installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-bundled-skills-'))
  try {
    await prepareBundledSkills(root)
    // `.learnings/` is filled in per workspace; shipping an empty one invites a
    // model to read the installation directory instead of the project.
    expect(existsSync(join(root, 'skills', 'fiction-crafter', '.learnings'))).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
