import { randomUUID } from 'node:crypto'
import { openSync, closeSync, fstatSync, readSync } from 'node:fs'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../pi-rpc/process.js'

type Active = { id: string; startedAt: number; trigger: string }

// Read only a bounded tail of the verified native file. Never rewrite a rollout or
// infer identity from a filename. If an entry cannot be proven, leave it unlinked.
function nativeEntryId(path: string | undefined, result: Record<string, unknown>): string | undefined {
  if (!path || typeof result.summary !== 'string' || !result.summary) return
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const buffer = Buffer.alloc(Math.min(size, 1024 * 1024))
    const offset = size - buffer.length
    readSync(fd, buffer, 0, buffer.length, offset)
    const lines = buffer.toString('utf8').split('\n')
    if (offset) lines.shift()
    for (const line of lines.reverse()) {
      if (!line.trim()) continue
      const entry = JSON.parse(line) as Record<string, unknown>
      if (
        entry.type === 'compaction' &&
        entry.summary === result.summary &&
        entry.firstKeptEntryId === result.firstKeptEntryId &&
        entry.tokensBefore === result.tokensBefore &&
        typeof entry.id === 'string'
      )
        return entry.id
    }
  } catch {
    /* History remains independently readable if live correlation is unavailable. */
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export class CompactionLifecycle {
  private active: Active | undefined
  constructor(
    private readonly emit: (update: SessionUpdate) => void,
    private readonly sessionFile: () => string | undefined
  ) {}

  start(ev: PiRpcEvent): void {
    if (this.active) return
    this.active = {
      id: `pi-compaction-${randomUUID()}`,
      startedAt: Date.now(),
      trigger: String(ev.reason ?? 'automatic')
    }
    this.update('in_progress')
  }

  end(ev: PiRpcEvent): void {
    if (!this.active) this.start(ev)
    const error = typeof ev.errorMessage === 'string' ? ev.errorMessage : undefined
    const result = ev.result && typeof ev.result === 'object' ? (ev.result as Record<string, unknown>) : {}
    const status = ev.aborted === true ? 'cancelled' : error ? 'failed' : 'completed'
    this.update(status, { error, result })
    this.active = undefined
  }

  interrupt(status: 'failed' | 'cancelled', error?: string): void {
    if (!this.active) return
    this.update(status, { error })
    this.active = undefined
  }

  private update(status: string, details: { error?: string; result?: Record<string, unknown> } = {}): void {
    const active = this.active!
    const result = details.result ?? {}
    const eventId = nativeEntryId(this.sessionFile(), result)
    this.emit({
      sessionUpdate: 'compaction_update',
      compactionId: active.id,
      status,
      ...(typeof result.summary === 'string' ? { summary: { type: 'text', text: result.summary } } : {}),
      _meta: {
        contextCompaction: {
          version: 1,
          status,
          trigger: active.trigger,
          startedAt: active.startedAt,
          phase: status === 'in_progress' ? 'summarizing' : status,
          ...(status === 'in_progress' ? {} : { durationMs: Math.max(0, Date.now() - active.startedAt) }),
          ...(eventId ? { eventId } : {}),
          ...(typeof result.tokensBefore === 'number' ? { preTokens: result.tokensBefore } : {}),
          ...(typeof result.estimatedTokensAfter === 'number' ? { postTokens: result.estimatedTokensAfter } : {}),
          ...(details.error ? { error: details.error } : {})
        }
      }
    } as unknown as SessionUpdate)
  }
}
