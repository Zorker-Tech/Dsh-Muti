/**
 * Worktree-isolated collaborative multi-agent work (`ctx.meshCollaboration`): one
 * authoritative plan, one shared todo board, per-agent git worktrees, cross-agent
 * progress sampling, and predicted conflict reports.
 *
 * The service is the only place that decides isolation. A dispatched task either
 * runs in a mesh-owned worktree created for its agent, or in the collaboration's own
 * working directory when it asks for that; the run then receives the plan and board
 * as injected context, and its run id is recorded on the task.
 *
 * Every durable record is mesh-owned: the domain is declared here, versioned here,
 * and read only through `ctx.storageDomain`. No session-format, session-event, or
 * session-query schema changes with this package.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createContextHost } from '@deepseek-ai/dsh-agent-mesh'
import type { AgentHost } from '@deepseek-ai/dsh-agent-mesh'
import { CollaborationBoard, renderPrompt } from './boards.ts'
import type { CollaborationTables } from './boards.ts'
import { MeshCollaborationController } from './controller.ts'
import { collaborationDomainSpec } from './domain.ts'
import type { CollaborationTaskRecord, PlanRecord, TodoBoardRecord, WorktreeRecord } from './domain.ts'
import { CollaborationError } from './errors.ts'
import { GitRunner } from './git.ts'
import { registerCollaborationTools } from './tools.ts'
import { WorktreeManager } from './worktrees.ts'
import type {
  CollaborationMeshPort,
  CollaborationView,
  ConflictReport,
  ContextPreview,
  CreateWorktreeRequest,
  DispatchOptions,
  IsolationMode,
  ObserveOutcome,
  PlanPatch,
  RemoveWorktreeOptions,
  SetTodosOptions,
  StartCollaborationRequest,
  TaskDispatchResult,
  TodoInput,
  WorktreeView,
} from './types.ts'

export { CollaborationError } from './errors.ts'
export type { CollaborationErrorCode } from './errors.ts'
// The Remote controller is exported from the entry so it stays inside the package's
// public export graph: the Typert pass analyzes that graph, and a controller outside
// it would publish no methods.
export { MeshCollaborationController }
export { collaborationDomainSpec } from './domain.ts'
export { CollaborationBoard, contentHash, renderContext, renderPrompt } from './boards.ts'
export type { CollaborationTables } from './boards.ts'
export { GitRunner, parseStatus, statusKind } from './git.ts'
export type { GitCommandResult, GitHunk, GitRunnerOptions, GitStatusEntry, GitWorktreeEntry } from './git.ts'
export { WorktreeManager } from './worktrees.ts'
export type { WorktreeManagerOptions } from './worktrees.ts'
export type * from './types.ts'
export type {
  CollaborationId,
  CollaborationRecord,
  CollaborationTaskId,
  CollaborationTaskRecord,
  FileChangeStat,
  FileChangeStatus,
  PlanPhase,
  PlanRecord,
  TodoBoardRecord,
  WorktreeId,
  WorktreeProgress,
  WorktreeRecord,
} from './domain.ts'

/** Cordis plugin name. */
export const name = 'agent-mesh-collaboration'
/** The storage hub, the mesh registry, and the tool runtime must all be present. */
export const inject = ['storageDomain', 'agentMesh', 'tools']

/** Deployment choices for worktree isolation. */
export interface Config {
  /** Mesh-owned directory inside a repository holding created worktrees. */
  worktreeDir?: string
  /** Prefix for the branch created for one worktree. */
  branchPrefix?: string
  /** Git executable; a bare name is resolved through the child's `PATH`. */
  gitCommand?: string
  /** Wall-clock budget for one git command, in milliseconds. */
  gitTimeoutMs?: number
  /** Commit-ish a worktree branches from when neither the task nor the caller names one. */
  baseRef?: string
  /** Isolation a task seeded without one gets. */
  defaultIsolation?: IsolationMode
  /** Whether same-hunk overlaps are warnings or blocking findings. */
  conflictPolicy?: 'report' | 'block'
  /** Repository-relative path prefixes used to identify shared feature areas. */
  featureBoundaries?: string[]
}

