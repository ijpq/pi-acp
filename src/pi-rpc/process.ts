import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { McpServer } from '@agentclientprotocol/sdk'
import { fileURLToPath } from 'node:url'
import { readNativeIdentity, verifyNativeIdentity, type NativeIdentity } from '../acp/identity.js'
import { existsSync } from 'node:fs'
import crossSpawn from 'cross-spawn'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getPiAcpDir } from '../acp/paths.js'
import { type TierChoice } from '../service-tier.js'
import { readFileSync } from 'node:fs'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'
import { sharedSkillArgs } from './shared-skills.js'
import { terminateNativeTree } from './terminate.js'

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'abort' | 'clear_queue' | 'clone'; id?: string }
  | { type: 'steer' | 'follow_up'; id?: string; message: string; images?: unknown[] }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'get_available_thinking_levels'; id?: string }
  | { type: 'set_thinking_level'; id?: string; level: string }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PiExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true }

export type PiRpcEvent = Record<string, unknown>

/** Maximum wait for an auxiliary context-usage update. */
export const SESSION_STATS_TIMEOUT_MS = 1_000

/**
 * Shape of `stats.contextUsage` in pi's `get_session_stats` response.
 * `tokens` is null while pi has no trustworthy token count (e.g. right after compaction).
 */
export type PiContextUsage = {
  tokens?: number | null
  contextWindow?: number | null
}

export type PiSessionStats = {
  sessionId?: string
  sessionFile?: string
  totalMessages?: number
  cost?: number
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
  contextUsage?: PiContextUsage | null
}

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
  mcpServers?: McpServer[]
  createSession?: boolean
  expectedNativeSessionId?: string
}

export class PiRpcProcess {
  nativeIdentity?: NativeIdentity
  tierFile?: string
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, { resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private readonly preludeLines: string[] = []
  private compacting = false

  private constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly ownsProcessGroup = false
  ) {
    this.child = child

    const decoder = new StringDecoder('utf8')
    let buffered = ''
    const consume = (line: string) => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        // pi may emit a human-readable prelude on stdout before NDJSON starts.
        // Capture it so the ACP adapter can surface it on session start.
        const cleaned = stripAnsi(String(line)).trimEnd()
        if (cleaned) this.preludeLines.push(cleaned)
        return
      }

      if (msg?.type === 'response') {
        const id = typeof msg.id === 'string' ? msg.id : undefined
        // `resolve` removes the pending entry. Responses for unknown or already timed-out
        // ids are dropped: a response is never a pi event, so it must not be broadcast.
        if (id !== undefined) this.pending.get(id)?.resolve(msg as PiRpcResponse)
        return
      }

