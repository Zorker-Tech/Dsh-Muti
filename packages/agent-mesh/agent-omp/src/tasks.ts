/**
 * OMP's own todo and plan state for one session.
 *
 * OMP has a native `todo` tool: each committed snapshot is either a `custom` entry with
 * `customType: "user_todo_edit"` (the SDK/UI edit path) or the `details.phases` of a
 * successful `todo` tool result, and OMP's own restoration scans backward for the latest
 * of either. Plan mode is recorded as `mode_change` entries whose `mode` is `plan`
 * (active) or `plan_paused`, with the plan file path in `data.planFilePath`.
 *
 * Everything here is read-only: the plan file the entries locate is reported verbatim and
 * never opened.
 * @module @deepseek-ai/dsh-agent-omp/tasks
 */

import type {
  AgentHost,
  AgentId,
  AgentNativeTasks,
  AgentSession,
  AgentSessionKey,
  AgentTodo,
  AgentTodoStatus,
} from '@deepseek-ai/dsh-agent-mesh'
import {
  OMP_DEFAULT_TRANSCRIPT_BYTES,
  OMP_PLAN_MODES,
  findOmpSessionFile,
  foldOmpEntries,
  isRecord,
  isoOrUndefined,
  note,
  ompBranch,
  readArray,
  readBoolean,
  readOmpSessionView,
  readRecord,
  readString,
  sessionKey,
  type OmpNativeEntry,
  type OmpStoreLayout,
} from './sessions.ts'

/** Everything a native task read needs. */
export interface OmpNativeTaskRead {
  /** Host providing the filesystem and the environment. */
  readonly host: AgentHost
  /** Resolved store layout. */
  readonly layout: OmpStoreLayout
  /** Owning agent id, stamped on every todo. */
  readonly agentId: AgentId
  /** Session to read. */
  readonly session: AgentSession
}

/**
 * Read OMP's own todo list and plan-mode state for a session. Read-only.
 *
 * @param read - Host, layout and the session to read.
 * @returns the observed state; `available` is always `true` because OMP records a native
 *   todo list and plan mode, and the notes state when this session carries neither.
 */
export async function readOmpNativeTasks(read: OmpNativeTaskRead): Promise<AgentNativeTasks> {
  const path = read.session.nativePath ?? (await findOmpSessionFile(read.host, read.layout, read.session.nativeId))
  if (path === undefined) {
    return {
      available: true,
      todos: [],
      notes: [note('*', `no session file was found for ${read.session.nativeId}`)],
    }
  }
  const view = await readOmpSessionView(read.host, path, OMP_DEFAULT_TRANSCRIPT_BYTES)
  if (view.missing || view.header === undefined) {
    return {
      available: true,
      todos: [],
      notes: [
        note(
          '*',
          view.missing
            ? 'the session file disappeared during the read, so no todo or plan state was read'
            : 'the session header was unreadable, so the session the todo items belong to is unknown',
        ),
      ],
    }
  }
  const branch = ompBranch(view)
  const observedIn: AgentSessionKey = sessionKey(read.agentId, view.header.id)
  const notes: string[] = [...view.notes]

  let todos: readonly AgentTodo[] = []
  let sawTodos = false
  for (const entry of branch.chain) {
    const snapshot = todoSnapshot(entry, read.agentId, observedIn)
    if (snapshot === undefined) continue
    sawTodos = true
    todos = snapshot
  }
  if (sawTodos) {
    notes.push(note('todos', "omp's todo model carries no dependency edges, so every item has an empty blockedBy"))
  }

  const fold = foldOmpEntries(branch.chain)
  const plan =
    fold.mode === undefined
      ? undefined
      : {
        active: OMP_PLAN_MODES.includes(fold.mode),
        items: fold.planFilePath === undefined ? [] : [fold.planFilePath],
      }
  if (plan !== undefined && fold.planFilePath === undefined) {
    notes.push(
      note('plan', 'the plan-mode transition recorded no plan file path, so the plan body has no locator here'),
    )
  }
  if (plan !== undefined && plan.items.length > 0) {
    notes.push(
      note('plan', "omp records the plan's file path, not its text; the path is reported verbatim and the file is not read"),
    )
  }
  if (branch.abandoned > 0) {
    notes.push(note('todos', `${String(branch.abandoned)} entries on abandoned branches are excluded from this reading`))
  }
  if (!sawTodos && plan === undefined) {
    notes.push(note('*', 'no user_todo_edit snapshot, todo tool result or mode_change entry appeared on the live branch'))
  }

  return {
    available: true,
    todos,
    ...(plan === undefined ? {} : { plan }),
    notes,
  }
}

