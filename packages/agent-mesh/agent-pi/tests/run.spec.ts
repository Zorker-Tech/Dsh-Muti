/**
 * Pi's JSON event projection, argument construction, and managed run lifecycle.
 * @module @deepseek-ai/dsh-agent-pi/tests/run
 */

import { describe, expect, it } from 'vitest'
import type { AgentId, AgentRunEvent, AgentRunId, AgentRunRequest } from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolvePiConfig } from '../src/config.ts'
import {
  buildPiRunArgs,
  capEventText,
  classifyPiExit,
  DEFAULT_MAX_PENDING_EVENTS,
  generatePiSessionId,
  mintRunId,
  PiRunProjection,
  RunEventQueue,
  splitPiModel,
  startPiRun,
} from '../src/run.ts'
import type { PiRunContext } from '../src/run.ts'
import type { PiStoreLayout } from '../src/sessions.ts'
import { createFakeHost, processWith } from './host.ts'

const AGENT_ID: AgentId = brandString<AgentId>('pi')
const RUN_ID: AgentRunId = brandString<AgentRunId>('pi-run-test')
const LAYOUT: PiStoreLayout = {
  agentDir: '/home/tester/.pi/agent',
  defaultSessionsRoot: '/home/tester/.pi/agent/sessions',
  credentialPath: '/home/tester/.pi/agent/auth.json',
  settingsPath: '/home/tester/.pi/agent/settings.json',
  modelsPath: '/home/tester/.pi/agent/models.json',
}

function expectWarning(event: AgentRunEvent | undefined, text: string): void {
  if (event?.kind !== 'warning') throw new Error('expected a warning event')
  expect(event.message).toContain(text)
}

function expectToolInput(event: AgentRunEvent | undefined): void {
  if (event?.kind !== 'tool.started') throw new Error('expected a tool-started event')
  if (typeof event.input !== 'string') throw new Error('expected serialized tool input')
  expect(event.input).not.toBe('')
}
const CWD = '/home/tester/project'
const AT = '2026-10-16T00:00:00.000Z'

/** Build the context used by one startPiRun test. */
function runContext(
  host: ReturnType<typeof createFakeHost>,
  options: { readonly binary?: string; readonly layout?: PiStoreLayout } = {},
): PiRunContext {
  return {
    host,
    config: resolvePiConfig({ env: { FROM_CONFIG: 'config', SHARED: 'config' } }),
    agentId: AGENT_ID,
    runId: RUN_ID,
    resolve: async () => ({ binary: options.binary ?? '/usr/bin/pi', layout: options.layout ?? LAYOUT }),
  }
}

/** Create a run request with the minimum required fields and optional overrides. */
function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return { prompt: 'hello', cwd: CWD, ...overrides }
}

/** Collect the event stream and terminal result from one dispatched run. */
async function collectRun(context: PiRunContext, runRequest: AgentRunRequest) {
  const run = startPiRun(context, runRequest)
  const events = []
  for await (const event of run) events.push(event)
  return { events, result: await run.result }
}

/** Turn one native event into the exact JSON line Pi writes. */
function jsonLine(value: unknown): string {
  return JSON.stringify(value) ?? ''
}

