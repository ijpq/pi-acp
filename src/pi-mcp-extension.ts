import {
  atomicJson,
  isDirectOpenAI,
  readTierPreferences,
  tierCapability,
  tierModelKey,
  type TierModel,
  type TierObservation
} from './service-tier.js'

type Context = { model?: TierModel; isIdle(): boolean }
type McpApi = {
  registerCommand(
    name: string,
    definition: { description: string; handler: (args: string, ctx: Context) => Promise<void> }
  ): void
  registerMcpServer(name: string, config: Record<string, unknown>): void
  on(name: string, handler: (event: Record<string, unknown>, ctx: Context) => unknown): void
}
export default function register(api: McpApi) {
  if (typeof api.registerMcpServer !== 'function')
    throw new Error('PI_RUNTIME_UPGRADE_REQUIRED: native MCP needs Pi 1.4.0 or newer')
  api.registerCommand('codeg-pi-runtime-v1', {
    description: 'CodeG verified Pi native bridge',
    handler: async () => {}
  })
  const file = process.env.PI_ACP_TIER_FILE
  delete process.env.PI_ACP_TIER_FILE
  if (file) {
    let preferences = readTierPreferences(file)
    let observation: TierObservation | undefined
    let direct = false
    api.registerCommand('codeg-service-tier-v1', {
      description: 'CodeG session service-tier configuration',
      handler: async (args, ctx) => {
        const request = JSON.parse(args) as { nonce: string; choice: string }
        try {
          if (!ctx.isIdle()) throw new Error('PI_SETTINGS_BUSY')
          if (!ctx.model || !tierCapability(ctx.model).supported) throw new Error('PI_SERVICE_TIER_UNSUPPORTED')
          if (request.choice !== 'on' && request.choice !== 'off') throw new Error('PI_SERVICE_TIER_INVALID')
          const next = readTierPreferences(file)
          next.models[tierModelKey(ctx.model)] = request.choice
          atomicJson(file, next)
          preferences = next
          atomicJson(file + '.ack', { nonce: request.nonce, ok: true })
        } catch (error) {
          atomicJson(file + '.ack', {
            nonce: request.nonce,
            ok: false,
            error: error instanceof Error ? error.message : 'PI_SERVICE_TIER_FAILED'
          })
        }
      }
    })
    api.on('agent_start', () => {
      observation = undefined
    })
    api.on('before_provider_request', (event, ctx) => {
      if (!ctx.model || !tierCapability(ctx.model).supported) return
      const payload = event.payload as Record<string, unknown>
      const key = tierModelKey(ctx.model)
      const requested = preferences.models[key] === 'on' ? 'priority' : 'default'
      // Modify the actual provider payload via Pi's native request hook.
      payload.service_tier = requested
      direct = isDirectOpenAI(ctx.model)
      observation = { modelKey: key, requested, verification: 'unverified', updatedAt: new Date().toISOString() }
      atomicJson(file + '.observation', observation)
      return payload
    })
    api.on('after_provider_response', event => {
      if (!observation || typeof event.status !== 'number') return
      if (event.status >= 400) {
        observation = {
          ...observation,
          verification: 'rejected',
          httpStatus: event.status,
          updatedAt: new Date().toISOString()
        }
        atomicJson(file + '.observation', observation)
      }
    })
    api.on('message_end', event => {
      const message = event.message as { role?: string; stopReason?: string } | undefined
      if (observation && message?.role === 'assistant' && message.stopReason === 'error') {
        observation = { ...observation, verification: 'rejected', updatedAt: new Date().toISOString() }
        atomicJson(file + '.observation', observation)
      }
    })
    api.on('provider_stream_event', event => {
      if (!observation || !event.data || typeof event.data !== 'object') return
      const data = event.data as { type?: string; response?: { service_tier?: unknown } }
      if (data.type !== 'response.completed' || typeof data.response?.service_tier !== 'string') return
      const tier = data.response.service_tier
      if (!['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast'].includes(tier)) return
      observation = {
        ...observation,
        reported: tier,
        verification: direct ? 'upstream_reported' : 'endpoint_reported',
        updatedAt: new Date().toISOString()
      }
      atomicJson(file + '.observation', observation)
    })
  }
  const raw = process.env.PI_ACP_MCP_SERVERS_JSON
  delete process.env.PI_ACP_MCP_SERVERS_JSON
  const servers: Record<string, Record<string, unknown>> = JSON.parse(raw ?? '{}')
  for (const [name, config] of Object.entries(servers)) api.registerMcpServer(name, config)
}
