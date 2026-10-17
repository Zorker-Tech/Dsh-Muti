import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  AgentAdapter,
  AgentAuthOperationResult,
  AgentAuthState,
  AgentDescriptor,
  AgentId,
  AgentNativeTasks,
  AgentRunId,
  AgentSession,
  AgentSessionKey,
  AgentTranscript,
} from '@deepseek-ai/dsh-agent-mesh'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { AgentMeshController } from '../src/index.ts'
import { nativeLaunchShell } from '../src/native-launch-shell.ts'

const id = (value: string): AgentId => brandString<AgentId>(value)
const sessionKey = (value: string): AgentSessionKey => brandString<AgentSessionKey>(value)
const runId = (value: string): AgentRunId => brandString<AgentRunId>(value)
type SessionListRequest = Parameters<AgentAdapter['listSessions']>[0]
type TranscriptRequest = Parameters<AgentAdapter['readTranscript']>[0]
const sessionRequests = new WeakMap<AgentAdapter, SessionListRequest[]>()
const transcriptRequests = new WeakMap<AgentAdapter, TranscriptRequest[]>()
const launchCommandCalls = new WeakMap<AgentAdapter, string[]>()
const runCalls = new WeakMap<AgentAdapter, unknown[]>()

describe('native launch shell selection', () => {
  it('uses PowerShell on Windows and POSIX quoting elsewhere', () => {
    expect(nativeLaunchShell('win32')).toBe('powershell')
    expect(nativeLaunchShell('darwin')).toBe('posix')
  })
})

const authState: AgentAuthState = { status: 'authenticated', source: 'file', method: 'oauth' }
const operation: AgentAuthOperationResult = {
  ok: true,
  action: 'login',
  state: authState,
  instructions: 'complete sign-in',
  output: 'redacted',
}

const session: AgentSession = {
  key: sessionKey('codex:sess-1'),
  agentId: id('codex'),
  nativeId: 'sess-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  status: 'idle',
  notes: ['projected'],
}

const descriptor: AgentDescriptor = {
  id: id('codex'),
  displayName: 'Codex CLI',
  summary: 'A test agent.',
  capabilities: {
    runModes: ['headless-exec'],
    streaming: true,
    resume: true,
    interrupt: false,
    listSessions: true,
    readTranscript: true,
    nativeTodos: true,
    nativePlan: true,
    listModels: true,
    sandboxProfiles: [],
    approvalModes: [],
    credentials: { status: true, login: ['api-key'], logout: true },
  },
  detection: { installed: true, binaryPath: '/bin/codex', source: 'path', version: '1.0' },
  transports: [{ mode: 'headless-exec', mechanism: 'codex exec', available: true }],
  sessionRoot: '/home/tester/.codex/sessions',
  credentialPath: '/home/tester/.codex/auth.json',
  environmentKeys: [],
}

function makeAdapter(agentId: AgentId, options: {
  readonly descriptor?: AgentDescriptor
  readonly sessions?: readonly AgentSession[]
  readonly transcript?: AgentTranscript
} = {}): AgentAdapter {
  const listedSessions: SessionListRequest[] = []
  const readTranscripts: TranscriptRequest[] = []
  const launchCommands: string[] = []
  const startedRuns: unknown[] = []
  const adapter: AgentAdapter = {
    id: agentId,
    describe: async () => options.descriptor ?? { ...descriptor, id: agentId },
    readAuthState: async () => authState,
    listSessions: vi.fn(async (request: SessionListRequest) => {
      listedSessions.push(request)
      return options.sessions ?? [session]
    }),
    nativeLaunchCommand: vi.fn(async (nativeId: string) => {
      launchCommands.push(nativeId)
      return ['/bin/codex', 'resume', nativeId]
    }),
    readTranscript: vi.fn(async (request: Parameters<AgentAdapter['readTranscript']>[0]) => {
      readTranscripts.push(request)
      const transcript = options.transcript ?? {
        key: request.session.key,
        messages: [],
        totalMessages: 0,
        hasMore: false,
        notes: [],
      }
      if (request.maxMessages !== undefined) return transcript
      return {
        key: transcript.key,
        messages: transcript.messages,
        hasMore: transcript.hasMore,
        notes: transcript.notes,
      }
    }),
    readNativeTasks: async (): Promise<AgentNativeTasks> => ({ available: true, todos: [], notes: [] }),
    listModels: async () => [],
    readCapabilities: async () => ({
      agentId, tools: [], skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-01-01T00:00:00.000Z',
    }),
    resolveMcpServer: async () => undefined,
    startRun: vi.fn((request) => {
      startedRuns.push(request)
      throw new Error('run dispatch is owned by the mesh')
    }),
    login: vi.fn(async (_request: Parameters<AgentAdapter['login']>[0]) => operation),
    logout: async () => ({ ...operation, action: 'logout' }),
  }
  sessionRequests.set(adapter, listedSessions)
  transcriptRequests.set(adapter, readTranscripts)
  launchCommandCalls.set(adapter, launchCommands)
  runCalls.set(adapter, startedRuns)
  return adapter
}