describe('PiRunProjection', () => {
  it('preserves unknown records and projects lifecycle, text, tools, and warnings', () => {
    const projection = new PiRunProjection(RUN_ID)
    expect(projection.state()).toMatchObject({ settled: false, aborted: false, toolCalls: 0, toolFailures: 0 })
    expect(projection.bind('session-a', AT)).toMatchObject({ kind: 'session.bound', nativeSessionId: 'session-a' })
    expect(projection.bind('session-a', AT)).toBeUndefined()
    expect(projection.observe({ type: 'session', id: 'session-a', cwd: CWD }, '{}', AT)).toEqual([])
    expect(projection.observe(null, 'null', AT)[0]).toMatchObject({ kind: 'unknown', native: 'null' })
    expect(projection.observe({}, '{}', AT)[0]).toMatchObject({ kind: 'unknown' })
    expect(projection.observe({}, '{}', AT)[0]).not.toHaveProperty('nativeType')
    expect(projection.observe({ type: 'message_update' }, '{}', AT)[0]).toMatchObject({ kind: 'unknown', nativeType: 'message_update' })
    expect(projection.observe({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }, '{}', AT)).toEqual([])
    expect(projection.observe({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } }, '{}', AT)).toEqual([])
    expect(projection.observe({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } }, '{}', AT)[0]).toMatchObject({ kind: 'reasoning.delta', text: 'hmm' })
    expect(projection.observe({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', id: 'call-a', toolName: 'read' } }, '{}', AT)[0]).toMatchObject({ kind: 'tool.started', callId: 'call-a', toolName: 'read' })
    expect(projection.observe({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } }, '{}', AT)[0]).toMatchObject({ kind: 'tool.started', toolName: 'tool' })
    expect(projection.observe({ type: 'tool_execution_start', toolCallId: 'call-a' }, '{}', AT)).toEqual([])
    expect(projection.observe({ type: 'tool_execution_start', toolCallId: 'call-no-args' }, '{}', AT)[0]).toMatchObject({ kind: 'tool.started', callId: 'call-no-args' })
    expectToolInput(projection.observe({ type: 'tool_execution_start', args: () => {}, toolName: 'run' }, '{}', AT)[0])
    expect(projection.observe({ type: 'tool_execution_start', toolCallId: 'call-b', args: 1n }, '{}', AT)[0]).toMatchObject({ kind: 'tool.started', callId: 'call-b', input: '<unserializable>' })
    expect(projection.observe({ type: 'tool_execution_end', toolCallId: 'call-b', isError: true, result: { code: 1 } }, '{}', AT)[0]).toMatchObject({ kind: 'tool.completed', failed: true, output: '{"code":1}' })
    expect(projection.observe({ type: 'tool_execution_end' }, '{}', AT)[0]).toMatchObject({ kind: 'tool.completed', toolName: 'tool' })
    expectWarning(projection.observe({ type: 'compaction_start' }, '{}', AT)[0], 'unknown')
    expectWarning(projection.observe({ type: 'compaction_start', reason: 'limit' }, '{}', AT)[0], 'limit')
    expect(projection.observe({ type: 'compaction_end' }, '{}', AT)).toEqual([])
    expectWarning(projection.observe({ type: 'compaction_end', errorMessage: 'disk full' }, '{}', AT)[0], 'disk full')
    expectWarning(projection.observe({ type: 'auto_retry_start' }, '{}', AT)[0], '?/?')
    expectWarning(projection.observe({ type: 'auto_retry_start', attempt: 2, maxAttempts: 4, errorMessage: 'busy' }, '{}', AT)[0], '2/4')
    expect(projection.observe({ type: 'auto_retry_end', success: true }, '{}', AT)).toEqual([])
    expectWarning(projection.observe({ type: 'auto_retry_end' }, '{}', AT)[0], 'budget was exhausted')
    expectWarning(projection.observe({ type: 'auto_retry_end', finalError: 'offline' }, '{}', AT)[0], 'offline')
    expect(projection.observe({ type: 'bash_execution_update' }, 'raw bash', AT)[0]).toMatchObject({ kind: 'unknown', nativeType: 'bash_execution_update' })
    expect(projection.observe({ type: 'agent_settled' }, '{}', AT)).toEqual([])
    expectWarning(projection.observe({ type: 'agent_settled', aborted: true }, '{}', AT)[0], 'aborted')
    for (const type of ['agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start', 'queue_update', 'tool_execution_update']) {
      expect(projection.observe({ type }, '{}', AT)).toEqual([])
    }
    for (const type of ['session_info_changed', 'thinking_level_changed', 'summarization_retry_scheduled', 'summarization_retry_attempt_start', 'summarization_retry_finished']) {
      expect(projection.observe({ type }, '{}', AT)[0]).toMatchObject({ kind: 'unknown', nativeType: type })
    }
    expect(projection.observe({ type: 'future_event' }, '{}', AT)[0]).toMatchObject({ kind: 'unknown', nativeType: 'future_event' })
    projection.addNote('same note')
    projection.addNote('same note')
    expect(projection.state().notes.filter(note => note === 'same note')).toHaveLength(1)
    expect(projection.warn('warning', AT)).toMatchObject({ kind: 'warning', message: 'warning' })
    expect(projection.state()).toMatchObject({ settled: true, aborted: true, toolCalls: 2, toolFailures: 1 })
  })

  it('projects message content and accumulates assistant and standalone usage', () => {
    const projection = new PiRunProjection(RUN_ID)
    expect(projection.observe({ type: 'message_end' }, '{}', AT)[0]).toMatchObject({ kind: 'unknown', nativeType: 'message_end' })
    expect(projection.observe({ type: 'message_end', message: { role: 'user' } }, '{}', AT)).toEqual([])
    expect(projection.observe({ type: 'message_end', message: { role: 'toolResult' } }, '{}', AT)).toEqual([])
    expect(projection.observe({ type: 'message_end', message: { role: 'future' } }, '{}', AT)[0]).toMatchObject({ kind: 'unknown' })
    expect(projection.observe({ type: 'message_end', message: {} }, '{}', AT)[0]).toMatchObject({ kind: 'unknown' })
    expect(projection.observe({ type: 'message_end', message: { role: 'assistant', content: 'plain', stopReason: 'stop' } }, '{}', AT)).toMatchObject([
      { kind: 'message.completed', text: 'plain' },
    ])
    expect(projection.observe({ type: 'message_end', message: { role: 'assistant', content: [] } }, '{}', AT)).toEqual([])
    expect(projection.observe({ type: 'message_end', message: { role: 'assistant', content: {}, usage: {} } }, '{}', AT)).toEqual([
      { kind: 'usage.updated', runId: RUN_ID, at: AT, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 } },
    ])
    const events = projection.observe({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [null, { type: 'image', text: 'ignored' }, { type: 'text' }, { type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
        errorMessage: 'provider failed',
        usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, reasoning: 7, totalTokens: 18, cost: { total: 0.2 } },
      },
    }, '{}', AT)
    expect(events).toMatchObject([
      { kind: 'message.completed', text: 'AB' },
      { kind: 'warning', message: 'pi reported: provider failed' },
      { kind: 'usage.updated', usage: { inputTokens: 3, outputTokens: 4, cachedInputTokens: 5, reasoningTokens: 7, totalTokens: 18, costUsd: 0.2 } },
    ])
    expect(projection.observe({ type: 'entry_appended', entry: { type: 'message' } }, '{}', AT)).toEqual([])
    expect(projection.observe({ type: 'entry_appended', entry: { type: 'usage' } }, '{}', AT)).toEqual([])
    expect(projection.observe({ type: 'entry_appended', entry: { type: 'usage', usage: { cacheWrite: 2, cost: {} } } }, '{}', AT)[0]).toMatchObject({ kind: 'usage.updated' })
    expect(projection.state()).toMatchObject({ finalText: 'AB', lastStopReason: 'stop', lastErrorMessage: 'provider failed', cacheWriteTokens: 8 })
    expect(projection.state().notes).toContain('pi reports cache-write tokens, which the mesh usage record cannot carry')
  })

  it('handles message update no-ops and bounded event text', () => {
    const projection = new PiRunProjection(RUN_ID)
    expect(projection.observe({ type: 'message_update', assistantMessageEvent: { type: 'error' } }, '{}', AT)[0]).toMatchObject({ kind: 'warning', message: 'the assistant response failed' })
    expect(projection.observe({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'failed', error: { errorMessage: 'bad' } } }, '{}', AT)[0]).toMatchObject({ kind: 'warning', message: 'bad' })
    for (const type of ['done', 'start', 'text_start', 'text_end', 'thinking_start', 'thinking_end', 'toolcall_delta', 'toolcall_end']) {
      expect(projection.observe({ type: 'message_update', assistantMessageEvent: { type } }, '{}', AT)).toEqual([])
    }
    expect(projection.observe({ type: 'message_update', assistantMessageEvent: {} }, '{}', AT)[0]).toMatchObject({ kind: 'unknown', nativeType: 'message_update' })
    expect(projection.observe({ type: 'message_update', assistantMessageEvent: { type: 'future' } }, '{}', AT)[0]).toMatchObject({ kind: 'unknown', nativeType: 'message_update:future' })
    const long = 'x'.repeat(12_000)
    expect(capEventText('short')).toBe('short')
    expect(capEventText(long)).toContain('[truncated by dsh-agent-pi')
    const delta = projection.observe({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: long } }, '{}', AT)[0]
    if (delta?.kind !== 'message.delta') throw new Error('expected a text delta event')
    expect(delta.text).toContain('[truncated by dsh-agent-pi')
  })
})

