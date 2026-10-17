/** Pi's native provider configuration projected into the Harness LLM service. */

import { describe, expect, it } from 'vitest'
import { readPiLlmRoutes } from '../src/llm-models.ts'
import type { PiStoreLayout } from '../src/sessions.ts'
import { createFakeHost } from './host.ts'

const LAYOUT: PiStoreLayout = {
  agentDir: '/home/tester/.pi/agent',
  defaultSessionsRoot: '/home/tester/.pi/agent/sessions',
  credentialPath: '/home/tester/.pi/agent/auth.json',
  settingsPath: '/home/tester/.pi/agent/settings.json',
  modelsPath: '/home/tester/.pi/agent/models.json',
}

/** Encode one fixture as native JSON. */
function json(value: unknown): string {
  return JSON.stringify(value) ?? ''
}

describe('Pi native LLM routes', () => {
  it('projects provider and model overrides without exposing configured keys', async () => {
    const host = createFakeHost({
      env: {
        MODEL_KEY: 'model-key-value',
        PROVIDER_HEADER: 'provider-header-value',
        MODEL_HEADER: 'model-header-value',
      },
      files: {
        [LAYOUT.modelsPath]: json({ providers: {
          gateway: {
            api: 'openai-completions',
            baseUrl: 'https://gateway.example/v1',
            apiKey: 'PROVIDER_KEY',
            headers: { 'x-provider': 'PROVIDER_HEADER' },
            models: [{
              id: 'qwen-latest',
              name: 'Old name',
              contextWindow: 65_536,
              maxTokens: 8_192,
              input: ['text', 'image'],
              reasoning: false,
              api: 'openai-responses',
              baseUrl: 'https://model.example/v1',
              apiKey: 'MODEL_KEY',
              headers: { 'x-model': '$MODEL_HEADER' },
            }],
            modelOverrides: { 'qwen-latest': { name: 'Qwen Latest' } },
          },
        } }),
        [LAYOUT.settingsPath]: json({ defaultProvider: 'gateway', defaultModel: 'qwen-latest' }),
      },
    })

    const routes = await readPiLlmRoutes(host, LAYOUT)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      id: 'gateway',
      modelNamespace: 'gateway',
      displayName: 'gateway',
      profile: {
        api: 'openai-responses',
        baseURL: 'https://model.example/v1',
        headers: {
          'x-provider': 'provider-header-value',
          'x-model': 'model-header-value',
        },
      },
      models: [{
        id: 'qwen-latest',
        name: 'Qwen Latest',
        contextWindow: 65_536,
        maxTokens: 8_192,
        input: ['text', 'image'],
        reasoningEfforts: false,
      }],
    })
    await expect(routes[0]!.resolveApiKey()).resolves.toBe('model-key-value')
    expect(JSON.stringify(routes.map(({ id, models, profile }) => ({ id, models, profile }))))
      .not.toContain('model-key-value')
  })

  it('uses an agent-owned stored API key before the configured value and resolves literals', async () => {
    const host = createFakeHost({ files: {
      [LAYOUT.modelsPath]: json({ providers: {
        openai: { apiKey: 'FALLBACK_KEY', models: [{ id: 'gpt-5' }] },
        local: { api: 'openai-completions', baseUrl: 'http://127.0.0.1/v1', apiKey: 'ollama', models: [{ id: 'qwen' }] },
      } }),
      [LAYOUT.credentialPath]: json({ openai: { type: 'api_key', key: 'stored-openai-key' } }),
    } })
    const routes = await readPiLlmRoutes(host, LAYOUT)
    await expect(routes.find(route => route.id === 'openai')?.resolveApiKey()).resolves.toBe('stored-openai-key')
    await expect(routes.find(route => route.id === 'local')?.resolveApiKey()).resolves.toBe('ollama')
  })

  it('adds the saved built-in model and handles missing, malformed, and unqualified settings', async () => {
    const host = createFakeHost({ files: {
      [LAYOUT.modelsPath]: '{}',
      [LAYOUT.settingsPath]: json({ defaultProvider: 'openai', defaultModel: 'gpt-5' }),
    } })
    await expect(readPiLlmRoutes(host, LAYOUT)).resolves.toEqual([
      expect.objectContaining({
        id: 'openai',
        models: [{ id: 'gpt-5' }],
      }),
    ])

    host.write(LAYOUT.modelsPath, '{invalid')
    host.write(LAYOUT.settingsPath, '[]')
    await expect(readPiLlmRoutes(host, LAYOUT)).resolves.toEqual([])
    expect(host.logs).toContain(`${LAYOUT.modelsPath} is not a valid JSON object; no LLM routes were read from it`)
    expect(host.logs).toContain(`${LAYOUT.settingsPath} is not a valid JSON object; no LLM routes were read from it`)

    host.write(LAYOUT.modelsPath, '{}')
    host.write(LAYOUT.settingsPath, json({ defaultModel: 'gpt-5' }))
    await expect(readPiLlmRoutes(host, LAYOUT)).resolves.toEqual([])
  })

  it('projects override-only models and validates native provider metadata', async () => {
    const host = createFakeHost({ env: { LowerCase_Key: 'resolved-key' }, files: {
      [LAYOUT.modelsPath]: json({
        providers: [],
      }),
      [LAYOUT.settingsPath]: '{}',
    } })
    await expect(readPiLlmRoutes(host, LAYOUT)).resolves.toEqual([])
    expect(host.logs).toContain(`${LAYOUT.modelsPath} has a providers field that is not an object`)

    host.write(LAYOUT.modelsPath, json({ providers: {
      overridesOnly: {
        api: 'openai-completions',
        baseUrl: 'https://override.example/v1',
        modelOverrides: { patched: { name: 'Patched', contextWindow: 64 } },
      },
      badPatch: { models: [], modelOverrides: { ignored: 4 } },
      badReasoning: { models: [{ id: 'bad', reasoning: 1 }] },
      literalHeader: { models: [{ id: 'header' }], headers: { 'x-static': 'literal-value' } },
      bracedKey: { models: [{ id: 'secret', apiKey: '${LowerCase_Key}' }] },
      staticKey: { models: [{ id: 'literal', apiKey: 'literal-value' }] },
      malformedReference: { models: [{ id: 'literal-reference', apiKey: '${BAD-KEY}' }] },
    } }))
    const routed = await readPiLlmRoutes(host, LAYOUT)
    expect(routed.map(route => [route.id, route.models[0]?.id])).toEqual([
      ['overridesOnly', 'patched'],
      ['literalHeader', 'header'],
      ['bracedKey', 'secret'],
      ['staticKey', 'literal'],
      ['malformedReference', 'literal-reference'],
    ])
    expect(routed[0]?.models[0]).toMatchObject({ name: 'Patched', contextWindow: 64 })
    expect(routed[1]?.profile.headers).toEqual({ 'x-static': 'literal-value' })
    await expect(routed[2]?.resolveApiKey()).resolves.toBe('resolved-key')
    await expect(routed[3]?.resolveApiKey()).resolves.toBe('literal-value')
    await expect(routed[4]?.resolveApiKey()).resolves.toBe('${BAD-KEY}')
    expect(host.logs.some(message => message.includes('badReasoning') && message.includes('reasoning'))).toBe(true)
  })

  it('omits duplicate models and logs malformed or unsupported native declarations', async () => {
    const host = createFakeHost({ files: {
      [LAYOUT.modelsPath]: json({
        modelOverrides: { ignored: { name: 'ignored' } },
        providers: {
          primitive: [],
          malformed: { models: 'not-an-array' },
          invalidOverrides: { api: 'openai-completions', baseUrl: 'https://one', modelOverrides: [], models: [] },
          duplicate: { api: 'openai-completions', baseUrl: 'https://two', models: [{ id: 'same' }, { id: 'same' }] },
          audio: { api: 'openai-completions', baseUrl: 'https://three', models: [{ id: 'audio', input: ['audio'] }] },
          commandHeader: { api: 'openai-completions', baseUrl: 'https://four', headers: { authorization: '!command' }, models: [{ id: 'command' }] },
          disabledAuth: { api: 'openai-completions', baseUrl: 'https://five', authHeader: false, models: [{ id: 'disabled' }] },
          badCapacity: { api: 'openai-completions', baseUrl: 'https://six', models: [{ id: 'bad', contextWindow: 0 }] },
          invalidCapacityType: { api: 'openai-completions', baseUrl: 'https://six-point-five', models: [{ id: 'bad', contextWindow: '128' }] },
          badHeader: { api: 'openai-completions', baseUrl: 'https://seven', headers: { authorization: 4 }, models: [{ id: 'bad-header' }] },
          invalidModelFields: { api: 'openai-completions', baseUrl: 'https://eight', models: [{ id: 'bad-fields', input: 'text', reasoning: 'yes' }] },
          invalidProviderFields: { api: 4, baseUrl: 'https://nine', models: [{ id: 'bad-provider' }] },
          invalidHeadersField: { api: 'openai-completions', baseUrl: 'https://ten', headers: [], models: [{ id: 'bad-headers' }] },
          invalidAuthHeader: { api: 'openai-completions', baseUrl: 'https://eleven', authHeader: 'yes', models: [{ id: 'bad-auth-header' }] },
          invalidApiKey: { api: 'openai-completions', baseUrl: 'https://twelve', apiKey: 4, models: [{ id: 'bad-key' }] },
          invalidProviderName: { api: 'openai-completions', baseUrl: 'https://thirteen', name: 4, models: [{ id: 'bad-name' }] },
          invalidModelApi: { api: 'openai-completions', baseUrl: 'https://fourteen', models: [{ id: 'bad-api', api: 4 }] },
          invalidModelBaseUrl: { api: 'openai-completions', baseUrl: 'https://fifteen', models: [{ id: 'bad-base-url', baseUrl: 4 }] },
          invalidModelHeaders: { api: 'openai-completions', baseUrl: 'https://sixteen', models: [{ id: 'bad-model-headers', headers: [] }] },
          invalidModelAuthHeader: { api: 'openai-completions', baseUrl: 'https://seventeen', models: [{ id: 'bad-model-auth-header', authHeader: false }] },
          invalidModelApiKey: { api: 'openai-completions', baseUrl: 'https://eighteen', models: [{ id: 'bad-model-key', apiKey: 4 }] },
          invalidModelName: { api: 'openai-completions', baseUrl: 'https://nineteen', models: [{ id: 'bad-model-name', name: 4 }] },
          invalidInputValues: { api: 'openai-completions', baseUrl: 'https://twenty', models: [{ id: 'bad-input', input: ['text', 3] }] },
          malformedModels: { api: 'openai-completions', baseUrl: 'https://twenty-one', models: [null, {}, { id: 3 }] },
          invalidProviders: [],
        },
      }),
      [LAYOUT.settingsPath]: '{}',
    } })

    await expect(readPiLlmRoutes(host, LAYOUT)).resolves.toEqual([])
    expect(host.logs).toContain(`${LAYOUT.modelsPath} declares a top-level modelOverrides field that Pi does not use`)
    expect(host.logs).toContain(`${LAYOUT.modelsPath} provider "primitive" is not an object`)
    expect(host.logs).toContain(`${LAYOUT.modelsPath} provider "malformed" has a models field that is not an array`)
    expect(host.logs).toContain(`${LAYOUT.modelsPath} provider "invalidOverrides" has an invalid modelOverrides field`)
    expect(host.logs).toContain(`${LAYOUT.modelsPath} declares model "duplicate/same" more than once; DSH will not route it`)
    expect(host.logs.some(message => message.includes('audio') && message.includes('unavailable'))).toBe(true)
    expect(host.logs.some(message => message.includes('commandHeader') && message.includes('does not execute'))).toBe(true)
    expect(host.logs.some(message => message.includes('disabledAuth') && message.includes('cannot reproduce'))).toBe(true)
    expect(host.logs.some(message => message.includes('badCapacity') && message.includes('contextWindow'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidCapacityType') && message.includes('contextWindow'))).toBe(true)
    expect(host.logs.some(message => message.includes('badHeader') && message.includes('not a string'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidModelFields') && message.includes('input modalities'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidProviderFields') && message.includes('api'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidHeadersField') && message.includes('headers'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidAuthHeader') && message.includes('authHeader'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidApiKey') && message.includes('apiKey'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidProviderName') && message.includes('name'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidModelApi') && message.includes('api'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidModelBaseUrl') && message.includes('baseUrl'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidModelHeaders') && message.includes('headers'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidModelAuthHeader') && message.includes('authHeader'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidModelApiKey') && message.includes('apiKey'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidModelName') && message.includes('name'))).toBe(true)
    expect(host.logs.some(message => message.includes('invalidInputValues') && message.includes('modalities'))).toBe(true)
  })

  it('rejects command and OAuth credentials, missing environment names, and malformed auth files', async () => {
    const makeRoute = async (apiKey: string, auth = '') => {
      const host = createFakeHost({ files: {
        [LAYOUT.modelsPath]: json({ providers: { custom: {
          api: 'openai-completions', baseUrl: 'https://proxy.example/v1', apiKey, models: [{ id: 'm' }],
        } } }),
        ...(auth === '' ? {} : { [LAYOUT.credentialPath]: auth }),
      } })
      const routes = await readPiLlmRoutes(host, LAYOUT)
      return routes[0]!
    }

    await expect(makeRoute('!secret-command').then(route => route.resolveApiKey()))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_AUTH' })
    await expect(makeRoute('LATER_KEY').then(route => route.resolveApiKey()))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    await expect(makeRoute('fallback', json({ custom: { type: 'oauth', access: 'token' } }))
      .then(route => route.resolveApiKey())).rejects.toMatchObject({ code: 'UNSUPPORTED_AUTH' })
    await expect(makeRoute('fallback', '{broken').then(route => route.resolveApiKey()))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('reports invalid credential paths and returns no key for absent or unknown records', async () => {
    const files = { [LAYOUT.modelsPath]: json({ providers: {
      custom: { api: 'openai-completions', baseUrl: 'https://proxy.example/v1', models: [{ id: 'm' }] },
    } }) }
    const createRoute = async (options: Parameters<typeof createFakeHost>[0] = {}) => {
      const host = createFakeHost({
        files: { ...files, ...options.files },
        ...(options.dirs === undefined ? {} : { dirs: options.dirs }),
        ...(options.env === undefined ? {} : { env: options.env }),
      })
      const routes = await readPiLlmRoutes(host, LAYOUT)
      return { host, route: routes[0]! }
    }

    const absent = await createRoute()
    await expect(absent.route.resolveApiKey()).resolves.toBeUndefined()

    const unknown = await createRoute({ files: { [LAYOUT.credentialPath]: json({ custom: { type: 'unknown' } }) } })
    await expect(unknown.route.resolveApiKey()).resolves.toBeUndefined()

    const empty = await createRoute({ files: { [LAYOUT.credentialPath]: '' } })
    await expect(empty.route.resolveApiKey()).resolves.toBeUndefined()

    const command = await createRoute({ files: { [LAYOUT.credentialPath]: json({ custom: { type: 'api_key', key: '!command' } }) } })
    await expect(command.route.resolveApiKey()).rejects.toMatchObject({ code: 'UNSUPPORTED_AUTH' })

    const directory = await createRoute({ dirs: [LAYOUT.credentialPath] })
    await expect(directory.route.resolveApiKey()).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })

    const unreadable = await createRoute({ files: { [LAYOUT.credentialPath]: '   ' } })
    await expect(unreadable.route.resolveApiKey()).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })

    const nonObject = await createRoute({ files: { [LAYOUT.credentialPath]: '[]' } })
    await expect(nonObject.route.resolveApiKey()).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('refuses oversized and directory configuration files and oversized credentials', async () => {
    const missing = createFakeHost()
    await expect(readPiLlmRoutes(missing, LAYOUT)).resolves.toEqual([])

    const directory = createFakeHost({
      files: { [LAYOUT.settingsPath]: '{}' },
      dirs: [LAYOUT.modelsPath],
    })
    await expect(readPiLlmRoutes(directory, LAYOUT)).resolves.toEqual([])
    expect(directory.logs.some(message => message.includes('not a bounded Pi model configuration file'))).toBe(true)

    const oversized = createFakeHost({ files: {
      [LAYOUT.modelsPath]: `${' '.repeat(1024 * 1024)} `,
      [LAYOUT.settingsPath]: '{}',
    } })
    await expect(readPiLlmRoutes(oversized, LAYOUT)).resolves.toEqual([])
    expect(oversized.logs.some(message => message.includes('not a bounded Pi model configuration file'))).toBe(true)

    const credential = createFakeHost({ files: {
      [LAYOUT.modelsPath]: json({ providers: { custom: {
        api: 'openai-completions', baseUrl: 'https://proxy.example/v1', models: [{ id: 'm' }],
      } } }),
      [LAYOUT.credentialPath]: `${' '.repeat(8 * 1024 * 1024)} `,
    } })
    const routes = await readPiLlmRoutes(credential, LAYOUT)
    await expect(routes[0]?.resolveApiKey()).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })
})