/** {@link Config} with every default applied. */
interface ResolvedConfig {
  readonly worktreeDir: string
  readonly branchPrefix: string
  readonly gitCommand: string
  readonly gitTimeoutMs: number
  readonly defaultIsolation: IsolationMode
  readonly conflictPolicy: 'report' | 'block'
  readonly featureBoundaries: readonly string[]
  readonly baseRef?: string
}

/** Everything bound once the domain is open. */

/**
 * Apply the plugin's defaults to one caller configuration.
 * @param config - Caller configuration; every field is optional.
 * @returns the resolved configuration, with every default explicit.
 */
function resolveConfig(config: Config): ResolvedConfig {
  return {
    worktreeDir: config.worktreeDir ?? '.dsh-agent-mesh',
    branchPrefix: config.branchPrefix ?? 'agent-mesh/',
    gitCommand: config.gitCommand ?? 'git',
    gitTimeoutMs: config.gitTimeoutMs ?? 60_000,
    defaultIsolation: config.defaultIsolation ?? 'worktree',
    conflictPolicy: config.conflictPolicy ?? 'report',
    featureBoundaries: [...(config.featureBoundaries ?? [])],
    ...(config.baseRef === undefined ? {} : { baseRef: config.baseRef }),
  }
}

interface CollaborationRuntime {
  /** Host that runs git and reports the clock. */
  readonly host: AgentHost
  /** The five domain tables. */
  readonly tables: CollaborationTables
  /** Plans, board and tasks. */
  readonly board: CollaborationBoard
  /** Worktree lifecycle. */
  readonly worktrees: WorktreeManager
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    meshCollaboration: MeshCollaboration
  }
}

/**
 * The collaboration service.
 *
 * It owns the domain, the worktree manager, and the plan and board documents; a
 * consumer reaches all of them through this one key, and no other package writes
 * the collaboration tables.
 */
export class MeshCollaboration extends Service {
  /** The storage hub, the mesh registry, and the tool runtime. */
  static inject = ['storageDomain', 'agentMesh', 'tools']

  /** Validated plugin config. */
  static Config: z<Config> = z.object({
    worktreeDir: z.string().default('.dsh-agent-mesh'),
    branchPrefix: z.string().default('agent-mesh/'),
    gitCommand: z.string().default('git'),
    gitTimeoutMs: z.number().step(1).min(1).default(60_000),
    baseRef: z.string(),
    defaultIsolation: z.union(['worktree', 'shared-cwd']).default('worktree'),
    conflictPolicy: z.union(['report', 'block']).default('report'),
    featureBoundaries: z.array(z.string().min(1)).default([]),
  })

  private readonly config: ResolvedConfig
  private runtime?: CollaborationRuntime
  /** Set once the service unloads, so a late run settlement writes nothing. */
  private disposed = false
  private readonly settling = new Set<Promise<void>>()

  /**
   * @param ctx - Owning context.
   * @param config - Caller configuration; every field is optional and defaulted explicitly.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'meshCollaboration')
    this.config = resolveConfig(config)
  }

  /** Open the collaboration domain and bind the owners to its tables. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(collaborationDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'agent-mesh-collaboration.domainClose')
    this.ctx.effect(() => () => { this.disposed = true }, 'agent-mesh-collaboration.runObservers')
    const host = this.createHost()
    const tables: CollaborationTables = {
      collaborations: domain.table('collaborations'),
      plans: domain.table('plans'),
      todos: domain.table('todos'),
      tasks: domain.table('tasks'),
      worktrees: domain.table('worktrees'),
    }
    const board = new CollaborationBoard(tables, () => new Date(host.now()).toISOString())
    const worktrees = new WorktreeManager(
      host,
      new GitRunner(host, { command: this.config.gitCommand, timeoutMs: this.config.gitTimeoutMs }),
      tables.worktrees,
      {
        worktreeDir: this.config.worktreeDir,
        branchPrefix: this.config.branchPrefix,
        ...(this.config.baseRef === undefined ? {} : { baseRef: this.config.baseRef }),
        conflictPolicy: this.config.conflictPolicy,
        featureBoundaries: this.config.featureBoundaries,
      },
    )
    this.runtime = { host, tables, board, worktrees }
    registerCollaborationTools(this.ctx)
  }

  /**
   * Build the host processes run through.
   *
   * A test substitutes a fake host by overriding this method, which is why the host
   * is built here rather than in the constructor.
   * @returns the harness-backed host.
   */
  protected createHost(): AgentHost {
    return createContextHost(this.ctx)
  }