function mount(
  options: { readonly agentAccess?: boolean } = {},
): { readonly controller: AgentMeshController; readonly adapters: ReadonlyMap<AgentId, AgentAdapter> } {
  const ctx = new Context()
  ctx.provide('typert', { resources: { register: vi.fn() } } as never)
  ctx.provide('remoteAccess', { allows: () => options.agentAccess ?? true } as never)
  const secondId = id('pi')
  const first = makeAdapter(id('codex'), {
    sessions: [session, {
      ...session,
      key: sessionKey('codex:sess-2'),
      nativeId: 'sess-2',
      title: 'Second session',
      cwd: '/repo',
      model: 'o3',
      messageCount: 2,
    }],
    transcript: {
      key: session.key,
      messages: [{ index: 0, role: 'assistant', kind: 'assistant', text: 'done' }],
      totalMessages: 1,
      hasMore: false,
      notes: ['truncated native field'],
    },
  })
  const { sessionRoot, credentialPath, ...descriptorWithoutPaths } = descriptor
  void sessionRoot
  void credentialPath
  const secondDescriptor: AgentDescriptor = {
    ...descriptorWithoutPaths,
    id: secondId,
    displayName: 'Pi',
    capabilities: {
      ...descriptor.capabilities,
      credentials: { status: true, login: ['interactive'], logout: false },
    },
    detection: { installed: false, source: 'none', reason: 'not found' },
  }
  const second = makeAdapter(secondId, { descriptor: secondDescriptor })
  const adapters = new Map([[first.id, first], [second.id, second]])
  const mesh = {
    ids: [first.id, second.id],
    diagnostics: async () => ({
      bindingsReady: true,
      agents: [
        {
          id: first.id,
          displayName: undefined,
          detection: { installed: true, source: 'path', version: '1.0', binaryPath: '/bin/codex' },
          sessionRoot: '/sessions',
          credentialPath: '/auth.json',
          warnings: ['one warning'],
        },
        { id: second.id, detection: { installed: false, source: 'none', reason: 'not found' }, warnings: [] },
        { id: id('unknown'), warnings: [] },
      ],
    }),
    adapter: (agentId: AgentId) => {
      if (agentId === id('non-error')) throw 42
      const found = adapters.get(agentId)
      if (found === undefined) throw new Error(`agent "${agentId}" is not registered`)
      return found
    },
    readCapabilities: (agentId: AgentId, request: Parameters<AgentAdapter['readCapabilities']>[0]) => {
      const found = adapters.get(agentId)
      if (found === undefined) throw new Error(`agent "${agentId}" is not registered`)
      return found.readCapabilities(request)
    },
    sessionMark: () => undefined,
    pinSession: vi.fn(async () => undefined),
    archiveSession: vi.fn(async () => undefined),
    clearSessionDisposition: vi.fn(async () => true),
    bindings: () => [{ sessionId: 'harness-1', agentId: first.id, boundAt: '2026-01-01T00:00:00.000Z' }],
    bind: vi.fn(async () => undefined),
    unbind: vi.fn(async () => true),
    startRun: vi.fn(() => ({ runId: runId('run-1') })),
    runs: [
      {
        runId: 'run-1', agentId: first.id, cwd: '/repo', prompt: 'work', status: 'succeeded',
        startedAt: '2026-01-01T00:00:00.000Z', notes: [], events: [], eventCount: 0,
      },
      {
        runId: 'run-2', agentId: second.id, cwd: '/repo', prompt: 'more work', status: 'failed',
        startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z',
        finalText: 'partial', error: { code: 'failed', message: 'failed' }, notes: ['note'], events: [], eventCount: 1,
      },
    ],
    cancelRun: vi.fn(() => false),
  }
  ctx.provide('agentMesh', mesh as never)
  return { controller: new AgentMeshController(ctx), adapters }
}

