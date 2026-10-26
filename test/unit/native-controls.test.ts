import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakePiRpcProcess, FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('steering and follow-up invoke distinct native commands, preserve images, and never start an idle turn', async () => {
  const conn = asAgentConn(new FakeAgentSideConnection())
  const proc = new FakePiRpcProcess()
  const calls: unknown[] = []
  Reflect.set(proc, 'steer', async (...args: unknown[]) => {
    calls.push(args)
    return 'queued'
  })
  const session = new PiAcpSession({
    sessionId: 'native',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn
  })
  const agent = new PiAcpAgent(conn)
  Reflect.set(agent, 'sessions', { maybeGet: () => session })
  const params = {
    sessionId: 'native',
    prompt: [
      { type: 'text', text: 'native guidance' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw==' }
    ]
  }
  await assert.rejects(agent.extMethod('_session/steering', params), /NO_ACTIVE_TURN/)
  const prompt = session.prompt('long tool task')
  assert.deepEqual(await agent.extMethod('_session/steering', params), { outcome: 'injected', disposition: 'queued' })
  assert.deepEqual(await agent.extMethod('_pi/follow_up', params), { outcome: 'injected', disposition: 'queued' })
  assert.deepEqual(calls, [
    ['native guidance', [{ type: 'image', mimeType: 'image/png', data: 'iVBORw==' }], false],
    ['native guidance', [{ type: 'image', mimeType: 'image/png', data: 'iVBORw==' }], true]
  ])
  proc.emit({ type: 'agent_end' })
  assert.equal(session.isRunning(), true)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  assert.equal(proc.prompts.length, 1)
})

test('native errors are failures and process exit settles current and queued callers', async () => {
  const conn = asAgentConn(new FakeAgentSideConnection())
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'native',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn
  })
  const task = session.prompt('provider failure')
  proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await task, 'error')
  const current = session.prompt('current')
  const queued = session.prompt('queued')
  const rejected = Promise.all([assert.rejects(current, /process exited/), assert.rejects(queued, /process exited/)])
  proc.emit({ type: 'process_exit', error: 'process exited' })
  await rejected
  assert.equal(session.isRunning(), false)
})

test('cancel clears Pi steering/follow-up queues before abort, leaving no automatic work behind', async () => {
  const conn = asAgentConn(new FakeAgentSideConnection())
  const proc = new FakePiRpcProcess()
  const order: string[] = []
  proc.clearQueue = async () => {
    order.push('clear_queue')
  }
  proc.abort = async () => {
    order.push('abort')
  }
  const session = new PiAcpSession({
    sessionId: 'native',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn
  })
  const prompt = session.prompt('running')
  await session.cancel()
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'cancelled')
  assert.deepEqual(order, ['clear_queue', 'abort'])
})
