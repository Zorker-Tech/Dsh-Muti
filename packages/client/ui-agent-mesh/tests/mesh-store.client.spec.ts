import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentAuthOperationResult, AgentCapabilityInventory, AgentId, AgentNativeTasks, AgentRunEvent, AgentRunId, AgentTodo } from '@deepseek-ai/dsh-agent-mesh/types'
import type {
  MeshAgentRow, MeshBindingRow, MeshCapabilityRequest, MeshCredentialRow, MeshLoginRequest, MeshRunRow, MeshSessionListRequest,
  MeshSessionRequest, MeshSessionRow, MeshTranscriptResponse,
} from '@deepseek-ai/dsh-agent-mesh-controller/types'
import {
  createAgentMeshStore, type AgentMeshStoreDependencies,
} from '../src/client/mesh-store.ts'

afterEach(() => { vi.useRealTimers() })

const AGENT: MeshAgentRow = {
  agentId: 'codex', displayName: 'Codex', installed: true, version: '1.2.3', warnings: [],
}
const CODEX_ID = brandString<AgentId>('codex')
const OTHER_AGENT: MeshAgentRow = {
  agentId: 'grok', displayName: 'Grok', installed: false, detectionReason: 'not on PATH', warnings: ['probe timed out'],
}
const SESSION: MeshSessionRow = {
  key: 'codex:native-1', agentId: 'codex', nativeId: 'native-1', title: 'Fix the build',
  cwd: '/workspace', createdAt: '2026-10-16T07:00:00.000Z', updatedAt: '2026-10-16T08:00:00.000Z',
  status: 'idle', messageCount: 3, notes: [], pinned: false, archived: false,
}
const TRANSCRIPT: MeshTranscriptResponse = {
  key: SESSION.key,
  messages: [{ index: 0, role: 'assistant', kind: 'assistant', text: 'done' }],
  hasMore: false,
  notes: [],
}
const TASKS: AgentNativeTasks = {
  available: true,
  todos: [{ id: 'todo-1', content: 'Run the build', status: 'pending', owner: 'codex', blockedBy: [], updatedAt: '2026-10-16T08:00:00.000Z' } satisfies AgentTodo],
  plan: { active: true, items: ['build', 'test'] },
  notes: [],
}
const CAPABILITIES: AgentCapabilityInventory = {
  agentId: CODEX_ID,
  tools: [{ name: 'read_file', source: 'builtin' }],
  skills: [{ name: 'review', source: 'user', path: '/home/tester/.codex/skills/review/SKILL.md' }],
  mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [], observedAt: '2026-10-16T08:00:00.000Z',
}
const CREDENTIALS: MeshCredentialRow[] = [
  {
    agentId: 'codex', displayName: 'Codex', state: { status: 'authenticated', source: 'file', method: 'oauth' },
    loginFlows: ['api-key'], canLogout: true,
  },
]
const BINDING: MeshBindingRow = { sessionId: 'harness-1', agentId: 'codex', boundAt: '2026-10-16T08:00:00.000Z' }
const RUN: MeshRunRow = {
  runId: 'run-1', agentId: 'codex', cwd: '/workspace', prompt: 'Fix the build', status: 'running',
  startedAt: '2026-10-16T08:00:00.000Z', notes: [], events: [], eventCount: 0,
}
/** A Remote failure in the shape the gateway folds one into. */
const failure = (message: string) =>
  ({ ok: false as const, error: new RemoteError('gateway/internal', message, {}) })

