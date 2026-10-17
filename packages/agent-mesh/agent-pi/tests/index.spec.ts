/**
 * Pi adapter delegation, configured model projection, and Cordis registration.
 * @module @deepseek-ai/dsh-agent-pi/tests/index
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentAdapter, AgentModel, AgentRunRequest } from '@deepseek-ai/dsh-agent-mesh'
import type { Config as PiConfig } from '../src/index.ts'
import {
  apply,
  createPiAdapter,
  matchesModelPattern,
  PI_CAPABILITIES,
  PI_DISPLAY_NAME,
  PI_ID,
  PI_RUN_ENVIRONMENT_KEYS,
  PI_SUMMARY,
  PI_TRANSPORTS,
  readPiModels,
} from '../src/index.ts'
import type { PiStoreLayout } from '../src/sessions.ts'
import { assistantEntry, sessionFile, userEntry } from './fixtures.ts'
import { createFakeHost, processWith } from './host.ts'

const CWD = '/home/tester/project'
const LAYOUT: PiStoreLayout = {
  agentDir: '/home/tester/.pi/agent',
  defaultSessionsRoot: '/home/tester/.pi/agent/sessions',
  credentialPath: '/home/tester/.pi/agent/auth.json',
  settingsPath: '/home/tester/.pi/agent/settings.json',
  modelsPath: '/home/tester/.pi/agent/models.json',
}
const SESSION_PATH = `${LAYOUT.defaultSessionsRoot}/--home-tester-project--/2026-10-16_session-a.jsonl`
const SESSION_FILE = sessionFile({ id: 'session-a', cwd: CWD }, [
  userEntry('user-1', null, 'hello'),
  assistantEntry('assistant-1', 'user-1', [{ type: 'text', text: 'answer' }]),
])

/** Parse one JSON string held in a configured Pi file. */
function json(value: unknown): string {
  return JSON.stringify(value) ?? ''
}

describe('Pi configured model projection', () => {
  it('projects provider models, metadata overrides, missing defaults, and scoped globs', async () => {
    const host = createFakeHost({ files: {
      [LAYOUT.modelsPath]: json({
        modelOverrides: { ignored: { name: 'inert' } },
        providers: {
          malformed: [],
          broken: { models: 'not-an-array' },
          openai: {
            models: [null, [], {}, { id: 3 }, { id: '  ' }, { id: 'gpt-5', name: 'Base name' }, { id: 'legacy', name: 'Original' }],
            modelOverrides: {
              'gpt-5': { name: 'Patched name' },
              ghost: { name: 'Override-only model' },
              ignored: [],
              legacy: { name: 4 },
            },
          },
        },
      }),
      [LAYOUT.settingsPath]: json({ defaultModel: 'saved', defaultProvider: 'openai', enabledModels: [' ', 1, 'openai/gpt-*'] }),
    } })

    await expect(readPiModels(host, LAYOUT)).resolves.toEqual([
      { id: 'gpt-5', displayName: 'Patched name', provider: 'openai' },
    ])
    expect(host.logs).toContain(`${LAYOUT.modelsPath} declares a top-level modelOverrides, which pi's schema does not accept`)
  })

  it('keeps the full catalog when a configured enabled scope matches nothing', async () => {
    const host = createFakeHost({ files: {
      [LAYOUT.modelsPath]: json({ providers: {
        openai: { models: [{ id: 'gpt-5', name: 'GPT' }, { id: 'gpt-4' }] },
        anthropic: { models: [{ id: 'sonnet' }] },
      } }),
      [LAYOUT.settingsPath]: json({ defaultModel: 'saved-model', enabledModels: ['missing/*'] }),
    } })
    await expect(readPiModels(host, LAYOUT)).resolves.toEqual([
      { id: 'gpt-5', displayName: 'GPT', provider: 'openai' },
      { id: 'gpt-4', provider: 'openai' },
      { id: 'sonnet', provider: 'anthropic' },
      { id: 'saved-model' },
    ])
  })

  it('handles absent and malformed model files, known defaults, and empty scopes', async () => {
    const host = createFakeHost({ files: {
      [LAYOUT.modelsPath]: '',
      [LAYOUT.settingsPath]: json({ defaultModel: 'known', defaultProvider: 'openai', enabledModels: [] }),
    } })
    expect(await readPiModels(host, LAYOUT)).toEqual([{ id: 'known', provider: 'openai' }])

    host.write(LAYOUT.modelsPath, '{broken')
    host.write(LAYOUT.settingsPath, json({ defaultModel: ' ', defaultProvider: ' ', enabledModels: [''] }))
    expect(await readPiModels(host, LAYOUT)).toEqual([])

    host.write(LAYOUT.modelsPath, json({ providers: { openai: { models: [{ id: 'known' }] } } }))
    host.write(LAYOUT.settingsPath, json({ defaultModel: 'known', defaultProvider: 'openai', enabledModels: ['openai/known'] }))
    expect(await readPiModels(host, LAYOUT)).toEqual([{ id: 'known', provider: 'openai' }])

    host.write(LAYOUT.modelsPath, '{}')
    host.write(LAYOUT.settingsPath, '42')
    expect(await readPiModels(host, LAYOUT)).toEqual([])
  })

  it('matches exact ids and provider references, thinking suffixes, and glob syntax', () => {
    const providerModel: AgentModel = { id: 'gpt-5', provider: 'openai' }
    const plainModel: AgentModel = { id: 'gpt-5' }
    const taggedModel: AgentModel = { id: 'model:7b', provider: 'local' }
    const dottedModel: AgentModel = { id: 'a.b', provider: 'local' }
    const classModel: AgentModel = { id: 'model-b', provider: 'local' }

    expect(matchesModelPattern(' OPENAI/GPT-5:high ', providerModel)).toBe(true)
    expect(matchesModelPattern('gpt-5', providerModel)).toBe(true)
    expect(matchesModelPattern('gpt-5', plainModel)).toBe(true)
    expect(matchesModelPattern(' ', plainModel)).toBe(false)
    expect(matchesModelPattern('model:7b', taggedModel)).toBe(true)
    expect(matchesModelPattern(':high', plainModel)).toBe(false)
    expect(matchesModelPattern('openai/gpt-*', providerModel)).toBe(true)
    expect(matchesModelPattern('openai/g?t-5', providerModel)).toBe(true)
    expect(matchesModelPattern('local/model-[a-c]', classModel)).toBe(true)
    expect(matchesModelPattern('local/a.*', dottedModel)).toBe(true)
    expect(matchesModelPattern('local/model-[a-c', classModel)).toBe(false)
    expect(matchesModelPattern('other/gpt-5', providerModel)).toBe(false)
  })
})

