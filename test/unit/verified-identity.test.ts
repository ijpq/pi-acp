import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyNativeIdentity, readNativeIdentity } from '../../src/acp/identity.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { SessionManager } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('identity comes from native header and RPC, never the filename or an ACP alias', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-identity-'))
  const sessionFile = join(cwd, 'wrong-acp-id.jsonl')
  const source = JSON.stringify({ type: 'session', id: 'real-native-id', cwd }) + '\n'
  writeFileSync(sessionFile, source)
  assert.equal(readNativeIdentity(sessionFile).sessionId, 'real-native-id')
  assert.equal(verifyNativeIdentity({ sessionId: 'real-native-id', sessionFile }, cwd).sessionId, 'real-native-id')
  for (const state of [
    null,
    {},
    { sessionId: 'wrong-acp-id', sessionFile },
    { sessionId: 'real-native-id', sessionFile: join(cwd, 'missing.jsonl') }
  ]) {
    assert.throws(() => verifyNativeIdentity(state, cwd), /PI_/)
  }
  assert.throws(
    () => verifyNativeIdentity({ sessionId: 'real-native-id', sessionFile }, join(cwd, 'other')),
    /MISMATCH/
  )
  assert.equal(readFileSync(sessionFile, 'utf8'), source)
})

test('a failed get_state cannot mint a random ready ACP session', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-new-failed-'))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = cwd
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  })
  let disposed = 0
  t.mock.method(
    PiRpcProcess,
    'spawn',
    async () =>
      ({
        getState: async () => {
          throw new Error('get_state transport timeout')
        },
        dispose: () => {
          disposed++
        }
      }) as unknown as PiRpcProcess
  )
  const sessions = new SessionManager()
  await assert.rejects(
    sessions.create({ cwd, mcpServers: [], conn: asAgentConn(new FakeAgentSideConnection()) }),
    /transport timeout/
  )
  assert.equal(disposed, 1)
})

test('session receipts from independent adapter processes cannot overwrite one another', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-session-map-'))
  const path = join(root, 'session-map.json')
  const first = new SessionStore(path)
  const second = new SessionStore(path)
  first.upsert({
    sessionId: 'acp-alias',
    nativeSessionId: 'native',
    cwd: root,
    sessionFile: join(root, 'native.jsonl')
  })
  second.upsert({ sessionId: 'another', cwd: root, sessionFile: join(root, 'other.jsonl') })
  assert.equal(first.get('another')?.sessionId, 'another')
  assert.equal(second.get('acp-alias')?.nativeSessionId, 'native')
  first.delete('another')
  assert.equal(second.get('another'), null)
  assert.equal(second.get('acp-alias')?.nativeSessionId, 'native')
  mkdirSync(join(root, 'legacy'))
  writeFileSync(
    join(root, 'legacy', 'session-map.json'),
    JSON.stringify({
      version: 1,
      sessions: { old: { sessionId: 'old', cwd: root, sessionFile: join(root, 'old.jsonl') } }
    })
  )
  assert.equal(new SessionStore(join(root, 'legacy', 'session-map.json')).get('old')?.sessionId, 'old')
})
