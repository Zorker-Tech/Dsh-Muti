import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId } from '@deepseek-ai/dsh-agent-mesh/types'
import type { AgentCapabilityInventory } from '@deepseek-ai/dsh-agent-mesh/types'
import type { MeshBindingRow } from '@deepseek-ai/dsh-agent-mesh-controller/types'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { MeshAgentRow } from '@deepseek-ai/dsh-agent-mesh-controller/types'
import type {
  MeshCollaborationRow,
  MeshConflictReportRow,
  MeshTodoBoardRow,
  MeshWorktreeRow,
} from '@deepseek-ai/dsh-agent-mesh-collaboration/types'
import { apply, inject, PANEL_ID } from '../src/client/index.ts'
import { AgentsPanelIcon } from '../src/client/AgentsPanelIcon.tsx'
import { NS, zh } from '../src/client/locales.ts'
import type { MeshPanelInjected } from '../src/client/MeshPanel.tsx'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

const Empty = () => null

const AGENT: MeshAgentRow = { agentId: 'codex', displayName: 'Codex', installed: true, warnings: [] }
const AGENT_ID = brandString<AgentId>('codex')
const SOURCE_SESSION = { agentId: AGENT_ID, nativeId: 'native-7' }
const SESSION_ID = brandString<SessionId>('harness-1')

const SKILL_INVENTORY: AgentCapabilityInventory = {
  agentId: AGENT_ID,
  tools: [],
  skills: [
    { name: 'code-review', source: 'user' },
    { name: 'code-search', description: 'Search code', source: 'project' },
  ],
  mcpServers: [],
  commands: [],
  contextFiles: [],
  sources: [],
  notes: [],
  observedAt: '2026-10-17T00:00:00.000Z',
}

/** The `agentMesh` Remote namespace as the panel reads it. */
function agentMeshStub() {
  return {
    agents: vi.fn(async (): Promise<RemoteResult<readonly MeshAgentRow[]>> => ({ ok: true, value: [AGENT] })),
    capabilities: vi.fn(async (): Promise<RemoteResult<AgentCapabilityInventory | null>> => ({ ok: true, value: null })),
    sessions: vi.fn(async () => ({ ok: true as const, value: [] })),
    launchCommand: vi.fn(async () => ({ ok: true as const, value: { argv: ['codex', 'resume', 'native-1'], shell: 'posix' as const } })),
    pinSession: vi.fn(async (): Promise<RemoteResult<void>> => ({ ok: true, value: undefined })),
    unpinSession: vi.fn(async (): Promise<RemoteResult<void>> => ({ ok: true, value: undefined })),
    archiveSession: vi.fn(async (): Promise<RemoteResult<void>> => ({ ok: true, value: undefined })),
    unarchiveSession: vi.fn(async (): Promise<RemoteResult<void>> => ({ ok: true, value: undefined })),
    transcript: vi.fn(async () => ({ ok: true as const, value: { key: '', messages: [], hasMore: false, notes: [] } })),
    tasks: vi.fn(async () => ({ ok: true as const, value: { available: false, todos: [], notes: [] } })),
    credentials: vi.fn(async () => ({ ok: true as const, value: [] })),
    bindings: vi.fn(async (): Promise<RemoteResult<readonly MeshBindingRow[]>> => ({ ok: true, value: [] })),
    runs: vi.fn(async () => ({ ok: true as const, value: [] })),
    runCancel: vi.fn(async () => ({ ok: true as const, value: false })),
    bind: vi.fn(async () => ({ ok: true as const, value: undefined })),
    unbind: vi.fn(async () => ({ ok: true as const, value: false })),
    login: vi.fn(async () => ({ ok: true as const, value: { ok: true, action: 'login' as const, state: { status: 'authenticated' as const, source: 'file' as const } } })),
    logout: vi.fn(async () => ({ ok: true as const, value: { ok: true, action: 'logout' as const, state: { status: 'unauthenticated' as const, source: 'none' as const } } })),
  }
}

