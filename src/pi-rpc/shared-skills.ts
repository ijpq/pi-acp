import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// This launch-only contract contains source paths, never skills, auth or
// extension modules. Pi loads the originals with its native skill loader.
export function sharedSkillArgs(raw: string | undefined, cwd: string): string[] {
  if (raw === undefined || raw === '') return []
  let paths: unknown
  try {
    paths = JSON.parse(raw)
  } catch {
    throw new Error('PI_SHARED_SKILL_CONFIG_INVALID: expected a JSON array of source paths')
  }
  if (!Array.isArray(paths) || paths.length > 64 || paths.some(p => typeof p !== 'string' || !p || p.includes('\0'))) {
    throw new Error('PI_SHARED_SKILL_CONFIG_INVALID: expected at most 64 nonempty source paths')
  }
  const seen = new Set<string>()
  const args: string[] = []
  for (const path of paths as string[]) {
    let source: string
    try {
      source = realpathSync(resolve(cwd, path))
      const stat = statSync(source)
      if (!stat.isDirectory() && !(stat.isFile() && source.endsWith('.md'))) {
        throw new Error('not a skill directory or Markdown source')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error('PI_SHARED_SKILL_CONFIG_INVALID: cannot read a configured skill source', { cause: error })
    }
    const key = process.platform === 'win32' ? source.toLowerCase() : source
    if (seen.has(key)) continue
    seen.add(key)
    args.push('--skill', source)
  }
  return args
}
