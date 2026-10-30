import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('failed RPC admission stops the actual native descendant, including Windows cmd launchers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-stop-owned-'))
  const heartbeat = join(root, 'heartbeat')
  const wrapper = join(root, 'wrapper.cjs')
  await writeFile(
    wrapper,
    `const {spawn}=require('node:child_process');
const fs=require('node:fs');
const child=spawn(process.execPath,['-e',
  'const fs=require("node:fs");setInterval(()=>fs.appendFileSync(process.argv[1],"x"),20)',
  ${JSON.stringify(heartbeat)}],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(join(root, 'child.pid'))},String(child.pid));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const req=JSON.parse(line);
  process.stdout.write(JSON.stringify({type:'response',id:req.id,command:req.type,success:false,error:'FAULT_INJECTED'})+'\\n');
});
setInterval(()=>{},1000);
`
  )
  const windows = process.platform === 'win32'
  const launcher = join(root, 'pi.cmd')
  if (windows) await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${wrapper}"\r\n`)
  const child = windows
    ? crossSpawn(launcher, [], { stdio: 'pipe', windowsHide: true })
    : spawn(process.execPath, [wrapper], { stdio: 'pipe', detached: true })
  const proc = new (PiRpcProcess as any)(child, !windows) as PiRpcProcess
  let nativePid: number | undefined
  let stopped = false
  try {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        nativePid = Number(await readFile(join(root, 'child.pid'), 'utf8'))
        if ((await readFile(heartbeat, 'utf8')).length) break
      } catch {
        // Wait for both owned fixture files to be created.
      }
      await pause(20)
    }
    assert.ok(nativePid, 'This test owns a real native descendant')
    await proc.stopExecution()
    await pause(100)
    const afterStop = (await readFile(heartbeat, 'utf8')).length
    await pause(150)
    assert.equal(
      (await readFile(heartbeat, 'utf8')).length,
      afterStop,
      'Native work must stop before reporting success'
    )
    stopped = true
  } finally {
    // Safety net for the before-fix test: only PIDs started by this fixture.
    if (!stopped && nativePid) {
      try {
        process.kill(nativePid, 'SIGKILL')
      } catch {
        // Already stopped by the implementation under test.
      }
    }
    if (!stopped && !windows && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The owned process group is already gone.
      }
    }
    child.kill('SIGKILL')
  }
})