/** The `meshCollaboration` Remote namespace used by the collaboration page. */
function meshCollaborationStub() {
  const worktree = (id: string, repoRoot: string): MeshWorktreeRow => ({
    id, path: `${repoRoot}/.dsh-agent-mesh/worktrees/${id}`, repoRoot, branch: `codex/${id}`,
    baseCommit: 'base', baseRef: 'HEAD', agentId: 'codex', state: 'active', reusable: false,
    collaborationId: 'collab-1', taskId: 'task-1', runId: '', changedFiles: 0, dirty: false,
    ahead: 0, files: [], notes: [], sampledAt: '',
  })
  const collaboration: MeshCollaborationRow = {
    id: 'collab-1', title: 'Fix the app', repoRoot: '/repo', createdAt: '', updatedAt: '',
    objective: 'Fix the app', mode: 'inject', activePhaseId: '', phases: [], decisions: [],
    todoRevision: 0, todoCount: 0, tasks: [], worktrees: [],
  }
  const board: MeshTodoBoardRow = { collaborationId: collaboration.id, revision: 0, updatedAt: '', todos: [] }
  const conflicts: MeshConflictReportRow = {
    repoRoot: collaboration.repoRoot, at: '', worktrees: [], findings: [], suggestedOrder: [], notes: [],
  }
  return {
    collaborations: vi.fn(async (): Promise<RemoteResult<readonly MeshCollaborationRow[]>> => ({
      ok: true,
      value: [collaboration],
    })),
    todosGet: vi.fn(async (request: { readonly collaborationId: string }): Promise<RemoteResult<MeshTodoBoardRow>> => ({
      ok: true, value: { ...board, collaborationId: request.collaborationId },
    })),
    worktrees: vi.fn(async (request: { readonly repoRoot: string }): Promise<RemoteResult<readonly MeshWorktreeRow[]>> => ({
      ok: true, value: request.repoRoot === collaboration.repoRoot ? [worktree('worktree-1', request.repoRoot)] : [],
    })),
    worktreeConflicts: vi.fn(async (request: { readonly repoRoot: string }): Promise<RemoteResult<MeshConflictReportRow>> => ({
      ok: true, value: { ...conflicts, repoRoot: request.repoRoot },
    })),
    worktreeIntegrated: vi.fn(async (request: { readonly worktreeId: string }): Promise<RemoteResult<MeshWorktreeRow>> => ({
      ok: true, value: worktree(request.worktreeId, collaboration.repoRoot),
    })),
  }
}

/** The `remote` service carrying one namespace object per property. */
class RemoteStub extends Service {
  constructor(ctx: Context, readonly agentMesh: ReturnType<typeof agentMeshStub>) {
    super(ctx, 'remote')
  }
}

/**
 * Read the object one slot entry's `inject` callback returned.
 * @param entry - registered slot entry.
 * @returns the injected face object.
 * @throws if the entry injected no face.
 */
function injectedFace(entry: StoredEntry): MeshPanelInjected {
  const face: object | undefined = entry.inject?.()
  if (face === undefined) throw new Error('slot entry injected no face')
  return face as MeshPanelInjected
}

/**
 * Boot the browser half over a real slot registry, a recording locale service,
 * and the Remote stub, with the two target slots declared.
 * @returns the context, the Remote stub, and the declared slots' disposer.
 */
