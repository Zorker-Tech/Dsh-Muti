/** Grok Build's configured models projected into the Harness LLM service. */

import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { AgentHost } from '@deepseek-ai/dsh-agent-mesh'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { NativeProviderLlmRoute, PiAiModelProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { GrokPaths } from './sessions.ts'

/** Maximum bytes read from Grok's user model configuration. */
const CONFIG_MAX_BYTES = 1024 * 1024

/** Request behavior this adapter cannot reproduce. */
const UNSUPPORTED_FIELDS = [
  'query_params',
  'auth_provider',
  'auth_provider_command',
  'reasoning_summary',
  'temperature',
  'top_p',
  'max_request_bytes',
  'mtls_cert_dir',
  'stream_tool_calls',
  'supports_backend_search',
] as const

/** Read the Grok models declared in its user-level `config.toml`.
 * @param host - File access and diagnostic services for the detected agent.
 * @param paths - Resolved paths for the selected Grok installation.
 * @returns Configured model routes this adapter can reproduce.
 */
export async function readGrokLlmRoutes(
  host: AgentHost,
  paths: GrokPaths,
): Promise<readonly NativeProviderLlmRoute[]> {
  const path = join(paths.home, 'config.toml')
  const stat = await host.stat(path)
  if (stat === undefined) return []
  if (stat.isDirectory || stat.size > CONFIG_MAX_BYTES) {
    host.log('warn', `${path} is not a bounded Grok model configuration file`)
    return []
  }
  const text = await host.readHead(path, CONFIG_MAX_BYTES)
  let root: Record<string, unknown>
  try {
    root = parseToml(text)
  } catch {
    host.log('warn', `${path} is not a readable TOML model configuration`)
    return []
  }

  const rawModels = root['model']
  if (rawModels !== undefined && !isRecord(rawModels)) {
    host.log('warn', `${path} model section is not a TOML table`)
    return []
  }
  const rawProviders = root['model_providers']
  if (rawProviders !== undefined && !isRecord(rawProviders)) {
    host.log('warn', `${path} model_providers section is not a TOML table`)
    return []
  }
  const models = isRecord(rawModels) ? rawModels : {}
  const providers = isRecord(rawProviders) ? rawProviders : {}
  const routes: NativeProviderLlmRoute[] = []
  for (const [alias, rawModel] of Object.entries(models)) {
    if (!isRecord(rawModel)) {
      host.log('warn', `${path} model "${alias}" is not a TOML table`)
      continue
    }
    try {
      const route = routeFor(host, path, alias, rawModel, providers)
      if (route !== undefined) routes.push(route)
    } catch (error) {
      host.log('warn', `Grok model "${alias}" is unavailable: ${errorMessage(error)}`)
    }
  }
  return routes
}

/** Build one independent route so model-specific API and endpoint overrides stay intact. */
function routeFor(
  host: AgentHost,
  path: string,
  alias: string,
  modelConfig: Record<string, unknown>,
  providers: Record<string, unknown>,
): NativeProviderLlmRoute | undefined {
  const modelProvider = optionalString(modelConfig, 'model_provider', path, alias, host)
  if (modelConfig['model_provider'] !== undefined && modelProvider === undefined) return undefined
  let providerConfig: Record<string, unknown> = {}
  if (modelProvider !== undefined) {
    const rawProvider = providers[modelProvider]
    if (rawProvider !== undefined && !isRecord(rawProvider)) {
      host.log('warn', `${path} model provider "${modelProvider}" is not a TOML table`)
      return undefined
    }
    providerConfig = isRecord(rawProvider) ? rawProvider : {}
  }
  const unsupported = UNSUPPORTED_FIELDS.find(key => modelConfig[key] !== undefined || providerConfig[key] !== undefined)
  if (unsupported !== undefined) {
    host.log('warn', `Grok model "${alias}" uses ${unsupported}, which the direct Harness model route cannot reproduce`)
    return undefined
  }

  const modelIdValue = optionalString(modelConfig, 'model', path, alias, host)
  const modelBaseURL = optionalString(modelConfig, 'base_url', path, alias, host)
  const providerBaseURL = optionalString(providerConfig, 'base_url', path, modelProvider ?? alias, host)
  const modelName = optionalString(modelConfig, 'name', path, alias, host)
  const modelBackend = optionalString(modelConfig, 'api_backend', path, alias, host)
  const providerBackend = optionalString(providerConfig, 'api_backend', path, modelProvider ?? alias, host)
  if (invalidOptional(modelConfig, 'model', modelIdValue)
    || invalidOptional(modelConfig, 'base_url', modelBaseURL)
    || invalidOptional(providerConfig, 'base_url', providerBaseURL)
    || invalidOptional(modelConfig, 'name', modelName)
    || invalidOptional(modelConfig, 'api_backend', modelBackend)
    || invalidOptional(providerConfig, 'api_backend', providerBackend)) return undefined
  const modelId = modelIdValue ?? alias
  const baseURL = modelBaseURL ?? providerBaseURL
  const name = modelName ?? alias
  const backend = modelBackend ?? providerBackend ?? 'chat_completions'
  const api = apiFor(backend)
  if (api === undefined) {
    host.log('warn', `Grok model "${alias}" uses unsupported api_backend "${backend}"`)
    return undefined
  }
  const modelContextWindow = positiveInteger(modelConfig, 'context_window', path, alias, host)
  const providerContextWindow = positiveInteger(providerConfig, 'context_window', path, modelProvider ?? alias, host)
  const modelMaxTokens = positiveInteger(modelConfig, 'max_completion_tokens', path, alias, host)
  const providerMaxTokens = positiveInteger(providerConfig, 'max_completion_tokens', path, modelProvider ?? alias, host)
  if (invalidOptional(modelConfig, 'context_window', modelContextWindow)
    || invalidOptional(providerConfig, 'context_window', providerContextWindow)
    || invalidOptional(modelConfig, 'max_completion_tokens', modelMaxTokens)
    || invalidOptional(providerConfig, 'max_completion_tokens', providerMaxTokens)) return undefined
  const contextWindow = modelContextWindow ?? providerContextWindow
  const maxTokens = modelMaxTokens ?? providerMaxTokens

  const headers = readHeaders(host, path, alias, providerConfig, modelConfig)
  if (headers === undefined) return undefined
  const modelApiKey = secretValue(modelConfig, 'api_key', path, alias, host)
  const providerApiKey = secretValue(providerConfig, 'api_key', path, modelProvider ?? alias, host)
  const modelEnvKeys = environmentNames(modelConfig, 'env_key', path, alias, host)
  const providerEnvKeys = environmentNames(providerConfig, 'env_key', path, modelProvider ?? alias, host)
  if (invalidOptional(modelConfig, 'api_key', modelApiKey)
    || invalidOptional(providerConfig, 'api_key', providerApiKey)
    || invalidOptional(modelConfig, 'env_key', modelEnvKeys)
    || invalidOptional(providerConfig, 'env_key', providerEnvKeys)) return undefined
  const apiKey = modelApiKey ?? providerApiKey
  const envKeys = modelEnvKeys ?? providerEnvKeys

  const nativeProvider = modelProvider ?? (baseURL === undefined ? 'xai' : alias)
  const model: PiAiModelProfile = {
    id: modelId,
    name,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
  return {
    id: nativeProvider,
    modelNamespace: alias,
    displayName: name,
    profile: {
      api,
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    },
    models: [model],
    allowAmbientAuth: false,
    resolveApiKey: async () => resolveApiKey(host, alias, apiKey, envKeys),
  }
}

/** Resolve the first explicit Grok key source without falling into session-token auth. */
function resolveApiKey(
  host: AgentHost,
  model: string,
  literal: string | undefined,
  names: readonly string[] | undefined,
): Promise<string | undefined> {
  return Promise.resolve().then(() => {
    if (literal !== undefined) return literal
    for (const name of names ?? []) {
      const value = host.env[name]
      if (value !== undefined && value.trim() !== '') return value
    }
    for (const name of ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']) {
      const value = host.env[name]
      if (value !== undefined && value.trim() !== '') return value
    }
    if (names !== undefined) {
      throw new LlmError(`Grok model "${model}" has no key in its configured environment variables or the Grok API-key environment`, 'MISSING_CREDENTIAL')
    }
    return undefined
  })
}

/** Merge configured and environment-sourced headers; unset environment values are omitted. */
function readHeaders(
  host: AgentHost,
  path: string,
  model: string,
  provider: Record<string, unknown>,
  config: Record<string, unknown>,
): Record<string, string> | undefined {
  let headers: Record<string, string> = {}
  for (const [source, owner] of [[provider, model], [config, model]] as const) {
    const staticHeaders = stringMap(source, 'extra_headers', path, owner, host)
    if (source['extra_headers'] !== undefined && staticHeaders === undefined) return undefined
    for (const [name, value] of Object.entries(staticHeaders ?? {})) headers = setHeader(headers, name, value)
    const environmentHeaders = stringMap(source, 'env_http_headers', path, owner, host)
    if (source['env_http_headers'] !== undefined && environmentHeaders === undefined) return undefined
    for (const [name, envName] of Object.entries(environmentHeaders ?? {})) {
      const value = host.env[envName]
      if (value !== undefined && value.trim() !== '') headers = setHeader(headers, name, value)
    }
  }
  return headers
}

/** Replace a case-insensitively matching header before adding its override. */
function setHeader(headers: Record<string, string>, name: string, value: string): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, entry] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) next[key] = entry
  }
  next[name] = value
  return next
}