      if (msg?.type === 'compaction_start' || msg?.type === 'auto_compaction_start') this.compacting = true
      if (msg?.type === 'compaction_end' || msg?.type === 'auto_compaction_end') this.compacting = false
      for (const h of this.eventHandlers) h(msg as PiRpcEvent)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += decoder.write(chunk)
      let boundary: number
      while ((boundary = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 1)
        consume(line.replace(/\r$/, ''))
      }
    })

    child.on('exit', (code, signal) => {
      const err = new Error(`pi process exited (code=${code}, signal=${signal})`)
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
      for (const handler of this.eventHandlers) handler({ type: 'process_exit', error: err.message })
    })

    child.on('error', err => {
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    const expected = params.sessionPath && !params.createSession ? readNativeIdentity(params.sessionPath) : undefined
    if (expected && params.expectedNativeSessionId && expected.sessionId !== params.expectedNativeSessionId) {
      throw new Error('PI_IDENTITY_MISMATCH: persisted mapping conflicts with native file')
    }
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = ['--mode', 'rpc', '--no-themes']
    const env = { ...process.env }
    args.push(...sharedSkillArgs(env.CODEG_SHARED_SKILL_PATHS_JSON, params.cwd))
    const tierFile = join(
      getPiAcpDir(),
      'service-tiers',
      createHash('sha256')
        .update(params.sessionPath ?? randomUUID())
        .digest('hex') + '.json'
    )
    env.PI_ACP_TIER_FILE = tierFile
    {
      const servers: Record<string, unknown> = {}
      for (const server of params.mcpServers ?? []) {
        if ('type' in server && server.type === 'sse') throw new Error('PI_MCP_TRANSPORT_UNSUPPORTED: SSE')
        if ('command' in server) {
          servers[server.name] = {
            command: server.command,
            args: server.args,
            env: Object.fromEntries(server.env.map(v => [v.name, v.value])),
            exposure: 'direct'
          }
        } else if ('url' in server) {
          servers[server.name] = {
            url: server.url,
            headers: Object.fromEntries(server.headers.map(v => [v.name, v.value])),
            exposure: 'direct'
          }
        }
      }
      env.PI_ACP_MCP_SERVERS_JSON = JSON.stringify(servers)
      const built = fileURLToPath(new URL('./pi-mcp-extension.js', import.meta.url))
      const extension = existsSync(built) ? built : fileURLToPath(new URL('../pi-mcp-extension.ts', import.meta.url))
      args.push('--extension', extension)
    }
    if (params.sessionPath) args.push('--session', params.sessionPath)

    // Windows cmd launchers need shell escaping; direct executables use native argv.
    const start = shouldUseShellForPiCommand(cmd) ? crossSpawn : spawn
    const child = start(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
      windowsHide: true,
      env
    }) as ChildProcessWithoutNullStreams

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e })
    }

    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })

    const proc = new PiRpcProcess(child, process.platform !== 'win32')
    proc.tierFile = tierFile

    try {
      proc.nativeIdentity = verifyNativeIdentity(await proc.getState(), params.cwd, expected)
      const commands = (await proc.getCommands()) as { commands?: Array<{ name?: string }> }
      if (!commands.commands?.some(command => command.name === 'codeg-pi-runtime-v1')) {
        throw new Error(
          'PI_RUNTIME_UPGRADE_REQUIRED: matching native MCP extension did not load; Pi 1.4.0 or newer is required'
        )
      }
    } catch (error) {
      proc.dispose()
      throw error
    }

    return proc
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.killed) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
  }

  async prompt(message: string, images: unknown[] = []): Promise<string | undefined> {
    // Pi 1.4 acknowledges only after preflight, which can include native compaction.
    const res = await this.request({ type: 'prompt', message, images }, { compactionAware: true })
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
    return (res.data as { disposition?: string } | undefined)?.disposition
  }

  async clearQueue(): Promise<void> {
    const res = await this.request({ type: 'clear_queue' })
    if (!res.success) throw new Error(`pi clear_queue failed: ${res.error}`)
  }

  async steer(message: string, images: unknown[] = [], followUp = false): Promise<string> {
    const res = await this.request({ type: followUp ? 'follow_up' : 'steer', message, images })
    if (!res.success) throw new Error(`pi steering failed: ${res.error}`)
    const disposition = (res.data as { disposition?: string } | undefined)?.disposition
    if (disposition !== 'queued' && disposition !== 'handled') throw new Error('PI_STEER_UNCONFIRMED')
    return disposition
  }

  async clone(): Promise<void> {
    const res = await this.request({ type: 'clone' })
    if (!res.success || (res.data as { cancelled?: boolean } | undefined)?.cancelled)
      throw new Error('PI_FORK_CANCELLED')
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async stopExecution(): Promise<void> {
    try {
      await this.clearQueue()
      // The native abort response is sent only once the session is idle.
      await this.abort()
    } catch (error) {
      try {
        await terminateNativeTree(this.child, this.ownsProcessGroup)
      } catch (failure) {
        throw new Error('PI_STOP_UNCONFIRMED: failed to stop the owned native execution', {
          cause: new AggregateError([error, failure])
        })
      }
    }
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setServiceTier(choice: TierChoice): Promise<void> {
    if (!this.tierFile) throw new Error('PI_SERVICE_TIER_BRIDGE_UNAVAILABLE')
    const nonce = randomUUID()
    const disposition = await this.prompt('/codeg-service-tier-v1 ' + JSON.stringify({ nonce, choice }))
    if (disposition !== 'handled') throw new Error('PI_SERVICE_TIER_NOT_CONFIRMED')
    const ack = JSON.parse(readFileSync(this.tierFile + '.ack', 'utf8')) as {
      nonce?: string
      ok?: boolean
      error?: string
    }
    if (ack.nonce !== nonce || !ack.ok)
      throw new Error(ack.nonce === nonce ? (ack.error ?? 'PI_SERVICE_TIER_FAILED') : 'PI_SERVICE_TIER_STALE_ACK')
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    const res = await this.request({ type: 'get_available_thinking_levels' })
    if (!res.success)
      throw new Error(`pi get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = res.data
    const levels = data && typeof data === 'object' && 'levels' in data ? data.levels : undefined
    if (
      !Array.isArray(levels) ||
      levels.length === 0 ||
      !levels.every(level => typeof level === 'string' && level.length > 0)
    ) {
      throw new Error('pi get_available_thinking_levels returned invalid levels')
    }
    return levels
  }

  async setThinkingLevel(level: string): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions }, { compactionAware: true })
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(timeoutMs?: number): Promise<PiSessionStats> {
    const res = await this.request({ type: 'get_session_stats' }, { timeoutMs })
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return (res.data ?? {}) as PiSessionStats
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? '') }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: 'switch_session', sessionPath })
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private request(cmd: PiRpcCommand, opts?: { timeoutMs?: number; compactionAware?: boolean }): Promise<PiRpcResponse> {
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }
    const timeoutMs = opts?.timeoutMs ?? 30_000

    const line = `${JSON.stringify(withId)}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      // Returns false when the id was already dropped (e.g. by the timeout), so the
      // caller can avoid settling the promise twice.
      const drop = (): boolean => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        return this.pending.delete(id)
      }

      this.pending.set(id, {
        resolve: res => {
          drop()
          resolve(res)
        },
        reject: error => {
          drop()
          reject(error)
        }
      })

      const arm = () => {
        timer = setTimeout(async () => {
          timer = undefined
          if (!this.pending.has(id)) return
          if (opts?.compactionAware && this.compacting) {
            try {
              const health = await this.request({ type: 'get_state' }, { timeoutMs: 5_000 })
              if (!this.pending.has(id)) return
              if (!health.success) throw new Error(`Pi compaction health check failed: ${health.error}`)
              if (!this.compacting || (health.data as { isCompacting?: boolean } | undefined)?.isCompacting === true) {
                arm()
                return
              }
              throw new Error('PI_COMPACTION_STATE_LOST: Pi is no longer compacting but did not report its outcome')
            } catch (error) {
              if (drop()) reject(error)
              return
            }
          }
          if (drop()) reject(new Error(`pi ${cmd.type} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      }
      arm()

      void this.writeLine(line).catch(error => {
        if (!drop()) return
        reject(error)
      })
    })
  }

  private writeLine(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.child.stdin.write(line, error => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      } catch (error: unknown) {
        reject(error)
      }
    })
  }
}
