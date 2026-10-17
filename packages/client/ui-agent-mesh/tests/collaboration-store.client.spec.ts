import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  MeshCollaborationRow,
  MeshConflictReportRow,
  MeshTaskRow,
  MeshTodoBoardRow,
  MeshWorktreeRow,
} from '@deepseek-ai/dsh-agent-mesh-collaboration/types'
import { createMeshCollaborationStore } from '../src/client/collaboration-store.ts'
import type { MeshCollaborationStoreDependencies } from '../src/client/collaboration-store.ts'

const COLLABORATION: MeshCollaborationRow = {
  id: 'collab-1', title: 'Fix the app', repoRoot: '/repo', createdAt: '', updatedAt: '',
  objective: 'Fix the app', mode: 'inject', activePhaseId: '', phases: [], decisions: [],
  todoRevision: 0, todoCount: 0, tasks: [], worktrees: [],
}
const BOARD: MeshTodoBoardRow = { collaborationId: COLLABORATION.id, revision: 1, updatedAt: '', todos: [] }
const WORKTREE: MeshWorktreeRow = {
  id: 'worktree-1', path: '/repo/.dsh-agent-mesh/worktrees/worktree-1', repoRoot: '/repo',
  branch: 'codex/worktree-1', baseCommit: 'base', baseRef: 'HEAD', agentId: 'codex',
  state: 'active', reusable: false, collaborationId: COLLABORATION.id, taskId: 'task-1', runId: '',
  changedFiles: 0, dirty: false, ahead: 0, files: [], notes: [], sampledAt: '',
}
const CONFLICTS: MeshConflictReportRow = {
  repoRoot: '/repo', at: '', worktrees: [WORKTREE.id], findings: [], suggestedOrder: [], notes: [],
}
const RUNNING_TASK: MeshTaskRow = {
  id: 'task-1', collaborationId: COLLABORATION.id, title: 'Implement the change', instruction: 'Make the change',
  assignee: 'codex', status: 'running', isolation: 'worktree', dependsOn: [], runId: 'run-1', worktreeId: WORKTREE.id,
  note: '', createdAt: '', updatedAt: '',
}

/** A Remote failure in the form returned by the client gateway. */
function failure<Value>(message: string): RemoteResult<Value> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

/** Build the four Remote methods and retain connection-reset listeners. */
function dependencies() {
  const resetListeners = new Set<() => void>()
  const deps: MeshCollaborationStoreDependencies = {
    collaborations: vi.fn(async (): Promise<RemoteResult<readonly MeshCollaborationRow[]>> => ({
      ok: true, value: [COLLABORATION],
    })),
    todosGet: vi.fn(async (request: { readonly collaborationId: string }): Promise<RemoteResult<MeshTodoBoardRow>> => ({
      ok: true, value: { ...BOARD, collaborationId: request.collaborationId },
    })),
    worktrees: vi.fn(async (): Promise<RemoteResult<readonly MeshWorktreeRow[]>> => ({ ok: true, value: [WORKTREE] })),
    worktreeConflicts: vi.fn(async (): Promise<RemoteResult<MeshConflictReportRow>> => ({ ok: true, value: CONFLICTS })),
    worktreeIntegrated: vi.fn(async (): Promise<RemoteResult<MeshWorktreeRow>> => ({
      ok: true, value: { ...WORKTREE, state: 'merged' },
    })),
    subscribeReset: vi.fn((listener: () => void) => {
      resetListeners.add(listener)
      return () => { resetListeners.delete(listener) }
    }),
  }
  return { deps, resetListeners }
}

afterEach(() => { vi.useRealTimers() })

