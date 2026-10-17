import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import AgentMesh, { AgentMeshError } from '../src/index.ts'
import type {
  AgentAdapter, AgentAuthState, AgentDescriptor, AgentId, AgentMcpServerConfig,
  AgentRunEvent, AgentRunId, AgentSession, AgentSessionKey,
} from '../src/types.ts'

const roots: string[] = []
const fibers: Fiber[] = []

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Mount the storage stack and the mesh on a fresh context backed by a scratch root. */
async function mount(existingRoot?: string): Promise<{ ctx: Context; root: string }> {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'dsh-agent-mesh-'))
  if (!roots.includes(root)) roots.push(root)
  const ctx = new Context()
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(root, '.storage') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  fibers.push(await ctx.plugin(AgentMesh))
  return { ctx, root }
}

const sessionId = (value: string): SessionId => brandString<SessionId>(value)
const agentId = (value: string): AgentId => brandString<AgentId>(value)

const externalSession = (id: string, nativeId: string, updatedAt: string): AgentSession => ({
  key: brandString<AgentSessionKey>(`${id}:${nativeId}`),
  agentId: agentId(id),
  nativeId,
  createdAt: updatedAt,
  updatedAt,
  status: 'idle',
  notes: [],
})

const authState: AgentAuthState = { status: 'authenticated', source: 'file' }

const descriptorFor = (id: string): AgentDescriptor => ({
  id: agentId(id),
  displayName: id,
  summary: `${id} test agent`,
  capabilities: {
    runModes: ['headless-exec'],
    streaming: true,
    resume: false,
    interrupt: false,
    listSessions: true,
    readTranscript: true,
    nativeTodos: false,
    nativePlan: false,
    listModels: false,
    sandboxProfiles: [],
    approvalModes: [],
    credentials: { status: true, login: [], logout: false },
  },
  detection: { installed: true, binaryPath: `/usr/bin/${id}`, source: 'path', version: '1.0.0' },
  transports: [{ mode: 'headless-exec', mechanism: `${id} exec`, available: true }],
  environmentKeys: [],
})

/** An adapter that answers every read with an empty, well-formed result. */
function fakeAdapter(id: string, describe: () => Promise<AgentDescriptor> = async () => descriptorFor(id)): AgentAdapter {
  return {
    id: agentId(id),
    describe,
    readAuthState: async () => authState,
    listSessions: async () => [],
    nativeLaunchCommand: async nativeId => [id, 'resume', nativeId],
    readTranscript: async request => ({ key: request.session.key, messages: [], hasMore: false, notes: [] }),
    readNativeTasks: async () => ({ available: false, todos: [], notes: [] }),
    listModels: async () => [],
    readCapabilities: async () => ({
      agentId: agentId(id), tools: [], skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    }),
    resolveMcpServer: async () => undefined,
    login: async () => ({ ok: false, action: 'login', state: authState }),
    logout: async () => ({ ok: false, action: 'logout', state: authState }),
    startRun: () => {
      throw new Error('not used in these tests')
    },
  }
}

