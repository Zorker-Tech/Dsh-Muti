import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId, AgentSession } from '@deepseek-ai/dsh-agent-mesh'
import { resolveOmpConfig } from '../src/config.ts'
import { resolveOmpStore, sessionKey } from '../src/sessions.ts'
import { readOmpNativeTasks } from '../src/tasks.ts'
import { entry, messageEntry, sessionFile, sessionHeader } from './support/fixtures.ts'
import { FakeHost } from './support/fake-host.ts'

const HOME = '/home/tester'
const BUCKET = '/home/tester/.omp/agent/sessions/-work-repo'
const agentId = brandString<AgentId>('omp')

/** A host, the resolved layout, and a session row for one file. */
async function fixtureOf(content: string): Promise<{
  host: FakeHost
  layout: ReturnType<typeof resolveOmpStore>
  session: AgentSession
}> {
  const host = new FakeHost({ env: {}, home: HOME })
  const layout = resolveOmpStore({ host, config: resolveOmpConfig() })
  const path = `${BUCKET}/1750000000000_sess-1.jsonl`
  host.addFile(path, content)
  return {
    host,
    layout,
    session: {
      key: sessionKey(agentId, 'sess-1'),
      agentId,
      nativeId: 'sess-1',
      nativePath: path,
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:01.000Z',
      status: 'idle',
      notes: [],
    },
  }
}

/** Read the native task state of one session file. */
async function tasksOf(content: string): Promise<Awaited<ReturnType<typeof readOmpNativeTasks>>> {
  const { host, layout, session } = await fixtureOf(content)
  return readOmpNativeTasks({ host, layout, agentId, session })
}

