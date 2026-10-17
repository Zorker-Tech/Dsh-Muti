/** OMP's configured chat models projected into the Harness LLM service. */

import { parse as parseYaml } from 'yaml'
import type { AgentHost } from '@deepseek-ai/dsh-agent-mesh'
import type { NativeProviderLlmRoute, PiAiModelProfile, PiAiModality } from '@deepseek-ai/dsh-llm-pi-ai'
import type { OmpStoreLayout } from './sessions.ts'

/** Maximum bytes read from each OMP model configuration. */
const CONFIG_MAX_BYTES = 1024 * 1024

/** OMP roles whose models do not serve ordinary chat requests. */
const NON_CHAT_ROLES = new Set(['image', 'web', 'speech', 'dictation', 'judge'])

/** Configuration fields with runtime behavior this Harness route cannot reproduce. */
const UNSUPPORTED_FIELDS = [
  'compat',
  'discovery',
  'disableStrictTools',
  'remoteCompaction',
  'transport',
  'imageInputDecoder',
  'tokenizer',
  'broker',
] as const

interface NativeModel {
  readonly modelId: string
  readonly provider: string
  readonly providerConfig: Record<string, unknown>
  readonly modelConfig: Record<string, unknown>
  readonly custom: boolean
}

/** Read OMP's chat models without opening its SQLite auth store.
 * @param host - File access and diagnostic services for the detected agent.
 * @param layout - Resolved paths for OMP's model and settings files.
 * @returns Configured chat-model routes this adapter can reproduce.
 */
export async function readOmpLlmRoutes(
  host: AgentHost,
  layout: OmpStoreLayout,
): Promise<readonly NativeProviderLlmRoute[]> {
  const [modelsRoot, settingsRoot] = await Promise.all([
    readConfig(host, layout.modelsPath),
    readConfig(host, layout.settingsPath),
  ])
  const rawProviders = modelsRoot?.['providers']
  if (rawProviders !== undefined && !isRecord(rawProviders)) {
    host.log('warn', `${layout.modelsPath} providers field is not a YAML mapping`)
  }
  const providers = isRecord(rawProviders) ? rawProviders : {}
  const candidates = configuredModels(host, layout.modelsPath, providers)
  for (const selector of roleSelectors(host, layout.settingsPath, settingsRoot)) {
    const existing = candidates.some(model => model.provider === selector.provider
      && readString(model.modelConfig, 'id') === selector.model)
    if (existing) continue
    const providerConfig = providers[selector.provider]
    if (providerConfig !== undefined && !isRecord(providerConfig)) continue
    candidates.push({
      modelId: selector.model,
      provider: selector.provider,
      providerConfig: isRecord(providerConfig) ? providerConfig : {},
      modelConfig: { id: selector.model },
      custom: false,
    })
  }

  const routes: NativeProviderLlmRoute[] = []
  for (const candidate of candidates) {
    try {
      const route = routeFor(host, layout, candidate)
      if (route !== undefined) routes.push(route)
    } catch (error) {
      host.log('warn', `OMP model route "${candidate.provider}/${candidate.modelId}" is unavailable: ${errorMessage(error)}`)
    }
  }
  return routes
}

/** Parse one bounded YAML file; malformed or oversized files contribute no routes. */
async function readConfig(host: AgentHost, path: string): Promise<Record<string, unknown> | undefined> {
  const stat = await host.stat(path)
  if (stat === undefined) return undefined
  if (stat.isDirectory || stat.size > CONFIG_MAX_BYTES) {
    host.log('warn', `${path} is not a bounded OMP model configuration file`)
    return undefined
  }
  const text = await host.readHead(path, CONFIG_MAX_BYTES)
  if (text.trim() === '') return {}
  try {
    const value: unknown = parseYaml(text)
    if (isRecord(value)) return value
    host.log('warn', `${path} is not a YAML mapping`)
  } catch {
    host.log('warn', `${path} is not valid YAML`)
  }
  return undefined
}