describe('agent mesh registry', () => {
  it('registers adapters as effects and removes them on dispose', async () => {
    const { ctx } = await mount()
    const dispose = ctx.agentMesh.register(fakeAdapter('codex'))
    expect(ctx.agentMesh.ids).toEqual([agentId('codex')])

    dispose()
    expect(ctx.agentMesh.ids).toEqual([])

    const replacement = fakeAdapter('codex')
    const staleDispose = ctx.agentMesh.register(fakeAdapter('codex'))
    staleDispose()
    ctx.agentMesh.register(replacement)
    staleDispose()
    expect(ctx.agentMesh.adapter('codex')).toBe(replacement)
  })

  it('refuses a duplicate agent id', async () => {
    const { ctx } = await mount()
    ctx.agentMesh.register(fakeAdapter('codex'))
    expect(() => ctx.agentMesh.register(fakeAdapter('codex'))).toThrow(AgentMeshError)
    expect(() => ctx.agentMesh.register(fakeAdapter('codex'))).toThrow(/already registered/)
  })

  it('refuses to resolve an agent that has no adapter', async () => {
    const { ctx } = await mount()
    try {
      ctx.agentMesh.adapter('grok')
      expect.unreachable('adapter() should have thrown')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AgentMeshError)
      expect((error as AgentMeshError).code).toBe('mesh/agent-not-registered')
      expect((error as AgentMeshError).remediation).toBeDefined()
    }
  })

  it('describes every registered adapter in registration order', async () => {
    const { ctx } = await mount()
    ctx.agentMesh.register(fakeAdapter('codex'))
    ctx.agentMesh.register(fakeAdapter('pi'))
    expect((await ctx.agentMesh.describe()).map(entry => entry.id)).toEqual([agentId('codex'), agentId('pi')])
  })

  it('resolves native MCP configuration through the owning adapter without connecting', async () => {
    const { ctx } = await mount()
    const config: AgentMcpServerConfig = {
      name: 'docs', source: 'project', transport: 'stdio', command: 'docs-mcp', args: [], env: {}, cwd: '/repo',
    }
    const resolve = vi.fn(async () => config)
    ctx.agentMesh.register({ ...fakeAdapter('codex'), resolveMcpServer: resolve })

    await expect(ctx.agentMesh.resolveMcpServer('codex', { serverName: 'docs', cwd: '/repo' })).resolves.toBe(config)
    expect(resolve).toHaveBeenCalledWith({ serverName: 'docs', cwd: '/repo' })
  })

  it('lists sessions across adapters in activity order and keeps store failures visible', async () => {
    const { ctx } = await mount()
    const older = externalSession('codex', 'older', '2026-10-15T00:00:00.000Z')
    const newer = externalSession('pi', 'newer', '2026-10-16T00:00:00.000Z')
    ctx.agentMesh.register({
      ...fakeAdapter('codex'),
      listSessions: async () => [older],
    })
    ctx.agentMesh.register({
      ...fakeAdapter('pi'),
      listSessions: async () => [newer],
    })
    ctx.agentMesh.register({
      ...fakeAdapter('grok'),
      listSessions: async () => { throw new Error('store is unreadable') },
    })
    ctx.agentMesh.register({
      ...fakeAdapter('omp'),
      listSessions: async () => { throw 'invalid session record' },
    })

    await expect(ctx.agentMesh.listSessions()).resolves.toEqual({
      items: [newer, older],
      failures: [
        { agentId: agentId('grok'), message: 'store is unreadable' },
        { agentId: agentId('omp'), message: 'invalid session record' },
      ],
    })
  })

  it('persists pin and archive marks for exact external session identities', async () => {
    const { ctx, root } = await mount()
    const session = externalSession('codex', 'native-1', '2026-10-16T00:00:00.000Z')
    const secondSession = externalSession('codex', 'native-2', '2026-10-16T00:00:01.000Z')
    ctx.agentMesh.register({ ...fakeAdapter('codex'), listSessions: async () => [session, secondSession] })
    const reference = { agentId: session.agentId, nativeId: session.nativeId }
    const secondReference = { agentId: secondSession.agentId, nativeId: secondSession.nativeId }

    expect(ctx.agentMesh.sessionMark(reference)).toBeUndefined()
    await ctx.agentMesh.pinSession(reference)
    await ctx.agentMesh.pinSession(secondReference)
    expect(ctx.agentMesh.sessionMark(reference)).toMatchObject({
      key: session.key,
      disposition: 'pinned',
      nativeId: 'native-1',
    })
    await ctx.agentMesh.archiveSession(reference)
    expect(ctx.agentMesh.sessionMarks()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: session.key, disposition: 'archived' }),
      expect.objectContaining({ key: secondSession.key, disposition: 'pinned' }),
    ]))
    await expect(ctx.agentMesh.clearSessionDisposition(reference, 'pinned')).resolves.toBe(false)

    const previousFibers = fibers.splice(0).reverse()
    for (const fiber of previousFibers) await fiber.dispose()
    const reopened = await mount(root)
    expect(reopened.ctx.agentMesh.sessionMark(reference)).toMatchObject({
      key: session.key,
      disposition: 'archived',
    })
    await expect(reopened.ctx.agentMesh.clearSessionDisposition(reference, 'archived')).resolves.toBe(true)
    await expect(reopened.ctx.agentMesh.clearSessionDisposition(secondReference, 'pinned')).resolves.toBe(true)
    expect(reopened.ctx.agentMesh.sessionMarks()).toEqual([])
  })

  it('rejects mark reads before the service opens its storage domain', () => {
    const mesh = new AgentMesh(new Context())
    expect(() => mesh.sessionMarks()).toThrow('agent mesh session marks are not available before the service is ready')
  })

  it('requires an extant source-owned session before pinning or archiving it', async () => {
    const { ctx } = await mount()
    ctx.agentMesh.register(fakeAdapter('codex'))
    const reference = { agentId: agentId('codex'), nativeId: 'missing' }

    await expect(ctx.agentMesh.pinSession(reference)).rejects.toMatchObject({ code: 'mesh/session-not-found' })
    await expect(ctx.agentMesh.archiveSession(reference)).rejects.toMatchObject({ code: 'mesh/session-not-found' })
    expect(ctx.agentMesh.sessionMarks()).toEqual([])
  })

  it('returns an empty catalog when no adapters are registered', async () => {
    const { ctx } = await mount()
    await expect(ctx.agentMesh.listSessions()).resolves.toEqual({ items: [], failures: [] })
  })

  it('propagates cancellation before adapter reads and after a read settles', async () => {
    const { ctx } = await mount()
    const beforeRead = new AbortController()
    beforeRead.abort(new Error('cancelled before read'))
    await expect(ctx.agentMesh.listSessions({ signal: beforeRead.signal })).rejects.toThrow('cancelled before read')

    const duringRead = new AbortController()
    ctx.agentMesh.register({
      ...fakeAdapter('codex'),
      listSessions: async () => {
        duringRead.abort(new Error('cancelled during read'))
        return []
      },
    })
    await expect(ctx.agentMesh.listSessions({ signal: duringRead.signal })).rejects.toThrow('cancelled during read')
  })
})

