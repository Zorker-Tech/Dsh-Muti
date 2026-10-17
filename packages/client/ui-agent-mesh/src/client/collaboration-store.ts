/**
 * Remote-backed collaboration panel source. It reads the collaboration list,
 * one shared todo board, worktree progress, and optional conflict reports;
 * every view uses the same snapshots and refresh actions.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MeshCollaborationRow,
  MeshConflictReportRow,
  MeshTodoBoardRow,
  MeshWorktreeRow,
} from '@deepseek-ai/dsh-agent-mesh-collaboration/types'
import type { MeshListState, MeshValueState } from './mesh-store.ts'

/** One Remote call reduced to its value or a message safe to render. */
type ReadOutcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly message: string }

/** Values the collaboration panel reads through the generated Remote client. */
export interface MeshCollaborationStoreDependencies {
  /** List every collaboration, newest change first. */
  readonly collaborations: (collaborationId: null) => Promise<RemoteResult<readonly MeshCollaborationRow[]>>
  /** Read one collaboration's revisioned shared todo board. */
  readonly todosGet: (request: { readonly collaborationId: string }) => Promise<RemoteResult<MeshTodoBoardRow>>
  /** Read live worktree progress for one repository. */
  readonly worktrees: (request: { readonly repoRoot: string }) => Promise<RemoteResult<readonly MeshWorktreeRow[]>>
  /** Compare live worktrees in one repository. */
  readonly worktreeConflicts: (request: { readonly repoRoot: string }) => Promise<RemoteResult<MeshConflictReportRow>>
  /** Mark one worktree integrated. */
  readonly worktreeIntegrated: (request: { readonly worktreeId: string }) => Promise<RemoteResult<MeshWorktreeRow>>
  /** Subscribe to API reconnection so visible data can be re-read. */
  readonly subscribeReset: (listener: () => void) => () => void
}

/** Shared facts displayed by the collaboration page. */
export interface MeshCollaborationSnapshot {
  /** Known collaborations; retained while a refresh is in flight or fails. */
  readonly collaborations: MeshListState<MeshCollaborationRow>
  /** Collaboration selected by the page. */
  readonly selectedId: string | null
  /** Boards keyed by collaboration id. */
  readonly boards: Readonly<Record<string, MeshValueState<MeshTodoBoardRow>>>
  /** Live worktree rows keyed by repository root. */
  readonly worktrees: Readonly<Record<string, MeshListState<MeshWorktreeRow>>>
  /** Conflict reports keyed by repository root. */
  readonly conflicts: Readonly<Record<string, MeshValueState<MeshConflictReportRow>>>
  /** Mutating operations currently in flight. */
  readonly pending: readonly string[]
}

/** Refresh and selection actions exposed to the collaboration view. */
export interface MeshCollaborationActions {
  /** Re-read the list and the selected collaboration's board and worktrees. */
  readonly refreshAll: () => Promise<void>
  /** Select a collaboration and read its board and worktrees. */
  readonly select: (collaborationId: string) => void
  /** Re-read one collaboration's shared todo board. */
  readonly refreshBoard: (collaborationId: string) => Promise<void>
  /** Re-read one repository's worktree progress. */
  readonly refreshWorktrees: (repoRoot: string) => Promise<void>
  /** Recompute one repository's advisory conflict report. */
  readonly refreshConflicts: (repoRoot: string) => Promise<void>
  /** Mark one worktree integrated, then refresh its repository and the list. */
  readonly markIntegrated: (worktreeId: string) => Promise<void>
}

/** One source: snapshot observable plus its read and mutation actions. */
export interface MeshCollaborationStore {
  readonly hooks: { readonly collaboration: HostObservable<MeshCollaborationSnapshot> }
  readonly actions: MeshCollaborationActions
}

const IDLE_LIST: MeshListState<never> = { status: 'idle', rows: [], error: null }
const IDLE_VALUE: MeshValueState<never> = { status: 'idle', value: null, error: null }

/** Fold a Remote or transport failure into a renderable message. */
async function readCall<Value>(call: () => Promise<RemoteResult<Value>>): Promise<ReadOutcome<Value>> {
  let result: RemoteResult<Value>
  try {
    result = await call()
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message }
}

/**
 * Create the Remote-backed collaboration source.
 * @param deps - Collaboration Remote calls and the connection-reset subscription.
 * @returns the observable snapshot and the actions that update it.
 */
