/**
 * The collaboration Remote surface: what the Web Client reads to show collaborations,
 * their plans, their boards, their tasks, and the worktrees those tasks run in, and
 * what it sends to move a plan, write a board, dispatch a task, or clean up a worktree.
 *
 * Every method delegates to `ctx.meshCollaboration`, so a Client never reads the
 * collaboration tables, git, or an agent's own store itself.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/controller
 */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteError, TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { CollaborationTaskRecord, PlanRecord, TodoBoardRecord, WorktreeRecord } from './domain.ts'
import { CollaborationError } from './errors.ts'
import type { CollaborationView, WorktreeView } from './types.ts'
import type {
  MeshCollaborationRow,
  MeshCollaborationStartRequest,
  MeshCollaborationRequest,
  MeshConflictFindingRow,
  MeshConflictReportRow,
  MeshContextPreviewRequest,
  MeshContextPreviewRow,
  MeshFileChangeRow,
  MeshPlanAdvanceRequest,
  MeshPlanPhaseRow,
  MeshPlanSetRequest,
  MeshTaskDispatchRequest,
  MeshTaskDispatchResponse,
  MeshTaskRow,
  MeshTodoBoardRow,
  MeshTodoRow,
  MeshTodosObserveRequest,
  MeshTodosObserveResponse,
  MeshTodosSetRequest,
  MeshWorktreeConflictsRequest,
  MeshWorktreeCreateRequest,
  MeshWorktreeIntegratedRequest,
  MeshWorktreeListRequest,
  MeshWorktreeRemoveRequest,
  MeshWorktreeRemoveResponse,
  MeshWorktreeRow,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No collaboration has that id. */
    'agent-mesh-collaboration/unknown-collaboration': { readonly collaborationId: string }
    /** No task of that collaboration has that id. */
    'agent-mesh-collaboration/unknown-task': { readonly collaborationId: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    meshCollaborationController: MeshCollaborationController
  }
}

/** The collaboration Remote service, mounted in the API assembly as `remote.meshCollaboration`. */
export class MeshCollaborationController extends TypertRemoteService {
  /** The collaboration service read by every Remote method. */
  static inject = ['meshCollaboration']

  /**
   * @param ctx - Owning context.
   */
  constructor(ctx: Context) {
    super(ctx, 'meshCollaborationController', { namespace: 'meshCollaboration' })
  }

  /**
   * Every collaboration, most recently changed first, or one collaboration.
   * @param collaborationId - Collaboration to read; null lists every one.
   * @param signal - Carrier cancellation.
   * @returns one row per collaboration.
   */
  @Remote('collaborations')
  remoteExportCollaborations(
    collaborationId: string | null,
    signal: AbortSignal,
  ): Promise<readonly MeshCollaborationRow[]> {
    return Promise.resolve().then(() => {
      signal.throwIfAborted()
      const views = collaborationId === null
        ? this.ctx.meshCollaboration.list()
        : [this.ctx.meshCollaboration.get(collaborationId)]
      return views.map(collaborationRow)
    })
  }

  /**
   * Create one collaboration.
   * @param request - Title, objective, repository, and optional task seeds.
   * @param signal - Carrier cancellation.
   * @returns the created collaboration.
   */
  @Remote('collaborationStart')
  async remoteExportCollaborationStart(request: MeshCollaborationStartRequest, signal: AbortSignal): Promise<MeshCollaborationRow> {
    signal.throwIfAborted()
    const view = await this.ctx.meshCollaboration.start({
      title: request.title,
      objective: request.objective,
      repoRoot: request.repoRoot,
      ...(request.tasks === undefined ? {} : {
        tasks: request.tasks.map(seed => ({
          title: seed.title,
          instruction: seed.instruction,
          assignee: seed.assignee,
          ...(seed.dependsOn === undefined ? {} : { dependsOn: seed.dependsOn }),
          ...(seed.isolation === undefined ? {} : { isolation: seed.isolation === 'shared-cwd' ? 'shared-cwd' : 'worktree' }),
        })),
      }),
    })
    return collaborationRow(view)
  }