describe('agent mesh diagnostics', () => {
  it('reports an installed agent without warnings', async () => {
    const { ctx } = await mount()
    ctx.agentMesh.register(fakeAdapter('codex'))
    const report = await ctx.agentMesh.diagnostics()
    expect(report.bindingsReady).toBe(true)
    expect(report.agents).toEqual([
      {
        id: agentId('codex'),
        displayName: 'codex',
        detection: { installed: true, binaryPath: '/usr/bin/codex', source: 'path', version: '1.0.0' },
        capabilities: descriptorFor('codex').capabilities,
        warnings: [],
      },
    ])
  })

  it('turns a missing binary into that agent\'s warning, not a failure', async () => {
    const { ctx } = await mount()
    ctx.agentMesh.register(fakeAdapter('grok', async () => ({
      ...descriptorFor('grok'),
      detection: { installed: false, source: 'none', reason: '`grok` was not found on PATH or in any known install location' },
    })))
    const report = await ctx.agentMesh.diagnostics()
    expect(report.agents[0]?.warnings).toEqual(['`grok` was not found on PATH or in any known install location'])
  })

  it('uses the default detection warning and reports known store paths', async () => {
    const { ctx } = await mount()
    ctx.agentMesh.register(fakeAdapter('pi', async () => ({
      ...descriptorFor('pi'),
      detection: { installed: false, source: 'none' },
      sessionRoot: '/home/tester/.pi/sessions',
      credentialPath: '/home/tester/.pi/auth.json',
    })))
    const report = await ctx.agentMesh.diagnostics()
    expect(report.agents[0]?.warnings).toEqual(['the agent binary was not found'])
    expect(report.agents[0]).toMatchObject({
      sessionRoot: '/home/tester/.pi/sessions',
      credentialPath: '/home/tester/.pi/auth.json',
    })
  })

  it('turns a throwing adapter into a warning and still reports its peers', async () => {
    const { ctx } = await mount()
    ctx.agentMesh.register(fakeAdapter('omp', async () => {
      throw new Error('store layout unresolvable')
    }))
    ctx.agentMesh.register(fakeAdapter('codex'))
    ctx.agentMesh.register(fakeAdapter('pi', async () => {
      throw 'session root is malformed'
    }))
    const report = await ctx.agentMesh.diagnostics()
    expect(report.agents[0]?.warnings).toEqual(['the adapter could not describe this agent: store layout unresolvable'])
    expect(report.agents[0]?.displayName).toBeUndefined()
    expect(report.agents[1]?.displayName).toBe('codex')
    expect(report.agents[2]?.warnings).toEqual(['the adapter could not describe this agent: session root is malformed'])
  })
})

describe('agent mesh runs', () => {
  it('dispatches through the service, reports the run, and cancels it', async () => {
    const { ctx } = await mount()
    const runId = brandString<AgentRunId>('run-service')
    const cancelled: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const adapter: AgentAdapter = {
      ...fakeAdapter('codex'),
      startRun: () => ({
        id: runId,
        result: gate.then(() => ({
          runId,
          agentId: agentId('codex'),
          status: 'succeeded' as const,
          startedAt: '2026-10-16T00:00:00.000Z',
          finishedAt: '2026-10-16T00:00:01.000Z',
          durationMs: 1000,
          cwd: '/work',
          finalText: 'ok',
          notes: [],
        })),
        cancel: (reason) => { cancelled.push(reason ?? ''); release() },
        async *[Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
          await gate
        },
      }),
    }
    ctx.agentMesh.register(adapter)

    const handle = ctx.agentMesh.startRun('codex', { prompt: 'p', cwd: '/work' })
    expect(handle.runId).toBe('run-service')
    expect(ctx.agentMesh.runs.map(run => run.runId)).toEqual(['run-service'])
    expect(ctx.agentMesh.run('run-service')?.status).toBe('running')
    expect(ctx.agentMesh.run('missing')).toBeUndefined()

    expect(ctx.agentMesh.cancelRun('run-service', 'test')).toBe(true)
    expect(cancelled).toEqual(['test'])
    const settled = await ctx.agentMesh.waitForRun('run-service')
    expect(settled?.status).toBe('succeeded')
    expect(settled?.finalText).toBe('ok')
    expect(await ctx.agentMesh.waitForRun('missing')).toBeUndefined()
  })

  it('refuses to dispatch to an agent with no adapter', async () => {
    const { ctx } = await mount()
    expect(() => ctx.agentMesh.startRun('grok', { prompt: 'p', cwd: '/work' })).toThrow(AgentMeshError)
  })
})

