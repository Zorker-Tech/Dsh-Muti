import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId, AgentRunEvent, AgentRunRequest, HostProcess, HostSpawnSpec } from '@deepseek-ai/dsh-agent-mesh'
import { resolveOmpConfig } from '../src/config.ts'
import {
  buildJsonRunArgs as buildRunArgs,
  capEventText,
  classifyOmpExit,
  DEFAULT_MAX_PENDING_EVENTS,
  mintRunId,
  OmpRunProjection,
  RunEventQueue,
  runEnvironment,
  startOmpJsonRun as startOmpRun,
} from '../src/run.ts'
import { resolveOmpStore } from '../src/sessions.ts'
import { sessionFile, sessionHeader } from './support/fixtures.ts'
import { FakeHost } from './support/fake-host.ts'

const HOME = '/home/tester'
const BUCKET = '/home/tester/.omp/agent/sessions/-work-repo'
const agentId = brandString<AgentId>('omp')
const EVENT_AT = '2026-10-16T00:00:00.000Z'

/** Create the pure event mapper used by one direct projection case. */
function projection(): OmpRunProjection {
  return new OmpRunProjection({ runId: mintRunId(new FakeHost({ home: HOME }), 1) })
}

/** A process host that rejects its streams with non-Error values. */
class UnusualStreamHost extends FakeHost {
  constructor(private readonly lineFailure?: unknown, private readonly stderrFailure?: unknown) {
    super({ home: HOME })
  }

  override spawn(_spec: HostSpawnSpec): HostProcess {
    const lineFailure = this.lineFailure
    const stderrFailure = this.stderrFailure
    return {
      lines: (async function* lines(): AsyncGenerator<string> {
        yield JSON.stringify({ type: 'session', id: 'stream' })
        if (lineFailure !== undefined) throw lineFailure
        yield JSON.stringify({ type: 'agent_end' })
      })(),
      stderr: async () => {
        if (stderrFailure !== undefined) throw stderrFailure
        return ''
      },
      exit: Promise.resolve({ code: 0, signal: null, timedOut: false, cancelled: false }),
      cancel: () => undefined,
    }
  }
}

/** A request with every optional field absent. */
function request(prompt = 'do the work'): AgentRunRequest {
  return { prompt, cwd: '/work/repo' }
}

/** Run one scripted dispatch and collect its events and terminal result. */
async function dispatch(
  host: FakeHost,
  config: Parameters<typeof resolveOmpConfig>[0] = {},
  runRequest: AgentRunRequest = request(),
): Promise<{ events: AgentRunEvent[]; result: Awaited<ReturnType<typeof startOmpRun>['result']> }> {
  const layout = resolveOmpStore({ host, config: resolveOmpConfig(config) })
  const run = startOmpRun({ host, config: resolveOmpConfig(config), layout, agentId, runId: mintRunId(host, 1) }, runRequest)
  const events: AgentRunEvent[] = []
  for await (const event of run) events.push(event)
  return { events, result: await run.result }
}

