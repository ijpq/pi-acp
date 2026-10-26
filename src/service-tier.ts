import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type TierModel = { id?: string; provider?: string; api?: string; baseUrl?: string }
export type TierChoice = 'on' | 'off'
export type TierObservation = {
  modelKey: string
  requested: 'priority' | 'default'
  reported?: string
  verification: 'unverified' | 'endpoint_reported' | 'upstream_reported' | 'rejected'
  httpStatus?: number
  updatedAt: string
}
type Preferences = { version: 1; models: Record<string, TierChoice> }

export function tierModelKey(model: TierModel): string {
  return createHash('sha256')
    .update(JSON.stringify([model.provider, model.id, model.api, model.baseUrl]))
    .digest('hex')
}

export function tierCapability(model: TierModel | undefined): { supported: boolean; reason: string } {
  if (!model || !['openai-responses', 'openai-codex-responses'].includes(model.api ?? ''))
    return { supported: false, reason: 'Fast / Speed requires an OpenAI Responses interface.' }
  if (!/^(?:gpt-(?:4\.1|4o|5(?:[.-]|$)|6(?:[.-]|$))|o[134](?:-|$))/.test(model.id ?? ''))
    return { supported: false, reason: 'Service tiers have not been established for this model.' }
  return { supported: true, reason: '' }
}

export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 })
  renameSync(temp, path)
}

export function readTierPreferences(path: string): Preferences {
  if (!existsSync(path)) return { version: 1, models: {} }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Preferences
  if (value.version !== 1 || !value.models || Object.values(value.models).some(v => v !== 'on' && v !== 'off'))
    throw new Error('PI_SERVICE_TIER_SETTINGS_INVALID')
  return value
}

export function readTierObservation(path: string, model: TierModel): TierObservation | undefined {
  if (!existsSync(path)) return undefined
  const value = JSON.parse(readFileSync(path, 'utf8')) as TierObservation
  return value.modelKey === tierModelKey(model) ? value : undefined
}

export function serviceTierState(file: string | undefined, model: TierModel) {
  const capability = tierCapability(model)
  const choice = file && capability.supported ? (readTierPreferences(file).models[tierModelKey(model)] ?? 'off') : 'off'
  const observation = file ? readTierObservation(file + '.observation', model) : undefined
  return { ...capability, choice, observation }
}

export function tierDescription(observation?: TierObservation): string {
  const billing =
    'May increase charges or quota use; billing is determined by your provider or relay. Off requests default; On requests priority. Reasoning is unchanged. Changes require an idle task.'
  if (!observation) return 'Not yet requested / unverified. ' + billing
  const reported = observation.reported
    ? `; ${observation.verification === 'upstream_reported' ? 'upstream' : 'endpoint'} reported ${observation.reported}`
    : ''
  const status =
    observation.verification === 'rejected'
      ? '; provider request failed; tier unverified'
      : observation.verification === 'upstream_reported'
        ? '; upstream tier reported (speed is not measured)'
        : '; upstream unverified'
  return `Last request: ${observation.requested}${reported}${status}. ${billing}`
}

export function isDirectOpenAI(model: TierModel): boolean {
  try {
    const url = new URL(model.baseUrl ?? '')
    return url.protocol === 'https:' && ['api.openai.com', 'chatgpt.com'].includes(url.hostname)
  } catch {
    return false
  }
}
