import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import register from '../../src/pi-mcp-extension.js'
import {
  serviceTierState,
  tierCapability,
  tierDescription,
  tierModelKey,
  isDirectOpenAI
} from '../../src/service-tier.js'

test('service tier is gated by model and Responses interface, independently of reasoning', () => {
  assert.equal(tierCapability({ id: 'gpt-5.4', api: 'openai-responses' }).supported, true)
  assert.equal(tierCapability({ id: 'gpt-5.4', api: 'openai-codex-responses' }).supported, true)
  assert.equal(tierCapability({ id: 'gpt-5.4', api: 'openai-completions' }).supported, false)
  assert.equal(tierCapability({ id: 'claude-opus', api: 'openai-responses' }).supported, false)
  assert.equal(tierCapability({ id: 'unknown', api: 'openai-responses' }).supported, false)
  assert.notEqual(
    tierModelKey({ id: 'gpt-5.4', api: 'openai-responses', baseUrl: 'https://a' }),
    tierModelKey({ id: 'gpt-5.4', api: 'openai-responses', baseUrl: 'https://b' })
  )
  assert.equal(isDirectOpenAI({ baseUrl: 'https://api.openai.com/v1' }), true)
  assert.equal(isDirectOpenAI({ baseUrl: 'https://api.openai.com.relay.example/v1' }), false)
  assert.equal(isDirectOpenAI({ baseUrl: 'http://api.openai.com/v1' }), false)
})

test('native Pi extension persists per-model choice and only trusts raw response fields', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pi-acp-tier-')), 'preferences.json')
  const old = process.env.PI_ACP_TIER_FILE
  const hooks = new Map<string, (event: Record<string, unknown>, ctx: typeof context) => unknown>()
  const commands = new Map<string, (args: string, ctx: typeof context) => Promise<void>>()
  const model = { id: 'gpt-5.4', provider: 'relay', api: 'openai-responses', baseUrl: 'https://relay.example/v1' }
  const context = { model, isIdle: () => true }
  try {
    process.env.PI_ACP_TIER_FILE = file
    register({
      registerMcpServer() {},
      registerCommand(name, definition) {
        commands.set(name, definition.handler)
      },
      on(name, handler) {
        hooks.set(name, handler)
      }
    })
    assert.equal(process.env.PI_ACP_TIER_FILE, undefined)
    assert.equal(serviceTierState(file, model).choice, 'off')
    await commands.get('codeg-service-tier-v1')!(JSON.stringify({ nonce: 'one', choice: 'on' }), context)
    const payload = { model: model.id, reasoning: { effort: 'high' } }
    const result = hooks.get('before_provider_request')!({ payload }, context) as typeof payload & {
      service_tier: string
    }
    assert.equal(result.service_tier, 'priority')
    assert.equal(result.reasoning.effort, 'high')
    assert.match(tierDescription(serviceTierState(file, model).observation), /upstream unverified/)
    hooks.get('provider_stream_event')!({ data: { type: 'response.completed', response: {} } }, context)
    assert.equal(serviceTierState(file, model).observation?.reported, undefined)
    hooks.get('provider_stream_event')!(
      { data: { type: 'response.completed', response: { service_tier: 'default' } } },
      context
    )
    assert.equal(serviceTierState(file, model).observation?.verification, 'endpoint_reported')
    assert.match(
      tierDescription(serviceTierState(file, model).observation),
      /endpoint reported default; upstream unverified/
    )
    assert.equal(serviceTierState(file, { ...model, id: 'gpt-5.2' }).choice, 'off')
    context.isIdle = () => false
    await commands.get('codeg-service-tier-v1')!(JSON.stringify({ nonce: 'two', choice: 'off' }), context)
    assert.equal(serviceTierState(file, model).choice, 'on')
    assert.match(tierDescription(), /billing is determined by your provider or relay/)
  } finally {
    if (old === undefined) delete process.env.PI_ACP_TIER_FILE
    else process.env.PI_ACP_TIER_FILE = old
  }
})
