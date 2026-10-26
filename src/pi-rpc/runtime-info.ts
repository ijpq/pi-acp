import crossSpawn from 'cross-spawn'
import { getPiCommand } from './command.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export function selectedPiChangelog(command: string): string | null {
  if (!isAbsolute(command) || !existsSync(command)) return null
  let dir = dirname(realpathSync(command))
  for (let depth = 0; depth < 5; depth++) {
    for (const root of [dir, join(dir, 'node_modules/@earendil-works/pi-coding-agent')]) {
      try {
        const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
        const file = join(root, 'CHANGELOG.md')
        if (metadata.name === '@earendil-works/pi-coding-agent' && existsSync(file)) return file
      } catch {
        /* The selected launcher may not have an adjacent package. */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Probe only the executable selected for RPC, with a bounded diagnostic call. */
export function piRuntimeInfo(command = getPiCommand(process.env.PI_ACP_PI_COMMAND)) {
  try {
    const result = crossSpawn.sync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
      maxBuffer: 4096
    })
    const value = String(result.stdout ?? '')
      .trim()
      .replace(/^v/, '')
    const version = result.status === 0 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value) ? value : null
    return { command, version, verified: version !== null }
  } catch {
    return { command, version: null, verified: false }
  }
}
