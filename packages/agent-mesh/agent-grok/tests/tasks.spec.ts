import { describe, expect, it } from 'vitest'
import type { AgentId, AgentSessionKey } from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveGrokConfig } from '../src/config.ts'
import { grokAdapter } from '../src/index.ts'
import { readGrokNativeTasks, stableKeyId } from '../src/tasks.ts'
import { MemoryHost } from './support/memory-host.ts'

const DIR = '/home/tester/.grok/sessions/%2Fwork/sess-1'
const KEY = brandString<AgentSessionKey>('grok:sess-1')
const UPDATED_MS = Date.parse('2026-05-04T00:00:00.000Z')

describe('grok native tasks', () => {
  it('projects plan.json todos and the plan_mode lifecycle state', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: {
        [`${DIR}/plan.json`]: JSON.stringify({
          todos: {
            t1: { content: 'first', status: 'in_progress' },
            t2: { content: 'second', status: 'completed' },
            t3: { content: 'third', status: 'weird' },
          },
        }),
        [`${DIR}/plan_mode.json`]: JSON.stringify({ state: 'Active' }),
      },
      mtimes: { [`${DIR}/plan.json`]: UPDATED_MS },
    })

    const tasks = await readGrokNativeTasks({ host, sessionDir: DIR, observedIn: KEY })

    expect(tasks).toEqual({
      available: true,
      todos: [
        {
          id: `grok-${stableKeyId('t1')}`,
          content: 'first',
          status: 'in_progress',
          owner: 'grok',
          blockedBy: [],
          updatedAt: '2026-05-04T00:00:00.000Z',
          observedIn: KEY,
          nativeKey: 't1',
        },
        {
          id: `grok-${stableKeyId('t2')}`,
          content: 'second',
          status: 'completed',
          owner: 'grok',
          blockedBy: [],
          updatedAt: '2026-05-04T00:00:00.000Z',
          observedIn: KEY,
          nativeKey: 't2',
        },
        {
          id: `grok-${stableKeyId('t3')}`,
          content: 'third',
          status: 'pending',
          owner: 'grok',
          blockedBy: [],
          updatedAt: '2026-05-04T00:00:00.000Z',
          observedIn: KEY,
          nativeKey: 't3',
        },
      ],
      plan: { active: true, items: ['first', 'second', 'third'] },
      notes: ["todos: grok's todo model carries no dependency edges, so every item has an empty blockedBy"],
    })
  })

  it('declares a transient plan state instead of reading it as inactive', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: {
        [`${DIR}/plan.json`]: JSON.stringify({ todos: { t1: { content: 'first', status: 'pending' } } }),
        [`${DIR}/plan_mode.json`]: JSON.stringify({ state: 'Planning' }),
      },
    })

    const tasks = await readGrokNativeTasks({ host, sessionDir: DIR })

    expect(tasks.plan).toEqual({ active: false, items: ['first'] })
    expect(tasks.notes).toEqual([
      "todos: grok's todo model carries no dependency edges, so every item has an empty blockedBy",
      'plan: plan_mode.json records the transient state "Planning", which is not a durable activity signal',
    ])
  })

  it('reports a plan without todos and no plan file at all', async () => {
    const onlyMode = new MemoryHost({
      env: { PATH: '' },
      files: { [`${DIR}/plan_mode.json`]: JSON.stringify({ state: 'Inactive' }) },
    })
    const modeTasks = await readGrokNativeTasks({ host: onlyMode, sessionDir: DIR })
    expect(modeTasks.available).toBe(true)
    expect(modeTasks.todos).toEqual([])
    expect(modeTasks.plan).toEqual({ active: false, items: [] })
    expect(modeTasks.notes).toEqual([])

    const onlyPlan = new MemoryHost({
      env: { PATH: '' },
      files: { [`${DIR}/plan.json`]: JSON.stringify({ todos: {} }) },
    })
    const planTasks = await readGrokNativeTasks({ host: onlyPlan, sessionDir: DIR })
    expect(planTasks.plan).toBeUndefined()
    expect(planTasks.todos).toEqual([])
  })

  it('returns an empty todo list when a valid plan omits the todos map', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: { [`${DIR}/plan.json`]: '[]', [`${DIR}/plan_mode.json`]: '[]' },
    })
    const tasks = await readGrokNativeTasks({ host, sessionDir: DIR })
    expect(tasks.available).toBe(true)
    expect(tasks.todos).toEqual([])
    expect(tasks.plan).toBeUndefined()
  })

  it('reports the absence of both task files as no native task state', async () => {
    const host = new MemoryHost({ env: { PATH: '' } })
    const tasks = await readGrokNativeTasks({ host, sessionDir: DIR })

    expect(tasks).toEqual({ available: false, todos: [], notes: [] })
  })

  it('declares an unreadable plan.json rather than failing the read', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: { [`${DIR}/plan.json`]: '{"todos":' },
    })

    const tasks = await readGrokNativeTasks({ host, sessionDir: DIR })

    expect(tasks.available).toBe(true)
    expect(tasks.todos).toEqual([])
    expect(tasks.notes[0]).toMatch(/^todos: plan\.json could not be parsed: /)
    expect(tasks.notes[1]).toBe("todos: grok's todo model carries no dependency edges, so every item has an empty blockedBy")
  })

  it('skips malformed todo values and declares an unreadable plan mode', async () => {
    const host = new MemoryHost({
      env: { PATH: '' },
      files: {
        [`${DIR}/plan.json`]: JSON.stringify({ todos: { invalid: null, fallback: {} } }),
        [`${DIR}/plan_mode.json`]: '{not json',
      },
    })

    const tasks = await readGrokNativeTasks({ host, sessionDir: DIR })
    expect(tasks.todos).toMatchObject([{ nativeKey: 'fallback', content: 'fallback', status: 'pending' }])
    expect(tasks.todos[0]).not.toHaveProperty('observedIn')
    expect(tasks.notes.find(note => note.startsWith('plan:'))).toMatch(/^plan: plan_mode\.json could not be parsed: /)
  })

  it('reads native tasks through the adapter by locating the session directory', async () => {
    const sessionDir = '/home/tester/.grok/sessions/%2Fwork/sess-9'
    const host = new MemoryHost({
      home: '/home/tester',
      env: { PATH: '' },
      files: {
        [`${sessionDir}/summary.json`]: JSON.stringify({ info: { id: 'sess-9', cwd: '/work' }, updated_at: '2026-01-02T00:00:00.000Z' }),
        [`${sessionDir}/plan.json`]: JSON.stringify({ todos: { t1: { content: 'first', status: 'pending' } } }),
      },
    })
    const adapter = grokAdapter(host, resolveGrokConfig())
    const session = (await adapter.listSessions({}))[0]
    if (session === undefined) throw new Error('the fixture session was not listed')

    const tasks = await adapter.readNativeTasks({ session })

    expect(tasks.available).toBe(true)
    expect(tasks.todos[0]?.observedIn).toBe('grok:sess-9')
    expect(tasks.todos[0]?.content).toBe('first')
  })

  it('reports an unresolvable session directory as no task state', async () => {
    const host = new MemoryHost({ home: '/home/tester', env: { PATH: '' } })
    const adapter = grokAdapter(host, resolveGrokConfig())
    const tasks = await adapter.readNativeTasks({
      session: {
        key: KEY,
        agentId: brandString<AgentId>('grok'),
        nativeId: 'sess-gone',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'idle',
        notes: [],
      },
    })

    expect(tasks).toEqual({
      available: false,
      todos: [],
      notes: ['the session directory could not be located in the grok store; no native task state was read'],
    })
  })
})