describe('OMP run dispatch', () => {
  it('projects a full NDJSON stream onto mesh run events', async () => {
    const host = new FakeHost({ env: {}, home: HOME })
    host.script({
      lines: [
        JSON.stringify({ type: 'session', id: 'sess-1', timestamp: '2026-10-16T00:00:00.000Z', cwd: '/work/repo', version: 3 }),
        JSON.stringify({ type: 'agent_start' }),
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Working' } }),
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hm' } }),
        JSON.stringify({
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'read_file',
          args: { path: 'src/index.ts' },
        }),
        JSON.stringify({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read_file', result: 'file text', isError: false }),
        JSON.stringify({
          type: 'todo_reminder',
          todos: [
            { content: 'Wire the reader', status: 'in_progress' },
            { content: 'Ship it', status: 'abandoned' },
          ],
        }),
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input: 10, output: 4, totalTokens: 14 } },
        }),
        JSON.stringify({ type: 'agent_end', isTerminal: true }),
      ],
    })

    const { events, result } = await dispatch(host)
    expect(events.map(event => event.kind)).toEqual([
      'run.started',
      'session.bound',
      'message.delta',
      'reasoning.delta',
      'tool.started',
      'tool.completed',
      'todos.updated',
      'message.completed',
      'usage.updated',
      'run.finished',
    ])

    const bound = events[1]
    expect(bound).toMatchObject({ kind: 'session.bound', nativeSessionId: 'sess-1' })
    const todos = events[6]
    expect(todos).toMatchObject({
      kind: 'todos.updated',
      todos: [
        { content: 'Wire the reader', status: 'in_progress' },
        { content: 'Ship it', status: 'cancelled' },
      ],
    })
    const toolStart = events[4]
    expect(toolStart).toMatchObject({ kind: 'tool.started', callId: 'call-1', toolName: 'read_file', input: '{"path":"src/index.ts"}' })
    const toolEnd = events[5]
    expect(toolEnd).toMatchObject({ kind: 'tool.completed', callId: 'call-1', toolName: 'read_file', output: '"file text"' })

    expect(result.status).toBe('succeeded')
    expect(result.finalText).toBe('Done.')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 0, totalTokens: 14 })
    expect(result.nativeSessionKey).toBe('omp:sess-1')
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeUndefined()

    const spawn = host.spawns[0]
    expect(spawn?.command).toBe('omp')
    expect(spawn?.args).toEqual(['--mode', 'json'])
    expect(spawn?.stdin).toBe('do the work')
    expect(spawn?.cwd).toBe('/work/repo')
    expect(spawn?.env).toMatchObject({ PI_CODING_AGENT_DIR: '/home/tester/.omp/agent' })
  })

  it('maps a todo_auto_clear to an empty todo update and warns on notices', async () => {
    const host = new FakeHost({ env: {}, home: HOME })
    host.script({
      lines: [
        JSON.stringify({ type: 'session', id: 'sess-1' }),
        JSON.stringify({ type: 'notice', level: 'warning', message: 'a stale extension was skipped', source: 'loader' }),
        JSON.stringify({ type: 'todo_auto_clear' }),
        JSON.stringify({ type: 'agent_end' }),
      ],
    })
    const { events } = await dispatch(host)
    expect(events.map(event => event.kind)).toEqual([
      'run.started',
      'session.bound',
      'warning',
      'todos.updated',
      'run.finished',
    ])
    expect(events[2]).toMatchObject({ kind: 'warning', message: 'omp warning notice from loader: a stale extension was skipped' })
    expect(events[3]).toMatchObject({ kind: 'todos.updated', todos: [] })
  })

  it('classifies an unauthenticated exit from the stderr evidence', async () => {
    const host = new FakeHost({ env: {}, home: HOME })
    host.script({
      lines: ['no api key is configured for the selected provider'],
      exit: { code: 1, signal: null, timedOut: false, cancelled: false },
      stderr: 'omp: no api key is configured for the selected provider',
    })
    const { events, result } = await dispatch(host)

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('run/auth-not-configured')
    expect(result.error?.output).toContain('no api key')
    expect(result.error?.remediation).toContain('omp login')
    expect(result.exitCode).toBe(1)
    expect(events.at(-1)?.kind).toBe('run.finished')
  })

  it('classifies a missing session, a rate limit and a plain crash', () => {
    expect(classifyOmpExit(1, 'error: session abc not found')).toMatchObject({ code: 'run/session-not-found' })
    expect(classifyOmpExit(1, 'provider rate limit reached (429)')).toMatchObject({ code: 'run/rate-limited' })
    expect(classifyOmpExit(2, 'boom')).toMatchObject({ code: 'run/agent-crashed', message: 'omp exited with code 2' })
  })

  it('classifies an exit with no session header as context-unavailable', async () => {
    const host = new FakeHost({ env: {}, home: HOME })
    host.script({ lines: [], exit: { code: 0, signal: null, timedOut: false, cancelled: false } })
    const { result } = await dispatch(host)
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('run/context-unavailable')
  })

  it('classifies a failed assistant turn reported on the stream', async () => {
    const host = new FakeHost({ env: {}, home: HOME })
    host.script({
      lines: [
        JSON.stringify({ type: 'session', id: 'sess-1' }),
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider exploded' },
        }),
        JSON.stringify({ type: 'agent_end' }),
      ],
    })
    const { events, result } = await dispatch(host)
    expect(result.status).toBe('failed')
    expect(result.error).toMatchObject({ code: 'run/agent-crashed', message: 'provider exploded' })
    expect(events.some(event => event.kind === 'warning' && event.message.includes('provider exploded'))).toBe(true)
  })

  it('warns about an empty prompt and a requested sandbox, then succeeds', async () => {
    const host = new FakeHost({ env: {}, home: HOME })
    host.script({ lines: [JSON.stringify({ type: 'session', id: 'sess-1' }), JSON.stringify({ type: 'agent_end' })] })
    const { events, result } = await dispatch(host, {}, { prompt: '', cwd: '/work/repo', sandbox: 'strict', approval: 'on-request' })

    expect(events.filter(event => event.kind === 'warning')).toHaveLength(2)
    expect(result.status).toBe('succeeded')
    expect(result.notes).toContain('the prompt was empty, so omp was started with nothing to send')
    expect(result.notes).toContain('omp has no sandbox, so the requested sandbox profile was ignored')
    expect(result.notes.some(note => note.includes('approval "on-request" is not one of omp\'s modes'))).toBe(true)
    expect(host.spawns[0]?.args).toEqual(['--mode', 'json'])
  })

  it('resumes a known session by path and warns when its recorded cwd differs', async () => {
    const host = new FakeHost({ env: {}, home: HOME })
    const path = `${BUCKET}/1750000000000_sess-1.jsonl`
    host.addFile(path, sessionFile({ header: sessionHeader({ id: 'sess-1', cwd: '/work/elsewhere' }) }))
    host.script({
      lines: [JSON.stringify({ type: 'session', id: 'sess-1' }), JSON.stringify({ type: 'agent_end' })],
      exit: { code: 0, signal: null, timedOut: false, cancelled: false },
    })
    const { events, result } = await dispatch(host, {}, {
      prompt: 'continue',
      cwd: '/work/repo',
      resumeNativeId: 'sess-1',
      model: 'anthropic/claude-sonnet-4',
      approval: 'yolo',
    })

    expect(host.spawns[0]?.args).toEqual([
      '--mode',
      'json',
      '--resume',
      path,
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-4',
      '--approval-mode',
      'yolo',
    ])
    expect(result.notes.some(note => note.includes('records cwd /work/elsewhere'))).toBe(true)
    expect(events.some(event => event.kind === 'warning' && event.message.includes('records cwd'))).toBe(true)
  })

  it('passes an unknown resume id verbatim so omp can resolve it itself', async () => {
    const host = new FakeHost({ env: {}, home: HOME })
    host.script({ lines: [], exit: { code: 0, signal: null, timedOut: false, cancelled: false } })
    await dispatch(host, {}, { prompt: 'continue', cwd: '/work/repo', resumeNativeId: 'unknown-id' })
    expect(host.spawns[0]?.args).toEqual(['--mode', 'json', '--resume', 'unknown-id'])
  })

  it('records unparsable stdout as a note without inventing events', async () => {
    const host = new FakeHost({ env: {}, home: HOME })
    host.script({
      lines: ['not json', JSON.stringify({ type: 'session', id: 'sess-1' }), JSON.stringify({ type: 'agent_end' })],
    })
    const { result } = await dispatch(host)
    expect(result.status).toBe('succeeded')
    expect(result.notes.some(note => note.includes('1 stdout line(s) were not valid JSON'))).toBe(true)
  })

  it('builds argv for the provider/model split, resume and approval rules', () => {
    expect(buildRunArgs({})).toEqual(['--mode', 'json'])
    expect(buildRunArgs({ model: '@slow' })).toEqual(['--mode', 'json', '--model', '@slow'])
    expect(buildRunArgs({ model: 'openai/gpt-5' })).toEqual(['--mode', 'json', '--provider', 'openai', '--model', 'gpt-5'])
    // An approval mode outside omp's vocabulary is never passed on argv.
    expect(buildRunArgs({ approval: 'on-request' })).toEqual(['--mode', 'json'])
    expect(buildRunArgs({ approval: 'write' })).toEqual(['--mode', 'json', '--approval-mode', 'write'])
  })

  it('derives the child environment from the layout and layers the caller last', () => {
    const host = new FakeHost({ env: {}, home: HOME })
    const layout = resolveOmpStore({ host, config: resolveOmpConfig({ sessionDir: '/flat' }) })
    const env = runEnvironment({ config: resolveOmpConfig({ homeDir: '/opt/omp', env: { OMP_EXTRA: '1' } }), layout }, { OMP_EXTRA: '2', CALLER: 'yes' })
    expect(env).toEqual({
      PI_CODING_AGENT_DIR: '/home/tester/.omp/agent',
      PI_CODING_AGENT_SESSION_DIR: '/flat',
      OMP_PROFILE: '',
      OMP_EXTRA: '2',
      CALLER: 'yes',
    })
  })
})