  /**
   * Create one collaboration with its plan, its board, and its initial tasks.
   * @param request - Title, objective, repository, and optional task seeds.
   * @returns the created collaboration.
   */
  async start(request: StartCollaborationRequest): Promise<CollaborationView> {
    return await this.requireRuntime().board.start(request, this.config.defaultIsolation)
  }

  /**
   * Every collaboration, most recently changed first.
   * @returns one view per collaboration, without live worktree samples.
   */
  list(): readonly CollaborationView[] {
    return this.requireRuntime().board.list()
  }

  /**
   * Read one collaboration.
   * @param collaborationId - Collaboration id.
   * @returns the collaboration with its plan, board, tasks and worktrees.
   */
  get(collaborationId: string): CollaborationView {
    return this.requireRuntime().board.view(collaborationId)
  }

  /**
   * Read one collaboration's plan.
   * @param collaborationId - Collaboration id.
   * @returns the plan.
   */
  plan(collaborationId: string): PlanRecord {
    return this.requireRuntime().board.plan(collaborationId)
  }

  /**
   * Replace a collaboration's plan fields.
   * @param collaborationId - Collaboration id.
   * @param patch - Fields to replace; an absent field keeps its current value.
   * @returns the plan after the write.
   */
  async setPlan(collaborationId: string, patch: PlanPatch): Promise<PlanRecord> {
    return await this.requireRuntime().board.setPlan(collaborationId, patch)
  }

  /**
   * Move the plan to a phase, marking every earlier phase done.
   * @param collaborationId - Collaboration id.
   * @param phaseId - Phase to activate.
   * @returns the plan after the write.
   */
  async advancePhase(collaborationId: string, phaseId: string): Promise<PlanRecord> {
    return await this.requireRuntime().board.advancePhase(collaborationId, phaseId)
  }

  /**
   * Read a collaboration's todo board.
   * @param collaborationId - Collaboration id.
   * @returns the board with its revision.
   */
  getTodos(collaborationId: string): TodoBoardRecord {
    return this.requireRuntime().board.board(collaborationId)
  }

  /**
   * Replace a collaboration's todo board.
   * @param collaborationId - Collaboration id.
   * @param todos - The complete new board.
   * @param options - Expected revision; a mismatch is refused rather than applied.
   * @returns the board after the write.
   */
  async setTodos(collaborationId: string, todos: readonly TodoInput[], options: SetTodosOptions = {}): Promise<TodoBoardRecord> {
    return await this.requireRuntime().board.setTodos(collaborationId, todos, options)
  }

  /**
   * Fold one agent's own native task state into a collaboration's board.
   * @param collaborationId - Collaboration id.
   * @param agentId - Agent whose store is read.
   * @param sessionId - The agent's native session id; its newest session when omitted.
   * @returns the board, how many items changed, and what could not be observed.
   */
  async observeTodos(collaborationId: string, agentId: string, sessionId?: string): Promise<ObserveOutcome> {
    const runtime = this.requireRuntime()
    runtime.board.view(collaborationId)
    const adapter = this.mesh.adapter(agentId)
    const sessions = await adapter.listSessions({})
    const session = sessionId === undefined
      ? sessions[0]
      : sessions.find(candidate => candidate.nativeId === sessionId)
    if (session === undefined) {
      throw new CollaborationError(
        'mesh/session-not-found',
        sessionId === undefined
          ? `agent "${agentId}" has no session to observe`
          : `agent "${agentId}" has no session "${sessionId}"`,
        { remediation: "List that agent's sessions and name one, or dispatch a task first." },
      )
    }
    const tasks = await adapter.readNativeTasks({ session })
    return await runtime.board.observe(collaborationId, agentId, tasks, String(session.key))
  }

