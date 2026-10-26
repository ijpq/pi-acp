// Session-scoped configuration only. Never overwrite the user's mcp.json.
type McpApi = {
  registerCommand(name: string, definition: { description: string; handler: () => Promise<void> }): void
  registerMcpServer(name: string, config: Record<string, unknown>): void
}
export default function register(api: McpApi) {
  if (typeof api.registerMcpServer !== 'function')
    throw new Error('PI_RUNTIME_UPGRADE_REQUIRED: native MCP needs Pi 1.4.0 or newer')
  api.registerCommand('codeg-pi-runtime-v1', {
    description: 'CodeG verified Pi native bridge',
    handler: async () => {}
  })
  const raw = process.env.PI_ACP_MCP_SERVERS_JSON
  delete process.env.PI_ACP_MCP_SERVERS_JSON
  const servers: Record<string, Record<string, unknown>> = JSON.parse(raw ?? '{}')
  for (const [name, config] of Object.entries(servers)) api.registerMcpServer(name, config)
}
