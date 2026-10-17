/**
 * Read Pi's provider routes for the Harness LLM adapter.
 *
 * Catalog fields are kept separate from credentials: the route contains only
 * model and endpoint metadata, and its resolver reads `auth.json` or
 * `models.json` only when the LLM adapter needs a key.
 * @module @deepseek-ai/dsh-agent-pi/llm-models
 */

import type { AgentHost } from '@deepseek-ai/dsh-agent-mesh'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { NativeProviderLlmRoute, PiAiModelProfile, PiAiModality } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  isRecord,
  readArray,
  readBoolean,
  readRecord,
  readString,
  type PiStoreLayout,
} from './sessions.ts'

/** Maximum bytes read from Pi's model and credential files. */
const MODEL_CONFIG_MAX_BYTES = 1024 * 1024
const AUTH_FILE_MAX_BYTES = 8 * 1024 * 1024

interface NativeModel {
  readonly id: string
  readonly provider: string
  readonly providerConfig: Record<string, unknown>
  readonly modelConfig: Record<string, unknown>
}

/**
 * Read provider routes and models declared by Pi's own model configuration.
 *
 * Models with per-model API or endpoint overrides are kept on separate route
 * snapshots. Shell commands in credential or header values are refused rather
 * than executed by the Harness process.
 * @param host - Pi's host port.
 * @param layout - Resolved Pi store paths.
 * @returns serviceable model routes, without credential values in their metadata.
 */
export async function readPiLlmRoutes(
  host: AgentHost,
  layout: PiStoreLayout,
): Promise<readonly NativeProviderLlmRoute[]> {
  const [modelsText, settingsText] = await Promise.all([
    readConfigText(host, layout.modelsPath),
    readConfigText(host, layout.settingsPath),
  ])
  const modelRoot = parseConfigObject(host, layout.modelsPath, modelsText)
  const settings = parseConfigObject(host, layout.settingsPath, settingsText)
  if (modelRoot?.['modelOverrides'] !== undefined) {
    host.log('warn', `${layout.modelsPath} declares a top-level modelOverrides field that Pi does not use`)
  }
  const rawProviders = modelRoot?.['providers']
  if (rawProviders !== undefined && !isRecord(rawProviders)) {
    host.log('warn', `${layout.modelsPath} has a providers field that is not an object`)
  }
  const providers = readRecord(modelRoot, 'providers') ?? {}
  const nativeModels: NativeModel[] = []

  for (const [provider, value] of Object.entries(providers)) {
    if (!isRecord(value)) {
      host.log('warn', `${layout.modelsPath} provider "${provider}" is not an object`)
      continue
    }
    if (value['models'] !== undefined && !Array.isArray(value['models'])) {
      host.log('warn', `${layout.modelsPath} provider "${provider}" has a models field that is not an array`)
      continue
    }
    const rawOverrides = value['modelOverrides']
    if (rawOverrides !== undefined && !isRecord(rawOverrides)) {
      host.log('warn', `${layout.modelsPath} provider "${provider}" has an invalid modelOverrides field`)
    }
    const overrides = readRecord(value, 'modelOverrides') ?? {}
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    const models = new Map<string, Record<string, unknown>>()
    for (const model of readArray(value, 'models') ?? []) {
      if (!isRecord(model)) continue
      const id = nonEmpty(readString(model, 'id'))
      if (id === undefined) continue
      const patch = readRecord(overrides, id)
      if (seen.has(id)) {
        duplicates.add(id)
        models.delete(id)
        continue
      }
      seen.add(id)
      models.set(id, { ...model, ...patch })
    }
    for (const [id, patch] of Object.entries(overrides)) {
      if (seen.has(id) || !isRecord(patch)) continue
      models.set(id, { id, ...patch })
    }
    for (const duplicate of duplicates) {
      host.log('warn', `${layout.modelsPath} declares model "${provider}/${duplicate}" more than once; DSH will not route it`)
    }
    for (const [id, modelConfig] of models) {
      nativeModels.push({ id, provider, providerConfig: value, modelConfig })
    }
  }

  const defaultModel = nonEmpty(readString(settings, 'defaultModel'))
  const defaultProvider = nonEmpty(readString(settings, 'defaultProvider'))
  if (defaultModel !== undefined && defaultProvider !== undefined
    && !nativeModels.some(model => model.provider === defaultProvider && readString(model.modelConfig, 'id') === defaultModel)) {
    nativeModels.push({
      id: defaultModel,
      provider: defaultProvider,
      providerConfig: readRecord(providers, defaultProvider) ?? {},
      modelConfig: { id: defaultModel },
    })
  }

  const routes: NativeProviderLlmRoute[] = []
  for (const candidate of nativeModels) {
    try {
      routes.push(await routeFor(host, layout, candidate))
    } catch (error) {
      host.log('warn', `Pi model route "${candidate.provider}/${candidate.id}" is unavailable: ${errorMessage(error)}`)
    }
  }
  return routes
}

