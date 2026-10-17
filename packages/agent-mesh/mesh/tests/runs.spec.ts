import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AgentRunRegistry } from '../src/runs.ts'
import type {
  AgentAdapter,
  AgentId,
  AgentRun,
  AgentRunEvent,
  AgentRunId,
  AgentRunRequest,
  AgentRunResult,
  AgentSessionKey,
} from '../src/types.ts'

const agentId = brandString<AgentId>('codex')

/** A run whose events and result are scripted, with a controllable settle. */
function scriptedRun(
  events: readonly AgentRunEvent[],
  result: AgentRunResult,
): { run: AgentRun; cancelled: string[] } {
  const cancelled: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const run: AgentRun = {
    id: brandString<AgentRunId>('run-1'),
    result: gate.then(() => result),
    cancel: (reason) => { cancelled.push(reason ?? '') ; release() },
    async *[Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
      for (const event of events) yield event
      await gate
      yield { kind: 'run.finished', runId: brandString<AgentRunId>('run-1'), at: '2026-10-16T00:00:02.000Z', result }
    },
  }
  return { run, cancelled }
}

const request: AgentRunRequest = { prompt: 'do the thing', cwd: '/work' }

const terminal: AgentRunResult = {
  runId: brandString<AgentRunId>('run-1'),
  agentId,
  status: 'succeeded',
  startedAt: '2026-10-16T00:00:00.000Z',
  finishedAt: '2026-10-16T00:00:02.000Z',
  durationMs: 2000,
  cwd: '/work',
  finalText: 'done',
  notes: ['a note the projection could not carry'],
}

/** An adapter whose one run is scripted. */
function adapterWith(run: AgentRun, requests: AgentRunRequest[] = []): AgentAdapter {
  return {
    id: agentId,
    describe: async () => { throw new Error('not used') },
    readAuthState: async () => ({ status: 'unauthenticated', source: 'none' }),
    listSessions: async () => [],
    nativeLaunchCommand: async nativeId => ['agent', 'resume', nativeId],
    readTranscript: async () => { throw new Error('not used') },
    readNativeTasks: async () => ({ available: false, todos: [], notes: [] }),
    listModels: async () => [],
    readCapabilities: async () => ({
      agentId, tools: [], skills: [], mcpServers: [], commands: [], contextFiles: [], sources: [], notes: [],
      observedAt: '2026-10-16T00:00:00.000Z',
    }),
    resolveMcpServer: async () => undefined,
    login: async () => { throw new Error('not used') },
    logout: async () => { throw new Error('not used') },
    startRun: (request) => {
      requests.push(request)
      return run
    },
  }
}