describe('agent mesh failures', () => {
  it('carries a cause and a remediation when given one', () => {
    const cause = new Error('the underlying failure')
    const withOptions = new AgentMeshError('mesh/unsupported-operation', 'not supported', {
      cause,
      remediation: 'open the store first',
    })
    expect(withOptions.remediation).toBe('open the store first')
    expect(withOptions.cause).toBe(cause)
    expect(withOptions.name).toBe('AgentMeshError')

    const bare = new AgentMeshError('mesh/unsupported-operation', 'not supported')
    expect(bare.remediation).toBeUndefined()
    expect(bare.cause).toBeUndefined()
  })

  it('refuses a binding read before the store is open', () => {
    // A service that was never mounted has no storage domain, so every binding
    // operation reports the store as closed instead of reading undefined.
    const unmounted = new AgentMesh(new Context())
    expect(() => unmounted.bound(sessionId('sess-1'))).toThrow(/not open yet/)
    expect(() => unmounted.bindings()).toThrow(AgentMeshError)
  })
})

describe('agent mesh binding', () => {
  it('binds, reads, lists and clears a session binding', async () => {
    const { ctx } = await mount()
    ctx.agentMesh.register(fakeAdapter('codex'))
    const id = sessionId('sess-1')

    expect(ctx.agentMesh.bound(id)).toBeUndefined()
    await ctx.agentMesh.bind(id, agentId('codex'))
    expect(ctx.agentMesh.bound(id)).toBe(agentId('codex'))
    expect(ctx.agentMesh.bindings().map(entry => entry.sessionId)).toEqual([id])
    expect(ctx.agentMesh.bindings()[0]?.boundAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    expect(await ctx.agentMesh.unbind(id)).toBe(true)
    expect(await ctx.agentMesh.unbind(id)).toBe(false)
    expect(ctx.agentMesh.bound(id)).toBeUndefined()
  })

  it('keeps a durable binding when a binding-change observer throws', async () => {
    const { ctx } = await mount()
    ctx.agentMesh.register(fakeAdapter('codex'))
    const logger = vi.spyOn(ctx.logger, 'warn')
    const notify = vi.spyOn(ctx, 'parallel')
      .mockRejectedValueOnce(new Error('observer failed'))
      .mockRejectedValueOnce('non-Error observer failure')

    await ctx.agentMesh.bind(sessionId('error-observer'), agentId('codex'))
    expect(ctx.agentMesh.bound(sessionId('error-observer'))).toBe(agentId('codex'))
    expect(logger).toHaveBeenCalledWith('agent-mesh: binding-change observer failed: observer failed')
    await ctx.agentMesh.bind(sessionId('non-error-observer'), agentId('codex'))
    expect(ctx.agentMesh.bound(sessionId('non-error-observer'))).toBe(agentId('codex'))
    expect(logger).toHaveBeenLastCalledWith('agent-mesh: binding-change observer failed: <non-Error observer failure>')
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('refuses to bind a session to an agent that has no adapter', async () => {
    const { ctx } = await mount()
    await expect(ctx.agentMesh.bind(sessionId('sess-1'), agentId('grok'))).rejects.toBeInstanceOf(AgentMeshError)
  })

  it('keeps bindings across a restart of the mesh over the same storage root', async () => {
    const { ctx, root } = await mount()
    ctx.agentMesh.register(fakeAdapter('codex'))
    await ctx.agentMesh.bind(sessionId('sess-1'), agentId('codex'))
    for (const fiber of fibers.splice(0)) await fiber.dispose()

    const restarted = new Context()
    fibers.push(await restarted.plugin(Storage))
    fibers.push(await restarted.plugin(StorageJson, { root: join(root, '.storage') }))
    fibers.push(await restarted.plugin(StorageDomain, { backend: 'json' }))
    fibers.push(await restarted.plugin(AgentMesh))
    restarted.agentMesh.register(fakeAdapter('codex'))

    expect(restarted.agentMesh.bound(sessionId('sess-1'))).toBe(agentId('codex'))
  })
})
