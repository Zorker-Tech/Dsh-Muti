/**
 * Model-facing operations over a collaboration: start one, move its plan, write and
 * read its todo board, dispatch and isolate its tasks, and inspect or remove the
 * worktrees those tasks run in.
 *
 * Every tool reads and writes through `ctx.meshCollaboration`, so a tool call never
 * touches the domain tables, git, or an agent's store itself. A refused request is
 * thrown, which makes the call fail with the refusal reason rather than reporting
 * success for work that did not happen.
 *
 * Each tool's output schema is inline and its render reads the inferred value, so a
 * field added to one is a compile error in the other.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { TodoBoardRecord, WorktreeRecord } from './domain.ts'
import type { CollaborationView, ConflictReport, TaskDispatchResult, TodoStatus, WorktreeView } from './types.ts'

/** One rendered todo item. */
interface TodoLine {
  readonly id: string
  readonly status: string
  readonly owner: string
  readonly content: string
  readonly blockedBy: readonly string[]
}

/** One rendered worktree row. */
interface WorktreeLine {
  readonly id: string
  readonly state: string
  readonly reusable: boolean
  readonly branch: string
  readonly path: string
  readonly changedFiles: number
  readonly dirty: boolean
  readonly ahead: number
  readonly runId: string
}

/** One rendered collaboration summary. */
interface CollaborationLine {
  readonly id: string
  readonly title: string
  readonly repoRoot: string
  readonly objective: string
  readonly mode: string
  readonly activePhaseId: string
  readonly phases: readonly { readonly id: string; readonly title: string; readonly status: string }[]
  readonly decisions: readonly string[]
  readonly todoRevision: number
  readonly todoCount: number
  readonly tasks: readonly { readonly id: string; readonly status: string; readonly assignee: string; readonly title: string }[]
  readonly worktrees: readonly { readonly id: string; readonly state: string; readonly branch: string }[]
}

/** Render one todo item as a line. */
function todoLine(todo: TodoLine): string {
  const blocked = todo.blockedBy.length > 0 ? ` [blocked by ${todo.blockedBy.join(', ')}]` : ''
  return `${todo.id} [${todo.status}] (${todo.owner}) ${todo.content}${blocked}`
}

/** Render one worktree with its progress as a line. */
function worktreeLine(row: WorktreeLine): string {
  return `${row.id} ${row.state}${row.reusable ? ' (reusable)' : ''} ${row.branch} in ${row.path}`
    + ` — ${String(row.changedFiles)} changed file(s)${row.dirty ? ', dirty' : ', clean'}, ahead ${String(row.ahead)}`
    + (row.runId === '' ? '' : ` run=${row.runId}`)
}

/** Render one collaboration summary as text. */
function collaborationText(row: CollaborationLine): string {
  return [
    `${row.id} — ${row.title} (${row.repoRoot})`,
    `objective: ${row.objective}`,
    `plan mode: ${row.mode}${row.activePhaseId === '' ? '' : `, active phase ${row.activePhaseId}`}`,
    row.phases.length === 0 ? '' : `phases:\n${row.phases.map(phase => `  ${phase.id} [${phase.status}] ${phase.title}`).join('\n')}`,
    row.decisions.length === 0 ? '' : `decisions:\n${row.decisions.map(decision => `  - ${decision}`).join('\n')}`,
    `todos: ${String(row.todoCount)} (revision ${String(row.todoRevision)})`,
    row.tasks.length === 0 ? 'tasks: none' : `tasks:\n${row.tasks.map(task => `  ${task.id} [${task.status}] ${task.assignee}: ${task.title}`).join('\n')}`,
    row.worktrees.length === 0 ? '' : `worktrees:\n${row.worktrees.map(worktree => `  ${worktree.id} [${worktree.state}] ${worktree.branch}`).join('\n')}`,
  ].filter(line => line !== '').join('\n')
}