/** Collect declared custom models and explicit per-model overrides. */
function configuredModels(
  host: AgentHost,
  path: string,
  providers: Record<string, unknown>,
): NativeModel[] {
  const candidates: NativeModel[] = []
  for (const [provider, raw] of Object.entries(providers)) {
    if (!isRecord(raw)) {
      host.log('warn', `${path} provider "${provider}" is not a YAML mapping`)
      continue
    }
    const modelList = raw['models']
    if (modelList !== undefined && !Array.isArray(modelList)) {
      host.log('warn', `${path} provider "${provider}" models field is not a YAML sequence`)
      continue
    }
    const overridesValue = raw['modelOverrides']
    if (overridesValue !== undefined && !isRecord(overridesValue)) {
      host.log('warn', `${path} provider "${provider}" modelOverrides field is not a YAML mapping`)
    }
    const overrides = isRecord(overridesValue) ? overridesValue : {}
    const seen = new Set<string>()
    const duplicate = new Set<string>()
    for (const entry of Array.isArray(modelList) ? modelList : []) {
      if (!isRecord(entry)) continue
      const id = readNonEmptyString(entry, 'id')
      if (id === undefined) continue
      if (seen.has(id)) {
        duplicate.add(id)
        continue
      }
      seen.add(id)
      candidates.push({
        modelId: id,
        provider,
        providerConfig: raw,
        modelConfig: { ...entry, ...(isRecord(overrides[id]) ? overrides[id] : {}), id },
        custom: true,
      })
    }
    for (const id of duplicate) {
      host.log('warn', `${path} declares model "${provider}/${id}" more than once; DSH will not route it`)
    }
    for (const [id, patch] of Object.entries(overrides)) {
      if (seen.has(id) || !isRecord(patch)) continue
      candidates.push({ modelId: id, provider, providerConfig: raw, modelConfig: { ...patch, id }, custom: false })
    }
  }
  return candidates.filter(candidate => ![...configuredDuplicateIds(candidate.providerConfig)].includes(candidate.modelId))
}

/** Read all role selectors that name an exact `provider/model` pair. */
function roleSelectors(
  host: AgentHost,
  path: string,
  settings: Record<string, unknown> | undefined,
): readonly { readonly provider: string; readonly model: string }[] {
  const value = settings?.['modelRoles']
  if (value === undefined) return []
  if (!isRecord(value)) {
    host.log('warn', `${path} modelRoles field is not a YAML mapping`)
    return []
  }
  const roleMap = value
  const result = new Map<string, { provider: string; model: string }>()
  for (const [role, selector] of Object.entries(roleMap)) {
    if (NON_CHAT_ROLES.has(role) || typeof selector !== 'string') continue
    collectSelector(selector, roleMap, new Set(), result)
  }
  return [...result.values()]
}

/** Follow role aliases and collect only exact model selectors. */
function collectSelector(
  selector: string,
  roles: Record<string, unknown>,
  visiting: Set<string>,
  result: Map<string, { provider: string; model: string }>,
): void {
  const value = selector.trim()
  if (value === '*') {
    if (visiting.has('default')) return
    const defaultSelector = readString(roles, 'default')
    if (defaultSelector === undefined || defaultSelector === '*') return
    visiting.add('default')
    collectSelector(defaultSelector, roles, visiting, result)
    visiting.delete('default')
    return
  }
  const alias = value.startsWith('@') ? value.slice(1).split(':', 1)[0] : undefined
  if (alias !== undefined) {
    if (NON_CHAT_ROLES.has(alias)) return
    if (visiting.has(alias)) return
    const next = readString(roles, alias)
    if (next === undefined) return
    visiting.add(alias)
    collectSelector(next, roles, visiting, result)
    visiting.delete(alias)
    return
  }
  const pair = exactModelSelector(value)
  if (pair !== undefined) result.set(`${pair.provider}/${pair.model}`, pair)
}

/** Split an exact `provider/model` selector and remove a known effort suffix. */
function exactModelSelector(value: string): { readonly provider: string; readonly model: string } | undefined {
  const stripped = value.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, '')
  const slash = stripped.indexOf('/')
  if (slash <= 0 || slash === stripped.length - 1) return undefined
  const provider = stripped.slice(0, slash)
  const model = stripped.slice(slash + 1)
  if (!/^[A-Za-z0-9._-]+$/.test(provider)) return undefined
  return { provider, model }
}