/** Read one string or array of strings naming key environment variables. */
function environmentNames(
  source: Record<string, unknown>,
  key: string,
  path: string,
  model: string,
  host: AgentHost,
): readonly string[] | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  const values = typeof value === 'string' ? [value] : isStringArray(value) ? value : undefined
  if (values === undefined || values.length === 0 || values.some(name => typeof name !== 'string' || name.trim() === '')) {
    host.log('warn', `${path} model "${model}" has an invalid "${key}" field`)
    return undefined
  }
  return values.map(name => name.trim())
}

/** Narrow an untrusted array to its string entries. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
}

/** Read an optional literal key without ever logging its value. */
function secretValue(
  source: Record<string, unknown>,
  key: string,
  path: string,
  model: string,
  host: AgentHost,
): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    host.log('warn', `${path} model "${model}" has an invalid "${key}" field`)
    return undefined
  }
  return value
}

/** Read a configured string map without exposing malformed values in diagnostics. */
function stringMap(
  source: Record<string, unknown>,
  key: string,
  path: string,
  model: string,
  host: AgentHost,
): Record<string, string> | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.values(value).some(entry => typeof entry !== 'string')) {
    host.log('warn', `${path} model "${model}" has an invalid "${key}" table`)
    return undefined
  }
  return value as Record<string, string>
}

/** Read one optional non-empty TOML string. */
function optionalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  model: string,
  host: AgentHost,
): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    host.log('warn', `${path} model "${model}" has an invalid "${key}" field`)
    return undefined
  }
  return value.trim()
}

/** Read one positive integer capacity. */
function positiveInteger(
  source: Record<string, unknown>,
  key: string,
  path: string,
  model: string,
  host: AgentHost,
): number | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    host.log('warn', `${path} model "${model}" has an invalid "${key}" field`)
    return undefined
  }
  return value
}

/** Map Grok's protocol names to protocols supported by the Harness adapter. */
function apiFor(backend: string): string | undefined {
  switch (backend) {
    case 'chat_completions': return 'openai-completions'
    case 'responses': return 'openai-responses'
    case 'messages': return 'anthropic-messages'
    default: return undefined
  }
}

/** Whether a TOML value is a table. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a configured optional value failed its type and non-empty check. */
function invalidOptional(source: Record<string, unknown>, key: string, value: unknown): boolean {
  return source[key] !== undefined && value === undefined
}

/** Convert a thrown value to short diagnostic text. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