async function baseContext(options: { readonly cwd?: string } = { cwd: '/work/repo' }) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const agentMesh = agentMeshStub()
  const meshCollaboration = meshCollaborationStub()
  const promptState = { current: { openState: 'open' as 'open' | 'opening', openError: undefined as Error | undefined } }
  const sessionPrompt = vi.fn(async (): Promise<RemoteResult<{ readonly accepted: true }>> => ({
    ok: true,
    value: { accepted: true },
  }))
  const sessionFace = {
    getSnapshot: () => promptState.current,
    prompt: sessionPrompt,
  }
  const sessions = {
    list: { getSnapshot: () => ({ byId: { [SESSION_ID]: options.cwd === undefined ? {} : { cwd: options.cwd } } }) },
    using: vi.fn(async (
      _sessionId: SessionId,
      _options: { readonly source: 'agentMeshPanel' },
      operation: (reference: { readonly binding: { readonly session: typeof sessionFace } }) => Promise<void>,
    ) => operation({ binding: { session: sessionFace } })),
  }
  new RemoteStub(ctx, agentMesh)
  ctx.provide('remote.agentMesh', agentMesh as never)
  ctx.provide('remote.meshCollaboration', meshCollaboration as never)
  ctx.provide('locale', {
    register: vi.fn(() => () => {}),
    bind: vi.fn((ns: string) => (key: string, values?: Readonly<Record<string, string>>) => {
      const templates: Readonly<Record<string, string>> = {
        'skillMenu.boundAgent': 'the bound agent',
        'skillMenu.skillPrompt': 'Delegate to {agent} and use its "{skill}" skill for: ',
        'skillMenu.commandPrompt': 'Use DSH mesh_run to dispatch this task to {agent} with commandName "{command}": ',
      }
      return Object.entries(values ?? {}).reduce(
        (message, [name, value]) => message.replaceAll(`{${name}}`, value),
        templates[key] ?? `${ns}:${key}`,
      )
    }),
  } as never)
  const activePanel = { current: null as MainPanelId | null }
  ctx.provide('layout', {
    selectPanel: vi.fn((panelId: MainPanelId | null) => { activePanel.current = panelId }),
  } as never)
  let skillSource: InputTriggerSource | undefined
  const inputTriggers = {
    registerSource: vi.fn((source: InputTriggerSource) => {
      skillSource = source
      return () => { skillSource = undefined }
    }),
  }
  ctx.provide('inputTriggers', inputTriggers as never)
  ctx.provide('sessions', sessions as never)
  // A one-off declaration stand-in: the registered component renders nothing,
  // so the declaration is cast to the register position the two slots need.
  const declare = ctx.slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, Empty)
  return {
    ctx, agentMesh, meshCollaboration, sessions, sessionPrompt, promptState, declare, activePanel, inputTriggers,
    skillSource: () => skillSource,
  }
}