  /**
   * Replace a collaboration's plan fields.
   * @param request - Collaboration, objective, and the fields to replace.
   * @param signal - Carrier cancellation.
   * @returns the plan after the write.
   */
  @Remote('planSet')
  async remoteExportPlanSet(request: MeshPlanSetRequest, signal: AbortSignal): Promise<readonly MeshPlanPhaseRow[]> {
    signal.throwIfAborted()
    const plan = await this.call(request.collaborationId, async () => await this.ctx.meshCollaboration.setPlan(request.collaborationId, {
      objective: request.objective,
      ...(request.phases === undefined ? {} : {
        phases: request.phases.map(phase => ({
          id: phase.id,
          title: phase.title,
          status: phase.status === 'done' ? 'done' : phase.status === 'active' ? 'active' : 'todo',
          ...(phase.exitCriteria === '' ? {} : { exitCriteria: phase.exitCriteria }),
        })),
      }),
      ...(request.activePhaseId === undefined ? {} : { activePhaseId: request.activePhaseId }),
      ...(request.decisions === undefined ? {} : { decisions: request.decisions }),
      ...(request.mode === undefined ? {} : { mode: request.mode === 'observe' ? 'observe' : 'inject' }),
    }))
    return plan.phases.map(phaseRow)
  }

  /**
   * Move a plan to a phase, marking every earlier phase done.
   * @param request - Collaboration and phase.
   * @param signal - Carrier cancellation.
   * @returns the plan phases after the write.
   */
  @Remote('planAdvance')
  async remoteExportPlanAdvance(request: MeshPlanAdvanceRequest, signal: AbortSignal): Promise<readonly MeshPlanPhaseRow[]> {
    signal.throwIfAborted()
    const plan = await this.call(
      request.collaborationId,
      () => this.ctx.meshCollaboration.advancePhase(request.collaborationId, request.phaseId),
    )
    return plan.phases.map(phaseRow)
  }

  /**
   * Render exactly the context a dispatched run for one agent would receive.
   * @param request - Collaboration and agent.
   * @param signal - Carrier cancellation.
   * @returns the block and its hash, or an unavailable result when the plan is observe-only.
   */
  @Remote('planContextPreview')
  async remoteExportPlanContextPreview(request: MeshContextPreviewRequest, signal: AbortSignal): Promise<MeshContextPreviewRow> {
    signal.throwIfAborted()
    const preview = await this.call(
      request.collaborationId,
      () => this.ctx.meshCollaboration.contextPreview(request.collaborationId, request.agentId),
    )
    return preview === undefined
      ? { available: false, text: '', hash: '' }
      : { available: true, text: preview.text, hash: preview.hash }
  }

  /**
   * Read one collaboration's todo board.
   * @param request - Collaboration to read.
   * @param signal - Carrier cancellation.
   * @returns the board with its revision.
   */
  @Remote('todosGet')
  async remoteExportTodosGet(request: MeshCollaborationRequest, signal: AbortSignal): Promise<MeshTodoBoardRow> {
    signal.throwIfAborted()
    return boardRow(await this.call(request.collaborationId, () => this.ctx.meshCollaboration.getTodos(request.collaborationId)))
  }