  /**
   * Render exactly the context a dispatched run for one agent would receive.
   * @param collaborationId - Collaboration id.
   * @param agentId - Agent the context would be rendered for.
   * @returns the context block and its hash, or undefined when the plan mode is observe-only.
   */
  contextPreview(collaborationId: string, agentId: string): ContextPreview | undefined {
    return this.requireRuntime().board.context(collaborationId, agentId)
  }

  /**
   * Every task of one collaboration, in creation order.
   * @param collaborationId - Collaboration id.
   * @returns the tasks.
   */
  tasks(collaborationId: string): readonly CollaborationTaskRecord[] {
    return this.requireRuntime().board.tasks(collaborationId)
  }

  /**
   * Read one task.
   * @param collaborationId - Collaboration the task belongs to.
   * @param taskId - Task id.
   * @returns the task.
   */
  task(collaborationId: string, taskId: string): CollaborationTaskRecord {
    return this.requireRuntime().board.task(collaborationId, taskId)
  }

  /**
   * Dispatch one task: isolate it, inject the shared context, and record the run.
   *
   * A task is refused when it already runs or succeeded, and when any task it depends
   * on has not succeeded.
   * @param collaborationId - Collaboration owning the task.
   * @param taskId - Task to dispatch.
   * @param options - Base ref for a newly created worktree and a run budget.
   * @returns the task after dispatch, the run id, the working directory, and the injected context.
   */
  async dispatchTask(collaborationId: string, taskId: string, options: DispatchOptions = {}): Promise<TaskDispatchResult> {
    const runtime = this.requireRuntime()
    const task = runtime.board.task(collaborationId, taskId)
    if (task.status === 'running' || task.status === 'succeeded') {
      throw new CollaborationError('mesh/invalid-transition', `task "${task.id}" is already ${task.status}`, {
        remediation: 'Dispatch a task that is queued or blocked, or create a new task for the extra work.',
      })
    }
    const unfinished = task.dependsOn
      .map(dependency => runtime.board.task(collaborationId, dependency))
      .filter(dependency => dependency.status !== 'succeeded')
    if (unfinished.length > 0) {
      throw new CollaborationError(
        'mesh/invalid-transition',
        `task "${task.id}" is blocked by ${unfinished.map(dependency => `${dependency.id} (${dependency.status})`).join(', ')}`,
        { remediation: 'Finish the dependency first, or dispatch it now and wait for it to settle.' },
      )
    }

    const collaboration = runtime.board.view(collaborationId)
    const context = runtime.board.context(collaborationId, task.assignee)
    let cwd = collaboration.record.repoRoot
    let worktreeId: string | undefined
    if (task.isolation === 'worktree') {
      const worktree = await runtime.worktrees.create({
        agentId: task.assignee,
        repoRoot: collaboration.record.repoRoot,
        label: task.id,
        collaborationId,
        taskId: task.id,
        reuse: true,
        ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
      })
      cwd = worktree.path
      worktreeId = worktree.id
    }

    const handle = this.mesh.startRun(task.assignee, {
      prompt: renderPrompt(task.instruction, context),
      cwd,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    const running = await runtime.board.markTaskRunning(task, handle.runId, worktreeId)
    if (worktreeId !== undefined) await runtime.worktrees.bindRun(worktreeId, handle.runId)
    this.observeRun(task.id, handle.runId)
    return { task: running, runId: handle.runId, cwd, context }
  }

  /**
   * List worktrees with a live progress sample.
   * @param repoRoot - Restrict to one repository; every recorded worktree when omitted.
   * @returns one view per worktree, newest first; an explicit path outside a git
   *   repository returns an empty list.
   */
  async worktrees(repoRoot?: string): Promise<readonly WorktreeView[]> {
    return await this.requireRuntime().worktrees.list(repoRoot)
  }

  /**
   * Create or reuse one worktree.
   * @param request - Agent, repository, base ref, and labels.
   * @returns the worktree with its first sample.
   */
  async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeView> {
    return await this.requireRuntime().worktrees.create(request)
  }

  /**
   * Compare the live worktrees of one repository.
   * @param repoRoot - Repository to analyse.
   * @returns predicted same-file, same-hunk, feature-area, and base-commit findings.
   */
  async worktreeConflicts(repoRoot: string): Promise<ConflictReport> {
    return await this.requireRuntime().worktrees.conflicts(repoRoot)
  }

  /**
   * Remove one worktree.
   * @param worktreeId - Worktree to remove.
   * @param options - `force` discards uncommitted and unmerged work.
   * @returns the record, marked `removed`.
   */
  async removeWorktree(worktreeId: string, options: RemoveWorktreeOptions = {}): Promise<WorktreeRecord> {
    return await this.requireRuntime().worktrees.remove(worktreeId, options)
  }

  /**
   * Mark one worktree integrated, or outstanding again.
   * @param worktreeId - Worktree to mark.
   * @param merged - `false` marks it outstanding again.
   * @returns the updated record.
   */
  async markWorktreeIntegrated(worktreeId: string, merged: boolean = true): Promise<WorktreeRecord> {
    return await this.requireRuntime().worktrees.markIntegrated(worktreeId, merged)
  }

  /** The mesh registry, narrowed to the operations collaboration consumes. */
  private get mesh(): CollaborationMeshPort {
    return this.ctx.agentMesh
  }

  /**
   * Fold one run's terminal status into its task in the background.
   *
   * The mesh's `waitForRun` never rejects for a failed run, so the only failure this
   * contains is an adapter defect; a settlement that arrives after unload is dropped.
   */
  private observeRun(taskId: string, runId: string): void {
    const settling = this.mesh.waitForRun(runId).then(async (snapshot) => {
      const runtime = this.runtime
      if (this.disposed || runtime === undefined || snapshot === undefined) return
      const settled = await runtime.board.settleTask(taskId, runId, snapshot.status, snapshot.error?.message)
      if (settled?.worktreeId !== undefined) await runtime.worktrees.bindRun(settled.worktreeId, undefined)
    }).catch((error: unknown) => {
      this.ctx.logger.warn(
        'agent-mesh-collaboration: run %s did not settle: %s',
        runId,
        error instanceof Error ? error.message : String(error),
      )
    })
    this.settling.add(settling)
    void settling.finally(() => { this.settling.delete(settling) })
  }

  /** Resolve the open runtime, refusing use before the domain opened. */
  private requireRuntime(): CollaborationRuntime {
    if (this.runtime === undefined) {
      throw new CollaborationError('mesh/unsupported-operation', 'the collaboration service is not open yet')
    }
    return this.runtime
  }
}

/**
 * Apply the collaboration plugin: mount the service, which registers the tools once
 * its domain is open, and the Remote surface the Web Client reads.
 * @param ctx - Owning context.
 * @param config - Caller configuration, validated by the service's own schema.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(MeshCollaboration, config)
  // The Remote surface is mounted with the service so one bundle row carries both the
  // in-process API and the Client's `remote.meshCollaboration` namespace.
  ctx.plugin(MeshCollaborationController)
}

/**
 * Module-shaped default export. The Loader resolves a plugin as
 * `module.default ?? module`, so this object keeps `name` and `inject` visible
 * to it (a bare function default would drop both).
 */
export default { name, inject, apply }