describe('OMP native tasks', () => {
  it('reads a user_todo_edit snapshot and maps the native status vocabulary', async () => {
    const tasks = await tasksOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          entry('e1', null, 'custom', {
            customType: 'user_todo_edit',
            data: {
              phases: [
                {
                  name: 'Build',
                  tasks: [
                    { content: 'Write the parser', status: 'completed' },
                    { content: 'Wire the reader', status: 'in_progress' },
                    { content: 'Ship it', status: 'blocked' },
                    { content: 'Rewrite the world', status: 'abandoned' },
                    { content: 'Unspecified work' },
                  ],
                },
              ],
            },
          }),
        ],
      }),
    )

    expect(tasks.available).toBe(true)
    expect(tasks.todos.map(todo => [todo.content, todo.status])).toEqual([
      ['Write the parser', 'completed'],
      ['Wire the reader', 'in_progress'],
      ['Ship it', 'blocked'],
      ['Rewrite the world', 'cancelled'],
      ['Unspecified work', 'pending'],
    ])
    expect(tasks.todos[0]).toMatchObject({
      owner: agentId,
      observedIn: 'omp:sess-1',
      nativeKey: 'Build/Write the parser',
      blockedBy: [],
      updatedAt: '2026-10-16T00:00:01.000Z',
    })
    expect(tasks.todos.every(todo => /^omp-[0-9a-f]{8}$/.test(todo.id))).toBe(true)
    expect(new Set(tasks.todos.map(todo => todo.id)).size).toBe(tasks.todos.length)
    expect(tasks.notes).toContain("todos: omp's todo model carries no dependency edges, so every item has an empty blockedBy")
    expect(tasks.plan).toBeUndefined()
  })

  it('reads a committed todo tool result, ignoring views and errors', async () => {
    const tasks = await tasksOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          messageEntry('e1', null, {
            role: 'toolResult',
            toolName: 'todo',
            isError: false,
            details: { op: 'view', phases: [{ name: 'Ignored', tasks: [{ content: 'not a snapshot', status: 'pending' }] }] },
          }),
          messageEntry('e2', 'e1', {
            role: 'toolResult',
            toolName: 'todo',
            isError: true,
            details: { op: 'edit', phases: [{ name: 'Ignored', tasks: [{ content: 'failed snapshot', status: 'pending' }] }] },
          }),
          messageEntry('e3', 'e2', {
            role: 'toolResult',
            toolName: 'todo',
            isError: false,
            details: {
              op: 'edit',
              phases: [{ name: 'Phase 2', tasks: [{ content: 'Committed task', status: 'in_progress' }] }],
            },
          }),
        ],
      }),
    )

    expect(tasks.todos.map(todo => [todo.content, todo.status, todo.nativeKey])).toEqual([
      ['Committed task', 'in_progress', 'Phase 2/Committed task'],
    ])
  })

  it('keeps the last snapshot on the live branch', async () => {
    const tasks = await tasksOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          entry('e1', null, 'custom', {
            customType: 'user_todo_edit',
            data: { phases: [{ name: 'Old', tasks: [{ content: 'stale', status: 'pending' }] }] },
          }),
          entry('e2', 'e1', 'custom', {
            customType: 'user_todo_edit',
            data: { phases: [{ name: 'New', tasks: [{ content: 'current', status: 'completed' }] }] },
          }),
        ],
      }),
    )
    expect(tasks.todos.map(todo => todo.content)).toEqual(['current'])
  })

  it('derives the plan from the latest mode_change and reports the plan file path', async () => {
    const active = await tasksOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          entry('e1', null, 'mode_change', { mode: 'none' }),
          entry('e2', 'e1', 'mode_change', { mode: 'plan', data: { planFilePath: '/work/repo/.omp/plan.md' } }),
        ],
      }),
    )
    expect(active.plan).toEqual({ active: true, items: ['/work/repo/.omp/plan.md'] })
    expect(active.notes).toContain(
      "plan: omp records the plan's file path, not its text; the path is reported verbatim and the file is not read",
    )

    const paused = await tasksOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [entry('e1', null, 'mode_change', { mode: 'plan_paused' })],
      }),
    )
    expect(paused.plan).toEqual({ active: true, items: [] })
    expect(paused.notes).toContain(
      'plan: the plan-mode transition recorded no plan file path, so the plan body has no locator here',
    )

    const off = await tasksOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [entry('e1', null, 'mode_change', { mode: 'none' })],
      }),
    )
    expect(off.plan).toEqual({ active: false, items: [] })
  })

  it('reports an available native model with no state when the session records neither', async () => {
    const tasks = await tasksOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [messageEntry('e1', null, { role: 'user', content: 'hello' })],
      }),
    )
    expect(tasks.available).toBe(true)
    expect(tasks.todos).toEqual([])
    expect(tasks.plan).toBeUndefined()
    expect(tasks.notes).toContain(
      'no user_todo_edit snapshot, todo tool result or mode_change entry appeared on the live branch',
    )
  })

  it('notes when the session file cannot be found', async () => {
    const host = new FakeHost({ env: {}, home: HOME })
    const layout = resolveOmpStore({ host, config: resolveOmpConfig() })
    const tasks = await readOmpNativeTasks({
      host,
      layout,
      agentId,
      session: {
        key: sessionKey(agentId, 'gone'),
        agentId,
        nativeId: 'gone',
        createdAt: '2026-10-16T00:00:00.000Z',
        updatedAt: '2026-10-16T00:00:00.000Z',
        status: 'idle',
        notes: [],
      },
    })
    expect(tasks).toEqual({ available: true, todos: [], notes: ['no session file was found for gone'] })
  })

  it('reports a vanished file separately from an unreadable header', async () => {
    const missing = await fixtureOf('')
    const vanished = await readOmpNativeTasks({
      host: missing.host,
      layout: missing.layout,
      agentId,
      session: { ...missing.session, nativePath: `${BUCKET}/vanished.jsonl` },
    })
    expect(vanished.notes).toContain('the session file disappeared during the read, so no todo or plan state was read')

    const unreadable = await tasksOf('not a session header\n')
    expect(unreadable.notes).toContain('the session header was unreadable, so the session the todo items belong to is unknown')
  })

  it('finds a session file when the row carries no path', async () => {
    const { host, layout, session } = await fixtureOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [entry('todo', null, 'custom', { customType: 'user_todo_edit', data: { phases: [{ tasks: [{ content: 'found by id' }] }] } })],
      }),
    )
    const { nativePath: _nativePath, ...withoutPath } = session
    const tasks = await readOmpNativeTasks({ host, layout, agentId, session: withoutPath })
    expect(tasks.todos.map(todo => todo.content)).toEqual(['found by id'])
  })

  it('guards malformed todo candidates and keeps only the live snapshot', async () => {
    const tasks = await tasksOf(
      sessionFile({
        header: sessionHeader({ id: 'sess-1' }),
        entries: [
          messageEntry('e1', null, { role: 'user', toolName: 'todo', details: { phases: [] } }),
          messageEntry('e2', 'e1', { role: 'toolResult', toolName: 'other', details: { phases: [] } }),
          messageEntry('e3', 'e2', { role: 'toolResult', toolName: 'todo', isError: true, details: { op: 'edit', phases: [] } }),
          messageEntry('e4', 'e3', { role: 'toolResult', toolName: 'todo', details: { op: 'edit' } }),
          messageEntry('e5', 'e4', { role: 'toolResult', toolName: 'todo', details: { phases: [] } }),
          entry('e6', 'e5', 'custom', { customType: 'other', data: { phases: [] } }),
          entry('e7', 'e6', 'custom', { customType: 'user_todo_edit' }),
          entry('e8', 'e7', 'other', {}),
          entry('abandoned', 'e8', 'custom', {
            customType: 'user_todo_edit',
            data: { phases: [{ name: 'Old', tasks: [{ content: 'old branch' }] }] },
          }),
          entry('live', 'e8', 'custom', {
            timestamp: 'invalid date',
            customType: 'user_todo_edit',
            data: {
              phases: [
                null,
                { tasks: 'not an array' },
                {
                  tasks: [null, { content: '' }, { content: 'same', status: 'unexpected' }, { content: 'same', status: 'abandoned' }],
                },
              ],
            },
          }),
        ],
      }),
    )
    expect(tasks.todos.map(todo => [todo.content, todo.status, todo.updatedAt])).toEqual([
      ['same', 'pending', '1970-01-01T00:00:00.000Z'],
      ['same', 'cancelled', '1970-01-01T00:00:00.000Z'],
    ])
    expect(tasks.todos[1]?.id).toBe(`${tasks.todos[0]?.id}-2`)
    expect(tasks.notes.join('\n')).toContain('abandoned branches are excluded from this reading')
  })
})