/** The Remote namespace this source reads, as the plugin adapts it. */
function remoteStub() {
  return {
    agents: vi.fn<() => Promise<RemoteResult<readonly MeshAgentRow[]>>>()
      .mockResolvedValue({ ok: true, value: [AGENT, OTHER_AGENT] }),
    sessions: vi.fn<(request: MeshSessionListRequest) => Promise<RemoteResult<readonly MeshSessionRow[]>>>()
      .mockResolvedValue({ ok: true, value: [SESSION] }),
    capabilities: vi.fn<(request: MeshCapabilityRequest) => Promise<RemoteResult<AgentCapabilityInventory | null>>>()
      .mockResolvedValue({ ok: true, value: CAPABILITIES }),
    transcript: vi.fn<(request: MeshSessionRequest) => Promise<RemoteResult<MeshTranscriptResponse>>>()
      .mockResolvedValue({ ok: true, value: TRANSCRIPT }),
    tasks: vi.fn<(request: MeshSessionRequest) => Promise<RemoteResult<AgentNativeTasks>>>()
      .mockResolvedValue({ ok: true, value: TASKS }),
    credentials: vi.fn<(agentId: string | null) => Promise<RemoteResult<readonly MeshCredentialRow[]>>>()
      .mockResolvedValue({ ok: true, value: CREDENTIALS }),
    bindings: vi.fn<() => Promise<RemoteResult<readonly MeshBindingRow[]>>>()
      .mockResolvedValue({ ok: true, value: [BINDING] }),
    runs: vi.fn<() => Promise<RemoteResult<readonly MeshRunRow[]>>>()
      .mockResolvedValue({ ok: true, value: [RUN] }),
    runCancel: vi.fn<(runId: string) => Promise<RemoteResult<boolean>>>()
      .mockResolvedValue({ ok: true, value: true }),
    bind: vi.fn<(sessionId: string, agentId: string) => Promise<RemoteResult<void>>>()
      .mockResolvedValue({ ok: true, value: undefined }),
    unbind: vi.fn<(sessionId: string) => Promise<RemoteResult<boolean>>>()
      .mockResolvedValue({ ok: true, value: true }),
    login: vi.fn<(request: MeshLoginRequest) => Promise<RemoteResult<AgentAuthOperationResult>>>()
      .mockResolvedValue({ ok: true, value: { ok: true, action: 'login', state: { status: 'authenticated', source: 'file' } } }),
    logout: vi.fn<(agentId: string) => Promise<RemoteResult<AgentAuthOperationResult>>>()
      .mockResolvedValue({ ok: true, value: { ok: true, action: 'logout', state: { status: 'unauthenticated', source: 'none' } } }),
  }
}

/**
 * Build one source over the Remote stub and its connection-reset channel.
 * @returns the store, its Remote stub, and the reset trigger with its disposer spy.
 */
function harness() {
  const remote = remoteStub()
  let reset = (): void => {}
  const resetDisposed = vi.fn()
  const deps: AgentMeshStoreDependencies = {
    ...remote,
    subscribeReset: (listener) => {
      reset = listener
      return resetDisposed
    },
  }
  return {
    store: createAgentMeshStore(deps),
    remote,
    reset: () => { reset() },
    resetDisposed,
  }
}

/**
 * Let every read the source already has in flight publish.
 * @returns resolution after the pending microtasks settle.
 */
