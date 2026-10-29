import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'compaction',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn)
  })
  return { conn, proc, session }
}

test('native compaction lifecycle is one structured card and does not finish the user task', async () => {
  const { conn, proc, session } = fixture()
  const task = session.prompt('continue')
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  await tick()
  const start = conn.updates.map(v => v.update as any).find(v => v.sessionUpdate === 'compaction_update')
  assert.equal(start?.status, 'in_progress')
  assert.ok(start._meta.contextCompaction.startedAt)
  proc.emit({
    type: 'compaction_end',
    reason: 'threshold',
    aborted: false,
    result: {
      tokensBefore: 120000,
      estimatedTokensAfter: 4000,
      summary: 'Retained requirements',
      firstKeptEntryId: 'entry1'
    }
  })
  await tick()
  assert.equal(session.isRunning(), true)
  const end = conn.updates
    .map(v => v.update as any)
    .filter(v => v.sessionUpdate === 'compaction_update')
    .at(-1)
  assert.equal(end.compactionId, start.compactionId)
  assert.equal(end.status, 'completed')
  assert.equal(end._meta.contextCompaction.postTokens, 4000)
  proc.emit({ type: 'agent_settled', aborted: false })
  assert.equal(await task, 'end_turn')
})

test('compaction failure and cancellation keep their actual terminal status and cause', async () => {
  for (const aborted of [false, true]) {
    const { conn, proc } = fixture()
    proc.emit({ type: 'compaction_start', reason: 'manual' })
    proc.emit({
      type: 'compaction_end',
      reason: 'manual',
      aborted,
      errorMessage: aborted ? undefined : 'Summary provider rejected request: 403'
    })
    await tick()
    const end = conn.updates
      .map(v => v.update as any)
      .filter(v => v.sessionUpdate === 'compaction_update')
      .at(-1)
    assert.equal(end?.status, aborted ? 'cancelled' : 'failed')
    assert.equal(end._meta.contextCompaction.error, aborted ? undefined : 'Summary provider rejected request: 403')
  }
})

test('unconfirmed admission stops native execution before releasing the task, retaining the error', async () => {
  const { proc, session } = fixture()
  let release!: () => void
  let stopStarted = false
  Reflect.set(proc, 'prompt', async () => {
    throw new Error('pi prompt timed out after 30000ms')
  })
  Reflect.set(proc, 'stopExecution', async () => {
    stopStarted = true
    await new Promise<void>(resolve => {
      release = resolve
    })
  })
  const task = session.prompt('continue')
  const rejected = assert.rejects(task, /pi prompt timed out after 30000ms/)
  await tick()
  assert.equal(stopStarted, true)
  assert.equal(session.isRunning(), true)
  release()
  await rejected
  assert.equal(session.isRunning(), false)
})

test('a successful native retry clears the earlier provider error instead of failing the final reply', async () => {
  const { proc, session } = fixture()
  const task = session.prompt('retryable work')
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'Provider overloaded: 529' }
  })
  proc.emit({ type: 'agent_end' })
  assert.equal(session.isRunning(), true)
  proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  proc.emit({ type: 'agent_settled', aborted: false })
  assert.equal(await task, 'end_turn')
  assert.equal(session.executionFailure(), undefined)
})

test('a terminal provider failure retains its diagnostic until the next task', async () => {
  const { proc, session } = fixture()
  const task = session.prompt('failing work')
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'Summary provider policy rejected: 403' }
  })
  proc.emit({ type: 'agent_settled', aborted: false })
  assert.equal(await task, 'error')
  assert.equal(session.executionFailure(), 'Summary provider policy rejected: 403')
})