describe('OMP run event projection', () => {
  it('binds headers, preserves unknown records and deduplicates projection notes', () => {
    const mapped = projection()
    expect(mapped.observe({ type: 'session', id: 'bare' }, 'header', EVENT_AT)).toMatchObject([
      { kind: 'session.bound', nativeSessionId: 'bare' },
    ])
    expect(mapped.state()).toMatchObject({ sessionId: 'bare', header: { id: 'bare' } })
    expect(mapped.state().notes).toEqual([])
    mapped.observe({ type: 'session', id: 'rich', cwd: '/work', parentSession: 'parent', version: 2, title: 'Title' }, 'header', EVENT_AT)
    expect(mapped.state().notes).toContain('the session header also records cwd, parentSession, version, title, which session.bound has no field for')

    expect(mapped.observe(null, 'null', EVENT_AT)[0]).toMatchObject({ kind: 'unknown', native: 'null' })
    expect(mapped.observe({ value: 1 }, 'no type', EVENT_AT)[0]).toMatchObject({ kind: 'unknown' })
    expect(mapped.observe({ type: 'thinking_level_changed' }, 'state', EVENT_AT)[0])
      .toMatchObject({ kind: 'unknown', nativeType: 'thinking_level_changed' })
    expect(mapped.observe({ type: 'future_event' }, 'future', EVENT_AT)[0])
      .toMatchObject({ kind: 'unknown', nativeType: 'future_event' })
    expect(mapped.state().notes).toEqual(expect.arrayContaining([
      'a stdout record had no event type and was preserved as an unknown event',
      'an unrecognized omp event type (future_event) was preserved as an unknown event',
    ]))

    mapped.addNote('same note')
    mapped.addNote('same note')
    expect(mapped.state().notes.filter(note => note === 'same note')).toHaveLength(1)
    expect(mapped.warn('a diagnostic', EVENT_AT)).toMatchObject({ kind: 'warning', message: 'a diagnostic' })

    const longUnknown = mapped.observe({ type: 'future_large' }, 'x'.repeat(9_000), EVENT_AT)[0]
    if (longUnknown?.kind !== 'unknown') throw new Error('expected an unknown event')
    expect(longUnknown.native).toContain('[truncated by dsh-agent-omp')
    expect(capEventText('short')).toBe('short')
    expect(capEventText('x'.repeat(8_193))).toContain('[truncated by dsh-agent-omp at 8192 characters]')
  })

  it('maps every known event family and the delta/message subtypes', () => {
    const mapped = projection()
    const map = (value: unknown, raw = 'native'): readonly AgentRunEvent[] => mapped.observe(value, raw, EVENT_AT)
    const outputs: AgentRunEvent[] = []
    for (const value of [
      { type: 'session', id: 'sess', cwd: '/work', parentSession: 'parent', version: 2, title: 'Session' },
      { type: 'message_update' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'text' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thought' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } },
      { type: 'message_update', assistantMessageEvent: { type: 'error' } },
      { type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'aborted' } },
      { type: 'message_update', assistantMessageEvent: { type: 'done' } },
      ...['start', 'text_start', 'text_end', 'thinking_start', 'thinking_end', 'image_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end']
        .map(type => ({ type: 'message_update', assistantMessageEvent: { type } })),
      { type: 'message_update', assistantMessageEvent: {} },
      { type: 'message_update', assistantMessageEvent: { type: 'unknown_delta' } },
      { type: 'message_end' },
      { type: 'message_end', message: { role: 'assistant' } },
      {
        type: 'message_end',
        message: {
          role: 'assistant', content: 'final text', stopReason: 'stop', errorMessage: 'provider warning',
          usage: {
            input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, reasoningTokens: 6,
            cost: { total: 0.5 },
          },
        },
      },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'A' }, null, { type: 'image' }, { type: 'text', text: 'B' }, { type: 'text' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', usage: {} } },
      ...['user', 'toolResult', 'bashExecution', 'pythonExecution', 'fileMention', 'developer', 'custom', 'hookMessage']
        .map(role => ({ type: 'message_end', message: { role } })),
      { type: 'message_end', message: {} },
      { type: 'tool_execution_start' },
      { type: 'tool_execution_start', toolCallId: 'call', toolName: 'read', args: { path: '/tmp/a' } },
      { type: 'tool_execution_end', isError: true },
      { type: 'tool_execution_end', toolCallId: 'call', toolName: 'read', result: { ok: true }, isError: false },
      { type: 'todo_reminder' },
      { type: 'todo_reminder', todos: [null, {}, { content: 'bad status' }, { content: 1, status: 'completed' }] },
      {
        type: 'todo_reminder', todos: [
          { content: 'doing', status: 'in_progress' }, { content: 'done', status: 'completed' },
          { content: 'blocked', status: 'blocked' }, { content: 'abandoned', status: 'abandoned' },
          { content: 'other', status: 'new' },
        ],
      },
      { type: 'todo_auto_clear' },
      { type: 'auto_compaction_start' },
      { type: 'auto_compaction_start', action: 'trim', reason: 'context' },
      { type: 'auto_compaction_end', aborted: true },
      { type: 'auto_compaction_end' },
      { type: 'auto_compaction_end', errorMessage: 'compaction failed' },
      { type: 'auto_retry_start' },
      { type: 'auto_retry_start', attempt: 2, maxAttempts: 4, errorMessage: 'provider unavailable' },
      { type: 'auto_retry_end', success: true },
      { type: 'auto_retry_end' },
      { type: 'auto_retry_end', finalError: 'retry exhausted' },
      { type: 'retry_fallback_applied' },
      { type: 'retry_fallback_applied', from: 'model-a', to: 'model-b', reason: 'rate limit' },
      { type: 'notice' },
      { type: 'notice', level: 'warn', message: 'notice text', source: 'plugin' },
      { type: 'agent_end', isTerminal: false },
      { type: 'agent_end' },
      ...[
        'agent_start', 'turn_start', 'turn_end', 'message_start', 'queue_update', 'tool_execution_update',
        'tool_stream_update', 'config_warnings_changed', 'advisor_cost_changed', 'advisor_yielded',
      ].map(type => ({ type })),
      ...[
        'model_changed', 'ttsr_triggered', 'goal_updated', 'irc_message', 'cache_warming_start',
        'cache_warming_end', 'retry_fallback_succeeded',
      ].map(type => ({ type })),
    ]) outputs.push(...map(value))

    expect(outputs.some(event => event.kind === 'message.delta' && event.text === 'text')).toBe(true)
    expect(outputs.some(event => event.kind === 'reasoning.delta' && event.text === 'thought')).toBe(true)
    expect(outputs.some(event => event.kind === 'todos.updated' && event.todos.length === 5)).toBe(true)
    expect(outputs.filter(event => event.kind === 'warning').length).toBeGreaterThan(5)
    expect(mapped.state()).toMatchObject({
      sessionId: 'sess', settled: true, aborted: true, finalText: 'AB', lastStopReason: 'aborted',
      lastErrorMessage: 'provider warning', toolCalls: 2, toolFailures: 1, cacheWriteTokens: 5,
    })
    expect(mapped.state().notes).toContain('omp reports cache-write tokens, which the mesh usage type cannot carry')
    expect(mapped.state().notes).toContain("omp's compaction failed: compaction failed")
    expect(mapped.state().notes).toContain("omp's automatic retry failed: the retry budget was exhausted")
  })

  it('bounds tool values and accumulates optional usage fields', () => {
    const mapped = projection()
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(mapped.observe({ type: 'tool_execution_start', args: circular }, 'raw', EVENT_AT)[0])
      .toMatchObject({ kind: 'tool.started', input: '<unserializable>' })
    expect(mapped.observe({ type: 'tool_execution_start', args: Symbol('arguments') }, 'raw', EVENT_AT)[0])
      .toMatchObject({ kind: 'tool.started', input: 'Symbol(arguments)' })
    const bounded = mapped.observe({ type: 'tool_execution_start', args: 'x'.repeat(9_000) }, 'raw', EVENT_AT)[0]
    if (bounded?.kind !== 'tool.started') throw new Error('expected a tool-started event')
    expect(bounded.input).toContain('[truncated by dsh-agent-omp')
    expect(mapped.observe({ type: 'message_end', message: { role: 'assistant', usage: { input: 1 } } }, 'raw', EVENT_AT))
      .toMatchObject([{ kind: 'usage.updated', usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 } }])
    expect(mapped.observe({ type: 'message_end', message: { role: 'assistant', usage: { reasoningTokens: 0, cost: { total: 0 } } } }, 'raw', EVENT_AT))
      .toMatchObject([{ kind: 'usage.updated' }])
  })
})