/** Build one route snapshot; per-model overrides stay isolated from sibling models. */
async function routeFor(
  host: AgentHost,
  layout: PiStoreLayout,
  native: NativeModel,
): Promise<NativeProviderLlmRoute> {
  const id = native.id
  const owner = `Pi route "${native.provider}/${id}"`
  const api = configString(native.modelConfig, 'api', owner) ?? configString(native.providerConfig, 'api', owner)
  const baseURL = configString(native.modelConfig, 'baseUrl', owner) ?? configString(native.providerConfig, 'baseUrl', owner)
  const headers = await resolveHeaders(
    host,
    configRecord(native.providerConfig, 'headers', owner),
    configRecord(native.modelConfig, 'headers', owner),
    `${native.provider}/${id}`,
  )
  const rawInput = readArray(native.modelConfig, 'input')
  if (native.modelConfig['input'] !== undefined && rawInput === undefined) {
    throw new LlmError(`${owner} declares input modalities that are not an array`, 'INVALID_CONFIG')
  }
  const input = modalities(rawInput, owner)
  const name = configString(native.modelConfig, 'name', owner)
  const contextWindow = positiveConfigNumber(native.modelConfig, 'contextWindow', owner)
  const maxTokens = positiveConfigNumber(native.modelConfig, 'maxTokens', owner)
  const model: PiAiModelProfile = {
    id,
    ...(name === undefined ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...input.length === 0 ? {} : { input },
    ...readBoolean(native.modelConfig, 'reasoning') === false ? { reasoningEfforts: false } : {},
  }
  const providerAuthHeader = configBoolean(native.providerConfig, 'authHeader', owner)
  const modelAuthHeader = configBoolean(native.modelConfig, 'authHeader', owner)
  if (providerAuthHeader === false || modelAuthHeader === false) {
    throw new LlmError(`Pi route "${native.provider}/${id}" disables authHeader, which DSH's provider adapter cannot reproduce`, 'UNSUPPORTED_AUTH')
  }
  if (native.modelConfig['reasoning'] !== undefined && typeof native.modelConfig['reasoning'] !== 'boolean') {
    throw new LlmError(`${owner} has an invalid "reasoning" field`, 'INVALID_CONFIG')
  }

  const apiKey = configString(native.modelConfig, 'apiKey', owner)
    ?? configString(native.providerConfig, 'apiKey', owner)
  const profile = {
    ...api === undefined ? {} : { api },
    ...baseURL === undefined ? {} : { baseURL },
    ...headers === undefined ? {} : { headers },
  }
  const displayName = configString(native.providerConfig, 'name', owner) ?? native.provider
  return {
    id: native.provider,
    modelNamespace: native.provider,
    displayName,
    profile,
    models: [model],
    resolveApiKey: async () => {
      const stored = await readStoredApiKey(host, layout.credentialPath, native.provider)
      if (stored !== undefined) return resolveSecret(host, stored, `auth.json provider "${native.provider}"`)
      if (apiKey !== undefined) return resolveSecret(host, apiKey, `models.json provider "${native.provider}"`)
      return undefined
    },
  }
}

/** Resolve configured provider/model headers without executing shell commands. */
async function resolveHeaders(
  host: AgentHost,
  providerHeaders: Record<string, unknown> | undefined,
  modelHeaders: Record<string, unknown> | undefined,
  model: string,
): Promise<Record<string, string> | undefined> {
  const combined = { ...stringRecord(providerHeaders, model), ...stringRecord(modelHeaders, model) }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(combined)) {
    if (value.startsWith('!')) {
      throw new LlmError(`Pi route "${model}" uses a shell command for header "${name}"; DSH does not execute credential commands`, 'UNSUPPORTED_AUTH')
    }
    headers[name] = environmentReference(value)
      ? await resolveSecret(host, value, `Pi route "${model}" header "${name}"`)
      : value
  }
  return Object.keys(headers).length === 0 ? undefined : headers
}

/** Read one API-key credential, without returning any other auth.json field. */
async function readStoredApiKey(host: AgentHost, path: string, provider: string): Promise<string | undefined> {
  const stat = await host.stat(path)
  if (stat === undefined) return undefined
  if (stat.isDirectory) throw new LlmError(`Pi credential path "${path}" is a directory`, 'INVALID_CREDENTIAL')
  if (stat.size > AUTH_FILE_MAX_BYTES) {
    throw new LlmError(`Pi credential file "${path}" exceeds the bounded read size`, 'INVALID_CREDENTIAL')
  }
  const text = await host.readHead(path, AUTH_FILE_MAX_BYTES)
  if (text.trim() === '') {
    if (stat.size > 0) throw new LlmError(`Pi credential file "${path}" could not be read completely`, 'INVALID_CREDENTIAL')
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new LlmError(`Pi credential file "${path}" is not valid JSON`, 'INVALID_CREDENTIAL', { cause: error })
  }
  if (!isRecord(value)) throw new LlmError(`Pi credential file "${path}" does not contain an object`, 'INVALID_CREDENTIAL')
  const credential = readRecord(value, provider)
  if (credential === undefined) return undefined
  const type = readString(credential, 'type')
  if (type === 'oauth') {
    throw new LlmError(`Pi route "${provider}" uses stored OAuth, which the direct DSH model route cannot refresh`, 'UNSUPPORTED_AUTH')
  }
  if (type !== 'api_key') return undefined
  const key = nonEmpty(readString(credential, 'key'))
  if (key?.startsWith('!')) {
    throw new LlmError(`Pi route "${provider}" uses a shell command for its API key; DSH does not execute credential commands`, 'UNSUPPORTED_AUTH')
  }
  return key
}

