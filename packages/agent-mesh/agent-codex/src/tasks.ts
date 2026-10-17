/**
 * Codex's own checklist and plan state, read from the tail of a rollout.
 *
 * Codex records its checklist twice: as `plan_update` events (and the equivalent
 * `update_plan` tool call) carrying `{step, status}` items, and as `todo_list` items
 * carrying `{text, completed}` entries. In plan mode it also records `plan` items carrying
 * the plan text. The latest record in the read window wins.
 * @module @deepseek-ai/dsh-agent-codex/tasks
 */

import type { AgentId, AgentNativeTasks, AgentTodo, AgentTodoStatus } from '@deepseek-ai/dsh-agent-mesh'
import type { CodexHost } from './types.ts'
import { asRecord, normalizeToken, parseJsonLine, str } from './json.ts'
import { note } from './notes.ts'
import { locateRollout, sessionKey, type CodexHome } from './sessions.ts'

/** Native `plan_update` step statuses, mapped onto the mesh todo vocabulary. */
const PLAN_STATUS: Readonly<Record<string, AgentTodoStatus>> = {
  pending: 'pending',
  inprogress: 'in_progress',
  completed: 'completed',
}

/** Everything a native task read needs. */
export interface CodexNativeTaskRead {
  /** Host providing the rollout read and the clock. */
  readonly host: CodexHost
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Owning agent id, stamped on every todo. */
  readonly agentId: AgentId
  /** Native thread id. */
  readonly nativeId: string
  /** Bytes read from the rollout tail; the latest task state is at the end of the file. */
  readonly tailBytes: number
}

/**
 * Read Codex's own todo and plan state for a session.
 *
 * @param read - Host, home layout and the session to read.
 * @returns the observed state, with the reason in `notes` when the session records none.
 */
export async function readCodexNativeTasks(read: CodexNativeTaskRead): Promise<AgentNativeTasks> {
  const located = await locateRollout(read.host, read.home, read.nativeId)
  if (located === undefined) {
    return {
      available: true,
      todos: [],
      notes: [note('*', `no Codex rollout for session ${read.nativeId} under ${read.home.path}`)],
    }
  }
  if (located.compressed) {
    return {
      available: true,
      todos: [],
      notes: [
        note('*', 'the rollout is zstd-compressed and this adapter version cannot decompress it, so no task state was read'),
      ],
    }
  }
  const tail = await read.host.readTail(located.path, Math.max(1, read.tailBytes))
  const observedAt = new Date(read.host.now()).toISOString()
  let todos: AgentTodo[] | undefined
  let planItems: readonly string[] | undefined
  let unparsable = 0
  for (const line of tail.text.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseJsonLine(line)
    if (!parsed.ok) {
      unparsable += 1
      continue
    }
    const record = asRecord(parsed.value)
    if (record === undefined) continue
    const timestamp = str(record, 'timestamp') ?? observedAt
    for (const candidate of extractTaskCandidates(str(record, 'type'), asRecord(record['payload']))) {
      if (candidate.kind === 'plan') planItems = candidate.items
      else todos = makeTodos(read, candidate.items, timestamp)
    }
  }
  const notes: string[] = []
  if (todos === undefined && planItems === undefined) {
    notes.push(note('*', 'no update_plan, plan_update or todo_list record appeared in the read window'))
  }
  if (todos !== undefined) {
    notes.push(note('status', 'Codex checklists carry pending, in-progress and completed only; blocked and cancelled are unreachable'))
    notes.push(note('updatedAt', "the timestamp of the record that carried the checklist stands in for each item's own last change time"))
    notes.push(note('blockedBy', 'Codex expresses no dependencies between checklist items, so blockedBy is empty'))
  }
  if (planItems !== undefined) {
    notes.push(
      note(
        'plan.active',
        'whether plan mode is still active is not recorded; `active` reflects only that a plan item exists in the read window',
      ),
    )
  }
  if (unparsable > 0) {
    notes.push(note('*', `${String(unparsable)} rollout line(s) in the read window were not valid JSON and could not contribute task state`))
  }
  return {
    available: true,
    todos: todos ?? [],
    ...(planItems === undefined ? {} : { plan: { active: true, items: planItems } }),
    notes,
  }
}

/** One checklist item as the native record carried it. */
interface TaskItem {
  /** Item text. */
  readonly content: string
  /** Item status in the mesh vocabulary. */
  readonly status: AgentTodoStatus
  /** Native key of the record that carried the item. */
  readonly nativeKey: string
}

/** Task state one native record contributed. */
type TaskCandidate =
  | { readonly kind: 'todos'; readonly items: readonly TaskItem[] }
  | { readonly kind: 'plan'; readonly items: readonly string[] }

