import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, codexAdapter } from '../src/index.ts'
import { FakeHost } from './fake-host.ts'

describe('Cordis plugin', () => {
  it('returns a native Codex resume command without starting the CLI', async () => {
    const host = new FakeHost()
    const adapter = codexAdapter(host)
    if (adapter.nativeLaunchCommand === undefined) throw new Error('Codex adapter has no native TUI launcher')
    await expect(adapter.nativeLaunchCommand('rollout-1')).resolves.toEqual(['codex', 'resume', 'rollout-1'])
    expect(host.spawns).toEqual([])
  })

  it('returns no native MCP server when Codex has no matching declaration', async () => {
    const adapter = codexAdapter(new FakeHost(), { homeDir: '/home/tester/.codex' })
    await expect(adapter.resolveMcpServer({ serverName: 'docs', cwd: '/work' })).resolves.toBeUndefined()
  })

  it('dispatches the default run mode through the app-server transport', async () => {
    const adapter = codexAdapter(new FakeHost())
    await expect(adapter.startRun({ prompt: 'hello', cwd: '/work' }).result)
      .resolves.toMatchObject({ status: 'failed' })
  })

  it('registers the adapter through a context effect', () => {
    const ctx = new Context()
    const register = vi.fn(() => () => undefined)
    const registeredLlmProviders: (readonly string[])[] = []
    ctx.provide('agentMesh', { register } as never)
    ctx.provide('llm', {
      registerAdapter: (providers: readonly string[]) => {
        registeredLlmProviders.push(providers)
        return () => undefined
      },
    } as never)

    apply(ctx)

    expect(register).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }))
    expect(registeredLlmProviders).toEqual([['agent-codex']])
  })

  it('keeps a configured native route unavailable until its named credential exists', async () => {
    const ctx = new Context()
    const configPath = '/opt/codex/config.toml'
    const content = [
      'model = "gpt-5.4"',
      'model_provider = "custom"',
      '',
      '[model_providers.custom]',
      'base_url = "https://models.example/v1"',
      'env_key = "DSH_AGENT_MESH_CODEX_MISSING_KEY"',
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

    apply(ctx, { homeDir: '/opt/codex' })
    if (llmAdapter === undefined) expect.unreachable('apply must register the native LLM adapter')
    await expect(llmAdapter.listModels('agent-codex')).resolves.toEqual([])
  })
})
