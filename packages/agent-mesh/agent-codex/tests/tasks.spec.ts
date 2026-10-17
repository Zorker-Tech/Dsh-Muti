import { describe, expect, it } from 'vitest'
import type { AgentId, AgentSession, AgentSessionKey } from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { codexAdapter } from '../src/index.ts'
import { codexTodoId, hashText } from '../src/tasks.ts'
import { FakeHost } from './fake-host.ts'

const THREAD = '01920000-aaaa-bbbb-cccc-ddddeeeeffff'
const ROLLOUT = `/home/tester/.codex/sessions/2026/10/16/rollout-2026-10-16T10-00-00-${THREAD}.jsonl`

/** Build a session row pointing at the fixture rollout. */
function sessionFixture(): AgentSession {
  return {
    key: brandString<AgentSessionKey>(`codex:${THREAD}`),
    agentId: brandString<AgentId>('codex'),
    nativeId: THREAD,
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
    status: 'idle',
    notes: [],
  }
}

/** Build one rollout line. */
function line(timestamp: string, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp, type, payload })
}

describe('native task extraction', () => {
  it('reads the latest plan_update record and maps its statuses', async () => {
    const host = new FakeHost()
    host.addFile(
      ROLLOUT,
      [
        line('2026-10-16T10:00:00.000Z', 'session_meta', { id: THREAD }),
        line('2026-10-16T10:01:00.000Z', 'event_msg', {
          type: 'plan_update',
          plan: [
            { step: 'one', status: 'pending' },
            { step: 'two', status: 'in_progress' },
            { step: 'three', completed: true },
          ],
        }),
        line('2026-10-16T10:02:00.000Z', 'event_msg', { type: 'plan_update', plan: [{ step: 'later', status: 'pending' }] }),
      ].join('\n'),
    )
    const tasks = await codexAdapter(host).readNativeTasks({ session: sessionFixture() })
    expect(tasks.available).toBe(true)
    expect(tasks.plan).toBeUndefined()
    expect(tasks.todos.map(todo => [todo.content, todo.status])).toEqual([['later', 'pending']])
    expect(tasks.todos[0]).toMatchObject({
      owner: 'codex',
      blockedBy: [],
      updatedAt: '2026-10-16T10:02:00.000Z',
      observedIn: `codex:${THREAD}`,
      nativeKey: 'update_plan',
    })
    expect(tasks.notes).toContain('status: Codex checklists carry pending, in-progress and completed only; blocked and cancelled are unreachable')
    expect(tasks.notes).toContain('blockedBy: Codex expresses no dependencies between checklist items, so blockedBy is empty')
  })

  it('maps every native status token', async () => {
    const host = new FakeHost()
    host.addFile(
      ROLLOUT,
      [
        line('2026-10-16T10:00:00.000Z', 'session_meta', { id: THREAD }),
        line('2026-10-16T10:01:00.000Z', 'event_msg', {
          type: 'plan_update',
          plan: [
            { step: 'pending work', status: 'pending' },
            { step: 'active work', status: 'in_progress' },
            { step: 'done work', completed: true },
            { step: 'unmarked work' },
          ],
        }),
      ].join('\n'),
    )
    const tasks = await codexAdapter(host).readNativeTasks({ session: sessionFixture() })
    expect(tasks.todos.map(todo => todo.status)).toEqual(['pending', 'in_progress', 'completed', 'pending'])
  })

  it('reads an update_plan tool call whose arguments are a JSON string', async () => {
    const host = new FakeHost()
    host.addFile(
      ROLLOUT,
      [
        line('2026-10-16T10:00:00.000Z', 'session_meta', { id: THREAD }),
        line('2026-10-16T10:01:00.000Z', 'response_item', {
          type: 'function_call',
          name: 'update_plan',
          arguments: JSON.stringify({ plan: [{ step: 'from a tool call', status: 'in_progress' }] }),
        }),
      ].join('\n'),
    )
    const tasks = await codexAdapter(host).readNativeTasks({ session: sessionFixture() })
    expect(tasks.todos.map(todo => [todo.content, todo.status, todo.nativeKey])).toEqual([['from a tool call', 'in_progress', 'update_plan']])
  })

  it('reads a todo_list item and a plan item', async () => {
    const host = new FakeHost()
    host.addFile(
      ROLLOUT,
      [
        line('2026-10-16T10:00:00.000Z', 'session_meta', { id: THREAD }),
        line('2026-10-16T10:01:00.000Z', 'event_msg', {
          type: 'item_completed',
          item: { type: 'todo_list', items: [{ text: 'first', completed: true }, { text: 'second' }] },
        }),
        line('2026-10-16T10:02:00.000Z', 'event_msg', { type: 'item_completed', item: { type: 'plan', text: 'phase one' } }),
      ].join('\n'),
    )
    const tasks = await codexAdapter(host).readNativeTasks({ session: sessionFixture() })
    expect(tasks.todos.map(todo => [todo.content, todo.status, todo.nativeKey])).toEqual([
      ['first', 'completed', 'todo_list'],
      ['second', 'pending', 'todo_list'],
    ])
    expect(tasks.plan).toEqual({ active: true, items: ['phase one'] })
    expect(tasks.notes.join('\n')).toContain('plan.active: whether plan mode is still active is not recorded')
  })

  it('reports an empty state with a reason when the session records no tasks', async () => {
    const host = new FakeHost()
    host.addFile(ROLLOUT, `${line('2026-10-16T10:00:00.000Z', 'session_meta', { id: THREAD })}\n`)
    const tasks = await codexAdapter(host).readNativeTasks({ session: sessionFixture() })
    expect(tasks).toEqual({
      available: true,
      todos: [],
      notes: ['no update_plan, plan_update or todo_list record appeared in the read window'],
    })
  })

  it('reports a compressed rollout and a missing rollout without throwing', async () => {
    const host = new FakeHost()
    host.addFile(`${ROLLOUT}.zst`, 'binary')
    const compressed = await codexAdapter(host).readNativeTasks({ session: sessionFixture() })
    expect(compressed.todos).toEqual([])
    expect(compressed.notes[0]).toContain('zstd-compressed')

    const missing = await codexAdapter(new FakeHost()).readNativeTasks({ session: sessionFixture() })
    expect(missing.notes[0]).toBe(`no Codex rollout for session ${THREAD} under /home/tester/.codex`)
  })

  it('keeps todo ids stable across reads and disambiguates repeated content', async () => {
    const host = new FakeHost()
    host.addFile(
      ROLLOUT,
      [
        line('2026-10-16T10:00:00.000Z', 'session_meta', { id: THREAD }),
        line('2026-10-16T10:01:00.000Z', 'event_msg', {
          type: 'plan_update',
          plan: [{ step: 'same', status: 'pending' }, { step: 'same', status: 'pending' }],
        }),
      ].join('\n'),
    )
    const adapter = codexAdapter(host)
    const first = await adapter.readNativeTasks({ session: sessionFixture() })
    const second = await adapter.readNativeTasks({ session: sessionFixture() })
    expect(first.todos.map(todo => todo.id)).toEqual(second.todos.map(todo => todo.id))
    expect(first.todos[0]?.id).toBe(codexTodoId(THREAD, 'update_plan', 'same'))
    expect(first.todos[1]?.id).toBe(`${codexTodoId(THREAD, 'update_plan', 'same')}-2`)
  })

  it('hashes ids with FNV-1a', () => {
    expect(hashText('')).toBe('811c9dc5')
    expect(hashText('abc')).toMatch(/^[0-9a-f]{8}$/)
    expect(codexTodoId('t', 'update_plan', 'x')).toMatch(/^codex-[0-9a-f]{8}$/)
  })

  it('ignores malformed and empty records while accepting the remaining native task forms', async () => {
    const host = new FakeHost()
    host.addFile(
      ROLLOUT,
      [
        'not json',
        'null',
        JSON.stringify({ type: 'missing_payload' }),
        line('2026-10-16T10:01:00.000Z', 'response_item', { type: 'message', name: 'update_plan' }),
        line('2026-10-16T10:01:01.000Z', 'response_item', { type: 'function_call', name: 'other', arguments: '[]' }),
        line('2026-10-16T10:01:02.000Z', 'response_item', { type: 'function_call', name: 'update_plan', arguments: 'not json' }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify([{ text: 'array item' }, {}]) },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'plan_update', plan: [] } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'todo_list', items: [] } }),
        JSON.stringify({ type: 'other_event', payload: { type: 'todo_list', items: [{ step: 'top-level fallback' }] } }),
        JSON.stringify({ type: 'other_event', payload: { type: 'todo_list', items: 'not an array' } }),
        JSON.stringify({ type: 'other_event', payload: { type: 'todo_list', items: [] } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'todo_list', items: [{ step: 'event fallback' }, {}] } }),
        JSON.stringify({ type: 'event_msg', payload: { item: { type: 'todo_list', items: [] } } }),
        JSON.stringify({ type: 'event_msg', payload: { item: { type: 'plan' } } }),
        JSON.stringify({ type: 'other_event', payload: { type: 'plan' } }),
        JSON.stringify({ type: 'other_event', payload: { type: 'plan', text: 'top-level plan' } }),
      ].join('\n'),
    )

    const tasks = await codexAdapter(host).readNativeTasks({ session: sessionFixture() })
    expect(tasks.todos.map(todo => todo.content)).toEqual(['event fallback'])
    expect(tasks.plan).toEqual({ active: true, items: ['top-level plan'] })
    expect(tasks.notes).toContain('1 rollout line(s) in the read window were not valid JSON and could not contribute task state')
  })
})