describe('OMP run terminal classification', () => {
  it('settles spawn, exit, timeout, signal, assistant-error and abort results', async () => {
    const errorSpawn = new FakeHost({ home: HOME })
    errorSpawn.script({ spawnFailure: new Error('binary missing') })
    const spawnError = await dispatch(errorSpawn)
    expect(spawnError.result).toMatchObject({
      status: 'failed', error: { code: 'run/start-failed', message: 'the omp process could not be started: binary missing' },
    })

    const stringSpawn = new FakeHost({ home: HOME })
    stringSpawn.script({ spawnFailure: 'host refused spawn' })
    expect((await dispatch(stringSpawn)).result.error?.message).toContain('host refused spawn')

    const noStatus = new FakeHost({ home: HOME })
    noStatus.script({ exit: { code: null, signal: null, timedOut: false, cancelled: false } })
    expect((await dispatch(noStatus)).result).toMatchObject({ status: 'failed', error: { code: 'run/start-failed' } })

    const signal = new FakeHost({ home: HOME })
    signal.script({ exit: { code: null, signal: 'SIGKILL', timedOut: false, cancelled: false } })
    expect((await dispatch(signal)).result).toMatchObject({
      status: 'failed', signal: 'SIGKILL', error: { code: 'run/agent-crashed' },
    })

    const timed = new FakeHost({ home: HOME })
    timed.script({
      lines: [JSON.stringify({ type: 'session', id: 'timed' })],
      exit: { code: null, signal: 'SIGTERM', timedOut: true, cancelled: false },
    })
    expect((await dispatch(timed, {}, { ...request(), timeoutMs: 50 })).result).toMatchObject({
      status: 'timeout', error: { code: 'run/timeout', message: 'the run exceeded its 50 ms budget' },
      notes: ['the run was killed after 50 ms'],
    })

    const genericTimeout = new FakeHost({ home: HOME })
    genericTimeout.script({ exit: { code: null, signal: 'SIGTERM', timedOut: true, cancelled: false } })
    expect((await dispatch(genericTimeout)).result.error?.message).toContain('its configured budget')

    const nonzero = new FakeHost({ home: HOME })
    nonzero.script({
      exit: { code: 2, signal: null, timedOut: false, cancelled: false },
      stderr: 'provider quota exceeded; '.repeat(200),
    })
    const nonzeroResult = (await dispatch(nonzero)).result
    expect(nonzeroResult).toMatchObject({ status: 'failed', error: { code: 'run/rate-limited' } })
    expect(nonzeroResult.error?.output).toHaveLength(2_000)

    const assistantError = new FakeHost({ home: HOME })
    assistantError.script({
      lines: [
        JSON.stringify({ type: 'session', id: 'error' }),
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'error' } }),
      ],
    })
    expect((await dispatch(assistantError)).result).toMatchObject({
      status: 'failed', error: { code: 'run/agent-crashed', message: 'the assistant response failed' },
    })

    const aborted = new FakeHost({ home: HOME })
    aborted.script({
      lines: [
        JSON.stringify({ type: 'session', id: 'aborted' }),
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'aborted' } }),
      ],
    })
    expect((await dispatch(aborted)).result).toMatchObject({
      status: 'cancelled', error: { code: 'run/cancelled', message: 'omp aborted the turn' },
    })
  })

  it('records incomplete streams, stream read failures, stderr failures and malformed lines', async () => {
    const incomplete = new FakeHost({ home: HOME })
    incomplete.script({ lines: [JSON.stringify({ type: 'session', id: 'incomplete' })] })
    expect((await dispatch(incomplete)).result.notes).toContain(
      'the stream ended before omp reported a terminal agent_end, so the turn may not have finished',
    )

    const streamFailure = new FakeHost({ home: HOME })
    streamFailure.script({
      lines: [JSON.stringify({ type: 'session', id: 'stream' })], linesError: 'stdout disconnected',
      exit: { code: 0, signal: null, timedOut: false, cancelled: false },
    })
    const stream = await dispatch(streamFailure)
    expect(stream.events.some(event => event.kind === 'warning' && event.message.includes('stdout disconnected'))).toBe(true)
    expect(stream.result.notes).toContain('the stdout stream ended abnormally: stdout disconnected')

    const stderrFailure = new FakeHost({ home: HOME })
    stderrFailure.script({
      lines: [JSON.stringify({ type: 'session', id: 'stderr' }), JSON.stringify({ type: 'agent_end' })],
      stderrError: 'stderr denied',
    })
    expect((await dispatch(stderrFailure)).result.notes).toContain('the stdout stream ended abnormally: stderr could not be read: stderr denied')

    const malformed = new FakeHost({ home: HOME })
    malformed.script({ lines: ['', 'not json', JSON.stringify({ type: 'session', id: 'parsed' }), JSON.stringify({ type: 'agent_end' })] })
    const result = (await dispatch(malformed)).result
    expect(result.notes).toContain('1 stdout line(s) were not valid JSON and are recorded as notes')
    expect(result.status).toBe('succeeded')
  })

  it('keeps a non-Error JSON parser failure in the malformed-line note', async () => {
    const host = new FakeHost({ home: HOME })
    host.script({ lines: ['not json'] })
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw 'parser rejected input'
    })
    try {
      const result = (await dispatch(host)).result
      expect(result.notes).toContain('stdout line was not valid JSON (parser rejected input)')
    } finally {
      parse.mockRestore()
    }
  })

  it('stringifies non-Error stdout and stderr stream failures', async () => {
    const stdout = await dispatch(new UnusualStreamHost('non-error stdout failure'))
    expect(stdout.result.notes).toContain('the stdout stream ended abnormally: non-error stdout failure')
    expect(stdout.events.some(event => event.kind === 'warning' && event.message.includes('non-error stdout failure'))).toBe(true)

    const stderr = await dispatch(new UnusualStreamHost(undefined, 'non-error stderr failure'))
    expect(stderr.result.notes).toContain('the stdout stream ended abnormally: stderr could not be read: non-error stderr failure')
  })

  it('uses profile notes, resolves empty and matching resumes, and handles cancellation before spawn', async () => {
    const profile = new FakeHost({ env: { OMP_PROFILE: 'staging' }, home: HOME })
    profile.script({ lines: [JSON.stringify({ type: 'session', id: 'profile' }), JSON.stringify({ type: 'agent_end' })] })
    const profileRun = await dispatch(profile, { homeDir: '/override' })
    expect(profileRun.result.notes).toContain(
      'the host environment selects profile "staging", which would ignore the adapter\'s homeDir override, so the run was started with the default profile selected',
    )

    const emptyResume = new FakeHost({ home: HOME })
    emptyResume.script({ lines: [JSON.stringify({ type: 'session', id: 'empty-resume' }), JSON.stringify({ type: 'agent_end' })] })
    await dispatch(emptyResume, {}, { ...request(), resumeNativeId: '' })
    expect(emptyResume.spawns[0]?.args).toEqual(['--mode', 'json'])

    const matchingResume = new FakeHost({ home: HOME })
    matchingResume.addFile(`${BUCKET}/1750000000000_same.jsonl`, sessionFile({ header: sessionHeader({ id: 'same', cwd: '/work/repo' }) }))
    matchingResume.script({ lines: [JSON.stringify({ type: 'session', id: 'same' }), JSON.stringify({ type: 'agent_end' })] })
    const same = await dispatch(matchingResume, {}, { ...request(), resumeNativeId: 'same' })
    expect(same.events.some(event => event.kind === 'warning' && event.message.includes('records cwd'))).toBe(false)

    const noHeader = new FakeHost({ home: HOME })
    noHeader.addFile(`${BUCKET}/1750000000000_headerless.jsonl`, 'not json\n')
    noHeader.script({ lines: [JSON.stringify({ type: 'session', id: 'headerless' }), JSON.stringify({ type: 'agent_end' })] })
    const headerless = await dispatch(noHeader, {}, {
      ...request(), resumeNativeId: `${BUCKET}/1750000000000_headerless.jsonl`,
    })
    expect(headerless.result.notes.some(note => note.includes('records cwd'))).toBe(false)

    const emptyCwd = new FakeHost({ home: HOME })
    emptyCwd.addFile(`${BUCKET}/1750000000000_empty-cwd.jsonl`, sessionFile({
      header: sessionHeader({ id: 'empty-cwd', cwd: '' }),
    }))
    emptyCwd.script({ lines: [JSON.stringify({ type: 'session', id: 'empty-cwd' }), JSON.stringify({ type: 'agent_end' })] })
    const emptyCwdRun = await dispatch(emptyCwd, {}, { ...request(), resumeNativeId: 'empty-cwd' })
    expect(emptyCwdRun.events.some(event => event.kind === 'warning' && event.message.includes('records cwd'))).toBe(false)

    const cancelled = new FakeHost({ home: HOME })
    cancelled.script({ lines: [JSON.stringify({ type: 'session', id: 'cancelled' })] })
    const config = resolveOmpConfig()
    const layout = resolveOmpStore({ host: cancelled, config })
    const run = startOmpRun({ host: cancelled, config, layout, agentId, runId: mintRunId(cancelled, 4) }, request())
    run.cancel('first reason')
    run.cancel('later reason')
    const result = await run.result
    expect(result).toMatchObject({ status: 'cancelled', notes: ['cancelled by the caller: first reason'] })
    expect(cancelled.cancels).toContain('first reason')
  })

  it('settles an unexpected producer rejection as a protocol error', async () => {
    class FailedListHost extends FakeHost {
      override async listDir(_path: string): Promise<Awaited<ReturnType<FakeHost['listDir']>>> {
        throw new Error('session lookup failed')
      }
    }
    const host = new FailedListHost({ home: HOME })
    const config = resolveOmpConfig()
    const layout = resolveOmpStore({ host, config })
    const run = startOmpRun({ host, config, layout, agentId, runId: mintRunId(host, 5) }, {
      ...request(), resumeNativeId: 'resume-id',
    })
    const result = await run.result
    expect(result).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })
    expect(host.logs.some(log => log.message.includes('session lookup failed'))).toBe(true)

    class FailedListHostNonError extends FakeHost {
      override async listDir(_path: string): Promise<Awaited<ReturnType<FakeHost['listDir']>>> {
        throw 'non-error lookup failure'
      }
    }
    const nonErrorHost = new FailedListHostNonError({ home: HOME })
    const nonErrorConfig = resolveOmpConfig()
    const nonErrorLayout = resolveOmpStore({ host: nonErrorHost, config: nonErrorConfig })
    const nonErrorRun = startOmpRun({
      host: nonErrorHost, config: nonErrorConfig, layout: nonErrorLayout, agentId,
      runId: mintRunId(nonErrorHost, 6),
    }, { ...request(), resumeNativeId: 'resume-id' })
    expect((await nonErrorRun.result).error?.message).toBe('the run ended without a terminal result')
    expect(nonErrorHost.logs.some(log => log.message.includes('non-error lookup failure'))).toBe(true)
  })

  it('records run events dropped when no consumer is reading', async () => {
    const host = new FakeHost({ home: HOME })
    host.script({
      lines: Array.from({ length: DEFAULT_MAX_PENDING_EVENTS + 10 }, (_, index) => JSON.stringify({
        type: 'tool_execution_start', toolCallId: `call-${String(index)}`, toolName: 'read',
      })),
    })
    const config = resolveOmpConfig()
    const layout = resolveOmpStore({ host, config })
    const run = startOmpRun({ host, config, layout, agentId, runId: mintRunId(host, 7) }, request())
    const result = await run.result
    expect(result.notes.some(note => note.includes('event(s) were dropped because nothing was reading'))).toBe(true)
  })
})