async function flushed(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('Agent mesh source', () => {
  it('reads every list on the first subscriber and clears on the last', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    const disposeSecond = h.store.hooks.mesh.subscribe(vi.fn())
    expect(h.remote.agents).toHaveBeenCalledOnce()
    expect(h.remote.credentials).toHaveBeenCalledWith(null)
    expect(h.remote.bindings).toHaveBeenCalledOnce()
    expect(h.remote.runs).toHaveBeenCalledOnce()
    await flushed()
    const snapshot = h.store.hooks.mesh.getSnapshot()
    expect(snapshot.agents).toMatchObject({ status: 'ready', rows: [AGENT, OTHER_AGENT] })
    expect(snapshot.credentials.rows).toEqual(CREDENTIALS)
    expect(snapshot.bindings.rows).toEqual([BINDING])
    expect(snapshot.runs.rows).toEqual([RUN])

    dispose()
    expect(h.resetDisposed).not.toHaveBeenCalled()
    expect(h.store.hooks.mesh.getSnapshot().agents.status).toBe('ready')
    disposeSecond()
    expect(h.resetDisposed).toHaveBeenCalledOnce()
    const cleared = h.store.hooks.mesh.getSnapshot()
    expect(cleared.agents).toMatchObject({ status: 'idle', rows: [] })
    expect(cleared.runs).toMatchObject({ status: 'idle', rows: [] })

    const disposeRemount = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()
    expect(h.remote.agents).toHaveBeenCalledTimes(2)
    disposeRemount()
  })

  it('reads one agent’s sessions, then the selected session’s transcript and tasks, and follows a reset', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()
    h.store.actions.selectAgent('codex')
    expect(h.remote.sessions).toHaveBeenCalledWith({ agentId: 'codex' })
    expect(h.remote.capabilities).toHaveBeenCalledWith({ agentId: 'codex' })
    await flushed()
    expect(h.store.hooks.mesh.getSnapshot().sessions.codex?.rows).toEqual([SESSION])
    // A settled list is reused rather than re-read.
    h.store.actions.selectAgent('codex')
    expect(h.remote.sessions).toHaveBeenCalledOnce()

    h.store.actions.selectSession({ agentId: 'codex', sessionId: 'native-1' })
    expect(h.remote.capabilities).toHaveBeenLastCalledWith({ agentId: 'codex', cwd: '/workspace' })
    expect(h.remote.transcript).toHaveBeenCalledWith({ agentId: 'codex', sessionId: 'native-1' })
    expect(h.remote.tasks).toHaveBeenCalledWith({ agentId: 'codex', sessionId: 'native-1' })
    await flushed()
    const shown = h.store.hooks.mesh.getSnapshot()
    expect(shown.transcripts['codex:native-1']?.value).toEqual(TRANSCRIPT)
    expect(shown.tasks['codex:native-1']?.value).toEqual(TASKS)

    h.reset()
    await flushed()
    expect(h.remote.transcript).toHaveBeenCalledTimes(2)
    expect(h.remote.agents).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('keeps capability reads scoped, retryable, and protected from late responses', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()
    let settleOld: ((value: RemoteResult<AgentCapabilityInventory | null>) => void) | undefined
    h.remote.capabilities.mockImplementationOnce(() => new Promise((resolve) => { settleOld = resolve }))
    h.store.actions.selectAgent('codex')
    await h.store.actions.refreshCapabilities({ agentId: 'codex', cwd: '/workspace' })
    const selectedKey = JSON.stringify(['codex', '/workspace'])
    expect(h.store.hooks.mesh.getSnapshot().capabilities[selectedKey]).toMatchObject({ status: 'ready', value: CAPABILITIES })
    settleOld?.({ ok: true, value: null })
    await flushed()
    expect(h.store.hooks.mesh.getSnapshot().capabilities[selectedKey]?.value).toEqual(CAPABILITIES)

    h.remote.capabilities.mockResolvedValueOnce(failure('permission denied'))
    await h.store.actions.refreshCapabilities({ agentId: 'codex', cwd: '/workspace' })
    expect(h.store.hooks.mesh.getSnapshot().capabilities[selectedKey]).toMatchObject({ status: 'error', error: 'permission denied', value: CAPABILITIES })
    h.remote.capabilities.mockResolvedValueOnce({ ok: true, value: null })
    await h.store.actions.refreshCapabilities({ agentId: 'codex', cwd: '/workspace' })
    expect(h.store.hooks.mesh.getSnapshot().capabilities[selectedKey]).toMatchObject({ status: 'ready', value: null, error: null })
    h.reset()
    await flushed()
    expect(h.remote.capabilities).toHaveBeenCalledWith({ agentId: 'codex', cwd: '/workspace' })
    dispose()
  })

  it('keeps the newest answer when an earlier read of the same list settles late', async () => {
    const h = harness()
    let settleFirst: ((value: RemoteResult<readonly MeshSessionRow[]>) => void) | undefined
    h.remote.sessions.mockImplementationOnce(() => new Promise((resolve) => { settleFirst = resolve }))
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()
    h.store.actions.selectAgent('codex')
    await h.store.actions.refreshSessions('codex')
    expect(h.store.hooks.mesh.getSnapshot().sessions.codex).toMatchObject({ status: 'ready', rows: [SESSION] })
    settleFirst?.({ ok: true, value: [] })
    await flushed()
    expect(h.store.hooks.mesh.getSnapshot().sessions.codex).toMatchObject({ status: 'ready', rows: [SESSION] })
    dispose()
  })

  it('reports a failed read with the Remote message and keeps the rows shown', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()
    h.remote.agents.mockResolvedValue(failure('mesh is unavailable'))
    await h.store.actions.refreshAgents()
    expect(h.store.hooks.mesh.getSnapshot().agents).toMatchObject({
      status: 'error', error: 'mesh is unavailable', rows: [AGENT, OTHER_AGENT],
    })
    dispose()
  })

  it('starts session detail reads with empty previous values when the first read fails', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()

    h.remote.sessions.mockResolvedValueOnce(failure('sessions unavailable'))
    h.remote.transcript.mockResolvedValueOnce(failure('transcript unavailable'))
    h.remote.tasks.mockResolvedValueOnce(failure('tasks unavailable'))
    h.store.actions.selectAgent('codex')
    await flushed()
    h.store.actions.selectSession({ agentId: 'codex', sessionId: 'native-1' })
    await flushed()

    const snapshot = h.store.hooks.mesh.getSnapshot()
    expect(snapshot.sessions.codex).toMatchObject({ status: 'error', rows: [], error: 'sessions unavailable' })
    expect(snapshot.transcripts['codex:native-1']).toMatchObject({
      status: 'error', value: null, error: 'transcript unavailable',
    })
    expect(snapshot.tasks['codex:native-1']).toMatchObject({
      status: 'error', value: null, error: 'tasks unavailable',
    })
    dispose()
  })

  it('keeps usable previous values when a session detail read fails', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()
    await h.store.actions.refreshSessions('codex')
    await h.store.actions.refreshSession('codex', 'native-1')

    h.remote.sessions.mockResolvedValue(failure('session list unavailable'))
    h.remote.transcript.mockResolvedValue(failure('transcript unavailable'))
    h.remote.tasks.mockResolvedValue(failure('tasks unavailable'))
    h.remote.credentials.mockResolvedValue(failure('credentials unavailable'))
    h.remote.bindings.mockResolvedValue(failure('bindings unavailable'))
    h.remote.runs.mockResolvedValue(failure('runs unavailable'))
    await h.store.actions.refreshSessions('codex')
    await h.store.actions.refreshSession('codex', 'native-1')
    await h.store.actions.refreshCredentials()
    await h.store.actions.refreshBindings()
    await h.store.actions.refreshRuns()

    const snapshot = h.store.hooks.mesh.getSnapshot()
    expect(snapshot.sessions.codex).toMatchObject({ status: 'error', rows: [SESSION], error: 'session list unavailable' })
    expect(snapshot.transcripts['codex:native-1']).toMatchObject({
      status: 'error', value: TRANSCRIPT, error: 'transcript unavailable',
    })
    expect(snapshot.tasks['codex:native-1']).toMatchObject({ status: 'error', value: TASKS, error: 'tasks unavailable' })
    expect(snapshot.credentials).toMatchObject({ status: 'error', rows: CREDENTIALS, error: 'credentials unavailable' })
    expect(snapshot.bindings).toMatchObject({ status: 'error', rows: [BINDING], error: 'bindings unavailable' })
    expect(snapshot.runs).toMatchObject({ status: 'error', rows: [RUN], error: 'runs unavailable' })
    dispose()
  })

  it('ignores superseded session detail and list reads', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()
    let settleTranscript: ((value: RemoteResult<MeshTranscriptResponse>) => void) | undefined
    let settleTasks: ((value: RemoteResult<AgentNativeTasks>) => void) | undefined
    let settleCredentials: ((value: RemoteResult<readonly MeshCredentialRow[]>) => void) | undefined
    let settleBindings: ((value: RemoteResult<readonly MeshBindingRow[]>) => void) | undefined
    let settleRuns: ((value: RemoteResult<readonly MeshRunRow[]>) => void) | undefined
    h.remote.transcript.mockImplementationOnce(() => new Promise((resolve) => { settleTranscript = resolve }))
    h.remote.tasks.mockImplementationOnce(() => new Promise((resolve) => { settleTasks = resolve }))
    h.remote.credentials.mockImplementationOnce(() => new Promise((resolve) => { settleCredentials = resolve }))
    h.remote.bindings.mockImplementationOnce(() => new Promise((resolve) => { settleBindings = resolve }))
    h.remote.runs.mockImplementationOnce(() => new Promise((resolve) => { settleRuns = resolve }))

    const oldSession = h.store.actions.refreshSession('codex', 'native-1')
    await h.store.actions.refreshSession('codex', 'native-1')
    const oldCredentials = h.store.actions.refreshCredentials()
    await h.store.actions.refreshCredentials()
    const oldBindings = h.store.actions.refreshBindings()
    await h.store.actions.refreshBindings()
    const oldRuns = h.store.actions.refreshRuns()
    await h.store.actions.refreshRuns()

    settleTranscript?.({ ok: true, value: { ...TRANSCRIPT, messages: [] } })
    settleTasks?.({ ok: true, value: { ...TASKS, todos: [] } })
    settleCredentials?.({ ok: true, value: [] })
    settleBindings?.({ ok: true, value: [] })
    settleRuns?.({ ok: true, value: [] })
    await Promise.all([oldSession, oldCredentials, oldBindings, oldRuns])
    const snapshot = h.store.hooks.mesh.getSnapshot()
    expect(snapshot.transcripts['codex:native-1']?.value).toEqual(TRANSCRIPT)
    expect(snapshot.tasks['codex:native-1']?.value).toEqual(TASKS)
    expect(snapshot.credentials.rows).toEqual(CREDENTIALS)
    expect(snapshot.bindings.rows).toEqual([BINDING])
    expect(snapshot.runs.rows).toEqual([RUN])
    dispose()
  })

  it('renders Error and non-Error transport rejections as read messages', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()

    h.remote.agents.mockRejectedValueOnce(new Error('connection lost'))
    await h.store.actions.refreshAgents()
    expect(h.store.hooks.mesh.getSnapshot().agents.error).toBe('connection lost')

    h.remote.agents.mockRejectedValueOnce('transport stopped')
    await h.store.actions.refreshAgents()
    expect(h.store.hooks.mesh.getSnapshot().agents.error).toBe('transport stopped')
    dispose()
  })

  it('binds and unbinds the Harness session, reading the bindings again', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()
    await h.store.actions.bind('harness-1', 'grok')
    expect(h.remote.bind).toHaveBeenCalledWith('harness-1', 'grok')
    expect(h.remote.bindings).toHaveBeenCalledTimes(2)
    expect(h.store.hooks.mesh.getSnapshot().bindingError).toBeNull()

    h.remote.bind.mockResolvedValue(failure('unknown agent'))
    await h.store.actions.bind('harness-1', 'nope')
    expect(h.store.hooks.mesh.getSnapshot().bindingError).toBe('unknown agent')
    h.store.actions.dismissBindingError()
    expect(h.store.hooks.mesh.getSnapshot().bindingError).toBeNull()

    await h.store.actions.unbind('harness-1')
    expect(h.remote.unbind).toHaveBeenCalledWith('harness-1')
    expect(h.remote.bindings).toHaveBeenCalledTimes(3)

    h.remote.unbind.mockResolvedValue(failure('binding was already removed'))
    await h.store.actions.unbind('harness-1')
    expect(h.store.hooks.mesh.getSnapshot().bindingError).toBe('binding was already removed')
    dispose()
  })

  it('keeps one pending key when the same binding action is invoked twice', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()
    let settleFirst: ((value: RemoteResult<void>) => void) | undefined
    h.remote.bind.mockImplementationOnce(() => new Promise((resolve) => { settleFirst = resolve }))

    const first = h.store.actions.bind('harness-1', 'grok')
    expect(h.store.hooks.mesh.getSnapshot().pending).toEqual(['bind:harness-1'])
    const second = h.store.actions.bind('harness-1', 'grok')
    expect(h.store.hooks.mesh.getSnapshot().pending).toEqual(['bind:harness-1'])
    await second
    settleFirst?.({ ok: true, value: undefined })
    await first
    dispose()
  })

  it('cancels a run and reads the runs again, reporting a failure in its own slot', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()
    await h.store.actions.cancelRun('run-1')
    expect(h.remote.runCancel).toHaveBeenCalledWith('run-1')
    expect(h.remote.runs).toHaveBeenCalledTimes(2)

    h.remote.runCancel.mockResolvedValue(failure('run already finished'))
    await h.store.actions.cancelRun('run-1')
    expect(h.store.hooks.mesh.getSnapshot().runError).toBe('run already finished')
    // A failed cancellation leaves the roster readback to the next refresh.
    expect(h.remote.runs).toHaveBeenCalledTimes(2)
    h.store.actions.dismissRunError()
    expect(h.store.hooks.mesh.getSnapshot().runError).toBeNull()
    dispose()
  })

  it('refreshes a known active run and stops polling after it reaches a terminal status', async () => {
    vi.useFakeTimers()
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await h.store.actions.refreshRuns()
    const event = {
      kind: 'message.delta' as const,
      runId: brandString<AgentRunId>('run-1'), at: '2026-10-17T00:00:00.000Z', text: 'progress',
    } satisfies AgentRunEvent
    h.remote.runs.mockResolvedValue({ ok: true, value: [{ ...RUN, events: [event], eventCount: 1 }] })

    await vi.advanceTimersByTimeAsync(1_500)

    expect(h.remote.runs).toHaveBeenCalledTimes(3)
    expect(h.store.hooks.mesh.getSnapshot().runs.rows[0]).toMatchObject({ eventCount: 1, events: [event] })
    h.remote.runs.mockResolvedValue({ ok: true, value: [{ ...RUN, status: 'succeeded' }] })
    await vi.advanceTimersByTimeAsync(1_500)
    expect(h.remote.runs).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.remote.runs).toHaveBeenCalledTimes(4)
    dispose()
  })

  it('clears the active-run timer when the last subscriber leaves', async () => {
    vi.useFakeTimers()
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await h.store.actions.refreshRuns()
    dispose()

    await vi.advanceTimersByTimeAsync(3_000)

    expect(h.remote.runs).toHaveBeenCalledTimes(2)
  })

  it('discovers a run started while the panel source is subscribed', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.remote.runs.mockResolvedValue({ ok: true, value: [] })
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await h.store.actions.refreshRuns()
    h.remote.runs.mockResolvedValue({ ok: true, value: [RUN] })

    await vi.advanceTimersByTimeAsync(5_000)

    expect(h.remote.runs).toHaveBeenCalledTimes(3)
    expect(h.store.hooks.mesh.getSnapshot().runs.rows).toEqual([RUN])
    await vi.advanceTimersByTimeAsync(1_500)
    expect(h.remote.runs).toHaveBeenCalledTimes(4)
    dispose()
  })

  it('does not poll runs when no source subscriber is mounted', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.store.actions.refreshRuns()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(h.remote.runs).toHaveBeenCalledOnce()
  })

  it('reports what a login the adapter could not perform left for the user, without any secret', async () => {
    const h = harness()
    h.remote.login.mockResolvedValue({
      ok: true,
      value: {
        ok: false, action: 'login', state: { status: 'unauthenticated', source: 'none' },
        instructions: 'run `codex login` on the host', output: 'redacted output',
      },
    })
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()
    await h.store.actions.login('codex', 'device-code')
    expect(h.remote.login).toHaveBeenCalledWith({ agentId: 'codex', flow: 'device-code' })
    expect(h.store.hooks.mesh.getSnapshot().auth).toEqual({
      agentId: 'codex', action: 'login', ok: false,
      instructions: 'run `codex login` on the host', output: 'redacted output',
    })
    expect(JSON.stringify(h.remote.login.mock.calls)).not.toContain('secret')
    h.store.actions.dismissAuth()
    expect(h.store.hooks.mesh.getSnapshot().auth).toBeNull()
    dispose()
  })

  it('reports rejected login and logout operations and projects a completed logout', async () => {
    const h = harness()
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await flushed()

    await h.store.actions.login('codex', 'api-key', 'one-time-key')
    expect(h.remote.login).toHaveBeenCalledWith({ agentId: 'codex', flow: 'api-key', secret: 'one-time-key' })
    expect(JSON.stringify(h.store.hooks.mesh.getSnapshot())).not.toContain('one-time-key')
    expect(h.store.hooks.mesh.getSnapshot().auth).toEqual({
      agentId: 'codex', action: 'login', ok: true, instructions: null, output: null,
    })

    await h.store.actions.logout('codex')
    expect(h.store.hooks.mesh.getSnapshot().auth).toEqual({
      agentId: 'codex', action: 'logout', ok: true, instructions: null, output: null,
    })

    h.remote.login.mockResolvedValue(failure('login unavailable'))
    await h.store.actions.login('codex', 'api-key')
    expect(h.store.hooks.mesh.getSnapshot().auth).toEqual({
      agentId: 'codex', action: 'login', ok: false, instructions: 'login unavailable', output: null,
    })

    h.remote.logout.mockResolvedValue(failure('logout unavailable'))
    await h.store.actions.logout('codex')
    expect(h.store.hooks.mesh.getSnapshot().auth).toEqual({
      agentId: 'codex', action: 'logout', ok: false, instructions: 'logout unavailable', output: null,
    })
    dispose()
  })

  it('ignores a superseded answer for one list after a later read was requested', async () => {
    const h = harness()
    let settleFirst: ((value: RemoteResult<readonly MeshAgentRow[]>) => void) | undefined
    h.remote.agents.mockImplementationOnce(() => new Promise((resolve) => { settleFirst = resolve }))
    const dispose = h.store.hooks.mesh.subscribe(vi.fn())
    await h.store.actions.refreshAgents()
    settleFirst?.({ ok: true, value: [OTHER_AGENT] })
    await flushed()
    expect(h.store.hooks.mesh.getSnapshot().agents).toMatchObject({ status: 'ready', rows: [AGENT, OTHER_AGENT] })
    dispose()
  })
})
