import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getPiAcpSessionMapPath } from './paths.js'

export type StoredSession = {
  sessionId: string
  cwd: string
  sessionFile: string
  nativeSessionId?: string
  updatedAt: string
}

type SessionMapFile = {
  version: 1
  sessions: Record<string, StoredSession>
}

function ensureParentDir(path: string) {
  mkdirSync(dirname(path), { recursive: true })
}

function loadFile(path: string): SessionMapFile {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as SessionMapFile
    if (parsed?.version !== 1 || typeof parsed.sessions !== 'object' || !parsed.sessions) {
      return { version: 1, sessions: {} }
    }
    return parsed
  } catch {
    return { version: 1, sessions: {} }
  }
}

export class SessionStore {
  private readonly path: string

  constructor(path = getPiAcpSessionMapPath()) {
    this.path = path
  }

  get(sessionId: string): StoredSession | null {
    const path = this.entryPath(sessionId)
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as StoredSession | null
    const db = loadFile(this.path)
    if (db.sessions[sessionId]) return db.sessions[sessionId]
    // A custom Pi profile used to share the home-level adapter map. Import
    // its explicit association lazily; the native process verifies it on load.
    if (this.path !== getPiAcpSessionMapPath()) return null
    const legacyPath = join(homedir(), '.pi', 'pi-acp', 'session-map.json')
    return legacyPath !== this.path ? (loadFile(legacyPath).sessions[sessionId] ?? null) : null
  }

  private entryPath(sessionId: string): string {
    return join(this.path + '.d', createHash('sha256').update(sessionId).digest('hex') + '.json')
  }

  private write(sessionId: string, value: StoredSession | null): void {
    const path = this.entryPath(sessionId)
    ensureParentDir(path)
    const temporary = path + '.' + crypto.randomUUID() + '.tmp'
    writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 })
    renameSync(temporary, path)
  }

  upsert(entry: { sessionId: string; cwd: string; sessionFile: string; nativeSessionId?: string }): void {
    this.write(entry.sessionId, { ...entry, updatedAt: new Date().toISOString() })
  }

  delete(sessionId: string): void {
    this.write(sessionId, null)
  }
}