describe('ui-agent-mesh browser half', () => {
  it('uses the sidebar requested icon size', () => {
    const icon = AgentsPanelIcon({ size: 18, active: false } as PropsRuntime<'sidebar.panellist'>)
    expect(icon.props).toMatchObject({ size: 18 })
  })

  it('declares only the services its registrations read', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.agentMesh', 'remote.meshCollaboration', 'layout', 'inputTriggers', 'sessions'])
  })

  it('registers the agents sidebar entry and the panel it opens, and withdraws both on teardown', async () => {
    const { ctx, declare, inputTriggers, skillSource } = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('sidebar.panellist').map(entry => entry.options.id)).toEqual([PANEL_ID])
    expect(ctx.slots.entries('main').map(entry => entry.options.key)).toEqual([PANEL_ID])
    const entry = ctx.slots.entries('sidebar.panellist')[0]!
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe(`${NS}:panel`)
    expect(zh.panel).toBe('智能体网格')
    expect(inputTriggers.registerSource).toHaveBeenCalledOnce()
    expect(skillSource()?.trigger).toBe('/')

    await fiber.dispose()
    expect(skillSource()).toBeUndefined()
    expect(ctx.slots.entries('sidebar.panellist')).toEqual([])
    expect(ctx.slots.entries('main')).toEqual([])
    declare()
    await ctx.fiber.dispose()
  })

  it('offers skills from the agent bound to this Session and inserts a delegation prompt', async () => {
    const { ctx, agentMesh, declare, skillSource } = await baseContext()
    agentMesh.bindings.mockResolvedValueOnce({
      ok: true,
      value: [{ sessionId: SESSION_ID, agentId: AGENT_ID, boundAt: '2026-10-17T00:00:00.000Z' }],
    })
    agentMesh.capabilities.mockResolvedValueOnce({ ok: true, value: SKILL_INVENTORY })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const source = skillSource()
    if (source === undefined) throw new Error('agent skill source was not registered')
    const candidates = await source.candidates(
      { sessionId: SESSION_ID },
      { query: 'CoDe-REV', position: 'leading', drilled: false, signal: new AbortController().signal },
    )

    expect(candidates).toEqual([{
      name: 'code-review',
      description: 'agentMesh:skillMenu.fromAgent',
      value: 'codex\u0000code-review',
    }])
    expect(agentMesh.capabilities).toHaveBeenCalledWith({ agentId: AGENT_ID, cwd: '/work/repo' })
    expect(source.onPick({
      candidate: candidates[0]!,
      session: { sessionId: SESSION_ID },
      position: 'leading',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 1, draftRev: 1 },
    })).toEqual({ text: 'Delegate to codex and use its "code-review" skill for: ' })
    expect(source.onPick({
      candidate: { name: 'loose' },
      session: { sessionId: SESSION_ID },
      position: 'leading',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 1, draftRev: 1 },
    })).toEqual({ text: 'Delegate to the bound agent and use its "loose" skill for: ' })

    await fiber.dispose()
    declare()
    await ctx.fiber.dispose()
  })

  it('offers file-backed agent commands and directs the draft through mesh_run.commandName', async () => {
    const { ctx, agentMesh, declare, skillSource } = await baseContext()
    agentMesh.bindings.mockResolvedValue({
      ok: true,
      value: [{ sessionId: SESSION_ID, agentId: AGENT_ID, boundAt: '2026-10-17T00:00:00.000Z' }],
    })
    agentMesh.capabilities.mockResolvedValue({
      ok: true,
      value: {
        ...SKILL_INVENTORY,
        commands: [
          { name: 'review', description: 'Review changed files', source: 'user', path: '/work/.codex/prompts/review.md' },
          { name: 'followup', source: 'project', path: '/work/.codex/prompts/followup.md' },
          { name: 'native', source: 'builtin' },
        ],
      },
    })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const source = skillSource()
    if (source === undefined) throw new Error('agent skill and command source was not registered')
    const request = (query: string) => source.candidates(
      { sessionId: SESSION_ID },
      { query, position: 'leading', drilled: false, signal: new AbortController().signal },
    )
    const all = await request('')
    expect(all.map(candidate => candidate.name)).toEqual(['code-review', 'code-search', 'command:review', 'command:followup'])
    expect(all[2]).toMatchObject({
      name: 'command:review',
      label: 'review',
      description: 'Review changed files',
      value: 'codex\u0000command\u0000review',
    })
    expect(all[3]).toMatchObject({
      name: 'command:followup',
      label: 'followup',
      description: 'agentMesh:skillMenu.commandFromAgent',
      value: 'codex\u0000command\u0000followup',
    })
    const byCommandName = await request('review')
    expect(byCommandName.map(candidate => candidate.name)).toEqual(['code-review', 'command:review'])
    const byCommandPrefix = await request('command:')
    expect(byCommandPrefix.map(candidate => candidate.name)).toEqual(['command:review', 'command:followup'])
    expect(all.some(candidate => candidate.name === 'command:native')).toBe(false)
    const review = byCommandPrefix[0]!
    expect(source.onPick({
      candidate: review,
      session: { sessionId: SESSION_ID },
      position: 'leading',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 1, draftRev: 1 },
    })).toEqual({ text: 'Use DSH mesh_run to dispatch this task to codex with commandName "review": ' })

    await fiber.dispose()
    declare()
    await ctx.fiber.dispose()
  })

  it('resolves agent skills without a Session working directory', async () => {
    const { ctx, agentMesh, declare, skillSource } = await baseContext({})
    agentMesh.bindings.mockResolvedValueOnce({
      ok: true,
      value: [{ sessionId: SESSION_ID, agentId: AGENT_ID, boundAt: '2026-10-17T00:00:00.000Z' }],
    })
    agentMesh.capabilities.mockResolvedValueOnce({ ok: true, value: SKILL_INVENTORY })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const source = skillSource()
    if (source === undefined) throw new Error('agent skill source was not registered')
    await expect(source.candidates(
      { sessionId: SESSION_ID },
      { query: '', position: 'leading', drilled: false, signal: new AbortController().signal },
    )).resolves.toHaveLength(2)
    expect(agentMesh.capabilities).toHaveBeenCalledWith({ agentId: AGENT_ID })

    await fiber.dispose()
    declare()
    await ctx.fiber.dispose()
  })

  it('leaves the skill menu empty when unbound, aborted, unavailable, or filtered out', async () => {
    const { ctx, agentMesh, declare, skillSource } = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const source = skillSource()
    if (source === undefined) throw new Error('agent skill source was not registered')

    const request = (query: string, signal = new AbortController().signal) => source.candidates(
      { sessionId: SESSION_ID }, { query, position: 'leading', drilled: false, signal },
    )
    const abortedBefore = new AbortController()
    abortedBefore.abort()
    await expect(request('', abortedBefore.signal)).resolves.toEqual([])
    expect(agentMesh.bindings).not.toHaveBeenCalled()

    agentMesh.bindings.mockResolvedValueOnce({ ok: true, value: [] })
    await expect(request('')).resolves.toEqual([])

    agentMesh.bindings.mockResolvedValueOnce({
      ok: true,
      value: [{ sessionId: SESSION_ID, agentId: AGENT_ID, boundAt: '2026-10-17T00:00:00.000Z' }],
    })
    agentMesh.capabilities.mockResolvedValueOnce({ ok: true, value: null })
    await expect(request('')).resolves.toEqual([])

    agentMesh.bindings.mockResolvedValueOnce({
      ok: true,
      value: [{ sessionId: SESSION_ID, agentId: AGENT_ID, boundAt: '2026-10-17T00:00:00.000Z' }],
    })
    agentMesh.capabilities.mockResolvedValueOnce({ ok: true, value: SKILL_INVENTORY })
    await expect(request('not found')).resolves.toEqual([])

    const abortedAfterBindings = new AbortController()
    agentMesh.bindings.mockImplementationOnce(async () => {
      abortedAfterBindings.abort()
      return { ok: true, value: [{ sessionId: SESSION_ID, agentId: AGENT_ID, boundAt: '2026-10-17T00:00:00.000Z' }] }
    })
    await expect(request('', abortedAfterBindings.signal)).resolves.toEqual([])

    const abortedAfterCapabilities = new AbortController()
    agentMesh.bindings.mockResolvedValueOnce({
      ok: true,
      value: [{ sessionId: SESSION_ID, agentId: AGENT_ID, boundAt: '2026-10-17T00:00:00.000Z' }],
    })
    agentMesh.capabilities.mockImplementationOnce(async () => {
      abortedAfterCapabilities.abort()
      return { ok: true, value: SKILL_INVENTORY }
    })
    await expect(request('', abortedAfterCapabilities.signal)).resolves.toEqual([])

    await fiber.dispose()
    declare()
    await ctx.fiber.dispose()
  })

  it('surfaces Remote failures while resolving the bound agent skill inventory', async () => {
    const { ctx, agentMesh, declare, skillSource } = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const source = skillSource()
    if (source === undefined) throw new Error('agent skill source was not registered')
    const request = () => source.candidates(
      { sessionId: SESSION_ID },
      { query: '', position: 'leading', drilled: false, signal: new AbortController().signal },
    )
    const failure = new RemoteError('gateway/internal', 'mesh offline', {})
    agentMesh.bindings.mockResolvedValueOnce({ ok: false, error: failure })
    await expect(request()).rejects.toBe(failure)

    agentMesh.bindings.mockResolvedValueOnce({
      ok: true,
      value: [{ sessionId: SESSION_ID, agentId: AGENT_ID, boundAt: '2026-10-17T00:00:00.000Z' }],
    })
    agentMesh.capabilities.mockResolvedValueOnce({ ok: false, error: failure })
    await expect(request()).rejects.toBe(failure)

    await fiber.dispose()
    declare()
    await ctx.fiber.dispose()
  })

  it('opens a source-owned session in the Agent Mesh panel', async () => {
    const { ctx, declare, activePanel } = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    ctx.agentMeshNavigation.openSession(SOURCE_SESSION)
    expect(activePanel.current).toBe(PANEL_ID)
    const face = injectedFace(ctx.slots.entries('main')[0]!)
    expect(face.hooks.mesh.getSnapshot()).toMatchObject({
      selectedAgentId: 'codex',
      selectedSessionKey: 'codex:native-7',
    })
    await fiber.dispose()
    expect(ctx.get('agentMeshNavigation')).toBeUndefined()
    declare()
    await ctx.fiber.dispose()
  })

  it('forwards source-owned session disposition actions to the Remote namespace', async () => {
    const { ctx, agentMesh, declare } = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const reference = SOURCE_SESSION

    await Promise.all([
      ctx.agentMeshNavigation.pinSession(reference),
      ctx.agentMeshNavigation.unpinSession(reference),
      ctx.agentMeshNavigation.archiveSession(reference),
      ctx.agentMeshNavigation.unarchiveSession(reference),
    ])

    expect(agentMesh.pinSession).toHaveBeenCalledWith({ agentId: 'codex', sessionId: 'native-7' })
    expect(agentMesh.unpinSession).toHaveBeenCalledWith({ agentId: 'codex', sessionId: 'native-7' })
    expect(agentMesh.archiveSession).toHaveBeenCalledWith({ agentId: 'codex', sessionId: 'native-7' })
    expect(agentMesh.unarchiveSession).toHaveBeenCalledWith({ agentId: 'codex', sessionId: 'native-7' })

    agentMesh.pinSession.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/internal', 'pin rejected', {}),
    })
    await expect(ctx.agentMeshNavigation.pinSession(reference)).rejects.toMatchObject({ message: 'pin rejected' })

    await fiber.dispose()
    declare()
    await ctx.fiber.dispose()
  })

  it('reads the roster through the injected source, and reports a Remote failure as a message', async () => {
    const { ctx, agentMesh, declare } = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const face = injectedFace(ctx.slots.entries('main')[0]!)
    const dispose = face.hooks.mesh.subscribe(vi.fn())
    expect(agentMesh.agents).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(face.hooks.mesh.getSnapshot().agents.status).toBe('ready') })
    expect(face.hooks.mesh.getSnapshot().agents.rows).toEqual([AGENT])

    agentMesh.agents.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'mesh offline', {}) })
    await face.refreshAgents()
    expect(face.hooks.mesh.getSnapshot().agents).toMatchObject({ status: 'error', error: 'mesh offline' })
    dispose()
    await fiber.dispose()
    declare()
    await ctx.fiber.dispose()
  })

  it('routes every source action through the agentMesh Remote namespace', async () => {
    const { ctx, agentMesh, declare } = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const face = injectedFace(ctx.slots.entries('main')[0]!)
    const dispose = face.hooks.mesh.subscribe(vi.fn())

    face.selectAgent('codex')
    face.selectSession({ agentId: 'codex', sessionId: 'native-1' })
    await Promise.all([
      face.refreshAgents(),
      face.refreshSessions('codex'),
      face.refreshSession('codex', 'native-1'),
      face.refreshCredentials(),
      face.refreshBindings(),
      face.refreshRuns(),
      face.cancelRun('run-1'),
      face.bind('harness-1', 'codex'),
      face.unbind('harness-1'),
      face.login('codex', 'api-key'),
      face.logout('codex'),
      face.launchCommand({ agentId: 'codex', sessionId: 'native-1' }),
    ])
    face.refreshAll()

    for (const name of [
      'agents', 'sessions', 'launchCommand', 'transcript', 'tasks', 'credentials', 'bindings', 'runs', 'runCancel', 'bind', 'unbind', 'login', 'logout',
    ] as const) {
      expect(agentMesh[name]).toHaveBeenCalled()
    }

    dispose()
    await fiber.dispose()
    declare()
    await ctx.fiber.dispose()
  })

  it('reads collaboration records and routes collaboration actions through their Remote namespace', async () => {
    const { ctx, meshCollaboration, declare } = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const face = injectedFace(ctx.slots.entries('main')[0]!)
    const dispose = face.hooks.collaboration.subscribe(vi.fn())

    await vi.waitFor(() => { expect(face.hooks.collaboration.getSnapshot().collaborations.status).toBe('ready') })
    expect(face.hooks.collaboration.getSnapshot().selectedId).toBe('collab-1')
    expect(meshCollaboration.collaborations).toHaveBeenCalledWith(null)
    expect(meshCollaboration.todosGet).toHaveBeenCalledWith({ collaborationId: 'collab-1' })
    expect(meshCollaboration.worktrees).toHaveBeenCalledWith({ repoRoot: '/repo' })

    await Promise.all([
      face.collaborationActions.refreshBoard('collab-1'),
      face.collaborationActions.refreshWorktrees('/repo'),
      face.collaborationActions.refreshConflicts('/repo'),
      face.collaborationActions.markIntegrated('worktree-1'),
    ])
    expect(meshCollaboration.worktreeConflicts).toHaveBeenCalledWith({ repoRoot: '/repo' })
    expect(meshCollaboration.worktreeIntegrated).toHaveBeenCalledWith({ worktreeId: 'worktree-1' })

    dispose()
    await fiber.dispose()
    declare()
    await ctx.fiber.dispose()
  })

  it('queues a logged prompt through the retained Harness Session', async () => {
    const { ctx, sessions, sessionPrompt, declare } = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const face = injectedFace(ctx.slots.entries('main')[0]!)

    await face.queueDispatchPrompt(SESSION_ID, 'delegate this exact task')

    expect(sessions.using).toHaveBeenCalledOnce()
    expect(sessions.using.mock.calls[0]?.[0]).toBe(SESSION_ID)
    expect(sessions.using.mock.calls[0]?.[1]).toEqual({ source: 'agentMeshPanel' })
    expect(sessionPrompt).toHaveBeenCalledExactlyOnceWith(
      [{ type: 'text', text: 'delegate this exact task' }],
      'queue',
    )

    await fiber.dispose()
    declare()
    await ctx.fiber.dispose()
  })

  it('does not queue when the Harness Session is not open and surfaces admission failures', async () => {
    const { ctx, sessionPrompt, promptState, declare } = await baseContext()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const face = injectedFace(ctx.slots.entries('main')[0]!)
    const openError = new Error('session still opening')
    promptState.current = { openState: 'opening', openError }
    await expect(face.queueDispatchPrompt(SESSION_ID, 'task')).rejects.toBe(openError)
    expect(sessionPrompt).not.toHaveBeenCalled()

    promptState.current = { openState: 'opening', openError: undefined }
    await expect(face.queueDispatchPrompt(SESSION_ID, 'task')).rejects.toThrow()
    expect(sessionPrompt).not.toHaveBeenCalled()

    promptState.current = { openState: 'open', openError: undefined }
    const admissionError = new RemoteError('gateway/internal', 'prompt rejected', {})
    sessionPrompt.mockResolvedValueOnce({ ok: false, error: admissionError })
    await expect(face.queueDispatchPrompt(SESSION_ID, 'task')).rejects.toBe(admissionError)

    await fiber.dispose()
    declare()
    await ctx.fiber.dispose()
  })
})