/** Project one collaboration onto the summary every list-shaped answer carries. */
function collaborationRow(view: CollaborationView): {
  id: string
  title: string
  repoRoot: string
  updatedAt: string
  objective: string
  mode: string
  activePhaseId: string
  phases: { id: string; title: string; status: string; exitCriteria: string }[]
  decisions: string[]
  todoRevision: number
  todoCount: number
  tasks: {
    id: string
    title: string
    assignee: string
    status: string
    isolation: string
    dependsOn: string[]
    runId: string
    worktreeId: string
    note: string
  }[]
  worktrees: { id: string; path: string; branch: string; state: string; runId: string; taskId: string }[]
} {
  return {
    id: view.id,
    title: view.record.title,
    repoRoot: view.record.repoRoot,
    updatedAt: view.record.updatedAt,
    objective: view.plan.objective,
    mode: view.plan.mode,
    activePhaseId: view.plan.activePhaseId ?? '',
    phases: view.plan.phases.map(phase => ({
      id: phase.id,
      title: phase.title,
      status: phase.status,
      exitCriteria: phase.exitCriteria ?? '',
    })),
    decisions: [...view.plan.decisions],
    todoRevision: view.board.revision,
    todoCount: view.board.todos.length,
    tasks: view.tasks.map(task => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      status: task.status,
      isolation: task.isolation,
      dependsOn: [...task.dependsOn],
      runId: task.runId ?? '',
      worktreeId: task.worktreeId ?? '',
      note: task.note ?? '',
    })),
    worktrees: view.worktrees.map(worktree => ({
      id: worktree.id,
      path: worktree.path,
      branch: worktree.branch,
      state: worktree.state,
      runId: worktree.runId ?? '',
      taskId: worktree.taskId ?? '',
    })),
  }
}

