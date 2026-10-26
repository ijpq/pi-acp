import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export type NativeIdentity = { sessionId: string; sessionFile: string; cwd: string }

export function readNativeIdentity(sessionFile: string): NativeIdentity {
  const fd = openSync(sessionFile, 'r')
  try {
    const buffer = Buffer.alloc(65536)
    const count = readSync(fd, buffer, 0, buffer.length, 0)
    const line = buffer.subarray(0, count).toString('utf8').split('\n', 1)[0]
    const header: unknown = JSON.parse(line)
    if (!header || typeof header !== 'object') throw new Error('Invalid Pi session header')
    const value = header as Record<string, unknown>
    if (value.type !== 'session' || typeof value.id !== 'string' || !value.id || typeof value.cwd !== 'string') {
      throw new Error('Invalid Pi session identity')
    }
    return { sessionId: value.id, sessionFile: realpathSync(sessionFile), cwd: value.cwd }
  } finally {
    closeSync(fd)
  }
}

export function verifyNativeIdentity(state: unknown, cwd: string, expected?: NativeIdentity): NativeIdentity {
  const value = state as Record<string, unknown> | null
  if (
    typeof value?.sessionId !== 'string' ||
    !value.sessionId ||
    typeof value.sessionFile !== 'string' ||
    !isAbsolute(value.sessionFile)
  ) {
    throw new Error('PI_IDENTITY_UNVERIFIED: get_state did not return a persistent session identity')
  }
  if (!existsSync(value.sessionFile))
    throw new Error('PI_SESSION_FILE_MISSING: refusing to replace an unpersisted session')
  const identity = readNativeIdentity(value.sessionFile)
  if (
    identity.sessionId !== value.sessionId ||
    resolve(identity.cwd) !== resolve(cwd) ||
    (expected && (identity.sessionId !== expected.sessionId || identity.sessionFile !== expected.sessionFile))
  ) {
    throw new Error('PI_IDENTITY_MISMATCH: native state, file header and requested binding disagree')
  }
  return identity
}
