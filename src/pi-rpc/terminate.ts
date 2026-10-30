import { execFile, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

function exited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null
}

/** Only accepts the live child owned by this RPC instance, never a caller's PID. */
export async function terminateNativeTree(child: ChildProcess, ownsProcessGroup: boolean): Promise<void> {
  const pid = child.pid
  if (!pid) throw new Error('PI_STOP_UNCONFIRMED: native process has no PID')
  if (process.platform === 'win32' && exited(child)) {
    // Its numeric PID can now belong to an unrelated process. A dead launcher
    // does not prove descendants stopped and must not authorize taskkill.
    throw new Error('PI_STOP_UNCONFIRMED: native launcher already exited before tree termination')
  }
  let cleanup = () => {}
  const exit = exited(child)
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off('exit', onExit)
          reject(new Error('PI_STOP_UNCONFIRMED: native process did not exit'))
        }, 5_000)
        const onExit = () => {
          clearTimeout(timer)
          resolve()
        }
        cleanup = () => {
          clearTimeout(timer)
          child.off('exit', onExit)
        }
        child.once('exit', onExit)
      })
  void exit.catch(() => {})
  // A failed tree operation must never become a successful stop just because
  // the launcher exits. Observe both promises, including error paths.
  try {
    if (process.platform === 'win32') {
      const command = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
      await new Promise<void>((resolve, reject) => {
        execFile(command, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, error => {
          if (error) reject(new Error('PI_STOP_UNCONFIRMED: native process tree termination failed', { cause: error }))
          else resolve()
        })
      })
    } else if (ownsProcessGroup) {
      // spawn() created this private group. A wrapper's exit does not release
      // the group while its native descendants remain alive.
      try {
        process.kill(-pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    } else {
      throw new Error('PI_STOP_UNCONFIRMED: native process group ownership is unknown')
    }
    await exit
  } finally {
    cleanup()
  }
}