export function createMeshCollaborationStore(deps: MeshCollaborationStoreDependencies): MeshCollaborationStore {
  const IDLE_REFRESH_INTERVAL_MS = 15_000
  const ACTIVE_REFRESH_INTERVAL_MS = 3_000
  let snapshot: MeshCollaborationSnapshot = {
    collaborations: IDLE_LIST,
    selectedId: null,
    boards: {},
    worktrees: {},
    conflicts: {},
    pending: [],
  }
  const listeners = new Set<() => void>()
  const epochs = new Map<string, number>()
  let generation = 0
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let refreshFlight: { readonly generation: number; readonly promise: Promise<void> } | undefined
  let queuedRefreshGeneration: number | undefined
  let disposeReset: (() => void) | undefined

  const publish = (next: MeshCollaborationSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const beginRead = (key: string): { readonly epoch: number; readonly generation: number } => {
    const epoch = (epochs.get(key) ?? 0) + 1
    epochs.set(key, epoch)
    return { epoch, generation }
  }
  const mayPublish = (key: string, token: { readonly epoch: number; readonly generation: number }): boolean =>
    generation === token.generation && epochs.get(key) === token.epoch
  const withPending = (key: string, pending: boolean): void => {
    publish({
      ...snapshot,
      pending: pending
        ? (snapshot.pending.includes(key) ? snapshot.pending : [...snapshot.pending, key])
        : snapshot.pending.filter(item => item !== key),
    })
  }

  const loadCollaborations = async (): Promise<void> => {
    const key = 'collaborations'
    const token = beginRead(key)
    publish({ ...snapshot, collaborations: { ...snapshot.collaborations, status: 'loading' } })
    const outcome = await readCall(() => deps.collaborations(null))
    if (!mayPublish(key, token)) return
    if (!outcome.ok) {
      publish({
        ...snapshot,
        collaborations: { status: 'error', rows: snapshot.collaborations.rows, error: outcome.message },
      })
      return
    }
    const selectedId = snapshot.selectedId !== null && outcome.value.some(row => row.id === snapshot.selectedId)
      ? snapshot.selectedId
      : outcome.value[0]?.id ?? null
    publish({
      ...snapshot,
      collaborations: { status: 'ready', rows: outcome.value, error: null },
      selectedId,
    })
  }

  const loadBoard = async (collaborationId: string): Promise<void> => {
    const key = `board:${collaborationId}`
    const token = beginRead(key)
    const previous = snapshot.boards[collaborationId] ?? IDLE_VALUE
    publish({
      ...snapshot,
      boards: {
        ...snapshot.boards,
        [collaborationId]: { ...previous, status: 'loading' },
      },
    })
    const outcome = await readCall(() => deps.todosGet({ collaborationId }))
    if (!mayPublish(key, token)) return
    publish({
      ...snapshot,
      boards: {
        ...snapshot.boards,
        [collaborationId]: outcome.ok
          ? { status: 'ready', value: outcome.value, error: null }
          : { status: 'error', value: snapshot.boards[collaborationId]?.value ?? null, error: outcome.message },
      },
    })
  }

  const loadWorktrees = async (repoRoot: string): Promise<void> => {
    const key = `worktrees:${repoRoot}`
    const token = beginRead(key)
    const previous = snapshot.worktrees[repoRoot] ?? IDLE_LIST
    publish({
      ...snapshot,
      worktrees: { ...snapshot.worktrees, [repoRoot]: { ...previous, status: 'loading' } },
    })
    const outcome = await readCall(() => deps.worktrees({ repoRoot }))
    if (!mayPublish(key, token)) return
    publish({
      ...snapshot,
      worktrees: {
        ...snapshot.worktrees,
        [repoRoot]: outcome.ok
          ? { status: 'ready', rows: outcome.value, error: null }
          : { status: 'error', rows: previous.rows, error: outcome.message },
      },
    })
  }

  const loadConflicts = async (repoRoot: string): Promise<void> => {
    const key = `conflicts:${repoRoot}`
    const token = beginRead(key)
    const previous = snapshot.conflicts[repoRoot] ?? IDLE_VALUE
    publish({
      ...snapshot,
      conflicts: { ...snapshot.conflicts, [repoRoot]: { ...previous, status: 'loading' } },
    })
    const outcome = await readCall(() => deps.worktreeConflicts({ repoRoot }))
    if (!mayPublish(key, token)) return
    publish({
      ...snapshot,
      conflicts: {
        ...snapshot.conflicts,
        [repoRoot]: outcome.ok
          ? { status: 'ready', value: outcome.value, error: null }
          : { status: 'error', value: snapshot.conflicts[repoRoot]?.value ?? null, error: outcome.message },
      },
    })
  }

  const refreshSnapshot = async (expectedGeneration: number): Promise<void> => {
    await loadCollaborations()
    if (generation !== expectedGeneration) return
    const selectedId = snapshot.selectedId
    const collaboration = selectedId === null
      ? undefined
      : snapshot.collaborations.rows.find(row => row.id === selectedId)
    if (collaboration === undefined) return
    await Promise.all([loadBoard(collaboration.id), loadWorktrees(collaboration.repoRoot)])
    if (generation !== expectedGeneration) return
    const existingConflict = snapshot.conflicts[collaboration.repoRoot]
    if (existingConflict !== undefined && existingConflict.status !== 'idle') {
      await loadConflicts(collaboration.repoRoot)
    }
  }

  const refreshAll = (force = false): Promise<void> => {
    const currentGeneration = generation
    if (refreshFlight?.generation === currentGeneration) {
      if (force) queuedRefreshGeneration = currentGeneration
      return refreshFlight.promise
    }
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    pollTimer = undefined
    const promise = refreshSnapshot(currentGeneration)
    const flight = { generation: currentGeneration, promise }
    refreshFlight = flight
    void promise.then(() => { settleRefresh(flight) }, () => { settleRefresh(flight) })
    return promise
  }

  function schedulePoll(expectedGeneration: number): void {
    if (listeners.size === 0 || expectedGeneration !== generation) return
    const hasRunningTask = snapshot.collaborations.rows.some(row => row.tasks.some(task => task.status === 'running'))
    const delay = hasRunningTask ? ACTIVE_REFRESH_INTERVAL_MS : IDLE_REFRESH_INTERVAL_MS
    pollTimer = setTimeout(() => {
      pollTimer = undefined
      void refreshAll()
    }, delay)
  }

  function settleRefresh(flight: { readonly generation: number; readonly promise: Promise<void> }): void {
    if (refreshFlight !== flight) return
    refreshFlight = undefined
    if (queuedRefreshGeneration === flight.generation) {
      queuedRefreshGeneration = undefined
      /* v8 ignore next -- removing the final subscriber clears queuedRefreshGeneration before incrementing generation. */
      if (listeners.size > 0 && generation === flight.generation) {
        void refreshAll()
        return
      }
    }
    schedulePoll(flight.generation)
  }

  const actions: MeshCollaborationActions = {
    refreshAll,
    select: (collaborationId) => {
      publish({ ...snapshot, selectedId: collaborationId })
      const collaboration = snapshot.collaborations.rows.find(row => row.id === collaborationId)
      if (collaboration === undefined) return
      void Promise.all([loadBoard(collaborationId), loadWorktrees(collaboration.repoRoot)])
      if (snapshot.conflicts[collaboration.repoRoot] !== undefined) void loadConflicts(collaboration.repoRoot)
    },
    refreshBoard: loadBoard,
    refreshWorktrees: loadWorktrees,
    refreshConflicts: loadConflicts,
    markIntegrated: async (worktreeId) => {
      const pendingKey = `integrate:${worktreeId}`
      const actionGeneration = generation
      withPending(pendingKey, true)
      const outcome = await readCall(() => deps.worktreeIntegrated({ worktreeId }))
      if (generation !== actionGeneration) return
      withPending(pendingKey, false)
      if (!outcome.ok) throw new Error(outcome.message)
      await Promise.all([loadWorktrees(outcome.value.repoRoot), loadCollaborations()])
    },
  }

  return {
    hooks: {
      collaboration: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) {
            disposeReset = deps.subscribeReset(() => { void refreshAll(true) })
            void refreshAll()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size !== 0) return
            if (pollTimer !== undefined) clearTimeout(pollTimer)
            pollTimer = undefined
            queuedRefreshGeneration = undefined
            disposeReset?.()
            disposeReset = undefined
            generation++
            epochs.clear()
            publish({
              collaborations: IDLE_LIST,
              selectedId: null,
              boards: {},
              worktrees: {},
              conflicts: {},
              pending: [],
            })
          }
        },
      },
    },
    actions,
  }
}
