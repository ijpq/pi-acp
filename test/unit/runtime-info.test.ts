import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { piRuntimeInfo, selectedPiChangelog } from '../../src/pi-rpc/runtime-info.js'

test('runtime diagnostics probe the selected executable, including Windows launchers and spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi selected runtime '))
  try {
    const command = join(root, process.platform === 'win32' ? 'selected.cmd' : 'selected')
    writeFileSync(
      command,
      process.platform === 'win32' ? '@echo off\r\necho 1.4.0\r\n' : '#!/bin/sh\nprintf "1.4.0\\n"\n',
      { mode: 0o755 }
    )
    assert.deepEqual(piRuntimeInfo(command), { command, version: '1.4.0', verified: true })
    const pkg = join(root, 'node_modules/@earendil-works/pi-coding-agent')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0' })
    )
    writeFileSync(join(pkg, 'CHANGELOG.md'), 'Selected runtime changelog')
    assert.equal(selectedPiChangelog(command), join(pkg, 'CHANGELOG.md'))
    assert.equal(selectedPiChangelog(join(root, 'missing')), null)
    const missing = join(root, 'missing-pi')
    assert.deepEqual(piRuntimeInfo(missing), { command: missing, version: null, verified: false })
    writeFileSync(
      command,
      process.platform === 'win32'
        ? '@echo off\r\necho invalid version\r\n'
        : '#!/bin/sh\nprintf "invalid version\\n"\n',
      { mode: 0o755 }
    )
    assert.equal(piRuntimeInfo(command).verified, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