  /**
   * Replace one collaboration's todo board.
   * @param request - Collaboration, the complete new board, and the expected revision.
   * @param signal - Carrier cancellation.
   * @returns the board after the write.
   */
  @Remote('todosSet')
  async remoteExportTodosSet(request: MeshTodosSetRequest, signal: AbortSignal): Promise<MeshTodoBoardRow> {
    signal.throwIfAborted()
    const board = await this.call(request.collaborationId, async () => await this.ctx.meshCollaboration.setTodos(
      request.collaborationId,
      request.todos.map(todo => ({
        id: todo.id,
        content: todo.content,
        status: todo.status === 'in_progress'
          ? 'in_progress'
          : todo.status === 'completed'
            ? 'completed'
            : todo.status === 'blocked'
              ? 'blocked'
              : todo.status === 'cancelled' ? 'cancelled' : 'pending',
        ...(todo.owner === undefined ? {} : { owner: todo.owner }),
        ...(todo.blockedBy === undefined ? {} : { blockedBy: todo.blockedBy }),
      })),
      request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision },
    ))
    return boardRow(board)
  }

  /**
   * Fold one agent's own native task state into a collaboration's board.
   * @param request - Collaboration, agent, and optional session.
   * @param signal - Carrier cancellation.
   * @returns the board after the fold and how many items changed.
   */
  @Remote('todosObserve')
  async remoteExportTodosObserve(request: MeshTodosObserveRequest, signal: AbortSignal): Promise<MeshTodosObserveResponse> {
    signal.throwIfAborted()
    const sessionId = request.sessionId
    const outcome = await this.call(request.collaborationId, async () => sessionId === undefined
      ? await this.ctx.meshCollaboration.observeTodos(request.collaborationId, request.agentId)
      : await this.ctx.meshCollaboration.observeTodos(request.collaborationId, request.agentId, sessionId))
    return { observed: outcome.observed, board: boardRow(outcome.board), notes: [...outcome.notes] }
  }

  /**
   * Dispatch one collaboration task.
   * @param request - Collaboration, task, and dispatch options.
   * @param signal - Carrier cancellation.
   * @returns the run id, working directory, and injected context hash.
   */
  @Remote('taskDispatch')
  async remoteExportTaskDispatch(request: MeshTaskDispatchRequest, signal: AbortSignal): Promise<MeshTaskDispatchResponse> {
    signal.throwIfAborted()
    const result = await this.call(request.collaborationId, async () => await this.ctx.meshCollaboration.dispatchTask(
      request.collaborationId,
      request.taskId,
      {
        ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      },
    ))
    return {
      runId: result.runId,
      taskId: result.task.id,
      cwd: result.cwd,
      status: result.task.status,
      contextHash: result.context?.hash ?? '',
    }
  }

  /**
   * List worktrees with a live progress sample.
   * @param request - Optional repository filter.
   * @param signal - Carrier cancellation.
   * @returns one row per worktree, newest first.
   */
  @Remote('worktrees')
  async remoteExportWorktrees(request: MeshWorktreeListRequest, signal: AbortSignal): Promise<readonly MeshWorktreeRow[]> {
    signal.throwIfAborted()
    const views = await this.ctx.meshCollaboration.worktrees(request.repoRoot)
    return views.map(worktreeRow)
  }

  /**
   * Create or reuse one worktree.
   * @param request - Agent, repository, base ref, and labels.
   * @param signal - Carrier cancellation.
   * @returns the worktree with its first sample.
   */
  @Remote('worktreeCreate')
  async remoteExportWorktreeCreate(request: MeshWorktreeCreateRequest, signal: AbortSignal): Promise<MeshWorktreeRow> {
    signal.throwIfAborted()
    const view = await this.ctx.meshCollaboration.createWorktree({
      agentId: request.agentId,
      repoRoot: request.repoRoot,
      ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
      ...(request.label === undefined ? {} : { label: request.label }),
      ...(request.collaborationId === undefined ? {} : { collaborationId: request.collaborationId }),
      ...(request.reuse === undefined ? {} : { reuse: request.reuse }),
    })
    return worktreeRow(view)
  }

  /**
   * Compare the live worktrees of one repository.
   * @param request - Repository to analyse.
   * @param signal - Carrier cancellation.
   * @returns predicted same-file, same-hunk, feature-area, and base-commit findings.
   */
  @Remote('worktreeConflicts')
  async remoteExportWorktreeConflicts(request: MeshWorktreeConflictsRequest, signal: AbortSignal): Promise<MeshConflictReportRow> {
    signal.throwIfAborted()
    const report = await this.ctx.meshCollaboration.worktreeConflicts(request.repoRoot)
    return {
      repoRoot: report.repoRoot,
      at: report.at,
      worktrees: [...report.worktrees],
      findings: report.findings.map((finding): MeshConflictFindingRow => ({
        kind: finding.kind,
        severity: finding.severity,
        left: finding.left,
        right: finding.right,
        paths: [...finding.paths],
        detail: finding.detail,
      })),
      suggestedOrder: [...(report.suggestedOrder ?? [])],
      notes: [...report.notes],
    }
  }

  /**
   * Remove one worktree.
   * @param request - Worktree and whether uncommitted work may be discarded.
   * @param signal - Carrier cancellation.
   * @returns the removed worktree and whether its work was discarded.
   */
  @Remote('worktreeRemove')
  async remoteExportWorktreeRemove(request: MeshWorktreeRemoveRequest, signal: AbortSignal): Promise<MeshWorktreeRemoveResponse> {
    signal.throwIfAborted()
    const record = await this.ctx.meshCollaboration.removeWorktree(
      request.worktreeId,
      request.force === undefined ? {} : { force: request.force },
    )
    return { worktreeId: record.id, state: record.state, forced: request.force === true }
  }

  /**
   * Mark one worktree integrated, or outstanding again.
   * @param request - Worktree and the state to move it to.
   * @param signal - Carrier cancellation.
   * @returns the worktree after the write.
   */
  @Remote('worktreeIntegrated')
  async remoteExportWorktreeIntegrated(request: MeshWorktreeIntegratedRequest, signal: AbortSignal): Promise<MeshWorktreeRow> {
    signal.throwIfAborted()
    const record = await this.ctx.meshCollaboration.markWorktreeIntegrated(request.worktreeId, request.merged ?? true)
    return worktreeRow({ ...record })
  }

  /** Run one service call, mapping a missing referent onto the wire code. */
  private async call<T>(collaborationId: string, run: () => Promise<T> | T): Promise<T> {
    try {
      return await run()
    } catch (error: unknown) {
      if (error instanceof CollaborationError) {
        if (error.code === 'mesh/collaboration-not-found') {
          throw new RemoteError('agent-mesh-collaboration/unknown-collaboration', error.message, { collaborationId }, { cause: error })
        }
        if (error.code === 'mesh/task-not-found') {
          throw new RemoteError('agent-mesh-collaboration/unknown-task', error.message, { collaborationId }, { cause: error })
        }
      }
      throw error
    }
  }
}