describe('agent run registry', () => {
  it('captures a run, folds its result, and reports the terminal snapshot', async () => {
    const events: AgentRunEvent[] = [
      { kind: 'run.started', runId: brandString<AgentRunId>('run-1'), agentId, at: '2026-10-16T00:00:00.000Z' },
      { kind: 'message.delta', runId: brandString<AgentRunId>('run-1'), at: '2026-10-16T00:00:01.000Z', text: 'do' },
      { kind: 'message.completed', runId: brandString<AgentRunId>('run-1'), at: '2026-10-16T00:00:01.500Z', text: 'done' },
    ]
    const { run } = scriptedRun(events, terminal)
    const registry = new AgentRunRegistry(new Context())
    const handle = registry.start(adapterWith(run), request)
    expect(handle.runId).toBe('run-1')
    expect(registry.list()).toHaveLength(1)

    // Cancel releases the scripted gate, so the run settles as the adapter said.
    registry.cancel('run-1', 'testing')
    await handle.result
    const settled = await registry.wait('run-1')

    expect(settled?.status).toBe('succeeded')
    expect(settled?.finalText).toBe('done')
    expect(settled?.notes).toEqual(['a note the projection could not carry'])
    expect(settled?.eventCount).toBe(4)
    expect(settled?.events.map(event => event.kind)).toEqual([
      'run.started', 'message.delta', 'message.completed', 'run.finished',
    ])
    expect(settled?.nativeSessionKey).toBeUndefined()
  })

  it('passes the caller request through to the adapter unchanged', () => {
    const { run } = scriptedRun([], terminal)
    const requests: AgentRunRequest[] = []
    const registry = new AgentRunRegistry(new Context())
    registry.start(adapterWith(run, requests), { prompt: 'p', cwd: '/tmp', model: 'm', timeoutMs: 10 })
    expect(requests).toEqual([{ prompt: 'p', cwd: '/tmp', model: 'm', timeoutMs: 10 }])
  })

  it('refuses to cancel a run it does not track, or one already terminal', async () => {
    const { run, cancelled } = scriptedRun([], terminal)
    const registry = new AgentRunRegistry(new Context())
    expect(registry.cancel('missing')).toBe(false)

    const handle = registry.start(adapterWith(run), request)
    expect(registry.cancel('run-1')).toBe(true)
    await handle.result
    await registry.wait('run-1')
    expect(cancelled).toEqual([''])
    // The run settled with the adapter's own terminal status, so a second
    // cancel has nothing live to act on.
    expect(registry.cancel('run-1')).toBe(false)
  })

  it('reports an unknown run as absent', () => {
    const registry = new AgentRunRegistry(new Context())
    expect(registry.get('nope')).toBeUndefined()
    expect(registry.list()).toEqual([])
    expect(registry.cancel('nope')).toBe(false)
  })

  it('reports the native session a run bound to', async () => {
    const runId = brandString<AgentRunId>('run-bound')
    const run: AgentRun = {
      id: runId,
      result: Promise.resolve({
        ...terminal,
        runId,
        nativeSessionKey: brandString<AgentSessionKey>('codex:abc'),
      }),
      cancel: () => {},
      async *[Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
        yield { kind: 'session.bound', runId, at: '2026-10-16T00:00:00.500Z', nativeSessionId: 'abc' }
      },
    }
    const registry = new AgentRunRegistry(new Context())
    const handle = registry.start(adapterWith(run), request)
    await handle.result.catch(() => undefined)
    const settled = await registry.wait('run-bound')
    expect(settled?.nativeSessionKey).toBe('codex:abc')
    expect(settled?.finishedAt).toBe('2026-10-16T00:00:02.000Z')
  })

  it('bounds retained runs and retained events', async () => {
    const registry = new AgentRunRegistry(new Context(), { retainedEvents: 2, retainedRuns: 1 })
    const ids = ['run-1', 'run-2']
    for (const id of ids) {
      const runId = brandString<AgentRunId>(id)
      const run: AgentRun = {
        id: runId,
        result: Promise.resolve({ ...terminal, runId }),
        cancel: () => {},
        async *[Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
          for (const kind of ['run.started', 'message.delta', 'message.completed'] as const) {
            yield { kind, runId, agentId, at: '2026-10-16T00:00:00.000Z' } as AgentRunEvent
          }
        },
      }
      const handle = registry.start(adapterWith(run), request)
      await handle.result
      await registry.wait(id)
    }
    // One terminal run is retained; the newest replaced the older one.
    expect(registry.list().map(snapshot => snapshot.runId)).toEqual(['run-2'])
    expect(registry.get('run-2')?.events).toHaveLength(2)
  })

  it('keeps the terminal result when the event stream throws mid-run', async () => {
    const runId = brandString<AgentRunId>('run-throws')
    const run: AgentRun = {
      id: runId,
      result: Promise.resolve({ ...terminal, runId, status: 'succeeded' }),
      cancel: () => {},
      async *[Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
        yield { kind: 'run.started', runId, agentId, at: '2026-10-16T00:00:00.000Z' }
        throw new Error('stream broke')
      },
    }
    const registry = new AgentRunRegistry(new Context())
    const handle = registry.start(adapterWith(run), request)
    await handle.result
    const settled = await registry.wait('run-throws')
    // The adapter's own terminal result still wins: a broken stream is a
    // diagnostic, not a reason to discard the run's outcome.
    expect(settled?.status).toBe('succeeded')
    expect(settled?.eventCount).toBe(1)
  })

  it('stringifies non-Error failures from both the stream and terminal result', async () => {
    const runId = brandString<AgentRunId>('run-non-error')
    const run: AgentRun = {
      id: runId,
      result: Promise.resolve().then(() => { throw 'adapter result rejected' }),
      cancel: () => {},
      async *[Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
        throw 'event stream rejected'
      },
    }
    const registry = new AgentRunRegistry(new Context())
    const handle = registry.start(adapterWith(run), request)
    await handle.result.catch(() => undefined)
    const settled = await registry.wait('run-non-error')
    expect(settled?.status).toBe('failed')
    expect(settled?.error).toMatchObject({ code: 'run/protocol-error', message: 'adapter result rejected' })
  })

  it('records a failed run when an adapter never settles', async () => {
    const runId = brandString<AgentRunId>('run-rejects')
    const run: AgentRun = {
      id: runId,
      result: Promise.reject(new Error('adapter defect')),
      cancel: () => {},
      async *[Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
        yield { kind: 'run.started', runId, agentId, at: '2026-10-16T00:00:00.000Z' }
      },
    }
    const registry = new AgentRunRegistry(new Context())
    const handle = registry.start(adapterWith(run), request)
    await handle.result.catch(() => undefined)
    const settled = await registry.wait('run-rejects')
    expect(settled?.status).toBe('failed')
    expect(settled?.error?.code).toBe('run/protocol-error')
    expect(settled?.notes).toEqual(['the adapter failed after dispatch without producing a terminal result'])
  })

  it('dispose cancels every run still in flight', () => {
    const { run, cancelled } = scriptedRun([], terminal)
    const registry = new AgentRunRegistry(new Context())
    registry.start(adapterWith(run), request)
    registry.dispose()
    expect(cancelled).toEqual(['the agent mesh unloaded'])
  })
})