describe('createMeshCollaborationStore', () => {
  it('loads selected records, refreshes requested conflicts, handles integration, and re-reads on reset', async () => {
    const { deps, resetListeners } = dependencies()
    const store = createMeshCollaborationStore(deps)
    const listener = vi.fn()
    const disposeFirst = store.hooks.collaboration.subscribe(listener)

    await store.actions.refreshAll()
    const snapshot = store.hooks.collaboration.getSnapshot()
    expect(snapshot.collaborations.status).toBe('ready')
    expect(snapshot.boards[COLLABORATION.id]?.status).toBe('ready')
    expect(snapshot.worktrees[COLLABORATION.repoRoot]?.status).toBe('ready')
    expect(store.hooks.collaboration.getSnapshot().selectedId).toBe(COLLABORATION.id)
    expect(deps.collaborations).toHaveBeenCalledWith(null)
    expect(deps.todosGet).toHaveBeenCalledWith({ collaborationId: COLLABORATION.id })
    expect(deps.worktrees).toHaveBeenCalledWith({ repoRoot: COLLABORATION.repoRoot })

    store.actions.select(COLLABORATION.id)
    await vi.waitFor(() => {
      expect(deps.todosGet).toHaveBeenCalledTimes(2)
      expect(deps.worktrees).toHaveBeenCalledTimes(2)
    })
    await store.actions.refreshConflicts(COLLABORATION.repoRoot)
    expect(store.hooks.collaboration.getSnapshot().conflicts[COLLABORATION.repoRoot]?.value).toEqual(CONFLICTS)
    await store.actions.refreshAll()
    expect(deps.worktreeConflicts).toHaveBeenCalledTimes(2)

    store.actions.select(COLLABORATION.id)
    store.actions.select('missing')
    await store.actions.markIntegrated(WORKTREE.id)
    expect(deps.worktreeIntegrated).toHaveBeenCalledWith({ worktreeId: WORKTREE.id })
    expect(store.hooks.collaboration.getSnapshot().pending).toEqual([])

    const disposeSecond = store.hooks.collaboration.subscribe(vi.fn())
    expect(deps.subscribeReset).toHaveBeenCalledOnce()
    expect(resetListeners.size).toBe(1)
    disposeFirst()
    expect(resetListeners.size).toBe(1)
    const reset = [...resetListeners][0]
    if (reset === undefined) throw new Error('connection-reset listener was not registered')
    const previousReadCount = vi.mocked(deps.collaborations).mock.calls.length
    reset()
    await vi.waitFor(() => { expect(deps.collaborations).toHaveBeenCalledTimes(previousReadCount + 1) })
    disposeSecond()
    expect(resetListeners.size).toBe(0)
    expect(store.hooks.collaboration.getSnapshot()).toMatchObject({
      collaborations: { status: 'idle', rows: [] }, selectedId: null, boards: {}, worktrees: {}, conflicts: {}, pending: [],
    })
  })

  it('retains failures as readable state and clears a rejected integration action', async () => {
    const { deps } = dependencies()
    vi.mocked(deps.collaborations).mockResolvedValueOnce(failure('list unavailable'))
    vi.mocked(deps.todosGet).mockRejectedValueOnce(new Error('board transport failed'))
    vi.mocked(deps.worktrees).mockRejectedValueOnce('worktree transport failed')
    vi.mocked(deps.worktreeConflicts).mockResolvedValueOnce(failure('conflicts unavailable'))
    vi.mocked(deps.worktreeIntegrated).mockResolvedValueOnce(failure('integration unavailable'))
    const store = createMeshCollaborationStore(deps)
    const dispose = store.hooks.collaboration.subscribe(vi.fn())

    await vi.waitFor(() => { expect(store.hooks.collaboration.getSnapshot().collaborations.status).toBe('error') })
    expect(store.hooks.collaboration.getSnapshot().collaborations.error).toBe('list unavailable')
    store.actions.select('missing')
    await store.actions.refreshAll()
    expect(store.hooks.collaboration.getSnapshot().boards[COLLABORATION.id]).toMatchObject({ status: 'error', error: 'board transport failed' })
    expect(store.hooks.collaboration.getSnapshot().worktrees[COLLABORATION.repoRoot]).toMatchObject({ status: 'error', error: 'worktree transport failed' })
    await store.actions.refreshConflicts(COLLABORATION.repoRoot)
    await expect(store.actions.markIntegrated(WORKTREE.id)).rejects.toThrow('integration unavailable')

    const snapshot = store.hooks.collaboration.getSnapshot()
    expect(snapshot.conflicts[COLLABORATION.repoRoot]).toMatchObject({ status: 'error', error: 'conflicts unavailable' })
    expect(snapshot.pending).toEqual([])
    dispose()
  })

  it('keeps an empty collaboration result unselected and retains sampled worktrees on refresh failure', async () => {
    const empty = dependencies()
    vi.mocked(empty.deps.collaborations).mockResolvedValue({ ok: true, value: [] })
    const emptyStore = createMeshCollaborationStore(empty.deps)
    await emptyStore.actions.refreshAll()
    expect(emptyStore.hooks.collaboration.getSnapshot()).toMatchObject({
      collaborations: { status: 'ready', rows: [] },
      selectedId: null,
    })

    const sampled = dependencies()
    const store = createMeshCollaborationStore(sampled.deps)
    await store.actions.refreshAll()
    vi.mocked(sampled.deps.worktrees).mockResolvedValueOnce(failure('worktree refresh failed'))
    await store.actions.refreshWorktrees(COLLABORATION.repoRoot)
    expect(store.hooks.collaboration.getSnapshot().worktrees[COLLABORATION.repoRoot]).toMatchObject({
      status: 'error',
      rows: [WORKTREE],
      error: 'worktree refresh failed',
    })
  })

  it('does not publish a conflict report after the last subscriber leaves', async () => {
    const { deps } = dependencies()
    const store = createMeshCollaborationStore(deps)
    const dispose = store.hooks.collaboration.subscribe(vi.fn())
    await vi.waitFor(() => { expect(store.hooks.collaboration.getSnapshot().collaborations.status).toBe('ready') })

    let resolveConflicts: (result: RemoteResult<MeshConflictReportRow>) => void = () => {}
    vi.mocked(deps.worktreeConflicts).mockImplementationOnce(() => new Promise((resolve) => { resolveConflicts = resolve }))
    const conflictsRead = store.actions.refreshConflicts(COLLABORATION.repoRoot)
    await vi.waitFor(() => { expect(deps.worktreeConflicts).toHaveBeenCalledOnce() })
    dispose()
    resolveConflicts({ ok: true, value: CONFLICTS })
    await conflictsRead

    expect(store.hooks.collaboration.getSnapshot().conflicts).toEqual({})
  })

  it('does not publish a superseded board read or work completed after the last subscriber leaves', async () => {
    const { deps } = dependencies()
    const store = createMeshCollaborationStore(deps)
    const dispose = store.hooks.collaboration.subscribe(vi.fn())
    await vi.waitFor(() => { expect(store.hooks.collaboration.getSnapshot().boards[COLLABORATION.id]?.status).toBe('ready') })

    let resolveOld: (result: RemoteResult<MeshTodoBoardRow>) => void = () => {}
    vi.mocked(deps.todosGet)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce({ ok: true, value: { ...BOARD, revision: 2 } })
    const oldRead = store.actions.refreshBoard(COLLABORATION.id)
    const newRead = store.actions.refreshBoard(COLLABORATION.id)
    await newRead
    resolveOld({ ok: true, value: { ...BOARD, revision: 1 } })
    await oldRead
    expect(store.hooks.collaboration.getSnapshot().boards[COLLABORATION.id]?.value?.revision).toBe(2)

    let resolveLateList: (result: RemoteResult<readonly MeshCollaborationRow[]>) => void = () => {}
    vi.mocked(deps.collaborations).mockImplementationOnce(() => new Promise((resolve) => { resolveLateList = resolve }))
    const staleList = store.actions.refreshAll()
    dispose()
    resolveLateList({ ok: true, value: [COLLABORATION] })
    await staleList
    expect(store.hooks.collaboration.getSnapshot().collaborations.status).toBe('idle')
    expect(store.hooks.collaboration.getSnapshot().selectedId).toBeNull()
  })

  it('polls idle collaboration records every 15 seconds and stops after the last subscriber leaves', async () => {
    vi.useFakeTimers()
    const { deps } = dependencies()
    const store = createMeshCollaborationStore(deps)
    const dispose = store.hooks.collaboration.subscribe(vi.fn())

    await store.actions.refreshAll()
    const snapshot = store.hooks.collaboration.getSnapshot()
    expect(snapshot.collaborations.status).toBe('ready')
    expect(snapshot.boards[COLLABORATION.id]?.status).toBe('ready')
    expect(snapshot.worktrees[COLLABORATION.repoRoot]?.status).toBe('ready')
    expect(deps.collaborations).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(deps.collaborations).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.collaborations).toHaveBeenCalledTimes(2)

    dispose()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.collaborations).toHaveBeenCalledTimes(2)
  })

  it('switches to the active cadence when a refresh finds a running task', async () => {
    vi.useFakeTimers()
    const { deps } = dependencies()
    vi.mocked(deps.collaborations)
      .mockResolvedValueOnce({ ok: true, value: [COLLABORATION] })
      .mockResolvedValue({ ok: true, value: [{ ...COLLABORATION, tasks: [RUNNING_TASK] }] })
    const store = createMeshCollaborationStore(deps)
    const dispose = store.hooks.collaboration.subscribe(vi.fn())

    await store.actions.refreshAll()
    const snapshot = store.hooks.collaboration.getSnapshot()
    expect(snapshot.collaborations.status).toBe('ready')
    expect(snapshot.boards[COLLABORATION.id]?.status).toBe('ready')
    expect(snapshot.worktrees[COLLABORATION.repoRoot]?.status).toBe('ready')
    await store.actions.refreshAll()
    expect(deps.collaborations).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(deps.collaborations).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.collaborations).toHaveBeenCalledTimes(3)

    dispose()
  })

  it('shares a full refresh while the same subscription generation is already loading', async () => {
    vi.useFakeTimers()
    const { deps } = dependencies()
    let resolveList: (result: RemoteResult<readonly MeshCollaborationRow[]>) => void = () => {}
    vi.mocked(deps.collaborations).mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve }))
    const store = createMeshCollaborationStore(deps)
    const dispose = store.hooks.collaboration.subscribe(vi.fn())

    const sharedRefresh = store.actions.refreshAll()
    expect(deps.collaborations).toHaveBeenCalledOnce()
    resolveList({ ok: true, value: [COLLABORATION] })
    await sharedRefresh
    expect(store.hooks.collaboration.getSnapshot().boards[COLLABORATION.id]?.status).toBe('ready')
    dispose()
  })

  it('queues a fresh read when the connection resets during an in-flight refresh', async () => {
    vi.useFakeTimers()
    const { deps, resetListeners } = dependencies()
    let resolveList: (result: RemoteResult<readonly MeshCollaborationRow[]>) => void = () => {}
    vi.mocked(deps.collaborations).mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve }))
    const store = createMeshCollaborationStore(deps)
    const dispose = store.hooks.collaboration.subscribe(vi.fn())
    const reset = [...resetListeners][0]
    if (reset === undefined) throw new Error('connection-reset listener was not registered')
    reset()
    expect(deps.collaborations).toHaveBeenCalledOnce()

    resolveList({ ok: true, value: [COLLABORATION] })
    await vi.waitFor(() => { expect(deps.collaborations).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => {
      expect(deps.todosGet).toHaveBeenCalledTimes(2)
      expect(deps.worktrees).toHaveBeenCalledTimes(2)
      expect(store.hooks.collaboration.getSnapshot().boards[COLLABORATION.id]?.status).toBe('ready')
      expect(store.hooks.collaboration.getSnapshot().worktrees[COLLABORATION.repoRoot]?.status).toBe('ready')
    })

    dispose()
  })

  it('does not queue a connection-reset refresh after the last subscriber leaves', async () => {
    const { deps, resetListeners } = dependencies()
    let resolveList: (result: RemoteResult<readonly MeshCollaborationRow[]>) => void = () => {}
    vi.mocked(deps.collaborations).mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve }))
    const store = createMeshCollaborationStore(deps)
    const inFlight = store.actions.refreshAll()
    const dispose = store.hooks.collaboration.subscribe(vi.fn())
    const reset = [...resetListeners][0]
    if (reset === undefined) throw new Error('connection-reset listener was not registered')
    reset()
    dispose()

    resolveList({ ok: true, value: [COLLABORATION] })
    await inFlight
    await vi.waitFor(() => { expect(deps.collaborations).toHaveBeenCalledOnce() })
    expect(store.hooks.collaboration.getSnapshot().collaborations.status).toBe('idle')
  })

  it('releases a rejected refresh flight so a later refresh can succeed', async () => {
    const { deps } = dependencies()
    const store = createMeshCollaborationStore(deps)
    let failFirstPublish = true
    const dispose = store.hooks.collaboration.subscribe(() => {
      if (failFirstPublish && store.hooks.collaboration.getSnapshot().collaborations.status === 'loading') {
        failFirstPublish = false
        throw new Error('consumer listener failed')
      }
    })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    dispose()

    await expect(store.actions.refreshAll()).resolves.toBeUndefined()
    expect(store.hooks.collaboration.getSnapshot().collaborations.status).toBe('ready')
  })

  it('does not update pending integration state after the last subscriber leaves', async () => {
    const { deps } = dependencies()
    const store = createMeshCollaborationStore(deps)
    const dispose = store.hooks.collaboration.subscribe(vi.fn())
    await vi.waitFor(() => { expect(store.hooks.collaboration.getSnapshot().collaborations.status).toBe('ready') })
    let resolveIntegration: (result: RemoteResult<MeshWorktreeRow>) => void = () => {}
    vi.mocked(deps.worktreeIntegrated).mockImplementationOnce(() => new Promise((resolve) => { resolveIntegration = resolve }))

    const integration = store.actions.markIntegrated(WORKTREE.id)
    expect(store.hooks.collaboration.getSnapshot().pending).toEqual([`integrate:${WORKTREE.id}`])
    dispose()
    resolveIntegration({ ok: true, value: { ...WORKTREE, state: 'merged' } })
    await integration

    expect(store.hooks.collaboration.getSnapshot()).toMatchObject({ pending: [], collaborations: { status: 'idle' } })
    expect(deps.collaborations).toHaveBeenCalledOnce()
  })

  it('does not duplicate the pending integration key when an action is repeated', async () => {
    const { deps } = dependencies()
    const store = createMeshCollaborationStore(deps)
    await store.actions.refreshAll()
    let resolveIntegration: (result: RemoteResult<MeshWorktreeRow>) => void = () => {}
    const integrationResult = new Promise<RemoteResult<MeshWorktreeRow>>((resolve) => { resolveIntegration = resolve })
    vi.mocked(deps.worktreeIntegrated).mockImplementation(() => integrationResult)

    const first = store.actions.markIntegrated(WORKTREE.id)
    const second = store.actions.markIntegrated(WORKTREE.id)
    expect(store.hooks.collaboration.getSnapshot().pending).toEqual([`integrate:${WORKTREE.id}`])
    resolveIntegration({ ok: true, value: { ...WORKTREE, state: 'merged' } })
    await Promise.all([first, second])
    expect(store.hooks.collaboration.getSnapshot().pending).toEqual([])
  })

  it('does not let an old subscription refresh or settlement affect a remounted source', async () => {
    vi.useFakeTimers()
    const { deps } = dependencies()
    let resolveOldList: (result: RemoteResult<readonly MeshCollaborationRow[]>) => void = () => {}
    vi.mocked(deps.collaborations).mockImplementationOnce(() => new Promise((resolve) => { resolveOldList = resolve }))
    const store = createMeshCollaborationStore(deps)
    const disposeFirst = store.hooks.collaboration.subscribe(vi.fn())
    disposeFirst()
    const disposeSecond = store.hooks.collaboration.subscribe(vi.fn())

    await store.actions.refreshAll()
    const snapshot = store.hooks.collaboration.getSnapshot()
    expect(snapshot.collaborations.status).toBe('ready')
    expect(snapshot.boards[COLLABORATION.id]?.status).toBe('ready')
    expect(snapshot.worktrees[COLLABORATION.repoRoot]?.status).toBe('ready')
    resolveOldList({ ok: true, value: [COLLABORATION] })
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.collaborations).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(deps.collaborations).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.collaborations).toHaveBeenCalledTimes(3)

    disposeSecond()
  })

  it('stops a full refresh when the last subscriber leaves during worktree sampling', async () => {
    const { deps } = dependencies()
    const store = createMeshCollaborationStore(deps)
    const dispose = store.hooks.collaboration.subscribe(vi.fn())
    await vi.waitFor(() => {
      const snapshot = store.hooks.collaboration.getSnapshot()
      expect(snapshot.boards[COLLABORATION.id]?.status).toBe('ready')
      expect(snapshot.worktrees[COLLABORATION.repoRoot]?.status).toBe('ready')
    })

    let resolveLateWorktrees: (result: RemoteResult<readonly MeshWorktreeRow[]>) => void = () => {}
    vi.mocked(deps.worktrees).mockImplementationOnce(() => new Promise((resolve) => { resolveLateWorktrees = resolve }))
    const refresh = store.actions.refreshAll()
    await vi.waitFor(() => { expect(deps.worktrees).toHaveBeenCalledTimes(2) })
    dispose()
    resolveLateWorktrees({ ok: true, value: [WORKTREE] })
    await refresh

    expect(store.hooks.collaboration.getSnapshot()).toMatchObject({
      collaborations: { status: 'idle', rows: [] }, selectedId: null, boards: {}, worktrees: {}, conflicts: {},
    })
  })

  it('does not poll when the source has no subscribers', async () => {
    vi.useFakeTimers()
    const { deps } = dependencies()
    const store = createMeshCollaborationStore(deps)

    await store.actions.refreshAll()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(deps.collaborations).toHaveBeenCalledOnce()
  })
})
