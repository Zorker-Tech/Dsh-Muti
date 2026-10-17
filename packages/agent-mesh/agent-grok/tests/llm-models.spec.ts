/** Grok Build's native model configuration projected into the Harness LLM service. */

import { describe, expect, it } from 'vitest'
import { readGrokLlmRoutes } from '../src/llm-models.ts'
import type { GrokPaths } from '../src/sessions.ts'
import { MemoryHost } from './support/memory-host.ts'

const PATHS: GrokPaths = {
  home: '/home/tester/.grok',
  homeFromEnv: false,
  sessionRoot: '/home/tester/.grok/sessions',
  credentialPath: '/home/tester/.grok/auth.json',
}

const CONFIG = `${PATHS.home}/config.toml`

describe('Grok native LLM routes', () => {
  it('projects shared-provider settings, model limits, headers and a named key', async () => {
    const host = new MemoryHost({
      env: { GATEWAY_KEY: 'gateway-secret', TENANT_KEY: 'tenant-secret' },
      files: { [CONFIG]: [
        '[model.gateway-alias]',
        'model = "vendor/model-with-slash"',
        'model_provider = "gateway"',
        'name = "Team Model"',
        'api_backend = "responses"',
        'context_window = 131072',
        'max_completion_tokens = 8192',
        'env_key = ["MISSING_KEY", "GATEWAY_KEY"]',
        'extra_headers = { "X-Tenant" = "static-tenant", "X-Team" = "eng" }',
        'env_http_headers = { "x-tenant" = "TENANT_KEY" }',
        '[model_providers.gateway]',
        'base_url = "https://gateway.example/v1"',
        'api_backend = "chat_completions"',
      ].join('\n') },
    })

    const routes = await readGrokLlmRoutes(host, PATHS)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      id: 'gateway',
      modelNamespace: 'gateway-alias',
      displayName: 'Team Model',
      profile: {
        api: 'openai-responses',
        baseURL: 'https://gateway.example/v1',
        headers: { 'x-tenant': 'tenant-secret', 'X-Team': 'eng' },
      },
      models: [{ id: 'vendor/model-with-slash', name: 'Team Model', contextWindow: 131072, maxTokens: 8192 }],
      allowAmbientAuth: false,
    })
    await expect(routes[0]?.resolveApiKey()).resolves.toBe('gateway-secret')
    expect(JSON.stringify(routes.map(({ profile, models }) => ({ profile, models }))))
      .not.toContain('gateway-secret')
  })

  it('uses a literal key before environment keys and supports Messages routes', async () => {
    const host = new MemoryHost({
      env: { XAI_API_KEY: 'global-xai-key', ENV_KEY: 'environment-key' },
      files: { [CONFIG]: [
        '[model.messages]',
        'model = "claude-sonnet"',
        'base_url = "https://messages.example/v1"',
        'api_backend = "messages"',
        'api_key = "literal-key"',
        'env_key = "ENV_KEY"',
      ].join('\n') },
    })
    const routes = await readGrokLlmRoutes(host, PATHS)
    expect(routes[0]?.profile).toMatchObject({ api: 'anthropic-messages', baseURL: 'https://messages.example/v1' })
    await expect(routes[0]?.resolveApiKey()).resolves.toBe('literal-key')
  })

  it('uses Grok API key fallbacks and does not reuse a signed-in session token', async () => {
    const host = new MemoryHost({ env: { GROK_CODE_XAI_API_KEY: 'grok-key' }, files: {
      [CONFIG]: '[model.native]\nmodel = "grok-4.6"\napi_backend = "responses"\n',
    } })
    const routes = await readGrokLlmRoutes(host, PATHS)
    expect(routes[0]?.id).toBe('xai')
    await expect(routes[0]?.resolveApiKey()).resolves.toBe('grok-key')

    const noKey = new MemoryHost({ files: { [CONFIG]: '[model.native]\nmodel = "grok-4.6"\n' } })
    const noKeyRoute = (await readGrokLlmRoutes(noKey, PATHS))[0]
    await expect(noKeyRoute?.resolveApiKey()).resolves.toBeUndefined()
  })

  it('returns no routes for absent, malformed, oversized, or malformed model sections', async () => {
    const host = new MemoryHost()
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    host.writeFile(CONFIG, 'model = [broken')
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    expect(host.logs.some(line => line.includes('not a readable TOML'))).toBe(true)

    host.writeFile(CONFIG, `[model]\n${'x'.repeat(1024 * 1024)}`)
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    expect(host.logs.some(line => line.includes('not a bounded'))).toBe(true)

    host.writeFile(CONFIG, '[model]\n')
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    host.writeFile(CONFIG, '[model.bad]\nname = 1\n')
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    expect(host.logs.some(line => line.includes('invalid "name"'))).toBe(true)
  })

  it('refuses query, command-auth and request behavior it cannot represent', async () => {
    const host = new MemoryHost({ files: { [CONFIG]: [
      '[model.query]',
      'model = "m"',
      'query_params = { version = "v2" }',
      '[model.commands]',
      'model = "m"',
      'auth_provider = "rotating"',
      '[model.temperature]',
      'model = "m"',
      'temperature = 0.2',
    ].join('\n') } })
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    expect(host.logs.some(line => line.includes('query_params'))).toBe(true)
    expect(host.logs.some(line => line.includes('auth_provider'))).toBe(true)
    expect(host.logs.some(line => line.includes('temperature'))).toBe(true)
  })

  it('skips invalid provider values, backend names, limits, headers and key declarations', async () => {
    const host = new MemoryHost({ files: { [CONFIG]: [
      '[model_providers.bad]',
      'base_url = 1',
      '[model.bad-provider]',
      'model = "m"',
      'model_provider = "bad"',
      '[model.invalid-backend]',
      'model = "m"',
      'api_backend = "grpc"',
      '[model.invalid-limit]',
      'model = "m"',
      'context_window = 0',
      '[model.invalid-header]',
      'model = "m"',
      'extra_headers = { "x" = 3 }',
      '[model.invalid-env-key]',
      'model = "m"',
      'env_key = []',
    ].join('\n') } })
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    expect(host.logs.some(line => line.includes('invalid "base_url"'))).toBe(true)
    expect(host.logs.some(line => line.includes('unsupported api_backend'))).toBe(true)
    expect(host.logs.some(line => line.includes('invalid "context_window"'))).toBe(true)
    expect(host.logs.some(line => line.includes('invalid "extra_headers"'))).toBe(true)
    expect(host.logs.some(line => line.includes('invalid "env_key"'))).toBe(true)
  })

  it('throws a missing-credential error when all explicitly named keys are unset', async () => {
    const host = new MemoryHost({ files: { [CONFIG]: [
      '[model.gateway]',
      'model = "m"',
      'base_url = "https://gateway.example/v1"',
      'env_key = ["FIRST_KEY", "SECOND_KEY"]',
    ].join('\n') } })
    const route = (await readGrokLlmRoutes(host, PATHS))[0]
    await expect(route?.resolveApiKey()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('validates model tables, key sources, headers, and inherited provider settings', async () => {
    const host = new MemoryHost({
      env: { LOWER_KEY: 'lower-key-value', HEADER_KEY: 'dynamic-header', EMPTY_HEADER: '' },
      files: { [CONFIG]: 'model = 42\n' },
    })
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    expect(host.logs.some(line => line.includes('model section is not a TOML table'))).toBe(true)

    host.writeFile(CONFIG, 'model_providers = []\n')
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    expect(host.logs.some(line => line.includes('model_providers section is not a TOML table'))).toBe(true)

    host.writeFile(CONFIG, 'model.bad-model-table = []\n')
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    expect(host.logs.some(line => line.includes('model "bad-model-table" is not a TOML table'))).toBe(true)

    host.writeFile(CONFIG, [
      'model_providers = { malformed = false }',
      '[model.bad-provider]',
      'model = "m"',
      'model_provider = "malformed"',
    ].join('\n'))
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    expect(host.logs.some(line => line.includes('model provider "malformed" is not a TOML table'))).toBe(true)

    host.writeFile(CONFIG, '[model_providers.empty]\nbase_url = "https://empty.example/v1"\n')
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])

    host.writeFile(CONFIG, '[model.invalid-provider]\nmodel_provider = 4\n')
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])

    host.writeFile(CONFIG, [
      '[model.no-endpoint]',
      'api_backend = "messages"',
      'env_key = "LOWER_KEY"',
      '[model.named-alias]',
      'model_provider = "missing-provider"',
      'api_key = "literal-key"',
      '[model.invalid-static-headers]',
      'model = "m"',
      'extra_headers = { "x" = 3 }',
      '[model.invalid-base-url]',
      'model = "m"',
      'base_url = 4',
      '[model.invalid-env-headers]',
      'model = "m"',
      'env_http_headers = { "x" = 4 }',
      '[model.invalid-context-window]',
      'model = "m"',
      'context_window = 1.5',
      '[model.invalid-token-limit]',
      'model = "m"',
      'max_completion_tokens = 1.5',
      '[model.secret-env]',
      'model = "m"',
      'api_key = 4',
      '[model.empty-secret]',
      'model = "m"',
      'api_key = "  "',
      '[model.bad-environment-name]',
      'model = "m"',
      'env_key = ["", "SECOND"]',
      '[model.bad-env-type]',
      'model = "m"',
      'env_key = 4',
      '[model.aliased-headers]',
      'model = "m"',
      'model_provider = "headers"',
      '[model_providers.headers]',
      'extra_headers = { "X-Tenant" = "provider" }',
      'env_http_headers = { "X-Tenant" = "HEADER_KEY", "X-Empty" = "EMPTY_HEADER", "X-Missing" = "MISSING_HEADER" }',
      '[model.aliased-headers.extra_headers]',
      '"x-tenant" = "model"',
    ].join('\n'))
    const validatedRoutes = await readGrokLlmRoutes(host, PATHS)
    expect(validatedRoutes.map(route => route.modelNamespace)).toEqual(['no-endpoint', 'named-alias', 'aliased-headers'])
    await expect(validatedRoutes[0]?.resolveApiKey()).resolves.toBe('lower-key-value')
    await expect(validatedRoutes[1]?.resolveApiKey()).resolves.toBe('literal-key')
    expect(validatedRoutes[2]?.profile.headers).toEqual({ 'x-tenant': 'model' })
    expect(host.logs.some(line => line.includes('invalid "base_url"'))).toBe(true)
    expect(host.logs.some(line => line.includes('invalid "api_key"'))).toBe(true)
    expect(host.logs.some(line => line.includes('invalid "env_key"'))).toBe(true)
    expect(host.logs.some(line => line.includes('invalid "extra_headers" table'))).toBe(true)
    expect(host.logs.some(line => line.includes('invalid "env_http_headers" table'))).toBe(true)
    expect(host.logs.some(line => line.includes('context_window'))).toBe(true)
    expect(host.logs.some(line => line.includes('max_completion_tokens'))).toBe(true)

    host.writeFile(CONFIG, [
      '[model.defaulted]',
      '[model.with-headers]',
      'model = "m"',
      'model_provider = "headers"',
      '[model_providers.headers]',
      'extra_headers = { "X-Tenant" = "provider" }',
      'env_http_headers = { "X-Tenant" = "HEADER_KEY", "X-Empty" = "EMPTY_HEADER", "X-Missing" = "MISSING_HEADER" }',
      '[model.with-headers.extra_headers]',
      '"x-tenant" = "model"',
    ].join('\n'))
    const routes = await readGrokLlmRoutes(host, PATHS)
    expect(routes.map(route => route.modelNamespace)).toEqual(['defaulted', 'with-headers'])
    expect(routes[0]?.models).toEqual([{ id: 'defaulted', name: 'defaulted' }])
    expect(routes[1]?.profile.headers).toEqual({ 'x-tenant': 'model' })
  })

  it('formats non-Error provider lookup failures in route diagnostics', async () => {
    const env = new Proxy<Record<string, string | undefined>>({}, {
      get: () => { throw 'environment lookup failed' },
    })
    const host = new MemoryHost({ env, files: {
      [CONFIG]: '[model.route]\nmodel = "m"\nenv_http_headers = { x = "KEY" }\n',
    } })
    await expect(readGrokLlmRoutes(host, PATHS)).resolves.toEqual([])
    expect(host.logs.some(line => line.includes('environment lookup failed'))).toBe(true)

    const errorEnv = new Proxy<Record<string, string | undefined>>({}, {
      get: () => { throw new Error('environment provider failed') },
    })
    const errorHost = new MemoryHost({ env: errorEnv, files: {
      [CONFIG]: '[model.route]\nmodel = "m"\nenv_http_headers = { x = "KEY" }\n',
    } })
    await expect(readGrokLlmRoutes(errorHost, PATHS)).resolves.toEqual([])
    expect(errorHost.logs.some(line => line.includes('environment provider failed'))).toBe(true)
  })
})
