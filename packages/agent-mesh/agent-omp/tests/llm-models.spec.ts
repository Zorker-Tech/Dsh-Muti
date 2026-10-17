/** OMP's native YAML model configuration projected into the Harness LLM service. */

import { describe, expect, it } from 'vitest'
import { readOmpLlmRoutes } from '../src/llm-models.ts'
import type { OmpStoreLayout } from '../src/sessions.ts'
import { FakeHost } from './support/fake-host.ts'

const LAYOUT: OmpStoreLayout = {
  agentDir: '/home/tester/.omp/agent',
  configRoot: '/home/tester/.omp',
  defaultSessionsRoot: '/home/tester/.omp/agent/sessions',
  sessionsDirFromSetting: false,
  agentDirFromEnv: false,
  credentialPath: '/home/tester/.omp/agent/agent.db',
  settingsPath: '/home/tester/.omp/agent/config.yml',
  modelsPath: '/home/tester/.omp/agent/models.yml',
}

describe('OMP native LLM routes', () => {
  it('projects custom providers, model limits, environment keys, and role aliases', async () => {
    const host = new FakeHost({ env: { GATEWAY_KEY: 'gateway-secret' } })
    host.addFile(LAYOUT.modelsPath, [
      'providers:',
      '  gateway:',
      '    api: openai-responses',
      '    baseUrl: https://gateway.example/v1',
      '    apiKey: GATEWAY_KEY',
      '    headers:',
      '      X-Team: platform',
      '    models:',
      '      - id: qwen-latest',
      '        name: Qwen Latest',
      '        contextWindow: 131072',
      '        maxTokens: 8192',
      '        input: [text, image]',
      '      - id: literal',
      '        apiKey: local-literal-key',
      '  local:',
      '    api: openai-completions',
      '    baseUrl: http://127.0.0.1:8000/v1',
      '    auth: none',
      '    models:',
      '      - id: local-model',
    ].join('\n'))
    host.addFile(LAYOUT.settingsPath, [
      'modelRoles:',
      '  default: gateway/qwen-latest:high',
      '  smol: "@default"',
      '  image: imagegen/sdxl',
      '  fuzzy: qwen',
    ].join('\n'))

    const routes = await readOmpLlmRoutes(host, LAYOUT)
    expect(routes).toHaveLength(3)
    expect(routes[0]).toMatchObject({
      id: 'gateway',
      modelNamespace: 'gateway',
      displayName: 'gateway',
      profile: {
        api: 'openai-responses',
        baseURL: 'https://gateway.example/v1',
        headers: { 'X-Team': 'platform' },
      },
      models: [{ id: 'qwen-latest', name: 'Qwen Latest', contextWindow: 131072, maxTokens: 8192, input: ['text', 'image'] }],
    })
    await expect(routes[0]?.resolveApiKey()).resolves.toBe('gateway-secret')
    await expect(routes[1]?.resolveApiKey()).resolves.toBe('local-literal-key')
    expect(routes[2]).toMatchObject({
      id: 'local',
      allowAmbientAuth: false,
      models: [{ id: 'local-model' }],
    })
    await expect(routes[2]?.resolveApiKey()).resolves.toBeUndefined()
    expect(JSON.stringify(routes.map(({ profile, models }) => ({ profile, models }))))
      .not.toContain('gateway-secret')
  })

  it('projects exact built-in role selections and follows aliases without model-kind roles', async () => {
    const host = new FakeHost()
    host.addFile(LAYOUT.settingsPath, [
      'modelRoles:',
      '  default: openai/gpt-5',
      '  slow: "@default:high"',
      '  vision: anthropic/claude-sonnet-4-5',
      '  judge: openai/gpt-5-mini',
      '  all: "*"',
    ].join('\n'))
    const routes = await readOmpLlmRoutes(host, LAYOUT)
    expect(routes.map(({ id, models }) => [id, models[0]?.id])).toEqual([
      ['openai', 'gpt-5'],
      ['anthropic', 'claude-sonnet-4-5'],
    ])
    expect(host.logs).toEqual([])
  })

  it('returns no routes for invalid YAML, oversized files, and invalid root sections', async () => {
    const host = new FakeHost()
    host.addFile(LAYOUT.modelsPath, 'providers: [broken')
    await expect(readOmpLlmRoutes(host, LAYOUT)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('not valid YAML'))).toBe(true)

    host.addFile(LAYOUT.modelsPath, `providers:\n  p:\n${' '.repeat(1024 * 1024)}`)
    await expect(readOmpLlmRoutes(host, LAYOUT)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('not a bounded'))).toBe(true)

    host.addFile(LAYOUT.modelsPath, 'providers: []')
    host.addFile(LAYOUT.settingsPath, 'modelRoles: []')
    await expect(readOmpLlmRoutes(host, LAYOUT)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('providers field is not a YAML mapping'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('modelRoles field is not a YAML mapping'))).toBe(true)
  })

  it('logs malformed providers, duplicate ids, malformed override tables, and model lists', async () => {
    const host = new FakeHost()
    host.addFile(LAYOUT.modelsPath, [
      'providers:',
      '  primitive: false',
      '  malformed:',
      '    models: one',
      '  bad-overrides:',
      '    models: []',
      '    modelOverrides: []',
      '  duplicates:',
      '    api: openai-completions',
      '    baseUrl: https://gateway.example/v1',
      '    auth: none',
      '    models:',
      '      - id: same',
      '      - id: same',
    ].join('\n'))
    await expect(readOmpLlmRoutes(host, LAYOUT)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('primitive') && message.includes('not a YAML mapping'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('models field is not a YAML sequence'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('modelOverrides field is not a YAML mapping'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('declares model "duplicates/same" more than once'))).toBe(true)
  })

  it('refuses OAuth, unsupported auth headers, command credentials, and unsupported provider behavior', async () => {
    const host = new FakeHost()
    host.addFile(LAYOUT.modelsPath, [
      'providers:',
      '  oauth:',
      '    baseUrl: https://oauth.example/v1',
      '    auth: oauth',
      '    models:',
      '      - id: model',
      '  no-header:',
      '    baseUrl: https://gateway.example/v1',
      '    auth: none',
      '    authHeader: false',
      '    models:',
      '      - id: model',
      '  command:',
      '    baseUrl: https://gateway.example/v1',
      '    apiKey: "!secret-command"',
      '    models:',
      '      - id: model',
      '  special:',
      '    api: openai-completions',
      '    baseUrl: https://gateway.example/v1',
      '    auth: none',
      '    discovery: { type: proxy }',
      '    models:',
      '      - id: model',
    ].join('\n'))
    await expect(readOmpLlmRoutes(host, LAYOUT)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('OAuth credentials'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('disables authHeader'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('discovery'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('command for its API key'))).toBe(true)
  })

  it('rejects malformed model fields and cyclic role aliases without reading the SQLite store', async () => {
    const host = new FakeHost()
    host.addFile(LAYOUT.modelsPath, [
      'providers:',
      '  invalid:',
      '    api: openai-completions',
      '    baseUrl: https://gateway.example/v1',
      '    auth: none',
      '    models:',
      '      - id: bad-api',
      '        api: 42',
      '      - id: bad-input',
      '        input: [text, audio]',
      '      - id: bad-limit',
      '        contextWindow: 0',
      '      - id: bad-auth',
      '        authHeader: yes',
      '      - id: bad-reasoning',
      '        reasoning: maybe',
    ].join('\n'))
    host.addFile(LAYOUT.settingsPath, 'modelRoles:\n  default: "@slow"\n  slow: "@default"\n')
    await expect(readOmpLlmRoutes(host, LAYOUT)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('invalid "api"'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('unsupported input modalities'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('invalid "contextWindow"'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('invalid "authHeader"'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('reasoning'))).toBe(true)
  })

  it('follows exact role aliases and combines declared and override-only models', async () => {
    const host = new FakeHost()
    host.addFile(LAYOUT.modelsPath, '   ')
    host.addFile(LAYOUT.settingsPath, '[]')
    await expect(readOmpLlmRoutes(host, LAYOUT)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('not a YAML mapping'))).toBe(true)

    host.addFile(LAYOUT.modelsPath, [
      'providers:',
      '  primitive: false',
      '  roleProvider:',
      '    api: openai-completions',
      '    baseUrl: https://role.example/v1',
      '    auth: none',
      '    modelOverrides:',
      '      selected:',
      '        name: Selected by role',
      '  custom:',
      '    api: openai-completions',
      '    baseUrl: https://custom.example/v1',
      '    auth: none',
      '    headers:',
      '      X-Tenant: provider',
      '      X-Owner: provider',
      '    models:',
      '      - null',
      '      - {}',
      '      - id: ""',
      '      - id: patch-me',
      '        reasoning: false',
      '        headers:',
      '          x-tenant: model',
      '      - id: repeated',
      '      - id: repeated',
      '    modelOverrides:',
      '      patch-me:',
      '        name: Patched declaration',
      '      orphan:',
      '        name: Override only',
      '        reasoning: true',
      '        input: []',
      '  noKey:',
      '    models:',
      '      - id: no-key-model',
      '  invalidApi:',
      '    api: 4',
      '    models: [{ id: invalid }]',
      '  invalidBaseUrl:',
      '    baseUrl: 4',
      '    models: [{ id: invalid }]',
      '  invalidApiKey:',
      '    apiKey: 4',
      '    models: [{ id: invalid }]',
      '  invalidAuth:',
      '    auth: 4',
      '    models: [{ id: invalid }]',
      '  unsupportedAuth:',
      '    auth: bearer',
      '    models: [{ id: invalid }]',
      '  invalidHeaders:',
      '    headers: []',
      '    models: [{ id: invalid }]',
      '  invalidHeaderValue:',
      '    headers: { x: 4 }',
      '    models: [{ id: invalid }]',
      '  commandHeader:',
      '    headers: { x: "!command" }',
      '    models: [{ id: invalid }]',
      '  invalidModelHeaders:',
      '    models: [{ id: invalid, headers: [] }]',
      '  invalidName:',
      '    models: [{ id: invalid, name: 4 }]',
      '  invalidMaxTokens:',
      '    models: [{ id: invalid, maxTokens: 0 }]',
      '  invalidReasoning:',
      '    models: [{ id: invalid, reasoning: maybe }]',
      '  invalidInput:',
      '    models: [{ id: invalid, input: [audio] }]',
    ].join('\n'))
    host.addFile(LAYOUT.settingsPath, [
      'modelRoles:',
      '  default: "@alias"',
      '  alias: "@star"',
      '  star: "*"',
      '  any: "*"',
      '  missing: "@not-defined"',
      '  imageAlias: "@image"',
      '  cycleA: "@cycleB"',
      '  cycleB: "@cycleA"',
      '  malformed: 4',
      '  invalidProvider: bad+/model',
      '  primitiveProvider: primitive/model',
      '  selected: roleProvider/selected',
      '  alreadyListed: custom/patch-me',
      '  implicit: roleProvider/implicit',
      '  unconfigured: unconfigured/model',
    ].join('\n'))

    const routes = await readOmpLlmRoutes(host, LAYOUT)
    expect(routes.map(route => `${route.id}/${route.models[0]?.id}`)).toEqual([
      'roleProvider/selected',
      'custom/patch-me',
      'custom/orphan',
      'roleProvider/implicit',
      'unconfigured/model',
    ])
    expect(routes[1]?.models[0]).toMatchObject({ name: 'Patched declaration', reasoningEfforts: false })
    expect(routes[1]?.profile.headers).toEqual({ 'X-Owner': 'provider', 'x-tenant': 'model' })
    expect(routes[2]?.models[0]).toMatchObject({ name: 'Override only', input: [] })
    expect(routes[2]?.models[0]?.reasoningEfforts).not.toBe(false)
    await expect(routes[4]?.resolveApiKey()).resolves.toBeUndefined()
    expect(host.logs.some(({ message }) => message.includes('custom/repeated') && message.includes('more than once'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('has custom models but no apiKey'))).toBe(true)
    expect(host.logs.some(({ level }) => level === 'info')).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('unsupported auth mode'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('headers field is not a YAML mapping'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('header "x" is not a string'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('header "x" uses a command'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('invalid "api"'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('invalid "baseUrl"'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('invalid "apiKey"'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('invalid "auth"'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('invalid "name"'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('invalid "maxTokens"'))).toBe(true)
    expect(host.logs.some(({ message }) => message.includes('invalid "reasoning"'))).toBe(true)

    const noDefault = new FakeHost()
    noDefault.addFile(LAYOUT.settingsPath, 'modelRoles:\n  all: "*"\n')
    await expect(readOmpLlmRoutes(noDefault, LAYOUT)).resolves.toEqual([])

    const selfDefault = new FakeHost()
    selfDefault.addFile(LAYOUT.settingsPath, 'modelRoles:\n  default: "*"\n  all: "*"\n')
    await expect(readOmpLlmRoutes(selfDefault, LAYOUT)).resolves.toEqual([])
  })

  it('converts non-Error route failures to a diagnostic', async () => {
    const host = new FakeHost()
    host.addFile(LAYOUT.modelsPath, [
      'providers:',
      '  malformed:',
      '    api: 4',
      '    models: [{ id: model }]',
    ].join('\n'))
    const log = host.log.bind(host)
    let failOnce = true
    host.log = (level, message) => {
      if (failOnce) {
        failOnce = false
        throw 'route logging failed'
      }
      log(level, message)
    }
    await expect(readOmpLlmRoutes(host, LAYOUT)).resolves.toEqual([])
    expect(host.logs.some(({ message }) => message.includes('route logging failed'))).toBe(true)

    const errorHost = new FakeHost()
    errorHost.addFile(LAYOUT.modelsPath, [
      'providers:',
      '  malformed:',
      '    api: 4',
      '    models: [{ id: model }]',
    ].join('\n'))
    const errorLog = errorHost.log.bind(errorHost)
    let failWithError = true
    errorHost.log = (level, message) => {
      if (failWithError) {
        failWithError = false
        throw new Error('error route logging failed')
      }
      errorLog(level, message)
    }
    await expect(readOmpLlmRoutes(errorHost, LAYOUT)).resolves.toEqual([])
    expect(errorHost.logs.some(({ message }) => message.includes('error route logging failed'))).toBe(true)
  })
})