describe('Pi run classification and arguments', () => {
  it('classifies host causes and Pi diagnostics', () => {
    expect(classifyPiExit({ code: 0, signal: null, timedOut: false, cancelled: false }, '', undefined)).toEqual({ ok: true })
    expect(classifyPiExit({ code: 1, signal: null, timedOut: false, cancelled: true }, '', undefined)).toMatchObject({ failure: 'cancelled' })
    const timeout = classifyPiExit({ code: 1, signal: null, timedOut: true, cancelled: false }, '', 20)
    if (!('failure' in timeout) || timeout.failure !== 'timeout') throw new Error('expected a timeout failure')
    expect(timeout.message).toContain('20 ms')
    const missingTimeout = classifyPiExit({ code: 1, signal: null, timedOut: true, cancelled: false }, '', undefined)
    if (!('failure' in missingTimeout) || missingTimeout.failure !== 'timeout') throw new Error('expected a timeout failure')
    expect(missingTimeout.message).toContain('0 ms')
    expect(classifyPiExit({ code: null, signal: null, timedOut: false, cancelled: false }, '', undefined)).toMatchObject({ failure: 'start-failed' })
    expect(classifyPiExit({ code: 1, signal: null, timedOut: false, cancelled: false }, 'No session found matching id', undefined)).toMatchObject({ failure: 'session-not-found' })
    for (const message of ['no API key', 'invalid api key', 'not logged in', 'not authenticated', 'unauthorized', 'HTTP 401', 'no models available', 'use /login']) {
      expect(classifyPiExit({ code: 1, signal: null, timedOut: false, cancelled: false }, message, undefined)).toMatchObject({ failure: 'auth-not-configured' })
    }
    for (const message of ['rate limit', '429', 'quota exceeded']) {
      expect(classifyPiExit({ code: 1, signal: null, timedOut: false, cancelled: false }, message, undefined)).toMatchObject({ failure: 'rate-limited' })
    }
    expect(classifyPiExit({ code: null, signal: 'SIGTERM', timedOut: false, cancelled: false }, 'unexpected', undefined)).toMatchObject({ failure: 'agent-crashed', message: 'pi exited with signal SIGTERM' })
  })

  it('builds resume, model, and approval arguments without guessing invalid model names', () => {
    expect(buildPiRunArgs({ resumePath: '/session.jsonl', resumeId: 'ignored', newSessionId: 'ignored', model: 'openai/gpt-5', approval: 'approve' })).toEqual([
      '--mode', 'json', '--session', '/session.jsonl', '--provider', 'openai', '--model', 'gpt-5', '--approve',
    ])
    expect(buildPiRunArgs({ resumePath: undefined, resumeId: 'session', newSessionId: 'ignored', model: '  ', approval: 'default' })).toEqual(['--mode', 'json', '--session', 'session'])
    expect(buildPiRunArgs({ resumePath: undefined, resumeId: undefined, newSessionId: 'new-id', model: undefined, approval: undefined })).toEqual(['--mode', 'json', '--session-id', 'new-id'])
    expect(buildPiRunArgs({ resumePath: undefined, resumeId: undefined, newSessionId: undefined, model: 'gpt-5', approval: undefined })).toEqual(['--mode', 'json', '--model', 'gpt-5'])
    expect(buildPiRunArgs({ resumePath: undefined, resumeId: undefined, newSessionId: undefined, model: 'gpt-5', approval: undefined })).toEqual(['--mode', 'json', '--model', 'gpt-5'])
    expect(splitPiModel('openai/gpt-5')).toEqual({ provider: 'openai', model: 'gpt-5' })
    expect(splitPiModel('qwen/model:7b')).toEqual({ provider: 'qwen', model: 'model:7b' })
    expect(splitPiModel('/model')).toEqual({ model: '/model' })
    expect(splitPiModel('provider/')).toEqual({ model: 'provider/' })
    expect(splitPiModel('bad provider/model')).toEqual({ model: 'bad provider/model' })
    expect(splitPiModel('bad provider/model')).toEqual({ model: 'bad provider/model' })
    expect(generatePiSessionId(1_797_000_000_000)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(generatePiSessionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(mintRunId(createFakeHost({ startMs: 9_000 }), 3)).toBe('pi-9000-3')
  })
})

describe('RunEventQueue', () => {
  it('delivers events to a waiting reader, resolves on the terminal event, and ignores later events', async () => {
    const queue = new RunEventQueue()
    const iterator = queue[Symbol.asyncIterator]()
    const pending = iterator.next()
    const started = { kind: 'run.started' as const, runId: RUN_ID, agentId: AGENT_ID, at: AT }
    queue.emit(started)
    expect(await pending).toEqual({ value: started, done: false })
    const result = { runId: RUN_ID, agentId: AGENT_ID, status: 'succeeded' as const, startedAt: AT, finishedAt: AT, durationMs: 0, cwd: CWD, notes: [] }
    queue.emit({ kind: 'run.finished', runId: RUN_ID, at: AT, result })
    queue.emit(started)
    expect(await queue.result).toBe(result)
    expect(await iterator.next()).toMatchObject({ value: { kind: 'run.finished' }, done: false })
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
  })

  it('drops the oldest pending nonterminal event at the queue cap', async () => {
    const queue = new RunEventQueue()
    const started = { kind: 'run.started' as const, runId: RUN_ID, agentId: AGENT_ID, at: AT }
    for (let index = 0; index <= DEFAULT_MAX_PENDING_EVENTS; index += 1) queue.emit(started)
    expect(queue.droppedCount).toBe(1)
    const result = { runId: RUN_ID, agentId: AGENT_ID, status: 'succeeded' as const, startedAt: AT, finishedAt: AT, durationMs: 0, cwd: CWD, notes: [] }
    queue.emit({ kind: 'run.finished', runId: RUN_ID, at: AT, result })
    const events: AgentRunEvent[] = []
    for await (const event of queue) events.push(event)
    expect(events).toHaveLength(DEFAULT_MAX_PENDING_EVENTS + 1)
    expect(events.at(-1)).toMatchObject({ kind: 'run.finished' })
  })
})

describe('startPiRun', () => {
  it('fails before spawning when detection has no binary', async () => {
    const host = createFakeHost({})
    const context = { ...runContext(host), resolve: async () => ({ binary: undefined, layout: LAYOUT }) }
    const outcome = await collectRun(context, request())
    expect(outcome.result).toMatchObject({ status: 'failed', error: { code: 'detection/not-found' } })
  })

  it('runs a new session, forwards event facts and overlays caller environment', async () => {
    const host = createFakeHost({})
    host.queue(() => processWith([
      jsonLine({ type: 'session', id: 'new-session', cwd: CWD }),
      jsonLine({ type: 'message_end', message: { role: 'assistant', content: 'answer', stopReason: 'stop', usage: { input: 2, output: 3 } } }),
      jsonLine({ type: 'agent_settled' }),
      '',
      '{broken',
    ]))
    const outcome = await collectRun(runContext(host), request({
      prompt: '  ', model: 'openai/gpt-5', sandbox: 'strict', approval: 'review', timeoutMs: 20,
      env: { SHARED: 'request', FROM_REQUEST: 'request' },
    }))
    expect(outcome.result).toMatchObject({ status: 'succeeded', finalText: 'answer', nativeSessionKey: 'pi:new-session', usage: { inputTokens: 2, outputTokens: 3 } })
    expect(outcome.result.notes).toContain('the prompt was empty, so pi was started with nothing to send')
    expect(outcome.result.notes).toContain('pi has no sandbox, so the requested sandbox profile was ignored')
    expect(outcome.result.notes).toContain('"review" is not a pi approval mode, so no approval flag was passed')
    expect(outcome.result.notes).toContain('1 stdout line(s) were not valid JSON and are reported as warning events')
    expect(host.spawns[0]?.spec).toMatchObject({
      command: '/usr/bin/pi',
      cwd: CWD,
      stdin: '  ',
      timeoutMs: 20,
      env: { PI_CODING_AGENT_DIR: LAYOUT.agentDir, FROM_CONFIG: 'config', SHARED: 'request', FROM_REQUEST: 'request' },
    })
    const args = host.spawns[0]?.spec.args ?? []
    for (const arg of ['--mode', 'json', '--provider', 'openai', '--model', 'gpt-5']) {
      expect(args).toContain(arg)
    }
    expect(outcome.events.filter(event => event.kind === 'run.finished')).toHaveLength(1)
  })

  it('reports spawn failure while a resume id remains the session binding without a header', async () => {
    const failedHost = createFakeHost({})
    failedHost.failNextSpawn('ENOENT')
    const spawnFailure = await collectRun(runContext(failedHost), request({ timeoutMs: 0 }))
    expect(spawnFailure.result).toMatchObject({ status: 'failed', error: { code: 'run/start-failed' } })

    const emptyHost = createFakeHost({})
    emptyHost.queue(() => processWith([]))
    const empty = await collectRun(runContext(emptyHost), request({ resumeNativeId: 'missing-session' }))
    expect(empty.result).toMatchObject({ status: 'succeeded', nativeSessionKey: 'pi:missing-session' })
    expect(empty.result.notes).toContain('the stream ended before pi reported agent_settled, so the turn may not have finished')
    expect(emptyHost.spawns[0]?.spec.args).toContain('missing-session')
    expect(emptyHost.spawns[0]?.spec.args).not.toContain('--session-id')

    const throwingHost = createFakeHost({})
    throwingHost.spawn = () => { throw 'spawn rejected' }
    expect((await collectRun(runContext(throwingHost), request())).result).toMatchObject({ status: 'failed', error: { code: 'run/start-failed' } })
    expect(throwingHost.logs).toContain('pi could not be started: spawn rejected')
  })

  it('keeps the planned session id when a new run ends before Pi reports its session header', async () => {
    const host = createFakeHost({})
    host.queue(() => processWith([]))
    const outcome = await collectRun(runContext(host), request())

    expect(outcome.result.nativeSessionKey).toMatch(/^pi:[0-9a-f-]{36}$/u)
    expect(outcome.result.notes).toContain('the stream ended before pi reported agent_settled, so the turn may not have finished')
    expect(host.spawns[0]?.spec.args).toContain('--session-id')
  })

  it('rejects a cross-directory resume before spawning', async () => {
    const sessionPath = `${LAYOUT.defaultSessionsRoot}/--home-tester-other--/2026-10-16_session-a.jsonl`
    const host = createFakeHost({ files: { [sessionPath]: `${jsonLine({ type: 'session', id: 'session-a', cwd: '/home/tester/other' })}\n` } })
    const outcome = await collectRun(runContext(host), request({ resumeNativeId: 'session-a' }))
    expect(outcome.result).toMatchObject({ status: 'failed', error: { code: 'run/context-unavailable' } })
    expect(host.spawns).toHaveLength(0)
    expect(outcome.events.some(event => event.kind === 'warning')).toBe(true)
  })

  it('resumes from the located session file and reports assistant-side errors', async () => {
    const sessionPath = `${LAYOUT.defaultSessionsRoot}/--home-tester-project--/2026-10-16_session-b.jsonl`
    const host = createFakeHost({ files: { [sessionPath]: `${jsonLine({ type: 'session', id: 'session-b', cwd: CWD })}\n` } })
    host.queue(() => processWith([
      jsonLine({ type: 'session', id: 'session-b', cwd: CWD }),
      jsonLine({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } }),
    ]))
    const outcome = await collectRun(runContext(host), request({ resumeNativeId: 'session-b', approval: 'approve' }))
    expect(outcome.result).toMatchObject({ status: 'failed', error: { code: 'run/agent-crashed', message: 'the assistant response failed' } })
    expect(host.spawns[0]?.spec.args).toContain(sessionPath)
    expect(host.spawns[0]?.spec.args).toContain('--approve')

    const malformedHeaderPath = `${LAYOUT.defaultSessionsRoot}/--home-tester-project--/2026-10-16_session-c.jsonl`
    const malformedHeaderHost = createFakeHost({ files: { [malformedHeaderPath]: 'not-json\n' } })
    malformedHeaderHost.queue(() => processWith([jsonLine({ type: 'session', id: 'session-c', cwd: CWD })]))
    const malformedHeader = await collectRun(runContext(malformedHeaderHost), request({ resumeNativeId: 'session-c' }))
    expect(malformedHeaderHost.spawns[0]?.spec.args).toContain('session-c')
    expect(malformedHeader.result.status).toBe('succeeded')

    const emptyCwdPath = `${LAYOUT.defaultSessionsRoot}/--home-tester-project--/2026-10-16_empty-cwd.jsonl`
    const emptyCwdHost = createFakeHost({ files: { [emptyCwdPath]: `${jsonLine({ type: 'session', id: 'empty-cwd' })}\n` } })
    emptyCwdHost.queue(() => processWith([jsonLine({ type: 'session', id: 'empty-cwd', cwd: CWD })]))
    const emptyCwd = await collectRun(runContext(emptyCwdHost), request({ resumeNativeId: 'empty-cwd' }))
    expect(emptyCwdHost.spawns).toHaveLength(1)
    expect(emptyCwd.result.status).toBe('succeeded')
  })

  it('records cancellation and timeout outcomes and preserves the caller reason', async () => {
    const host = createFakeHost({})
    host.queue(() => ({
      lines: (async function* lines() { yield jsonLine({ type: 'session', id: 'session-c', cwd: CWD }) })(),
      stderr: async () => '',
      exit: Promise.resolve({ code: null, signal: null, timedOut: false, cancelled: true }),
      cancel: () => {},
    }))
    const run = startPiRun(runContext(host), request())
    run.cancel('user requested')
    run.cancel('ignored')
    const result = await run.result
    expect(result).toMatchObject({ status: 'cancelled' })
    expect(result.notes).toContain('cancelled by the caller: user requested')

    const timeoutHost = createFakeHost({})
    timeoutHost.queue(() => ({
      lines: (async function* lines() {})(),
      stderr: async () => '',
      exit: Promise.resolve({ code: null, signal: 'SIGTERM', timedOut: true, cancelled: false }),
      cancel: () => {},
    }))
    const timeout = await collectRun(runContext(timeoutHost), request({ timeoutMs: 50 }))
    expect(timeout.result).toMatchObject({ status: 'timeout', error: { code: 'run/timeout' } })
    expect(timeout.result.notes).toContain('the run was killed after 50 ms')
  })

  it('cancels a process after spawn and maps a Pi-reported abort to cancelled', async () => {
    const host = createFakeHost({})
    let reportSpawned: () => void = () => {}
    const spawned = new Promise<void>((resolve) => { reportSpawned = resolve })
    let finishLines: () => void = () => {}
    const finished = new Promise<void>((resolve) => { finishLines = resolve })
    host.queue(() => {
      reportSpawned()
      return {
        lines: (async function* lines() {
          await finished
          yield jsonLine({ type: 'session', id: 'cancelled', cwd: CWD })
        })(),
        stderr: async () => '',
        exit: (async () => {
          await finished
          return { code: 0, signal: null, timedOut: false, cancelled: true }
        })(),
        cancel: () =>{  finishLines() },
      }
    })
    const run = startPiRun(runContext(host), request())
    await spawned
    run.cancel('stop now')
    expect(await run.result).toMatchObject({ status: 'cancelled' })

    const abortedHost = createFakeHost({})
    abortedHost.queue(() => processWith([
      jsonLine({ type: 'session', id: 'aborted', cwd: CWD }),
      jsonLine({ type: 'agent_settled', aborted: true }),
    ]))
    const aborted = await collectRun(runContext(abortedHost), request())
    expect(aborted.result).toMatchObject({ status: 'cancelled', error: { code: 'run/cancelled', message: 'pi aborted the turn' } })
  })

  it('contains producer, stdout, and stderr errors and bounds process diagnostics', async () => {
    for (const cause of [new Error('resolve failed'), 'resolve failed']) {
      const host = createFakeHost({})
      const context = { ...runContext(host), resolve: async () => { throw cause } }
      expect(await startPiRun(context, request()).result).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })
      expect(host.logs).toContain(`pi run producer failed: ${cause instanceof Error ? cause.message : cause}`)
    }

    const stdoutHost = createFakeHost({})
    stdoutHost.queue(() => ({
      lines: (async function* lines() { throw 'stdout failed' })(),
      stderr: async () => '',
      exit: Promise.resolve({ code: 0, signal: null, timedOut: false, cancelled: false }),
      cancel: () => {},
    }))
    const stdoutFailure = await collectRun(runContext(stdoutHost), request())
    expect(stdoutFailure.result.notes).toContain('the stdout stream ended abnormally: stdout failed')

    for (const stderrError of [new Error('stderr failed'), 'stderr failed']) {
      const stderrHost = createFakeHost({})
      stderrHost.queue(() => ({
        lines: (async function* lines() { yield jsonLine({ type: 'session', id: 'stderr', cwd: CWD }) })(),
        stderr: async () => { throw stderrError },
        exit: Promise.resolve({ code: 1, signal: null, timedOut: false, cancelled: false }),
        cancel: () => {},
      }))
      const stderrFailure = await collectRun(runContext(stderrHost), request())
      expect(stderrFailure.result.notes).toContain(`the stdout stream ended abnormally: stderr could not be read: ${stderrError instanceof Error ? stderrError.message : stderrError}`)
    }

    const longStderrHost = createFakeHost({})
    longStderrHost.queue(() => processWith([], { code: 1, stderr: 'x'.repeat(2_100) }))
    const bounded = await collectRun(runContext(longStderrHost, { layout: { ...LAYOUT, sessionDirOverride: '/custom/sessions' } }), request({ approval: '' }))
    expect(bounded.result.error?.output).toHaveLength(2_000)
    expect(longStderrHost.spawns[0]?.spec.env).toMatchObject({ PI_CODING_AGENT_SESSION_DIR: '/custom/sessions' })

    const assistantErrorHost = createFakeHost({})
    assistantErrorHost.queue(() => processWith([
      jsonLine({ type: 'session', id: 'assistant-error', cwd: CWD }),
      jsonLine({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } }),
    ], { stderr: 'short stderr' }))
    const assistantError = await collectRun(runContext(assistantErrorHost), request({ sandbox: '' }))
    expect(assistantError.result.error).toMatchObject({ code: 'run/agent-crashed', output: 'short stderr' })
  })

  it('contains stream and stderr failures and counts events dropped without a reader', async () => {
    const host = createFakeHost({})
    host.queue(() => ({
      lines: (async function* lines() { throw new Error('pipe broke') })(),
      stderr: async () => { throw 'stderr broke' },
      exit: Promise.resolve({ code: 0, signal: null, timedOut: false, cancelled: false }),
      cancel: () => {},
    }))
    const run = startPiRun(runContext(host), request())
    const result = await run.result
    expect(result.notes).toContain('the stdout stream ended abnormally: pipe broke')

    const bulkHost = createFakeHost({})
    bulkHost.queue(() => processWith([
      jsonLine({ type: 'session', id: 'bulk', cwd: CWD }),
      ...Array.from({ length: DEFAULT_MAX_PENDING_EVENTS + 2 }, () => jsonLine({ type: 'future_event' })),
    ]))
    const bulk = startPiRun(runContext(bulkHost), request())
    const bulkResult = await bulk.result
    expect(bulkResult.notes.some(note => note.includes('event(s) were dropped'))).toBe(true)
    const events: AgentRunEvent[] = []
    for await (const event of bulk) events.push(event)
    expect(events.at(-1)).toMatchObject({ kind: 'run.finished' })
  })
})
