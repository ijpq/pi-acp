import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Storage owned by the ACP adapter.
 *
 * We intentionally keep this separate from pi's own ~/.pi/agent/* directory.
 */
export function getPiAcpDir(): string {
  return (
    process.env.PI_ACP_DATA_DIR ||
    (process.env.PI_CODING_AGENT_DIR
      ? join(process.env.PI_CODING_AGENT_DIR, 'pi-acp')
      : join(homedir(), '.pi', 'pi-acp'))
  )
}

export function getPiAcpSessionMapPath(): string {
  return join(getPiAcpDir(), 'session-map.json')
}
