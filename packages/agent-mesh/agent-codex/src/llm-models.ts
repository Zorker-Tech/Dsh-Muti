/**
 * Read Codex model routes from its user-level `config.toml`.
 *
 * This projection covers the Responses API and API keys from named environment
 * variables. Codex OAuth, command-backed auth, query parameters, and literal
 * bearer tokens need Codex-specific behavior the Harness provider cannot reuse.
 * @module @deepseek-ai/dsh-agent-codex/llm-models
 */

import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { AgentHost } from '@deepseek-ai/dsh-agent-mesh'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { NativeProviderLlmRoute, PiAiModelProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { CodexHome } from './sessions.ts'

/** Maximum bytes read from Codex's model configuration. */
const CONFIG_MAX_BYTES = 1024 * 1024

/**
 * Read configured Codex model routes from the user config only.
 * @param host - Host providing the bounded config read and environment.
 * @param home - Resolved Codex home.
 * @returns configured routes without copying any secret value into metadata.
 */
export async function readCodexLlmRoutes(
  host: AgentHost,
  home: CodexHome,
): Promise<readonly NativeProviderLlmRoute[]> {
  const path = join(home.path, 'config.toml')
  const stat = await host.stat(path)
  if (stat === undefined) return []
  if (stat.isDirectory || stat.size > CONFIG_MAX_BYTES) {
    host.log('warn', `${path} is not a bounded Codex model configuration file`)
    return []
  }
  const text = await host.readHead(path, CONFIG_MAX_BYTES)
  if (text.trim() === '') return []
  let root: Record<string, unknown>
  try {
    root = parseToml(text)
  } catch {
    host.log('warn', `${path} is not a readable TOML model configuration`)
    return []
  }

  const model = optionalString(root, 'model', path, host)
  const reviewModel = optionalString(root, 'review_model', path, host)
  const configuredProvider = optionalString(root, 'model_provider', path, host)
  if (invalidOptional(root, 'model', model)
    || invalidOptional(root, 'review_model', reviewModel)
    || invalidOptional(root, 'model_provider', configuredProvider)) return []
  const provider = configuredProvider ?? 'openai'
  const models: PiAiModelProfile[] = []
  if (model !== undefined) models.push({ id: model })
  if (reviewModel !== undefined && reviewModel !== model) models.push({ id: reviewModel })
  if (models.length === 0) return []

  const rawModelProviders = root['model_providers']
  if (rawModelProviders !== undefined && !isRecord(rawModelProviders)) {
    host.log('warn', `${path} model_providers is not a TOML table; no LLM route was read`)
    return []
  }
  const modelProviders = isRecord(rawModelProviders) ? rawModelProviders : undefined
  const rawProvider = modelProviders?.[provider]
  if (rawProvider !== undefined && !isRecord(rawProvider)) {
    host.log('warn', `${path} provider "${provider}" is not a TOML table; no LLM route was read`)
    return []
  }
  const providerConfig = isRecord(rawProvider) ? rawProvider : {}
  const unsupported = ['query_params', 'experimental_bearer_token', 'auth', 'aws']
    .find(key => providerConfig[key] !== undefined)
  if (unsupported !== undefined) {
    host.log('warn', `Codex provider "${provider}" uses ${unsupported}, which the direct Harness model route cannot reproduce`)
    return []
  }
  const configuredWire = optionalString(providerConfig, 'wire_api', path, host)
  if (invalidOptional(providerConfig, 'wire_api', configuredWire)) return []
  const wire = configuredWire ?? 'responses'
  if (wire !== 'responses') {
    host.log('warn', `Codex provider "${provider}" uses wire_api "${wire}"; the direct route supports responses only`)
    return []
  }
  const baseURL = optionalString(providerConfig, 'base_url', path, host)
  const displayName = optionalString(providerConfig, 'name', path, host)
  const envKey = optionalString(providerConfig, 'env_key', path, host)
  if (providerConfig['base_url'] !== undefined && baseURL === undefined
    || providerConfig['name'] !== undefined && displayName === undefined
    || providerConfig['env_key'] !== undefined && envKey === undefined) return []
  if (baseURL === undefined && provider !== 'openai' && provider !== 'openai-codex') {
    host.log('warn', `Codex provider "${provider}" has no base_url; no direct model route was read`)
    return []
  }

  const route: NativeProviderLlmRoute = {
    id: provider,
    modelNamespace: provider,
    displayName: displayName ?? provider,
    profile: {
      api: 'openai-responses',
      ...(baseURL === undefined ? {} : { baseURL }),
    },
    models,
    resolveApiKey: () => Promise.resolve().then(() => {
      const name = envKey ?? (provider === 'openai' || provider === 'openai-codex' ? 'OPENAI_API_KEY' : undefined)
      if (name === undefined) return undefined
      const value = host.env[name]
      if (value !== undefined && value !== '') return value
      throw new LlmError(`Codex provider "${provider}" names ${name}, which is not set in the agent environment`, 'MISSING_CREDENTIAL')
    }),
  }
  return [route]
}

/** Read one optional non-empty TOML string, reporting only its key on failure. */
function optionalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  host: AgentHost,
): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    host.log('warn', `${path} has an invalid "${key}" field; no direct model route was read`)
    return undefined
  }
  return value.trim()
}

/** Whether an optional configured value failed its type or non-empty check. */
function invalidOptional(source: Record<string, unknown>, key: string, value: unknown): boolean {
  return source[key] !== undefined && value === undefined
}

/** Whether a TOML value is a table. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