describe('PiAdapter', () => {
  it('returns a native Pi resume command with the resolved session directory', async () => {
    const host = createFakeHost({ env: { PATH: '' } })
    const adapter = createPiAdapter(host, { homeDir: LAYOUT.agentDir })
    await expect(adapter.nativeLaunchCommand('session-a')).resolves.toEqual([
      'pi', '--session-dir', LAYOUT.defaultSessionsRoot, '--session', 'session-a',
    ])
  })

  it('returns no native MCP server when Pi has no matching declaration', async () => {
    const adapter = createPiAdapter(createFakeHost(), { homeDir: LAYOUT.agentDir })
    await expect(adapter.resolveMcpServer({ serverName: 'docs', cwd: CWD })).resolves.toBeUndefined()
  })

  it('describes a configured binary once and caches the versioned descriptor', async () => {
    const host = createFakeHost({ files: { '/opt/pi/bin/pi': 'binary' }, env: { PATH: '/usr/bin' } })
    host.queue(() => processWith(['pi 1.2.0']))
    const adapter = createPiAdapter(host, { binaryPath: '/opt/pi/bin/pi', homeDir: LAYOUT.agentDir })
    expect(adapter.id).toBe(PI_ID)
    const descriptor = await adapter.describe()
    expect(descriptor).toMatchObject({
      id: PI_ID,
      displayName: PI_DISPLAY_NAME,
      summary: PI_SUMMARY,
      detection: { installed: true, binaryPath: '/opt/pi/bin/pi', source: 'config', version: 'pi 1.2.0' },
      transports: PI_TRANSPORTS,
      capabilities: PI_CAPABILITIES,
      environmentKeys: PI_RUN_ENVIRONMENT_KEYS,
    })
    expect(await adapter.describe()).toBe(descriptor)
    expect(host.spawns).toHaveLength(1)
  })

  it('delegates session, transcript, auth, model, and native-task reads to the host adapters', async () => {
    const host = createFakeHost({
      env: { PATH: '' },
      files: {
        [SESSION_PATH]: SESSION_FILE,
        [LAYOUT.modelsPath]: json({ providers: { openai: { models: [{ id: 'gpt-5', name: 'GPT-5' }] } } }),
        [LAYOUT.settingsPath]: json({ defaultModel: 'gpt-5', defaultProvider: 'openai' }),
        [LAYOUT.credentialPath]: json({ openai: { type: 'api_key', key: 'sk-secret' } }),
      },
    })
    const adapter = createPiAdapter(host, { homeDir: LAYOUT.agentDir })
    expect((await adapter.describe()).detection.installed).toBe(false)
    const sessions = await adapter.listSessions({ limit: 1 })
    const session = sessions[0]
    if (session === undefined) expect.unreachable('the session fixture must be listed')
    expect(session.nativeId).toBe('session-a')
    expect(await adapter.readTranscript({ session, maxMessages: 1, maxBytes: 64 * 1024 })).toMatchObject({
      key: session.key,
      messages: [{ role: 'assistant', text: 'answer' }],
    })
    expect(await adapter.readTranscript({ session })).toMatchObject({ key: session.key, totalMessages: 2 })
    expect(await adapter.readNativeTasks({ session })).toEqual({ available: false, todos: [], notes: [] })
    await expect(adapter.listModels()).resolves.toEqual([{ id: 'gpt-5', displayName: 'GPT-5', provider: 'openai' }])
    await expect(adapter.readAuthState()).resolves.toMatchObject({ status: 'authenticated', source: 'file' })
    await expect(adapter.login({ flow: 'interactive' })).resolves.toMatchObject({ ok: false, action: 'login' })
    await expect(adapter.logout()).resolves.toMatchObject({ ok: false, action: 'logout' })

    const configuredSessions = createPiAdapter(host, { homeDir: LAYOUT.agentDir, sessionDir: '/custom/sessions' })
    await expect(configuredSessions.listModels()).resolves.toHaveLength(1)
    const noBinaryRun = createPiAdapter(host).startRun({ prompt: 'hello', cwd: CWD })
    await expect(noBinaryRun.result).resolves.toMatchObject({ status: 'failed', error: { code: 'detection/not-found' } })
  })

  it('resolves and dispatches a run through the injected host', async () => {
    const host = createFakeHost({ files: { '/usr/bin/pi': 'binary' }, env: { PATH: '' } })
    host.queue(() => processWith([
      json({ type: 'session', id: 'run-session', cwd: CWD }),
      json({ type: 'agent_settled' }),
    ]))
    const adapter = createPiAdapter(host, { binaryPath: '/usr/bin/pi', env: { FROM_CONFIG: 'yes' }, runMode: 'headless-exec' })
    const run = adapter.startRun({ prompt: 'run now', cwd: CWD, env: { FROM_REQUEST: 'yes' } } satisfies AgentRunRequest)
    expect(await run.result).toMatchObject({ status: 'succeeded', nativeSessionKey: 'pi:run-session' })
    expect(host.spawns[0]?.spec.env).toMatchObject({ FROM_CONFIG: 'yes', FROM_REQUEST: 'yes' })
  })
})