/** Build one request route while refusing OMP-specific behavior DSH cannot copy. */
function routeFor(host: AgentHost, layout: OmpStoreLayout, native: NativeModel): NativeProviderLlmRoute | undefined {
  const modelId = native.modelId
  const owner = `OMP model "${native.provider}/${modelId}"`
  const unsupported = UNSUPPORTED_FIELDS.find(key => native.modelConfig[key] !== undefined || native.providerConfig[key] !== undefined)
  if (unsupported !== undefined) {
    host.log('warn', `${owner} uses ${unsupported}, which the direct Harness model route cannot reproduce`)
    return undefined
  }
  const providerApi = configString(host, layout.modelsPath, native.provider, native.providerConfig, 'api')
  const modelApi = configString(host, layout.modelsPath, `${native.provider}/${modelId}`, native.modelConfig, 'api')
  const providerBase = configString(host, layout.modelsPath, native.provider, native.providerConfig, 'baseUrl')
  const modelBase = configString(host, layout.modelsPath, `${native.provider}/${modelId}`, native.modelConfig, 'baseUrl')
  const providerApiKey = configString(host, layout.modelsPath, native.provider, native.providerConfig, 'apiKey')
  const modelApiKey = configString(host, layout.modelsPath, `${native.provider}/${modelId}`, native.modelConfig, 'apiKey')
  const providerAuth = authMode(host, layout.modelsPath, native.provider, native.providerConfig)
  const modelAuth = authMode(host, layout.modelsPath, `${native.provider}/${modelId}`, native.modelConfig)
  const providerAuthHeader = authHeader(host, layout.modelsPath, native.provider, native.providerConfig)
  const modelAuthHeader = authHeader(host, layout.modelsPath, `${native.provider}/${modelId}`, native.modelConfig)
  if (invalidConfiguredString(native.providerConfig, 'api', providerApi)
    || invalidConfiguredString(native.modelConfig, 'api', modelApi)
    || invalidConfiguredString(native.providerConfig, 'baseUrl', providerBase)
    || invalidConfiguredString(native.modelConfig, 'baseUrl', modelBase)
    || invalidConfiguredString(native.providerConfig, 'apiKey', providerApiKey)
    || invalidConfiguredString(native.modelConfig, 'apiKey', modelApiKey)
    || invalidConfiguredString(native.providerConfig, 'auth', providerAuth)
    || invalidConfiguredString(native.modelConfig, 'auth', modelAuth)
    || invalidConfiguredBoolean(native.providerConfig, 'authHeader', providerAuthHeader)
    || invalidConfiguredBoolean(native.modelConfig, 'authHeader', modelAuthHeader)) return undefined
  if (providerAuthHeader === false || modelAuthHeader === false) {
    host.log('warn', `${owner} disables authHeader, which the direct Harness model route cannot reproduce`)
    return undefined
  }
  const auth = modelAuth ?? providerAuth ?? 'apiKey'
  if (auth === 'oauth') {
    host.log('warn', `${owner} uses OMP OAuth credentials, which the read-only Harness route cannot refresh`)
    return undefined
  }
  if (auth !== 'none' && auth !== 'apiKey') {
    host.log('warn', `${owner} uses unsupported auth mode "${auth}"`)
    return undefined
  }
  if ((modelApiKey ?? providerApiKey)?.startsWith('!') === true) {
    host.log('warn', `${owner} uses a command for its API key; DSH does not execute credential commands`)
    return undefined
  }

  const headers = readHeaders(host, owner, native.providerConfig, native.modelConfig)
  if (headers === undefined) return undefined
  const contextWindow = positiveInteger(host, layout.modelsPath, owner, native.modelConfig, 'contextWindow')
  const maxTokens = positiveInteger(host, layout.modelsPath, owner, native.modelConfig, 'maxTokens')
  const input = modalities(host, layout.modelsPath, owner, native.modelConfig)
  const reasoning = native.modelConfig['reasoning']
  if (reasoning !== undefined && typeof reasoning !== 'boolean') {
    host.log('warn', `${owner} has an invalid "reasoning" field`)
    return undefined
  }
  if (invalidConfiguredNumber(native.modelConfig, 'contextWindow', contextWindow)
    || invalidConfiguredNumber(native.modelConfig, 'maxTokens', maxTokens)
    || native.modelConfig['input'] !== undefined && input === undefined) return undefined
  if (reasoning === true) host.log('info', `${owner} reasoning capability is taken from the installed Harness model catalog when available`)
  const name = configString(host, layout.modelsPath, owner, native.modelConfig, 'name')
  if (invalidConfiguredString(native.modelConfig, 'name', name)) return undefined
  const model: PiAiModelProfile = {
    id: modelId,
    ...(name === undefined ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(input === undefined ? {} : { input }),
    ...(reasoning === false ? { reasoningEfforts: false } : {}),
  }
  if (native.custom && auth !== 'none' && providerApiKey === undefined && modelApiKey === undefined) {
    host.log('warn', `${owner} has custom models but no apiKey; add an API key or set auth: none`)
    return undefined
  }
  const api = modelApi ?? providerApi
  const baseURL = modelBase ?? providerBase
  return {
    id: native.provider,
    modelNamespace: native.provider,
    displayName: native.provider,
    profile: {
      ...(api === undefined ? {} : { api }),
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    },
    models: [model],
    ...(auth === 'none' ? { allowAmbientAuth: false } : {}),
    resolveApiKey: () => Promise.resolve(auth === 'none'
      ? undefined
      : resolveConfiguredKey(host, modelApiKey ?? providerApiKey)),
  }
}

/** Merge static headers and reject OMP command-resolved values. */
function readHeaders(
  host: AgentHost,
  owner: string,
  provider: Record<string, unknown>,
  model: Record<string, unknown>,
): Record<string, string> | undefined {
  let headers: Record<string, string> = {}
  for (const source of [provider, model]) {
    if (source['headers'] === undefined) continue
    if (!isRecord(source['headers'])) {
      host.log('warn', `${owner} headers field is not a YAML mapping`)
      return undefined
    }
    for (const [name, value] of Object.entries(source['headers'])) {
      if (typeof value !== 'string') {
        host.log('warn', `${owner} header "${name}" is not a string`)
        return undefined
      }
      if (value.startsWith('!')) {
        host.log('warn', `${owner} header "${name}" uses a command; DSH does not execute credential commands`)
        return undefined
      }
      headers = setHeader(headers, name, value)
    }
  }
  return headers
}

/** Resolve OMP's environment-name-first, then literal API-key convention. */
function resolveConfiguredKey(
  host: AgentHost,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined
  const envValue = host.env[value]
  return envValue !== undefined && envValue !== '' ? envValue : value
}

/** Read a provider or model authentication mode. */
function authMode(
  host: AgentHost,
  path: string,
  model: string,
  source: Record<string, unknown>,
): string | undefined {
  return configString(host, path, model, source, 'auth')
}

/** Read the authHeader switch. */
function authHeader(
  host: AgentHost,
  path: string,
  model: string,
  source: Record<string, unknown>,
): boolean | undefined {
  const value = source['authHeader']
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    host.log('warn', `${path} model "${model}" has an invalid "authHeader" field`)
    return undefined
  }
  return value
}