describe('run event queue', () => {
  it('wakes a waiting consumer and resolves the terminal result exactly once', async () => {
    const result = (await dispatch(new FakeHost({ home: HOME }))).result
    const queue = new RunEventQueue()
    const iterator = queue[Symbol.asyncIterator]()
    const waiting = iterator.next()
    const warning: AgentRunEvent = {
      kind: 'warning', runId: result.runId, at: EVENT_AT, message: 'first',
    }
    queue.emit(warning)
    await expect(waiting).resolves.toMatchObject({ value: warning, done: false })

    const terminal: AgentRunEvent = { kind: 'run.finished', runId: result.runId, at: EVENT_AT, result }
    queue.emit(terminal)
    queue.emit({ kind: 'warning', runId: result.runId, at: EVENT_AT, message: 'late' })
    expect(await queue.result).toEqual(result)
    await expect(iterator.next()).resolves.toMatchObject({ value: terminal, done: false })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('drops the oldest queued event at the cap but always delivers run.finished', async () => {
    const result = (await dispatch(new FakeHost({ home: HOME }))).result
    const queue = new RunEventQueue()
    for (let index = 0; index <= DEFAULT_MAX_PENDING_EVENTS; index += 1) {
      queue.emit({ kind: 'warning', runId: result.runId, at: EVENT_AT, message: `event-${String(index)}` })
    }
    const terminal: AgentRunEvent = { kind: 'run.finished', runId: result.runId, at: EVENT_AT, result }
    queue.emit(terminal)
    expect(queue.droppedCount).toBe(1)
    const events: AgentRunEvent[] = []
    for await (const event of queue) events.push(event)
    expect(events).toHaveLength(DEFAULT_MAX_PENDING_EVENTS + 1)
    expect(events[0]).toMatchObject({ kind: 'warning', message: 'event-1' })
    expect(events.at(-1)).toEqual(terminal)
  })
})
