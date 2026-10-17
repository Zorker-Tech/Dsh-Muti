/**
 * Grok Build's native todo and plan state, read from one session directory.
 *
 * `plan.json` holds an ordered `todos` map; `plan_mode.json` holds the lifecycle state,
 * which has no per-item status of its own. Both are read in place and never written.
 * @module @deepseek-ai/dsh-agent-grok/tasks
 */

import { join } from 'node:path'
import type {
  AgentHost,
  AgentNativeTasks,
  AgentPlan,
  AgentSessionKey,
  AgentTodo,
} from '@deepseek-ai/dsh-agent-mesh'
import { DEFAULT_STORE_FILE_BYTES } from './config.ts'
import { GROK_AGENT_ID, PLAN_FILE, PLAN_MODE_FILE, note, readStoreJson } from './sessions.ts'
import { todoStatus } from './transcript.ts'

/** Inputs of one native task read. */
export interface GrokNativeTasksRequest {
  /** Host providing the bounded file reads and the file modification time. */
  readonly host: AgentHost
  /** Absolute session directory holding the task files. */
  readonly sessionDir: string
  /** Mesh key of the session the items were observed in, when known. */
  readonly observedIn?: AgentSessionKey
}

/**
 * Read grok's native todo and plan-mode state.
 *
 * A session that recorded neither file has no native task state, which is reported as
 * `available: false` rather than as an error.
 * @param request - Host, session directory and the session key items were observed in.
 * @returns the observed state, with every projection gap declared in `notes`.
 */
export async function readGrokNativeTasks(request: GrokNativeTasksRequest): Promise<AgentNativeTasks> {
  const { host } = request
  const planPath = join(request.sessionDir, PLAN_FILE)
  const modePath = join(request.sessionDir, PLAN_MODE_FILE)
  const planRead = await readStoreJson(host, planPath, DEFAULT_STORE_FILE_BYTES)
  const modeRead = await readStoreJson(host, modePath, DEFAULT_STORE_FILE_BYTES)
  const planMissing = !planRead.present
  const modeMissing = !modeRead.present
  if (planMissing && modeMissing) return { available: false, todos: [], notes: [] }

  const notes: string[] = []
  const stat = await host.stat(planPath)
  const updatedAt = new Date(stat === undefined || stat.mtimeMs <= 0 ? 0 : stat.mtimeMs).toISOString()

  let todos: readonly AgentTodo[] = []
  if (planRead.ok) {
    todos = todosFromPlan(planRead.value, updatedAt, request.observedIn)
  } else if (!planMissing) {
    notes.push(note('todos', `plan.json could not be parsed: ${planRead.error}`))
  }
  if (!planMissing) {
    notes.push(note('todos', "grok's todo model carries no dependency edges, so every item has an empty blockedBy"))
  }

  let modeState: string | undefined
  if (modeRead.ok) {
    const record = asRecord(modeRead.value)
    modeState = record === undefined ? undefined : nonEmpty(record['state'])
  } else if (!modeMissing) {
    notes.push(note('plan', `plan_mode.json could not be parsed: ${modeRead.error}`))
  }
  if (modeState !== undefined && modeState !== 'Active' && modeState !== 'Inactive') {
    notes.push(note('plan', `plan_mode.json records the transient state "${modeState}", which is not a durable activity signal`))
  }

  const plan: AgentPlan | undefined = modeState === undefined
    ? undefined
    : { active: modeState === 'Active', items: todos.map(todo => todo.content) }
  return {
    available: true,
    todos,
    ...(plan === undefined ? {} : { plan }),
    notes,
  }
}

/**
 * Deterministic id for a native todo key.
 *
 * FNV-1a over UTF-16 code units: dependency-free, stable across runs and platforms.
 * @param nativeKey - The native todo id.
 * @returns an eight-character hexadecimal digest.
 */
export function stableKeyId(nativeKey: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < nativeKey.length; index += 1) {
    hash ^= nativeKey.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Project `plan.json`'s `todos` map, preserving file order. */
function todosFromPlan(value: unknown, updatedAt: string, observedIn?: AgentSessionKey): readonly AgentTodo[] {
  const record = asRecord(value)
  const todos = record === undefined ? undefined : asRecord(record['todos'])
  if (todos === undefined) return []
  const out: AgentTodo[] = []
  for (const [key, raw] of Object.entries(todos)) {
    const item = asRecord(raw)
    if (item === undefined) continue
    out.push({
      id: `grok-${stableKeyId(key)}`,
      content: nonEmpty(item['content']) ?? key,
      status: todoStatus(item['status']),
      owner: GROK_AGENT_ID,
      blockedBy: [],
      updatedAt,
      ...(observedIn === undefined ? {} : { observedIn }),
      nativeKey: key,
    })
  }
  return out
}

/** Narrow a JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

/** A non-empty string field. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