/** Read a bounded user model configuration without accepting a truncated file. */
async function readConfigText(host: AgentHost, path: string): Promise<string> {
  const stat = await host.stat(path)
  if (stat === undefined) return ''
  if (stat.isDirectory || stat.size > MODEL_CONFIG_MAX_BYTES) {
    host.log('warn', `${path} is not a bounded Pi model configuration file`)
    return ''
  }
  return host.readHead(path, MODEL_CONFIG_MAX_BYTES)
}

/** Resolve a native secret field as an environment reference or literal value. */
function resolveSecret(host: AgentHost, source: string, owner: string): Promise<string> {
  return Promise.resolve().then(() => {
    if (source.startsWith('!')) {
      throw new LlmError(`${owner} uses a shell command; DSH does not execute credential commands`, 'UNSUPPORTED_AUTH')
    }
    const reference = environmentName(source)
    if (reference !== undefined) {
      const value = host.env[reference]
      if (value !== undefined && value !== '') return value
      throw new LlmError(`${owner} names ${reference}, which is not set in the agent environment`, 'MISSING_CREDENTIAL')
    }
    return source
  })
}

/** Recognize Pi's bare or braced environment-variable spelling. */
function environmentName(value: string): string | undefined {
  const explicit = value.startsWith('${') && value.endsWith('}')
    ? value.slice(2, -1)
    : value.startsWith('$') ? value.slice(1) : undefined
  if (explicit !== undefined) return /^[A-Za-z_][A-Za-z0-9_]*$/.test(explicit) ? explicit : undefined
  return /^[A-Z_][A-Z0-9_]*$/.test(value) ? value : undefined
}

/** Treat a header value as an environment reference only when it uses reference syntax. */
function environmentReference(value: string): boolean {
  return value.startsWith('$') || /^[A-Z_][A-Z0-9_]*$/.test(value)
}

/** Keep only string-valued entries from one native header object. */
function stringRecord(value: Record<string, unknown> | undefined, model: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, member] of Object.entries(value ?? {})) {
    if (typeof member !== 'string') {
      throw new LlmError(`Pi route "${model}" header "${name}" is not a string`, 'INVALID_CONFIG')
    }
    result[name] = member
  }
  return result
}

/** Read only modalities this adapter can send through pi-ai. */
function modalities(values: readonly unknown[] | undefined, owner: string): PiAiModality[] {
  const result: PiAiModality[] = []
  for (const value of values ?? []) {
    if (value !== 'text' && value !== 'image') {
      throw new LlmError(`${owner} declares input modalities DSH's provider adapter cannot send`, 'UNSUPPORTED_CONTENT')
    }
    result.push(value)
  }
  return result
}

/** A non-empty trimmed string, or `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/** A positive integer, or `undefined`. */
function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Read a configured non-empty string, rejecting values with the wrong type. */
function configString(source: Record<string, unknown>, key: string, owner: string): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LlmError(`${owner} has an invalid "${key}" field`, 'INVALID_CONFIG')
  }
  return value.trim()
}

/** Read a configured object field, rejecting a non-object value. */
function configRecord(
  source: Record<string, unknown>,
  key: string,
  owner: string,
): Record<string, unknown> | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new LlmError(`${owner} has an invalid "${key}" field`, 'INVALID_CONFIG')
  return value
}

/** Read a positive integer capacity when the native file declares one. */
function positiveConfigNumber(source: Record<string, unknown>, key: string, owner: string): number | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  const resolved = typeof value === 'number' ? positive(value) : undefined
  if (resolved === undefined) throw new LlmError(`${owner} has an invalid "${key}" field`, 'INVALID_CONFIG')
  return resolved
}

/** Read an optional configured boolean, rejecting values with the wrong type. */
function configBoolean(source: Record<string, unknown>, key: string, owner: string): boolean | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new LlmError(`${owner} has an invalid "${key}" field`, 'INVALID_CONFIG')
  return value
}

/** Parse a native JSON config file without exposing its contents in diagnostics. */
function parseConfigObject(host: AgentHost, path: string, text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return undefined
  try {
    const value: unknown = JSON.parse(text)
    if (isRecord(value)) return value
  } catch (error) {
    // The file path is enough to identify the invalid configuration.
    void error
  }
  host.log('warn', `${path} is not a valid JSON object; no LLM routes were read from it`)
  return undefined
}

/** Return a diagnostic without including the native file contents. */
function errorMessage(error: unknown): string {
  return String(error)
}
