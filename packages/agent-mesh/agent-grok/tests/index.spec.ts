import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentAdapter, AgentRunRequest } from '@deepseek-ai/dsh-agent-mesh'
import { apply, grokAdapter } from '../src/index.ts'
import { resolveGrokConfig } from '../src/config.ts'
import { MemoryHost } from './support/memory-host.ts'

describe('grok adapter entry points', () => {
  it('returns a native Grok resume command with the detected executable', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '/opt/tools' },
      files: { '/opt/tools/grok': '' },
      scripts: [{ stdout: ['grok 1.0.0'] }],
    })
    const adapter = grokAdapter(host, resolveGrokConfig())
    if (adapter.nativeLaunchCommand === undefined) throw new Error('Grok adapter has no native TUI launcher')
    await expect(adapter.nativeLaunchCommand('session-1'))
      .resolves.toEqual(['/opt/tools/grok', '--resume', 'session-1'])
  })

  it('uses the Grok command name when detection finds no executable', async () => {
    const adapter = grokAdapter(new MemoryHost(), resolveGrokConfig())
    if (adapter.nativeLaunchCommand === undefined) throw new Error('Grok adapter has no native TUI launcher')
    await expect(adapter.nativeLaunchCommand('session-1'))
      .resolves.toEqual(['grok', '--resume', 'session-1'])
  })

  it('registers the adapter with empty and explicit environment overlays', () => {
    const register = (): { readonly ctx: Context; readonly adapters: AgentAdapter[]; readonly llmProviders: string[][] } => {
      const ctx = new Context()
      const adapters: AgentAdapter[] = []
      const llmProviders: string[][] = []
      ctx.provide('agentMesh', {
        register(adapter: AgentAdapter) {
          adapters.push(adapter)
          return () => undefined
        },
      })
      ctx.provide('llm', {
        registerAdapter: (providers: readonly string[]) => {
          llmProviders.push([...providers])
          return () => undefined
        },
      } as never)
      return { ctx, adapters, llmProviders }
    }

    const defaultConfig = register()
    apply(defaultConfig.ctx, {})
    expect(defaultConfig.adapters.map(adapter => adapter.id)).toEqual(['grok'])
    expect(defaultConfig.llmProviders).toEqual([['agent-grok']])

    const configured = register()
    apply(configured.ctx, { env: { PATH: '/configured/bin' } })
    expect(configured.adapters.map(adapter => adapter.id)).toEqual(['grok'])
    expect(configured.llmProviders).toEqual([['agent-grok']])
  })

  it('lists no models and dispatches a run through the public adapter', async () => {
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '/opt/tools' },
      files: { '/opt/tools/grok': '' },
      scripts: [
        { stdout: ['grok 1.0.0'] },
        { stdout: [JSON.stringify({ type: 'end', sessionId: 'sess-1' })] },
      ],
    })
    const adapter = grokAdapter(host, resolveGrokConfig({ runMode: 'headless-exec' }))
    const request: AgentRunRequest = { prompt: 'hello', cwd: '/work' }

    expect(await adapter.listModels()).toEqual([])
    const result = await adapter.startRun(request).result
    expect(result.nativeSessionKey).toBe('grok:sess-1')
  })

  it('returns no native MCP server when Grok has no matching declaration', async () => {
    const adapter = grokAdapter(new MemoryHost(), resolveGrokConfig())
    await expect(adapter.resolveMcpServer({ serverName: 'docs', cwd: '/work' })).resolves.toBeUndefined()
  })

  it('dispatches the default run mode through the ACP transport', async () => {
    const adapter = grokAdapter(new MemoryHost(), resolveGrokConfig())
    await expect(adapter.startRun({ prompt: 'hello', cwd: '/work' }).result)
      .resolves.toMatchObject({ status: 'failed' })
  })

  it('reports an unavailable native model route through the Cordis logger', async () => {
    const ctx = new Context()
    const configPath = '/opt/grok/config.toml'
    const content = [
      '[model.native]',
      'model = "grok-4.6"',
      'api_backend = "responses"',
      '',
      '[model.native.extra_headers]',
      '"Invalid Header" = "value"',
    ].join('\n')
    const bytes = Buffer.from(content)
    let llmAdapter: { listModels(provider: string): Promise<readonly unknown[]> } | undefined
    ctx.provide('agentMesh', { register: () => () => undefined } as never)
    ctx.provide('fs', {
      resolve: async (path: string) => path,
      stat: async (path: string) => path === configPath ? { type: 'file', size: bytes.length } : undefined,
      readByteRange: async (_path: string, range: { offset: number; length: number }) =>
        bytes.subarray(range.offset, range.offset + range.length),
    } as never)
    ctx.provide('llm', {
      registerAdapter: (_providers: readonly string[], adapter: { listModels(provider: string): Promise<readonly unknown[]> }) => {
        llmAdapter = adapter
        return () => undefined
      },
    } as never)

    apply(ctx, { homeDir: '/opt/grok' })
    if (llmAdapter === undefined) expect.unreachable('apply must register the native LLM adapter')
    await expect(llmAdapter.listModels('agent-grok')).resolves.toEqual([])
  })
})