describe('Pi Cordis plugin', () => {
  it('registers one adapter using both defaulted and explicit config values', () => {
    const configs: readonly PiConfig[] = [{}, {
      binaryPath: '/opt/pi/bin/pi',
      homeDir: '/home/tester/custom-agent',
      sessionDir: '/home/tester/custom-sessions',
      env: { PI_CODING_AGENT_DIR: '/configured/agent' },
      runMode: 'headless-exec',
      interruptGraceMs: 1_000,
    }]
    for (const config of configs) {
      const ctx = new Context()
      const registered: AgentAdapter[] = []
      const llmProviders: string[][] = []
      ctx.provide('agentMesh', {
        register: (adapter: AgentAdapter) => {
          registered.push(adapter)
          return () => {}
        },
      })
      ctx.provide('llm', {
        registerAdapter: (providers: readonly string[]) => {
          llmProviders.push([...providers])
          return () => undefined
        },
      } as never)
      apply(ctx, config)
      expect(registered).toHaveLength(1)
      expect(registered[0]?.id).toBe(PI_ID)
      expect(llmProviders).toEqual([['agent-pi']])
    }
  })

  it('reports an unavailable native model route for configured and default store paths', async () => {
    const modelsPath = '/opt/pi/agent/models.json'
    const content = json({ providers: { custom: { api: 'not-a-supported-api', models: [{ id: 'model' }] } } })
    const bytes = Buffer.from(content)
    const configs = [
      { homeDir: '/opt/pi/agent', sessionDir: '/opt/pi/sessions' },
      { env: { PI_CODING_AGENT_DIR: '/opt/pi/agent' } },
    ]

    for (const config of configs) {
      const ctx = new Context()
      let llmAdapter: { listModels(provider: string): Promise<readonly unknown[]> } | undefined
      ctx.provide('agentMesh', { register: () => () => undefined } as never)
      ctx.provide('fs', {
        resolve: async (path: string) => path,
        stat: async (path: string) => path === modelsPath ? { type: 'file', size: bytes.length } : undefined,
        readByteRange: async (_path: string, range: { offset: number; length: number }) =>
          bytes.subarray(range.offset, range.offset + range.length),
      } as never)
      ctx.provide('llm', {
        registerAdapter: (_providers: readonly string[], adapter: { listModels(provider: string): Promise<readonly unknown[]> }) => {
          llmAdapter = adapter
          return () => undefined
        },
      } as never)

      apply(ctx, config)
      if (llmAdapter === undefined) expect.unreachable('apply must register the native LLM adapter')
      await expect(llmAdapter.listModels('agent-pi')).resolves.toEqual([])
    }
  })
})