/** Project one todo board onto the shape the board tools return. */
function boardValue(board: TodoBoardRecord): {
  collaborationId: string
  revision: number
  updatedAt: string
  todos: {
    id: string
    content: string
    status: TodoStatus
    owner: string
    blockedBy: string[]
    updatedAt: string
    nativeKey: string
    observedIn: string
  }[]
} {
  return {
    collaborationId: board.collaborationId,
    revision: board.revision,
    updatedAt: board.updatedAt,
    todos: board.todos.map(todo => ({
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

/** Project one worktree view onto the shape the worktree tools return. */
function worktreeValue(view: WorktreeView): {
  id: string
  path: string
  repoRoot: string
  branch: string
  baseCommit: string
  baseRef: string
  agentId: string
  state: string
  reusable: boolean
  collaborationId: string
  taskId: string
  runId: string
  changedFiles: number
  dirty: boolean
  ahead: number
  progressNotes: string[]
} {
  const progress = view.progress
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
    changedFiles: progress?.files.length ?? 0,
    dirty: progress?.dirty ?? false,
    ahead: progress?.ahead ?? 0,
    progressNotes: progress === undefined ? [] : [...progress.notes],
  }
}

/** Project one conflict report onto the shape the conflicts tool returns. */
function conflictValue(report: ConflictReport): {
  repoRoot: string
  at: string
  worktrees: string[]
  findings: { kind: string; severity: string; left: string; right: string; paths: string[]; detail: string }[]
  suggestedOrder: string[]
  notes: string[]
} {
  return {
    repoRoot: report.repoRoot,
    at: report.at,
    worktrees: [...report.worktrees],
    findings: report.findings.map(finding => ({
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

/** Project one dispatch onto the shape the dispatch tool returns. */
function dispatchValue(result: TaskDispatchResult): {
  taskId: string
  runId: string
  cwd: string
  status: string
  contextHash: string
} {
  return {
    taskId: result.task.id,
    runId: result.runId,
    cwd: result.cwd,
    status: result.task.status,
    contextHash: result.context?.hash ?? '',
  }
}

/** The phase branch shape shared by the plan and collaboration tools. */
type PhaseValue = { id: string; title: string; status: string }

/** Require an audited, per-call user decision before dispatching a named operation. */
function requireApproval(
  ctx: Context,
  toolName: string,
  reason: string,
  displayReason: { readonly en: string; readonly zh: string },
): void {
  const approvalRequests = new WeakSet<object>()
  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== toolName) return next()
    approvalRequests.add(exec)
    return Promise.resolve({ kind: 'ask', reason, displayReason })
  })
  ctx.effect(() => ctx.tools.guard(exec => exec.name === toolName && !approvalRequests.has(exec)
    ? `${toolName} requires an approval request before it can run.`
    : undefined), `agent-mesh-collaboration: ${toolName} approval guard`)
}

/**
 * Register the collaboration tools on the tool runtime.
 *
 * The registrations belong to the tool runtime's own effect scope, which is the
 * lifetime every other tool package uses; the runtime withdraws them when it unloads.
 * @param ctx - Owning context carrying `tools` and `meshCollaboration`.
 */
export function registerCollaborationTools(ctx: Context): void {
  requireApproval(
    ctx,
    'mesh_task_dispatch',
    'mesh_task_dispatch starts an external coding-agent run in the task worktree.',
    {
      en: 'Dispatch this collaboration task to its external coding agent? The agent can modify files and run commands in the task worktree.',
      zh: '要把此协作任务派发给外部编码智能体吗？该智能体可以在任务 worktree 中修改文件并运行命令。',
    },
  )
  requireApproval(
    ctx,
    'mesh_worktree_remove',
    'mesh_worktree_remove deletes an Agent Mesh worktree; force may discard uncommitted changes.',
    {
      en: 'Remove this Agent Mesh worktree? Forced removal can discard uncommitted work.',
      zh: '要删除此 Agent Mesh worktree 吗？强制删除可能丢弃未提交的改动。',
    },
  )

  ctx.tools.register(defineTool({
    name: 'mesh_collaboration_start',
    description: 'Create a collaboration: one authoritative plan, one shared todo board, and optional tasks assigned to agents. A worktree-isolated task gets its own git worktree when it is dispatched.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short human title.' },
      objective: { type: 'string', required: true, description: 'What the collaboration as a whole must achieve.' },
      repoRoot: { type: 'string', required: true, description: 'Absolute path of the repository the tasks work in.' },
      tasks: {
        type: 'array',
        description: 'Initial tasks. A seed may name a sibling by position ("task-1") or by id in dependsOn.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            instruction: { type: 'string', required: true },
            assignee: { type: 'string', required: true },
            dependsOn: { type: 'array', items: { type: 'string' } },
            isolation: { type: 'string', enum: ['worktree', 'shared-cwd'] },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collaborationId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          repoRoot: { type: 'string', required: true },
          phases: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true },
              },
            },
          },
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                assignee: { type: 'string', required: true },
                status: { type: 'string', required: true },
                isolation: { type: 'string', required: true },
                dependsOn: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Started collaboration ${value.collaborationId} "${value.title}" in ${value.repoRoot}.`,
          `phases: ${value.phases.map((phase: PhaseValue) => `${phase.id} [${phase.status}]`).join(' -> ')}`,
          value.tasks.length === 0
            ? 'No tasks were seeded; add work by dispatching with the board.'
            : `tasks:\n${value.tasks.map(task => `  ${task.id} [${task.status}] ${task.assignee}: ${task.title}`).join('\n')}`,
        ].join('\n'),
      }],
    },
    async execute(args) {
      const view = await ctx.meshCollaboration.start({
        title: args.title,
        objective: args.objective,
        repoRoot: args.repoRoot,
        ...(args.tasks === undefined ? {} : {
          tasks: args.tasks.map(task => ({
            title: task.title,
            instruction: task.instruction,
            assignee: task.assignee,
            ...(task.dependsOn === undefined ? {} : { dependsOn: task.dependsOn }),
            ...(task.isolation === undefined ? {} : { isolation: task.isolation }),
          })),
        }),
      })
      return {
        collaborationId: view.id,
        title: view.record.title,
        repoRoot: view.record.repoRoot,
        phases: view.plan.phases.map(phase => ({ id: phase.id, title: phase.title, status: phase.status })),
        tasks: view.tasks.map(task => ({
          id: task.id,
          title: task.title,
          assignee: task.assignee,
          status: task.status,
          isolation: task.isolation,
          dependsOn: [...task.dependsOn],
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_collaborations',
    description: 'List collaborations with their plan, board counts, tasks and worktrees, or read one collaboration by id.',
    parameters: {
      collaborationId: { type: 'string', description: 'Read one collaboration instead of listing every one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collaborations: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                repoRoot: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
                objective: { type: 'string', required: true },
                mode: { type: 'string', required: true },
                activePhaseId: { type: 'string', required: true },
                phases: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      status: { type: 'string', required: true },
                      exitCriteria: { type: 'string', required: true },
                    },
                  },
                },
                decisions: { type: 'array', required: true, items: { type: 'string' } },
                todoRevision: { type: 'integer', required: true },
                todoCount: { type: 'integer', required: true },
                tasks: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      assignee: { type: 'string', required: true },
                      status: { type: 'string', required: true },
                      isolation: { type: 'string', required: true },
                      dependsOn: { type: 'array', required: true, items: { type: 'string' } },
                      runId: { type: 'string', required: true },
                      worktreeId: { type: 'string', required: true },
                      note: { type: 'string', required: true },
                    },
                  },
                },
                worktrees: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      path: { type: 'string', required: true },
                      branch: { type: 'string', required: true },
                      state: { type: 'string', required: true },
                      runId: { type: 'string', required: true },
                      taskId: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.collaborations.length === 0
          ? 'No collaborations have been started.'
          : value.collaborations.map(collaborationText).join('\n\n'),
      }],
    },
    execute(args) {
      const views = args.collaborationId === undefined
        ? ctx.meshCollaboration.list()
        : [ctx.meshCollaboration.get(args.collaborationId)]
      return Promise.resolve({ collaborations: views.map(collaborationRow) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_plan_set',
    description: "Replace a collaboration's plan fields. The plan is the authoritative input every dispatched run receives.",
    parameters: {
      collaborationId: { type: 'string', required: true, description: 'Collaboration to change.' },
      objective: { type: 'string', required: true, description: 'The objective; it replaces the current one.' },
      phases: {
        type: 'array',
        description: 'The complete new phase list, in order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['todo', 'active', 'done'] },
            exitCriteria: { type: 'string' },
          },
        },
      },
      activePhaseId: { type: 'string', description: 'Phase to mark active; it must exist in the resulting list.' },
      decisions: { type: 'array', description: 'The complete decisions log.', items: { type: 'string' } },
      mode: { type: 'string', enum: ['inject', 'observe'], description: 'Whether the plan is injected into dispatched prompts or only observed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collaborationId: { type: 'string', required: true },
          objective: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          activePhaseId: { type: 'string', required: true },
          phases: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true },
                exitCriteria: { type: 'string', required: true },
              },
            },
          },
          decisions: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Plan of ${value.collaborationId} updated (mode ${value.mode}, active ${value.activePhaseId}).\n`
          + value.phases.map((phase: PhaseValue) => `${phase.id} [${phase.status}] ${phase.title}`).join('\n'),
      }],
    },
    async execute(args) {
      const plan = await ctx.meshCollaboration.setPlan(args.collaborationId, {
        objective: args.objective,
        ...(args.phases === undefined ? {} : {
          phases: args.phases.map(phase => ({
            id: phase.id,
            title: phase.title,
            status: phase.status,
            ...(phase.exitCriteria === undefined ? {} : { exitCriteria: phase.exitCriteria }),
          })),
        }),
        ...(args.activePhaseId === undefined ? {} : { activePhaseId: args.activePhaseId }),
        ...(args.decisions === undefined ? {} : { decisions: args.decisions }),
        ...(args.mode === undefined ? {} : { mode: args.mode }),
      })
      return {
        collaborationId: plan.collaborationId,
        objective: plan.objective,
        mode: plan.mode,
        activePhaseId: plan.activePhaseId ?? '',
        phases: plan.phases.map(phase => ({
          id: phase.id,
          title: phase.title,
          status: phase.status,
          exitCriteria: phase.exitCriteria ?? '',
        })),
        decisions: [...plan.decisions],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_plan_advance',
    description: 'Move the plan to a phase, marking every earlier phase done. Refused while an earlier phase is still open.',
    parameters: {
      collaborationId: { type: 'string', required: true, description: 'Collaboration to change.' },
      phaseId: { type: 'string', required: true, description: 'Phase to activate.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collaborationId: { type: 'string', required: true },
          activePhaseId: { type: 'string', required: true },
          phases: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Active phase of ${value.collaborationId} is now ${value.activePhaseId}.\n`
          + value.phases.map((phase: PhaseValue) => `${phase.id} [${phase.status}] ${phase.title}`).join('\n'),
      }],
    },
    async execute(args) {
      const plan = await ctx.meshCollaboration.advancePhase(args.collaborationId, args.phaseId)
      return {
        collaborationId: plan.collaborationId,
        activePhaseId: plan.activePhaseId ?? '',
        phases: plan.phases.map(phase => ({ id: phase.id, title: phase.title, status: phase.status })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_todos_set',
    description: "Replace a collaboration's shared todo board. Pass expectedRevision from a previous read to be refused instead of clobbering another writer's change.",
    parameters: {
      collaborationId: { type: 'string', required: true, description: 'Collaboration whose board is replaced.' },
      todos: {
        type: 'array',
        required: true,
        description: 'The complete new board.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            content: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] },
            owner: { type: 'string' },
            blockedBy: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      expectedRevision: { type: 'integer', description: 'Revision the caller read; the write is refused when the board moved on.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collaborationId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          updatedAt: { type: 'string', required: true },
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                content: { type: 'string', required: true },
                status: { type: 'string', required: true },
                owner: { type: 'string', required: true },
                blockedBy: { type: 'array', required: true, items: { type: 'string' } },
                updatedAt: { type: 'string', required: true },
                nativeKey: { type: 'string', required: true },
                observedIn: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Board written at revision ${String(value.revision)}.\n`
          + (value.todos.length === 0 ? '(empty)' : value.todos.map(todoLine).join('\n')),
      }],
    },
    async execute(args) {
      const board = await ctx.meshCollaboration.setTodos(
        args.collaborationId,
        args.todos.map(todo => ({
          id: todo.id,
          content: todo.content,
          status: todo.status,
          ...(todo.owner === undefined ? {} : { owner: todo.owner }),
          ...(todo.blockedBy === undefined ? {} : { blockedBy: todo.blockedBy }),
        })),
        args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision },
      )
      return boardValue(board)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_todos_get',
    description: "Read a collaboration's shared todo board with its revision.",
    parameters: {
      collaborationId: { type: 'string', required: true, description: 'Collaboration to read.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collaborationId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          updatedAt: { type: 'string', required: true },
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                content: { type: 'string', required: true },
                status: { type: 'string', required: true },
                owner: { type: 'string', required: true },
                blockedBy: { type: 'array', required: true, items: { type: 'string' } },
                updatedAt: { type: 'string', required: true },
                nativeKey: { type: 'string', required: true },
                observedIn: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.todos.length === 0
          ? `The board of ${value.collaborationId} is empty (revision ${String(value.revision)}).`
          : `revision ${String(value.revision)}\n${value.todos.map(todoLine).join('\n')}`,
      }],
    },
    execute(args) {
      return Promise.resolve(boardValue(ctx.meshCollaboration.getTodos(args.collaborationId)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_todos_observe',
    description: "Read one agent's own todo list for a session and fold it into the shared board. Authored items are never overwritten, and an item the board considers done is never reopened.",
    parameters: {
      collaborationId: { type: 'string', required: true, description: 'Collaboration whose board is folded into.' },
      agentId: { type: 'string', required: true, description: 'Agent whose own store is read, as reported by mesh_agents.' },
      sessionId: { type: 'string', description: "The agent's native session id; the newest session is read when omitted." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          observed: { type: 'integer', required: true },
          collaborationId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          updatedAt: { type: 'string', required: true },
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                content: { type: 'string', required: true },
                status: { type: 'string', required: true },
                owner: { type: 'string', required: true },
                blockedBy: { type: 'array', required: true, items: { type: 'string' } },
                updatedAt: { type: 'string', required: true },
                nativeKey: { type: 'string', required: true },
                observedIn: { type: 'string', required: true },
              },
            },
          },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Folded ${String(value.observed)} item(s) into the board of ${value.collaborationId}`
          + (value.notes.length === 0 ? '.' : `.\nnotes: ${value.notes.join('; ')}`)
          + (value.todos.length === 0 ? '' : `\n${value.todos.map(todoLine).join('\n')}`),
      }],
    },
    async execute(args) {
      const sessionId = args.sessionId
      const outcome = await ctx.meshCollaboration.observeTodos(
        args.collaborationId,
        args.agentId,
        ...(sessionId === undefined ? [] : ([sessionId] as [string])),
      )
      return { observed: outcome.observed, ...boardValue(outcome.board), notes: [...outcome.notes] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_task_dispatch',
    description: 'Dispatch one collaboration task: create or reuse its worktree, hand the agent the plan and board context plus the instruction, and record the run on the task. Refused when the task is already running or succeeded, or when a dependency is unfinished.',
    parameters: {
      collaborationId: { type: 'string', required: true, description: 'Collaboration owning the task.' },
      taskId: { type: 'string', required: true, description: 'Task to dispatch, as reported by mesh_collaborations.' },
      baseRef: { type: 'string', description: 'Commit-ish a newly created worktree branches from.' },
      timeoutMs: { type: 'integer', description: 'Wall-clock budget handed to the agent.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          runId: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          status: { type: 'string', required: true },
          contextHash: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Dispatched ${value.taskId} as run ${value.runId} in ${value.cwd}`
          + (value.contextHash === '' ? ' without an injected context block.' : ` with context ${value.contextHash}.`)
          + ' Read the run with mesh_runs.',
      }],
    },
    async execute(args) {
      return dispatchValue(await ctx.meshCollaboration.dispatchTask(args.collaborationId, args.taskId, {
        ...(args.baseRef === undefined ? {} : { baseRef: args.baseRef }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_worktrees',
    description: 'List mesh-owned git worktrees with a live progress sample: changed files, HEAD, and whether the tree is dirty.',
    parameters: {
      repoRoot: { type: 'string', description: 'Restrict to worktrees of one repository.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          worktrees: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                path: { type: 'string', required: true },
                repoRoot: { type: 'string', required: true },
                branch: { type: 'string', required: true },
                baseCommit: { type: 'string', required: true },
                baseRef: { type: 'string', required: true },
                state: { type: 'string', required: true },
                reusable: { type: 'boolean', required: true },
                agentId: { type: 'string', required: true },
                collaborationId: { type: 'string', required: true },
                taskId: { type: 'string', required: true },
                runId: { type: 'string', required: true },
                changedFiles: { type: 'integer', required: true },
                dirty: { type: 'boolean', required: true },
                ahead: { type: 'integer', required: true },
                progressNotes: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.worktrees.length === 0
          ? 'No worktrees are recorded.'
          : value.worktrees.map(worktreeLine).join('\n'),
      }],
    },
    async execute(args) {
      const views = await ctx.meshCollaboration.worktrees(args.repoRoot)
      return { worktrees: views.map(worktreeValue) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_worktree_create',
    description: 'Create a git worktree on a new branch inside the mesh-owned directory of a repository, or reuse a clean idle one already reserved for that agent.',
    parameters: {
      agentId: { type: 'string', required: true, description: 'Agent the worktree is reserved for.' },
      repoRoot: { type: 'string', required: true, description: 'Absolute path inside the repository.' },
      baseRef: { type: 'string', description: 'Commit-ish to branch from; the repository HEAD when omitted.' },
      label: { type: 'string', description: 'Label used in the branch name and the worktree directory.' },
      collaborationId: { type: 'string', description: 'Collaboration the worktree serves.' },
      reuse: { type: 'boolean', description: 'Reuse a clean idle worktree reserved for the same agent.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          worktree: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              path: { type: 'string', required: true },
              repoRoot: { type: 'string', required: true },
              branch: { type: 'string', required: true },
              baseCommit: { type: 'string', required: true },
              baseRef: { type: 'string', required: true },
              state: { type: 'string', required: true },
              reusable: { type: 'boolean', required: true },
              agentId: { type: 'string', required: true },
              collaborationId: { type: 'string', required: true },
              taskId: { type: 'string', required: true },
              runId: { type: 'string', required: true },
              changedFiles: { type: 'integer', required: true },
              dirty: { type: 'boolean', required: true },
              ahead: { type: 'integer', required: true },
              progressNotes: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: worktreeLine(value.worktree) }],
    },
    async execute(args) {
      const view = await ctx.meshCollaboration.createWorktree({
        agentId: args.agentId,
        repoRoot: args.repoRoot,
        ...(args.baseRef === undefined ? {} : { baseRef: args.baseRef }),
        ...(args.label === undefined ? {} : { label: args.label }),
        ...(args.collaborationId === undefined ? {} : { collaborationId: args.collaborationId }),
        ...(args.reuse === undefined ? {} : { reuse: args.reuse }),
      })
      return { worktree: worktreeValue(view) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_worktree_conflicts',
    description: 'Compare live worktrees for same-file and same-hunk edits, shared configured feature areas, and differing base commits. Findings are heuristic and advisory; this report does not prevent a separate dispatch.',
    parameters: {
      repoRoot: { type: 'string', required: true, description: 'Repository to analyse.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repoRoot: { type: 'string', required: true },
          at: { type: 'string', required: true },
          worktrees: { type: 'array', required: true, items: { type: 'string' } },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                severity: { type: 'string', required: true },
                left: { type: 'string', required: true },
                right: { type: 'string', required: true },
                paths: { type: 'array', required: true, items: { type: 'string' } },
                detail: { type: 'string', required: true },
              },
            },
          },
          suggestedOrder: { type: 'array', required: true, items: { type: 'string' } },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${String(value.worktrees.length)} live worktree(s) in ${value.repoRoot}`,
          value.findings.length === 0
            ? 'No conflict finding was detected.'
            : value.findings.map(finding => `${finding.severity}: ${finding.detail}\n  ${finding.paths.join('\n  ')}`).join('\n'),
          value.suggestedOrder.length === 0 ? '' : `suggested integration order: ${value.suggestedOrder.join(' -> ')}`,
          value.notes.map(note => `note: ${note}`).join('\n'),
        ].filter(line => line !== '').join('\n'),
      }],
    },
    async execute(args) {
      return conflictValue(await ctx.meshCollaboration.worktreeConflicts(args.repoRoot))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_worktree_remove',
    description: 'Remove a mesh-owned git worktree. DANGEROUS: a worktree with uncommitted changes or unmerged commits is refused unless force is true, and a forced removal discards that work permanently.',
    parameters: {
      worktreeId: { type: 'string', required: true, description: 'Worktree to remove.' },
      force: { type: 'boolean', description: 'Discard uncommitted and unmerged work. Only pass this after a human approved the loss.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          worktreeId: { type: 'string', required: true },
          state: { type: 'string', required: true },
          forced: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Worktree ${value.worktreeId} is ${value.state}${value.forced ? ' (its work was discarded)' : ''}.`,
      }],
    },
    async execute(args) {
      const record: WorktreeRecord = await ctx.meshCollaboration.removeWorktree(
        args.worktreeId,
        args.force === undefined ? {} : { force: args.force },
      )
      return { worktreeId: record.id, state: record.state, forced: args.force === true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mesh_worktree_integrated',
    description: 'Mark a worktree integrated so it stops appearing as outstanding work, or outstanding again with merged=false.',
    parameters: {
      worktreeId: { type: 'string', required: true, description: 'Worktree to mark.' },
      merged: { type: 'boolean', description: 'false marks it outstanding again; defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          worktreeId: { type: 'string', required: true },
          state: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Worktree ${value.worktreeId} is ${value.state}.` }],
    },
    async execute(args) {
      const record = await ctx.meshCollaboration.markWorktreeIntegrated(args.worktreeId, args.merged ?? true)
      return { worktreeId: record.id, state: record.state }
    },
  }))
}