/** Project one plan phase onto the wire. */
function phaseRow(phase: PlanRecord['phases'][number]): MeshPlanPhaseRow {
  return {
    id: phase.id,
    title: phase.title,
    status: phase.status,
    exitCriteria: phase.exitCriteria ?? '',
  }
}

/** Project one task onto the wire. */
function taskRow(task: CollaborationTaskRecord): MeshTaskRow {
  return {
    id: task.id,
    collaborationId: task.collaborationId,
    title: task.title,
    instruction: task.instruction,
    assignee: task.assignee,
    status: task.status,
    isolation: task.isolation,
    dependsOn: [...task.dependsOn],
    runId: task.runId ?? '',
    worktreeId: task.worktreeId ?? '',
    note: task.note ?? '',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/** Project one collaboration onto the wire. */
function collaborationRow(view: CollaborationView): MeshCollaborationRow {
  return {
    id: view.id,
    title: view.record.title,
    repoRoot: view.record.repoRoot,
    createdAt: view.record.createdAt,
    updatedAt: view.record.updatedAt,
    objective: view.plan.objective,
    mode: view.plan.mode,
    activePhaseId: view.plan.activePhaseId ?? '',
    phases: view.plan.phases.map(phaseRow),
    decisions: [...view.plan.decisions],
    todoRevision: view.board.revision,
    todoCount: view.board.todos.length,
    tasks: view.tasks.map(taskRow),
    worktrees: view.worktrees.map((worktree: WorktreeRecord) => ({
      id: worktree.id,
      path: worktree.path,
      branch: worktree.branch,
      state: worktree.state,
      runId: worktree.runId ?? '',
      taskId: worktree.taskId ?? '',
    })),
  }
}

/** Project one todo board onto the wire. */
function boardRow(board: TodoBoardRecord): MeshTodoBoardRow {
  return {
    collaborationId: board.collaborationId,
    revision: board.revision,
    updatedAt: board.updatedAt,
    todos: board.todos.map((todo): MeshTodoRow => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
      owner: todo.owner,
      blockedBy: [...todo.blockedBy],
      updatedAt: todo.updatedAt,
      nativeKey: todo.nativeKey ?? '',
      observedIn: todo.observedIn ?? '',
    })),
  }
}

/** Project one worktree with its sample onto the wire. */
function worktreeRow(view: WorktreeView): MeshWorktreeRow {
  const progress = view.progress
  const files: readonly MeshFileChangeRow[] = progress === undefined
    ? []
    : progress.files.map(file => ({ path: file.path, status: file.status }))
  return {
    id: view.id,
    path: view.path,
    repoRoot: view.repoRoot,
    branch: view.branch,
    baseCommit: view.baseCommit,
    baseRef: view.baseRef,
    agentId: view.agentId,
    state: view.state,
    reusable: view.reusable,
    collaborationId: view.collaborationId ?? '',
    taskId: view.taskId ?? '',
    runId: view.runId ?? '',
    changedFiles: files.length,
    dirty: progress?.dirty ?? false,
    ahead: progress?.ahead ?? 0,
    files,
    notes: progress === undefined ? [] : [...progress.notes],
    sampledAt: progress?.at ?? '',
  }
}

export default MeshCollaborationController