/**
 * The todo snapshot one entry commits, when it commits one.
 *
 * @param entry - A session entry on the live branch.
 * @param agent - Owning agent id, the items' owner.
 * @param observedIn - Mesh session key the items were observed in.
 * @returns the projected items, or `undefined` when the entry carries no snapshot.
 */
function todoSnapshot(
  entry: OmpNativeEntry,
  agent: AgentId,
  observedIn: AgentSessionKey,
): readonly AgentTodo[] | undefined {
  if (entry.type === 'custom') {
    if (readString(entry.record, 'customType') !== 'user_todo_edit') return undefined
    const data = readRecord(entry.record, 'data')
    const phases = data === undefined ? undefined : readArray(data, 'phases')
    return phases === undefined ? undefined : todosFromPhases(phases, entry.timestamp, agent, observedIn)
  }
  if (entry.type !== 'message') return undefined
  const message = readRecord(entry.record, 'message')
  if (message === undefined || readString(message, 'role') !== 'toolResult') return undefined
  if (readString(message, 'toolName') !== 'todo' || readBoolean(message, 'isError') === true) return undefined
  const details = readRecord(message, 'details')
  if (details === undefined || readString(details, 'op') === 'view') return undefined
  const phases = readArray(details, 'phases')
  return phases === undefined ? undefined : todosFromPhases(phases, entry.timestamp, agent, observedIn)
}

/** Project OMP's `TodoPhase[]` onto mesh items, in phase then task order. */
function todosFromPhases(
  phases: readonly unknown[],
  fallbackTime: string,
  agent: AgentId,
  observedIn: AgentSessionKey,
): readonly AgentTodo[] {
  const updatedAt = isoOrUndefined(fallbackTime) ?? new Date(0).toISOString()
  const items: AgentTodo[] = []
  const seen = new Map<string, number>()
  for (const phase of phases) {
    if (!isRecord(phase)) continue
    const phaseName = readString(phase, 'name') ?? ''
    const tasks = readArray(phase, 'tasks')
    if (tasks === undefined) continue
    for (const task of tasks) {
      if (!isRecord(task)) continue
      const content = readString(task, 'content')
      if (content === undefined || content === '') continue
      const nativeKey = `${phaseName}/${content}`
      const base = ompTodoId(observedIn, nativeKey)
      const occurrence = (seen.get(base) ?? 0) + 1
      seen.set(base, occurrence)
      items.push({
        // Identical content inside one phase is the only case that needs a suffix, so the
        // common item keeps one id no matter how the phases are reordered.
        id: occurrence === 1 ? base : `${base}-${String(occurrence)}`,
        content,
        status: todoStatusOf(readString(task, 'status')),
        owner: agent,
        blockedBy: [],
        updatedAt,
        observedIn,
        nativeKey,
      })
    }
  }
  return items
}

/** OMP's todo status vocabulary mapped onto the mesh one. */
function todoStatusOf(status: string | undefined): AgentTodoStatus {
  switch (status) {
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked'
    case 'abandoned':
      // OMP retires a task with `abandoned`; the mesh vocabulary calls that cancelled.
      return 'cancelled'
    default:
      return 'pending'
  }
}

/**
 * Derive a todo id that survives re-reads.
 *
 * The id hashes the owning session and the native key (phase name plus item content), so
 * the same item keeps its id across reads and reorderings.
 *
 * @param observedIn - Mesh session key the item was observed in.
 * @param nativeKey - Native key of the item, `<phase name>/<content>`.
 * @returns the mesh todo id value.
 */
export function ompTodoId(observedIn: AgentSessionKey, nativeKey: string): string {
  return `omp-${hashText(`${String(observedIn)}\u0000${nativeKey}`)}`
}

/**
 * FNV-1a over the UTF-16 code units of a string, as 8 hex digits.
 *
 * Implemented here rather than imported so the adapter adds no dependency; it is a
 * stability device for ids, not a security primitive. The reference adapter delegated the
 * same derivation to its host's branded id helper; the mesh todo id is a plain string, so
 * the hash lives here.
 *
 * @param text - Text to hash.
 * @returns eight lowercase hex digits.
 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