/** Extract the task state a single rollout record contributes, if any. */
function extractTaskCandidates(
  type: string | undefined,
  payload: Record<string, unknown> | undefined,
): readonly TaskCandidate[] {
  if (payload === undefined) return []
  const out: TaskCandidate[] = []
  if (type === 'response_item') {
    if (normalizeToken(str(payload, 'type')) === 'functioncall' && normalizeToken(str(payload, 'name')) === 'updateplan') {
      const items = planUpdateItems(str(payload, 'arguments'))
      if (items.length > 0) out.push({ kind: 'todos', items })
    }
    return out
  }
  if (type === 'event_msg') {
    const eventType = normalizeToken(str(payload, 'type'))
    if (eventType === 'planupdate' || eventType === 'turnplanupdated') {
      const items = planUpdateItems(payload['plan'])
      if (items.length > 0) out.push({ kind: 'todos', items })
    } else if (eventType === 'todolist') {
      const items = todoListItems(payload['items'])
      if (items.length > 0) out.push({ kind: 'todos', items })
    }
    const item = asRecord(payload['item'])
    const itemType = normalizeToken(str(item, 'type'))
    if (itemType === 'todolist') {
      const items = todoListItems(item?.['items'])
      if (items.length > 0) out.push({ kind: 'todos', items })
    } else if (itemType === 'plan') {
      const text = str(item, 'text')
      if (text !== undefined) out.push({ kind: 'plan', items: [text] })
    }
    return out
  }
  const itemType = normalizeToken(str(payload, 'type'))
  if (itemType === 'todolist') {
    const items = todoListItems(payload['items'])
    if (items.length > 0) out.push({ kind: 'todos', items })
  }
  if (itemType === 'plan') {
    const text = str(payload, 'text')
    if (text !== undefined) out.push({ kind: 'plan', items: [text] })
  }
  return out
}

/** Parse a `{plan: [{step, status}]}` payload, from an event or from tool-call arguments. */
function planUpdateItems(value: unknown): TaskItem[] {
  const parsed = typeof value === 'string' ? parseJsonLine(value) : undefined
  const source = parsed === undefined ? value : parsed.ok ? parsed.value : undefined
  const plan = Array.isArray(source) ? source : asRecord(source)?.['plan']
  if (!Array.isArray(plan)) return []
  const items: TaskItem[] = []
  for (const entry of plan) {
    const item = asRecord(entry)
    const content = str(item, 'step') ?? str(item, 'text')
    if (content === undefined) continue
    items.push({ content, status: todoStatus(item), nativeKey: 'update_plan' })
  }
  return items
}

/** Parse a `todo_list` item list of `{text, completed}` entries. */
function todoListItems(value: unknown): TaskItem[] {
  if (!Array.isArray(value)) return []
  const items: TaskItem[] = []
  for (const entry of value) {
    const item = asRecord(entry)
    const content = str(item, 'text') ?? str(item, 'step')
    if (content === undefined) continue
    items.push({ content, status: todoStatus(item), nativeKey: 'todo_list' })
  }
  return items
}

/** Native item status, mapped onto the mesh todo vocabulary. */
function todoStatus(item: Record<string, unknown> | undefined): AgentTodoStatus {
  if (item?.['completed'] === true) return 'completed'
  return PLAN_STATUS[normalizeToken(str(item, 'status'))] ?? 'pending'
}

/**
 * Build mesh todos with ids that are stable across reads.
 *
 * @param read - The task read, for session identity and ownership.
 * @param items - Native items, in list order.
 * @param timestamp - Timestamp of the record that carried the list.
 * @returns the mesh todos.
 */
function makeTodos(read: CodexNativeTaskRead, items: readonly TaskItem[], timestamp: string): AgentTodo[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = codexTodoId(read.nativeId, item.nativeKey, item.content)
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    return {
      // Identical content inside one list is the only case that needs a suffix, so the
      // common item keeps one id no matter how the list is reordered.
      id: occurrence === 1 ? base : `${base}-${String(occurrence)}`,
      content: item.content,
      status: item.status,
      owner: read.agentId,
      blockedBy: [],
      updatedAt: timestamp,
      observedIn: sessionKey(read.agentId, read.nativeId),
      nativeKey: item.nativeKey,
    }
  })
}

/**
 * Derive a todo id that survives re-reads.
 *
 * The id hashes the owning session, the native key and the item's content, so the same
 * checklist item keeps its id across reads.
 *
 * @param nativeId - Owning session's native id.
 * @param nativeKey - Native key of the item (`update_plan`, `todo_list`).
 * @param content - Item content.
 * @returns the mesh todo id value.
 */
export function codexTodoId(nativeId: string, nativeKey: string, content: string): string {
  return `codex-${hashText(`${nativeId}\u0000${nativeKey}\u0000${content}`)}`
}

/**
 * FNV-1a over the UTF-16 code units of a string, as 8 hex digits.
 *
 * Implemented here rather than imported so the adapter adds no dependency; it is a
 * stability device for ids, not a security primitive.
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
