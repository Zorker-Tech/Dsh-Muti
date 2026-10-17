/** Codex's native model configuration projected into the Harness LLM service. */

import { describe, expect, it } from 'vitest'
import { readCodexLlmRoutes } from '../src/llm-models.ts'
import type { CodexHome } from '../src/sessions.ts'
import { FakeHost } from './fake-host.ts'

const HOME: CodexHome = {
  path: '/home/tester/.codex',
  sessionsRoot: '/home/tester/.codex/sessions',
  archivedRoot: '/home/tester/.codex/archived_sessions',
  indexFile: '/home/tester/.codex/session_index.jsonl',
  credentialFile: '/home/tester/.codex/auth.json',
  fromEnv: false,
}

const CONFIG = `${HOME.path}/config.toml`

describe('Codex native LLM routes', () => {
  it('projects configured Responses models and resolves a named environment key', async () => {
    const host = new FakeHost()
    host.env['CODEX_GATEWAY_KEY'] = 'gateway-secret'
    host.addFile(CONFIG, [
      'model = "gpt-custom"',
      'review_model = "gpt-review"',
      'model_provider = "gateway"',
      '[model_providers.gateway]',
      'name = "Internal Gateway"',
      'wire_api = "responses"',
      'base_url = "https://gateway.example/v1"',
      'env_key = "CODEX_GATEWAY_KEY"',
    ].join('\n'))

    const routes = await readCodexLlmRoutes(host, HOME)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      id: 'gateway',
      modelNamespace: 'gateway',
      displayName: 'Internal Gateway',
      profile: { api: 'openai-responses', baseURL: 'https://gateway.example/v1' },
      models: [{ id: 'gpt-custom' }, { id: 'gpt-review' }],
    })
    expect(typeof routes[0]?.resolveApiKey).toBe('function')
    await expect(routes[0]?.resolveApiKey()).resolves.toBe('gateway-secret')
    expect(JSON.stringify(routes.map(({ id, models, profile }) => ({ id, models, profile }))))
      .not.toContain('gateway-secret')
  })

  it('uses the standard OpenAI environment key and omits a duplicate review model', async () => {
    const host = new FakeHost()
    host.env['OPENAI_API_KEY'] = 'openai-secret'
    host.addFile(CONFIG, 'model = "gpt-5-codex"\nreview_model = "gpt-5-codex"\n')
    const routes = await readCodexLlmRoutes(host, HOME)
    expect(routes[0]?.models).toEqual([{ id: 'gpt-5-codex' }])
    await expect(routes[0]?.resolveApiKey()).resolves.toBe('openai-secret')
  })

  it('returns no routes when there are no model selectors and reports invalid TOML', async () => {
    const host = new FakeHost()
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    host.addFile(CONFIG, '  \n')
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    host.addFile(CONFIG, 'model = [broken')
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('not a readable TOML'))).toBe(true)
  })

  it('rejects oversized files, malformed selectors, and malformed provider tables', async () => {
    const host = new FakeHost()
    host.addFile(CONFIG, `model = "gpt-5"\n${' '.repeat(1024 * 1024)}`)
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('not a bounded'))).toBe(true)

    host.addFile(CONFIG, 'model = 42\n')
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('invalid "model"'))).toBe(true)

    host.addFile(CONFIG, 'model = "gpt-5"\nmodel_provider = 2\n')
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('invalid "model_provider"'))).toBe(true)

    host.addFile(CONFIG, 'model = "gpt-5"\nmodel_providers = []\n')
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('model_providers is not a TOML table'))).toBe(true)
  })

  it('refuses unsupported provider behavior and missing custom endpoints', async () => {
    const host = new FakeHost()
    host.addFile(CONFIG, [
      'model = "bad"',
      'model_provider = "gateway"',
      '[model_providers.gateway]',
      'wire_api = "chat"',
      'base_url = "https://gateway.example/v1"',
    ].join('\n'))
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])

    host.addFile(CONFIG, [
      'model = "bad"',
      'model_provider = "gateway"',
      '[model_providers.gateway]',
      'wire_api = "responses"',
      'query_params = { mode = "unsafe-to-ignore" }',
    ].join('\n'))
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('query_params'))).toBe(true)
  })

  it('rejects malformed configured strings and reports missing credentials without printing values', async () => {
    const host = new FakeHost()
    host.addFile(CONFIG, [
      'model = "custom"',
      'model_provider = "gateway"',
      '[model_providers.gateway]',
      'wire_api = "responses"',
      'base_url = "https://gateway.example/v1"',
      'env_key = "MISSING_GATEWAY_KEY"',
    ].join('\n'))
    const routes = await readCodexLlmRoutes(host, HOME)
    await expect(routes[0]?.resolveApiKey()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(host.logs.some(({ message }) => message.includes('MISSING_GATEWAY_KEY'))).toBe(false)

    host.addFile(CONFIG, 'model = "custom"\nmodel_provider = "gateway"\n[model_providers.gateway]\nbase_url = 1\n')
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('invalid "base_url"'))).toBe(true)
  })

  it('handles review-only selectors, malformed provider entries, and keyless custom providers', async () => {
    const host = new FakeHost()
    host.addFile(CONFIG, 'model_provider = "gateway"\n')
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])

    host.addFile(CONFIG, [
      'review_model = "review-only"',
      'model_provider = "gateway"',
      'model_providers = { gateway = false }',
    ].join('\n'))
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('provider "gateway" is not a TOML table'))).toBe(true)

    host.addFile(CONFIG, [
      'model = "custom"',
      'model_provider = "gateway"',
      '[model_providers.gateway]',
      'wire_api = "responses"',
    ].join('\n'))
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('has no base_url'))).toBe(true)

    host.addFile(CONFIG, [
      'review_model = "review-only"',
      'model_provider = "gateway"',
      '[model_providers.gateway]',
      'wire_api = "responses"',
      'base_url = "https://gateway.example/v1"',
      'name = "Gateway"',
    ].join('\n'))
    const route = (await readCodexLlmRoutes(host, HOME))[0]
    expect(route?.models).toEqual([{ id: 'review-only' }])
    await expect(route?.resolveApiKey()).resolves.toBeUndefined()

    host.addFile(CONFIG, [
      'model = "custom"',
      'model_provider = "gateway"',
      '[model_providers.gateway]',
      'base_url = "https://gateway.example/v1"',
      'wire_api = 42',
    ].join('\n'))
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('invalid "wire_api"'))).toBe(true)

    host.addFile(CONFIG, [
      'model = "custom"',
      'model_provider = "gateway"',
      '[model_providers.gateway]',
      'wire_api = "responses"',
      'name = 4',
    ].join('\n'))
    await expect(readCodexLlmRoutes(host, HOME)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('invalid "name"'))).toBe(true)

    const codexHost = new FakeHost()
    codexHost.env['OPENAI_API_KEY'] = 'codex-key'
    codexHost.addFile(CONFIG, 'model = "gpt-5-codex"\nmodel_provider = "openai-codex"\n')
    const codexRoute = (await readCodexLlmRoutes(codexHost, HOME))[0]
    await expect(codexRoute?.resolveApiKey()).resolves.toBe('codex-key')
  })
})