/** Read and validate a configured string. */
function configString(
  host: AgentHost,
  path: string,
  model: string,
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    host.log('warn', `${path} model "${model}" has an invalid "${key}" field`)
    return undefined
  }
  return value.trim()
}

/** Read one positive integer model capability. */
function positiveInteger(
  host: AgentHost,
  path: string,
  model: string,
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    host.log('warn', `${path} model "${model}" has an invalid "${key}" field`)
    return undefined
  }
  return value
}

/** Read OMP's supported text and image input modalities. */
function modalities(
  host: AgentHost,
  path: string,
  model: string,
  source: Record<string, unknown>,
): PiAiModality[] | undefined {
  const value = source['input']
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(entry => entry !== 'text' && entry !== 'image')) {
    host.log('warn', `${path} model "${model}" declares unsupported input modalities`)
    return undefined
  }
  return value as PiAiModality[]
}

/** Read one model id from an OMP mapping. */
function readNonEmptyString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value !== 'string' || value.trim() === '' ? undefined : value.trim()
}

/** Read a string without a diagnostic. */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/** Whether a configured string failed validation. */
function invalidConfiguredString(source: Record<string, unknown>, key: string, value: unknown): boolean {
  return source[key] !== undefined && value === undefined
}

/** Whether a configured positive number failed validation. */
function invalidConfiguredNumber(source: Record<string, unknown>, key: string, value: unknown): boolean {
  return source[key] !== undefined && value === undefined
}

/** Whether a configured boolean failed validation. */
function invalidConfiguredBoolean(source: Record<string, unknown>, key: string, value: unknown): boolean {
  return source[key] !== undefined && value === undefined
}

/** Return identifiers removed after a provider repeats them. */
function configuredDuplicateIds(provider: Record<string, unknown>): ReadonlySet<string> {
  const models = provider['models']
  if (!Array.isArray(models)) return new Set()
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const entry of models) {
    if (!isRecord(entry)) continue
    const id = readNonEmptyString(entry, 'id')
    if (id === undefined) continue
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  return duplicates
}

/** Replace headers case-insensitively, matching Fetch header semantics. */
function setHeader(headers: Record<string, string>, name: string, value: string): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, entry] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) next[key] = entry
  }
  next[name] = value
  return next
}

/** Whether a YAML value is a mapping. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Convert a thrown value to short diagnostic text. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