describe('AgentMeshController', () => {
  it('injects the mesh service into the controller fiber', async () => {
    const ctx = new Context()
    ctx.provide('typert', { resources: { register: vi.fn() } } as never)
    ctx.provide('remoteAccess', { allows: () => true } as never)
    ctx.provide('agentMesh', {
      diagnostics: async () => ({ bindingsReady: true, agents: [] }),
    } as never)

    const fiber = ctx.plugin(AgentMeshController)
    await fiber.await()
    await expect(fiber.ctx.agentMeshController.remoteExportAgents(new AbortController().signal)).resolves.toEqual([])
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('projects diagnostics with and without optional agent fields', async () => {
    const { controller } = mount()
    expect(await controller.remoteExportAgents(new AbortController().signal)).toEqual([
      {
        agentId: 'codex', displayName: 'codex', installed: true, version: '1.0', binaryPath: '/bin/codex',
        sessionRoot: '/sessions', credentialPath: '/auth.json', warnings: ['one warning'],
      },
      { agentId: 'pi', displayName: 'pi', installed: false, detectionReason: 'not found', warnings: [] },
      { agentId: 'unknown', displayName: 'unknown', installed: false, warnings: [] },
    ])
  })

  it('forwards session filters and omits missing session fields', async () => {
    const { controller, adapters } = mount()
    const signal = new AbortController().signal
    const minimal = await controller.remoteExportSessions({ agentId: 'codex' }, signal)
    expect(minimal[0]).toEqual({
      key: session.key, agentId: 'codex', nativeId: 'sess-1', title: '', createdAt: session.createdAt,
      updatedAt: session.updatedAt, status: 'idle', notes: ['projected'],
      pinned: false, archived: false,
    })
    const full = await controller.remoteExportSessions({ agentId: 'codex', cwd: '/repo', limit: 1 }, signal)
    expect(full[1]).toMatchObject({ title: 'Second session', cwd: '/repo', model: 'o3', messageCount: 2 })
    const adapter = adapters.get(id('codex'))
    if (adapter === undefined) throw new Error('the Codex adapter was not mounted')
    expect(sessionRequests.get(adapter)).toContainEqual({ cwd: '/repo', limit: 1, signal })
  })

  it('returns a native resume command for an exact existing session without starting it', async () => {
    const { controller, adapters } = mount()
    const adapter = adapters.get(id('codex'))
    if (adapter === undefined) throw new Error('the Codex adapter was not mounted')
    const signal = new AbortController().signal

    await expect(controller.remoteExportLaunchCommand({ agentId: 'codex', sessionId: 'sess-1' }, signal))
      .resolves.toEqual({
        argv: ['/bin/codex', 'resume', 'sess-1'],
        shell: process.platform === 'win32' ? 'powershell' : 'posix',
      })
    expect(launchCommandCalls.get(adapter)).toEqual(['sess-1'])
    expect(runCalls.get(adapter)).toEqual([])
  })

  it('rejects a native launch command for a missing session and an aborted request', async () => {
    const { controller } = mount()
    await expect(controller.remoteExportLaunchCommand(
      { agentId: 'codex', sessionId: 'missing' }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'agent-mesh/unknown-session' })
    const aborted = new AbortController()
    aborted.abort(new Error('closed'))
    await expect(controller.remoteExportLaunchCommand(
      { agentId: 'codex', sessionId: 'sess-1' }, aborted.signal,
    )).rejects.toThrow('closed')
  })

  it('reports an adapter that cannot provide a native launch command', async () => {
    const { controller, adapters } = mount()
    const adapter = adapters.get(id('codex'))
    if (adapter === undefined) throw new Error('the Codex adapter was not mounted')
    delete adapter.nativeLaunchCommand
    await expect(controller.remoteExportLaunchCommand(
      { agentId: 'codex', sessionId: 'sess-1' }, new AbortController().signal,
    )).resolves.toBeNull()
  })

  it('does not list agent sessions when the caller lacks agent access', async () => {
    const { controller, adapters } = mount({ agentAccess: false })
    await expect(controller.remoteExportSessions({ agentId: 'codex' }, new AbortController().signal)).resolves.toEqual([])
    const adapter = adapters.get(id('codex'))
    if (adapter === undefined) throw new Error('the Codex adapter was not mounted')
    expect(sessionRequests.get(adapter)).toEqual([])
  })

  it('forwards pin, unpin, archive, and restore for source-owned session rows', async () => {
    const { controller } = mount()
    const signal = new AbortController().signal
    const request = { agentId: 'codex', sessionId: 'sess-1' }

    await expect(controller.remotePinSession(request, signal)).resolves.toBeUndefined()
    await expect(controller.remoteUnpinSession(request, signal)).resolves.toBeUndefined()
    await expect(controller.remoteArchiveSession(request, signal)).resolves.toBeUndefined()
    await expect(controller.remoteUnarchiveSession(request, signal)).resolves.toBeUndefined()
  })

  it('projects transcript windows and resolves native tasks by session id', async () => {
    const { controller, adapters } = mount()
    const signal = new AbortController().signal
    expect(await controller.remoteExportTranscript({ agentId: 'codex', sessionId: 'sess-1', maxMessages: 4 }, signal)).toEqual({
      key: session.key,
      messages: [{ index: 0, role: 'assistant', kind: 'assistant', text: 'done' }],
      totalMessages: 1,
      hasMore: false,
      notes: ['truncated native field'],
    })
    const adapter = adapters.get(id('codex'))
    if (adapter === undefined) throw new Error('the Codex adapter was not mounted')
    expect(transcriptRequests.get(adapter)).toContainEqual({ session, maxMessages: 4 })
    expect(await controller.remoteExportTranscript({ agentId: 'codex', sessionId: 'sess-1' }, signal)).toMatchObject({
      key: session.key,
      hasMore: false,
      notes: ['truncated native field'],
    })
    expect(await controller.remoteExportTasks({ agentId: 'codex', sessionId: 'sess-1' }, signal)).toEqual({
      available: true, todos: [], notes: [],
    })
  })

  it('forwards capability reads with project cwd and denies excluded agents', async () => {
    const { controller, adapters } = mount()
    const adapter = adapters.get(id('codex'))
    if (adapter === undefined) throw new Error('the Codex adapter was not mounted')
    const read = vi.spyOn(adapter, 'readCapabilities')
    const signal = new AbortController().signal
    await expect(controller.remoteExportCapabilities({ agentId: 'codex', cwd: '/repo' }, signal)).resolves.toMatchObject({
      agentId: 'codex', tools: [], skills: [], mcpServers: [], commands: [], contextFiles: [],
    })
    expect(read).toHaveBeenCalledWith({ cwd: '/repo', signal })
    await expect(controller.remoteExportCapabilities({ agentId: 'codex' }, signal)).resolves.toMatchObject({ agentId: 'codex' })
    expect(read).toHaveBeenNthCalledWith(2, { signal })
    const excluded = mount({ agentAccess: false })
    await expect(excluded.controller.remoteExportCapabilities({ agentId: 'codex' }, signal)).resolves.toBeNull()
    const aborted = new AbortController()
    aborted.abort(new Error('capability read cancelled'))
    await expect(controller.remoteExportCapabilities({ agentId: 'codex' }, aborted.signal)).rejects.toThrow('capability read cancelled')
  })

  it('reports unknown sessions with their wire details', async () => {
    const { controller } = mount()
    const expected: Partial<RemoteError> = {
      code: 'agent-mesh/unknown-session',
      details: { agentId: 'codex', sessionId: 'missing' },
    }
    await expect(controller.remoteExportTasks({ agentId: 'codex', sessionId: 'missing' }, new AbortController().signal))
      .rejects.toMatchObject(expected)
  })

  it('projects all or one credential row and forwards login and logout', async () => {
    const { controller, adapters } = mount()
    const signal = new AbortController().signal
    expect(await controller.remoteExportCredentials(null, signal)).toEqual([
      { agentId: 'codex', displayName: 'Codex CLI', state: authState, loginFlows: ['api-key'], canLogout: true },
      { agentId: 'pi', displayName: 'Pi', state: authState, loginFlows: ['interactive'], canLogout: false },
    ])
    expect(await controller.remoteExportCredentials('codex', signal)).toEqual([
      { agentId: 'codex', displayName: 'Codex CLI', state: authState, loginFlows: ['api-key'], canLogout: true },
    ])
    expect(await controller.remoteExportLogin({ agentId: 'codex', flow: 'api-key' }, signal)).toEqual(operation)
    expect(await controller.remoteExportLogin({ agentId: 'codex', flow: 'api-key', secret: 'secret' }, signal)).toEqual(operation)
    const codex = adapters.get(id('codex'))
    if (codex === undefined) throw new Error('the Codex adapter was not mounted')
    expect(codex.login).toHaveBeenLastCalledWith({ flow: 'api-key', secret: 'secret' })
    expect(await controller.remoteExportLogout('codex', signal)).toMatchObject({ action: 'logout' })
  })

  it('forwards binding and run operations, including optional run fields', async () => {
    const { controller } = mount()
    const signal = new AbortController().signal
    await expect(controller.remoteExportBind('harness-1', 'codex', signal)).resolves.toBeUndefined()
    expect(await controller.remoteExportUnbind('harness-1', signal)).toBe(true)
    expect(await controller.remoteExportBindings(signal)).toEqual([
      { sessionId: 'harness-1', agentId: 'codex', boundAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(await controller.remoteExportRunStart({ agentId: 'codex', prompt: 'work', cwd: '/repo' }, signal)).toEqual({ runId: 'run-1', agentId: 'codex' })
    await controller.remoteExportRunStart({
      agentId: 'pi', prompt: 'more work', cwd: '/repo', model: 'sonnet', approval: 'manual', resumeNativeId: 'sess-1', timeoutMs: 1000,
    }, signal)
    expect(await controller.remoteExportRuns(signal)).toEqual([
      {
        runId: 'run-1', agentId: 'codex', cwd: '/repo', prompt: 'work', status: 'succeeded',
        startedAt: '2026-01-01T00:00:00.000Z', notes: [], events: [], eventCount: 0,
      },
      {
        runId: 'run-2', agentId: 'pi', cwd: '/repo', prompt: 'more work', status: 'failed',
        startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z',
        finalText: 'partial', error: { code: 'failed', message: 'failed' }, notes: ['note'], events: [], eventCount: 1,
      },
    ])
    expect(await controller.remoteExportRunCancel('run-1', signal)).toBe(false)
  })

  it('maps unknown agents and propagates carrier cancellation', async () => {
    const { controller } = mount()
    await expect(controller.remoteExportSessions({ agentId: 'absent' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'agent-mesh/unknown-agent', details: { agentId: 'absent' } })
    await expect(controller.remoteExportSessions({ agentId: 'non-error' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'agent-mesh/unknown-agent', message: '42' })
    const aborted = new AbortController()
    aborted.abort(new Error('carrier stopped'))
    await expect(controller.remoteExportAgents(aborted.signal)).rejects.toThrow('carrier stopped')
  })
})
