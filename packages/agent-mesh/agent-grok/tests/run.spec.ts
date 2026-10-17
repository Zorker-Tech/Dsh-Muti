import { describe, expect, it } from 'vitest'
import type {
  AgentRun,
  AgentRunEvent,
  AgentRunId,
  AgentRunRequest,
  AgentRunResult,
} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { GrokAdapterConfig } from '../src/config.ts'
import { resolveGrokConfig } from '../src/config.ts'
import { GROK_AGENT_ID, resolveGrokPaths } from '../src/sessions.ts'
import {
  MAX_EVENT_TEXT_BYTES,
  buildRunArgs,
  classifyGrokOutcome,
  createStreamState,
  mapStreamingJsonLine,
  mintRunId,
  runEnvironment,
  startGrokRun,
  todoStatus,
  toolContentText,
  usageFromWire,
} from '../src/run.ts'
import type { GrokRunContext, GrokStreamState } from '../src/run.ts'
import { MemoryHost } from './support/memory-host.ts'

const HOME = '/home/tester'
const BINARY = '/opt/tools/grok'
const RUN_ID: AgentRunId = brandString<AgentRunId>('grok-run-1')
const AT = '2026-05-01T00:00:00.000Z'

/** The request most dispatch tests run: one prompt in one directory. */
const REQUEST: AgentRunRequest = { prompt: 'say hello', cwd: '/work/alpha' }

/** A run context over a scripted host, with a binary available unless the test says otherwise. */
function runContext(
  host: MemoryHost,
  options: { readonly config?: GrokAdapterConfig; readonly binary?: string | undefined } = {},
): GrokRunContext {
  return {
    host,
    config: resolveGrokConfig(options.config ?? {}),
    agentId: GROK_AGENT_ID,
    runId: RUN_ID,
    paths: resolveGrokPaths(host, undefined),
    resolveBinary: async () => Object.hasOwn(options, 'binary') ? options.binary : BINARY,
  }
}

/** Collect a run's events and its terminal record. */
async function drain(run: AgentRun): Promise<{ readonly events: AgentRunEvent[]; readonly result: AgentRunResult }> {
  const events: AgentRunEvent[] = []
  for await (const event of run) events.push(event)
  return { events, result: await run.result }
}

/** Dispatch one run and collect everything it produced. */
async function dispatch(
  host: MemoryHost,
  request: AgentRunRequest = REQUEST,
  context?: GrokRunContext,
): Promise<{ readonly events: AgentRunEvent[]; readonly result: AgentRunResult; readonly run: AgentRun }> {
  const run = startGrokRun(context ?? runContext(host), request)
  const { events, result } = await drain(run)
  return { events, result, run }
}

/** One streaming-json line of the given native type. */
const line = (type: string, fields: Record<string, unknown> = {}): string => JSON.stringify({ type, ...fields })

describe('grok run argv', () => {
  it('orders every option the request and configuration select', () => {
    const args = buildRunArgs(
      {
        prompt: '-fix the bug',
        cwd: '/repo',
        model: 'grok-5',
        sandbox: 'workspace',
        approval: 'default',
        resumeNativeId: 'native-1',
      },
      resolveGrokConfig({
        maxTurns: 4,
        reasoningEffort: 'high',
        noPlan: true,
        noSubagents: true,
        disableWebSearch: true,
      }),
    )

    expect(args).toEqual([
      '--single=-fix the bug',
      '--output-format',
      'streaming-json',
      '--cwd',
      '/repo',
      '-m',
      'grok-5',
      '--sandbox',
      'workspace',
      '--permission-mode',
      'default',
      '--max-turns',
      '4',
      '--reasoning-effort',
      'high',
      '-r',
      'native-1',
      '--no-plan',
      '--no-subagents',
      '--disable-web-search',
    ])
  })

  it('passes a normal prompt positionally and omits every unset flag', () => {
    expect(buildRunArgs({ prompt: 'say hello', cwd: '/repo' }, resolveGrokConfig())).toEqual([
      '-p',
      'say hello',
      '--output-format',
      'streaming-json',
      '--cwd',
      '/repo',
    ])
  })

  it('takes the configured defaults and spells the bypass approval as its own flag', () => {
    const args = buildRunArgs(
      { prompt: 'hi', cwd: '/repo' },
      resolveGrokConfig({ model: 'grok-4', sandbox: 'devbox', approval: 'bypassPermissions' }),
    )

    expect(args).toEqual([
      '-p',
      'hi',
      '--output-format',
      'streaming-json',
      '--cwd',
      '/repo',
      '-m',
      'grok-4',
      '--sandbox',
      'devbox',
      '--always-approve',
    ])
  })

  it('treats an empty per-request override as no override at all', () => {
    const args = buildRunArgs(
      { prompt: 'hi', cwd: '/repo', model: '', sandbox: '', approval: '' },
      resolveGrokConfig({ model: 'grok-4', sandbox: 'devbox' }),
    )

    expect(args).toEqual(['-p', 'hi', '--output-format', 'streaming-json', '--cwd', '/repo'])
  })
})

describe('grok stream line mapping', () => {
  it('maps each modelled update type onto mesh events', () => {
    const state = createStreamState()
    const context = { runId: RUN_ID, at: AT }
    const mapped = (native: unknown): readonly AgentRunEvent[] => mapStreamingJsonLine(native, context, state)

    expect(mapped({ type: 'text', data: 'Hel' })).toEqual([
      { kind: 'message.delta', runId: RUN_ID, at: AT, text: 'Hel' },
    ])
    expect(mapped({ type: 'thought', data: 'thinking' })).toEqual([
      { kind: 'reasoning.delta', runId: RUN_ID, at: AT, text: 'thinking' },
    ])
    expect(mapped({ type: 'text', data: '' })).toEqual([])
    expect(mapped({ type: 'thought' })).toEqual([])
    expect(mapped({
      type: 'tool_call',
      toolCallId: 'c1',
      toolName: 'read_file',
      rawInput: { path: '/a' },
      locations: [{ path: '/a' }, { path: '/a' }],
    })).toEqual([
      {
        kind: 'tool.started',
        runId: RUN_ID,
        at: AT,
        toolName: 'read_file',
        callId: 'c1',
        input: '{"path":"/a"}',
      },
      { kind: 'files.changed', runId: RUN_ID, at: AT, paths: ['/a'] },
    ])
    expect(mapped({
      type: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
    })).toEqual([
      {
        kind: 'tool.completed',
        runId: RUN_ID,
        at: AT,
        toolName: 'read_file',
        callId: 'c1',
        output: 'file body',
        failed: false,
      },
    ])
    expect(mapped({ type: 'tool_call_update', toolCallId: 'c2', status: 'pending' })).toEqual([])
    expect(mapped({
      type: 'tool_call_update',
      toolCallId: 'c2',
      status: 'failed',
      rawOutput: 'boom',
      locations: [{ path: '/b' }],
    })).toEqual([
      { kind: 'tool.completed', runId: RUN_ID, at: AT, toolName: 'tool', callId: 'c2', output: 'boom', failed: true },
      { kind: 'files.changed', runId: RUN_ID, at: AT, paths: ['/b'] },
    ])
    expect(mapped({ type: 'plan', entries: [{ content: 'step one', status: 'in_progress' }, { content: 'step two' }] })).toEqual([
      {
        kind: 'todos.updated',
        runId: RUN_ID,
        at: AT,
        todos: [{ content: 'step one', status: 'in_progress' }, { content: 'step two', status: 'pending' }],
      },
    ])
    expect(mapped({ type: 'usage', usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 3 } })).toEqual([
      { kind: 'usage.updated', runId: RUN_ID, at: AT, usage: { inputTokens: 10, outputTokens: 4 } },
    ])
    expect(state.text).toBe('Hel')
    expect(state.toolNames.get('c1')).toBe('read_file')
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 4 })
    expect(state.cacheCreationTokens).toBe(3)
  })

  it('keeps a line with no type and an unmodelled type as unknown events', () => {
    const state = createStreamState()
    const context = { runId: RUN_ID, at: AT }

    expect(mapStreamingJsonLine([1, 2], context, state)).toEqual([
      { kind: 'unknown', runId: RUN_ID, at: AT, native: '[1,2]' },
    ])
    expect(mapStreamingJsonLine({ type: 'future_thing', payload: true }, context, state)).toEqual([
      { kind: 'unknown', runId: RUN_ID, at: AT, nativeType: 'future_thing', native: '{"type":"future_thing","payload":true}' },
    ])
    expect(mapStreamingJsonLine({ type: 'usage', usage: { unexpected: 1 } }, context, state)).toEqual([
      { kind: 'unknown', runId: RUN_ID, at: AT, nativeType: 'usage', native: '{"type":"usage","usage":{"unexpected":1}}' },
    ])
    expect(state.notes).toEqual(['a streaming-json line carried no type and was preserved as unknown'])
  })

  it('omits an empty tool input while retaining the call event', () => {
    expect(mapStreamingJsonLine(
      { type: 'tool_call', toolCallId: 'empty', title: 'shell', rawInput: '' },
      { runId: RUN_ID, at: AT },
      createStreamState(),
    )).toEqual([{ kind: 'tool.started', runId: RUN_ID, at: AT, toolName: 'shell', callId: 'empty' }])
  })

  it('uses tool defaults, raw output fallbacks and omits absent native fields', () => {
    const context = { runId: RUN_ID, at: AT }
    const state = createStreamState()
    expect(mapStreamingJsonLine({ type: 'tool_call', rawInput: null, locations: ['not a record', {}] }, context, state)).toEqual([
      { kind: 'tool.started', runId: RUN_ID, at: AT, toolName: 'tool' },
    ])
    expect(mapStreamingJsonLine({ type: 'tool_call_update', status: 'completed', rawOutput: 'fallback' }, context, state)).toEqual([
      { kind: 'tool.completed', runId: RUN_ID, at: AT, toolName: 'tool', output: 'fallback', failed: false },
    ])
    expect(mapStreamingJsonLine({ type: 'tool_call_update', status: 'completed', rawOutput: '' }, context, state)).toEqual([
      { kind: 'tool.completed', runId: RUN_ID, at: AT, toolName: 'tool', failed: false },
    ])
  })

  it('records the end line session, stop reason, merged usage and turn count', () => {
    const state = createStreamState()
    const context = { runId: RUN_ID, at: AT }

    expect(mapStreamingJsonLine({ type: 'end', sessionId: 'sess-1', stopReason: 'end_turn', usage: { total_tokens: 7 }, num_turns: 3 }, context, state)).toEqual([])

    expect(state.ended).toBe(true)
    expect(state.sessionId).toBe('sess-1')
    expect(state.stopReason).toBe('end_turn')
    expect(state.usage).toEqual({ totalTokens: 7 })
    expect(state.notes).toEqual(['grok reported 3 model turns for this dispatch; the mesh result has no turn count'])

    const noSession = createStreamState()
    mapStreamingJsonLine({ type: 'end' }, context, noSession)
    expect(noSession.sessionId).toBeUndefined()
  })

  it('preserves only plan entries with a record and non-empty content', () => {
    expect(mapStreamingJsonLine({ type: 'plan', entries: [null, {}, { content: '' }, { content: 'keep' }] },
      { runId: RUN_ID, at: AT }, createStreamState())).toEqual([
      { kind: 'todos.updated', runId: RUN_ID, at: AT, todos: [{ content: 'keep', status: 'pending' }] },
    ])
    expect(mapStreamingJsonLine({ type: 'plan', entries: 'not-an-array' },
      { runId: RUN_ID, at: AT }, createStreamState())).toEqual([
      { kind: 'todos.updated', runId: RUN_ID, at: AT, todos: [] },
    ])
  })

  it('keeps unknown events with missing native values printable', () => {
    expect(mapStreamingJsonLine(undefined, { runId: RUN_ID, at: AT }, createStreamState())).toEqual([
      { kind: 'unknown', runId: RUN_ID, at: AT, native: '' },
    ])
  })

  it('reports an error line as a warning and keeps its message for classification', () => {
    const state = createStreamState()
    const context = { runId: RUN_ID, at: AT }

    expect(mapStreamingJsonLine({ type: 'error', message: 'rate limit exceeded' }, context, state)).toEqual([
      { kind: 'warning', runId: RUN_ID, at: AT, message: 'rate limit exceeded' },
    ])
    expect(state.errorMessage).toBe('rate limit exceeded')

    expect(mapStreamingJsonLine({ type: 'error' }, context, state)).toEqual([
      { kind: 'warning', runId: RUN_ID, at: AT, message: 'grok reported an error' },
    ])

    expect(mapStreamingJsonLine({ type: 'max_turns_reached' }, context, state)).toEqual([
      { kind: 'warning', runId: RUN_ID, at: AT, message: 'grok reached its turn limit and stopped before finishing the task' },
    ])
    expect(state.stopReason).toBe('max_turns_reached')
  })
})

describe('grok usage projection', () => {
  it('projects every recognized wire field', () => {
    expect(usageFromWire({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 2,
      reasoning_tokens: 1,
      total_tokens: 16,
      total_cost_usd: 0.25,
    })).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
      reasoningTokens: 1,
      totalTokens: 16,
      costUsd: 0.25,
    })
  })

  it('returns undefined when nothing recognizable is present', () => {
    expect(usageFromWire({ unexpected: 1 })).toBeUndefined()
    expect(usageFromWire(undefined)).toBeUndefined()
    expect(usageFromWire('10 tokens')).toBeUndefined()
  })

  it('drops a field that is not a finite number', () => {
    expect(usageFromWire({ input_tokens: 'ten', output_tokens: Number.POSITIVE_INFINITY, total_tokens: 5 })).toEqual({
      totalTokens: 5,
    })
  })
})

describe('grok todo status and tool content', () => {
  it('canonicalizes a native status and reports an unknown token as pending', () => {
    expect(todoStatus('pending')).toBe('pending')
    expect(todoStatus('in_progress')).toBe('in_progress')
    expect(todoStatus('completed')).toBe('completed')
    expect(todoStatus('blocked')).toBe('blocked')
    expect(todoStatus('cancelled')).toBe('cancelled')
    expect(todoStatus('nonsense')).toBe('pending')
  })

  it('joins ACP content blocks and names the path of a diff entry', () => {
    expect(toolContentText([
      { type: 'content', content: { type: 'text', text: 'first' } },
      { text: 'second' },
      { type: 'diff', path: '/a.ts' },
      'not a record',
    ])).toBe('first\nsecond\n[diff] /a.ts')
    expect(toolContentText('not an array')).toBeUndefined()
    expect(toolContentText([{ type: 'diff' }])).toBeUndefined()
  })
})

describe('grok outcome classification', () => {
  const exitOf = (code: number | null, extras: Partial<{ signal: string | null; timedOut: boolean; cancelled: boolean }> = {}) => ({
    code,
    signal: extras.signal ?? null,
    timedOut: extras.timedOut ?? false,
    cancelled: extras.cancelled ?? false,
  })

  it('accepts a zero exit and never reads the evidence', () => {
    expect(classifyGrokOutcome(exitOf(0), 'rate limit exceeded', 'unauthorized')).toEqual({ ok: true })
  })

  it('classifies cancellation and timeout from the host flags alone', () => {
    expect(classifyGrokOutcome(exitOf(null, { cancelled: true }), '', undefined)).toEqual({
      ok: false,
      failure: 'cancelled',
      code: 'run/cancelled',
      message: 'the run was cancelled',
      remediation: 'Re-dispatch the run when you want it to continue.',
    })
    expect(classifyGrokOutcome(exitOf(null, { timedOut: true }), '', undefined)).toEqual({
      ok: false,
      failure: 'timeout',
      code: 'run/timeout',
      message: 'the run exceeded its wall-clock budget',
      remediation: 'Raise the adapter timeout or split the task into smaller runs.',
    })
  })

  it('names the resumed session sandbox conflict in the remediation', () => {
    expect(classifyGrokOutcome(exitOf(1), 'cannot resume this session under sandbox profile "strict"', undefined)).toEqual({
      ok: false,
      failure: 'policy-blocked',
      code: 'run/policy-blocked',
      message: 'grok exited with code 1',
      remediation:
        'grok refuses to resume a session under a different sandbox profile than it was created with. Omit the sandbox override for this session, or start a new session with the requested profile.',
    })
  })

  it('classifies rate limiting, missing credentials and policy refusals from grok evidence', () => {
    expect(classifyGrokOutcome(exitOf(1), 'HTTP 429 too many requests', undefined)).toMatchObject({
      failure: 'rate-limited',
      code: 'run/rate-limited',
      remediation: 'Wait for the quota window to reset, or switch the model or account.',
    })
    expect(classifyGrokOutcome(exitOf(1), '', 'not authenticated: run grok login')).toMatchObject({
      failure: 'auth-not-configured',
      code: 'auth/not-configured',
      remediation: 'Log in through the Grok Build credential panel (`grok login`) and retry.',
    })
    expect(classifyGrokOutcome(exitOf(1), 'request blocked by moderation policy', undefined)).toMatchObject({
      failure: 'policy-blocked',
      code: 'run/policy-blocked',
      remediation: 'Review the request against the account policy or the session sandbox profile.',
    })
  })

  it('classifies an unexplained non-zero exit as a crash, naming a signal when there is no code', () => {
    expect(classifyGrokOutcome(exitOf(3), 'boom', undefined)).toEqual({
      ok: false,
      failure: 'crashed',
      code: 'run/agent-crashed',
      message: 'grok exited with code 3',
      remediation: 'Inspect the captured stderr tail and the session record for the cause.',
    })
    expect(classifyGrokOutcome(exitOf(null, { signal: 'SIGSEGV' }), 'boom', undefined)).toMatchObject({
      message: 'grok exited with signal SIGSEGV',
    })
    expect(classifyGrokOutcome(exitOf(null), 'boom', undefined)).toMatchObject({
      message: 'grok exited with signal unknown',
    })
  })
})

describe('grok run dispatch', () => {
  it('projects a successful dispatch into events and one terminal record', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '', XAI_API_KEY: 'xai-key', GROK_SANDBOX: 'ambient' },
      now: Date.parse('2026-05-01T00:00:00.000Z'),
      scripts: [{
        stdout: [
          line('text', { data: 'Hello' }),
          line('tool_call', { toolCallId: 'c1', title: 'shell', rawInput: { cmd: 'ls' } }),
          line('tool_call_update', { toolCallId: 'c1', status: 'completed', rawOutput: 'a.txt' }),
          line('plan', { entries: [{ content: 'ship it', status: 'in_progress' }] }),
          line('usage', { usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 2 } }),
          line('end', { sessionId: 'sess-1', stopReason: 'end_turn' }),
        ],
        stderr: '',
        code: 0,
      }],
    })
    const context = runContext(host, { config: { timeoutMs: 5000, env: { EXTRA: '1' } } })
    const { events, result } = await dispatch(host, { ...REQUEST, env: { CALLER: '2' } }, context)

    expect(host.spawned[0]).toMatchObject({
      command: BINARY,
      args: ['-p', 'say hello', '--output-format', 'streaming-json', '--cwd', '/work/alpha'],
      cwd: '/work/alpha',
      timeoutMs: 5000,
      maxLineBytes: MAX_EVENT_TEXT_BYTES * 1024,
    })
    expect(host.spawned[0]?.env).toMatchObject({
      XAI_API_KEY: 'xai-key',
      GROK_HOME: `${HOME}/.grok`,
      EXTRA: '1',
      CALLER: '2',
    })
    expect(host.spawned[0]?.env).not.toHaveProperty('GROK_SANDBOX')
    expect(events.map(event => event.kind)).toEqual([
      'run.started',
      'message.delta',
      'tool.started',
      'tool.completed',
      'todos.updated',
      'usage.updated',
      'session.bound',
      'message.completed',
      'run.finished',
    ])
    expect(events[6]).toMatchObject({ kind: 'session.bound', nativeSessionId: 'sess-1' })
    expect(events[7]).toMatchObject({ kind: 'message.completed', runId: RUN_ID, text: 'Hello' })
    expect(events[7]?.at).toBe(AT)
    expect(result).toEqual({
      runId: RUN_ID,
      agentId: 'grok',
      status: 'succeeded',
      startedAt: '2026-05-01T00:00:00.000Z',
      finishedAt: '2026-05-01T00:00:00.000Z',
      durationMs: 0,
      cwd: '/work/alpha',
      exitCode: 0,
      finalText: 'Hello',
      usage: { inputTokens: 10, outputTokens: 4 },
      nativeSessionKey: 'grok:sess-1',
      notes: [
        "no approval mode was requested, so grok's own configured permission mode applies",
        'grok reported 2 cache-creation input tokens, which the mesh usage record has no field for',
      ],
    })
  })

  it('fails the run when no grok binary is installed', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' } })
    const { events, result } = await dispatch(host, REQUEST, runContext(host, { binary: undefined }))

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'detection/not-found',
        message: 'the grok binary is not available',
        remediation: "Install Grok Build, or set the adapter binary path in this adapter's configuration.",
      },
    })
    expect(host.spawned).toEqual([])
    expect(events.map(event => event.kind)).toEqual(['run.started', 'run.finished'])
  })

  it('rejects a sandbox profile and an approval mode grok does not declare', async () => {
    const sandboxHost = new MemoryHost({ home: HOME, env: { PATH: '' } })
    const sandbox = await dispatch(sandboxHost, { ...REQUEST, sandbox: 'unconfined' })
    expect(sandbox.result).toMatchObject({
      status: 'failed',
      error: {
        code: 'schema/invalid',
        message: '"unconfined" is not a Grok sandbox profile',
        remediation: 'Declared profiles: off, workspace, devbox, read-only, strict.',
      },
    })
    expect(sandboxHost.spawned).toEqual([])

    const approvalHost = new MemoryHost({ home: HOME, env: { PATH: '' } })
    const approval = await dispatch(approvalHost, { ...REQUEST, approval: 'yolo' })
    expect(approval.result).toMatchObject({
      status: 'failed',
      error: {
        code: 'schema/invalid',
        message: '"yolo" is not a Grok approval mode',
        remediation: 'Declared modes: default, acceptEdits, auto, dontAsk, bypassPermissions, plan.',
      },
    })
  })

  it('reports a child that could not be started, naming a non-Error cause', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' }, spawnFailure: 'ENOEXEC' })
    const { result } = await dispatch(host)

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'run/start-failed',
        message: 'the grok process could not be started: ENOEXEC',
        remediation: 'Check that the resolved binary is executable and that the working directory exists.',
      },
    })
  })

  it('counts a stdout line that is not JSON and still reports the run', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '' },
      scripts: [{
        stdout: ['not json', '', line('text', { data: 'ok' }), line('end', { sessionId: 'sess-2' })],
        code: 0,
      }],
    })
    const { events, result } = await dispatch(host)

    const warnings = events.filter(event => event.kind === 'warning')
    expect(warnings.map(warning => warning.message)).toEqual([
      'streaming-json line 1 could not be parsed: Unexpected token \'o\', "not json" is not valid JSON',
      'streaming-json line 2 could not be parsed: empty line',
    ])
    expect(warnings.every(warning => warning.at === AT)).toBe(true)
    expect(result.status).toBe('succeeded')
    expect(result.finalText).toBe('ok')
    expect(result.notes).toContain('2 stdout line(s) were not valid JSON and are reported as warning events')
  })

  it('declares a reader that stopped early, a stderr read that failed and an unobservable exit', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '' },
      scripts: [{
        stdout: [line('text', { data: 'partial' })],
        streamFailure: new Error('the pipe broke'),
        stderrFailure: 'stderr is gone',
        exitFailure: new Error('no exit was observed'),
      }],
    })
    const { result } = await dispatch(host)

    expect(host.logs).toEqual([
      'warn: grok stderr could not be read: stderr is gone',
      'warn: the grok process could not be observed to exit: no exit was observed',
    ])
    expect(result.status).toBe('failed')
    expect(result.finalText).toBe('partial')
    expect(result).not.toHaveProperty('exitCode')
    expect(result.error).toMatchObject({ code: 'run/agent-crashed' })
    expect(result.notes).toContain('the streaming-json reader stopped early: the pipe broke')
  })

  it('warns when the native session id could not be observed', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' }, scripts: [{ stdout: [line('text', { data: 'done' })], code: 0 }] })
    const { events, result } = await dispatch(host)

    const warnings = events.filter(event => event.kind === 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.at).toBe(AT)
    expect(warnings[0]?.message).toBe('the native session id could not be observed: the `end` line carried no `sessionId`, so this run is unbound and cannot be resumed')
    expect(result.nativeSessionKey).toBeUndefined()
    expect(result.notes).toEqual([
      "no approval mode was requested, so grok's own configured permission mode applies",
      'the native session id could not be observed; the run cannot be resumed',
      'grok reported no token usage for this run',
      'the streaming-json stream ended without an `end` line; terminal metadata and usage may be missing',
    ])
  })

  it('binds the session a resume asked for when the stream never repeats it', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' }, scripts: [{ stdout: [line('text', { data: 'more' })], code: 0 }] })
    const { events, result } = await dispatch(host, { ...REQUEST, resumeNativeId: 'sess-9' })

    expect(events.some(event => event.kind === 'session.bound')).toBe(false)
    expect(result.nativeSessionKey).toBe('grok:sess-9')
    expect(result.notes).toEqual([
      "no sandbox override was requested, so the resumed session's recorded profile applies",
      "no approval mode was requested, so grok's own configured permission mode applies",
      'the streaming-json stream ended without an `end` line; terminal metadata and usage may be missing',
    ])
    expect(host.spawned[0]?.args).toContain('-r')
    expect(host.spawned[0]?.args).toContain('sess-9')
  })

  it('warns when grok stopped with a refusal', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '' },
      scripts: [{ stdout: [line('end', { sessionId: 'sess-3', stopReason: 'refusal' })], code: 0 }],
    })
    const { events, result } = await dispatch(host)

    expect(result.status).toBe('succeeded')
    const warnings = events.filter(event => event.kind === 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.at).toBe(AT)
    expect(warnings[0]?.message).toBe('grok stopped with a refusal; the task was not completed')
  })

  it('classifies a cancelled run that ends in a signal', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' }, scripts: [{ stdout: [line('text', { data: 'working' })], hold: true }] })
    const run = startGrokRun(runContext(host), REQUEST)
    run.cancel('the user changed their mind')
    run.cancel('a later reason must not replace the first')
    const { events, result } = await drain(run)

    expect(host.processes[0]?.cancelReason).toBe('the user changed their mind')
    expect(result).toMatchObject({ status: 'cancelled', error: { code: 'run/cancelled', message: 'the run was cancelled' } })
    expect(result.signal).toBe('SIGTERM')
    expect(events[0]).toMatchObject({ kind: 'run.started' })
  })

  it('cancels the child a cancel arrived before', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' }, scripts: [{ stdout: [], hold: true }] })
    let release: (() => void) | undefined
    const context: GrokRunContext = {
      ...runContext(host),
      resolveBinary: async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return BINARY
      },
    }
    const run = startGrokRun(context, REQUEST)
    run.cancel('stop before the child exists')
    release?.()
    const { result } = await drain(run)

    expect(host.processes[0]?.cancelled).toBe(true)
    expect(host.processes[0]?.cancelReason).toBe('stop before the child exists')
    expect(result.status).toBe('cancelled')
  })

  it('drops the oldest events when nothing reads the stream', async () => {
    const chatty = Array.from({ length: 4_100 }, (_, index) => line('text', { data: `chunk ${String(index)}` }))
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '' },
      scripts: [{ stdout: [...chatty, line('end', { sessionId: 'sess-4' })], code: 0 }],
    })
    const run = startGrokRun(runContext(host), REQUEST)
    const result = await run.result
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)

    expect(events[0]?.kind).toBe('message.delta')
    expect(events.filter(event => event.kind === 'message.delta')).toHaveLength(4_094)
    expect(result.notes.join('\n')).toMatch(/\d+ event\(s\) were dropped because nothing was reading the stream/)
  })

  it('settles a run whose binary resolver rejects as a protocol error', async () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' } })
    const context: GrokRunContext = {
      ...runContext(host),
      resolveBinary: async () => {
        throw new Error('the detector exploded')
      },
    }
    const { events, result } = await dispatch(host, REQUEST, context)

    expect(host.logs).toEqual(['warn: grok run producer failed: the detector exploded'])
    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'run/protocol-error',
        message: 'the run stream ended without a terminal event',
        remediation: 'Re-dispatch the run; if it repeats, capture the grok stdout stream for diagnosis.',
      },
    })
    expect(events.at(-1)?.kind).toBe('run.finished')
  })

  it('prefers an explicit request budget over the configured one and leaves a zero budget unbounded', async () => {
    const bounded = new MemoryHost({ home: HOME, env: { PATH: '' }, scripts: [{ stdout: [], code: 0 }] })
    await dispatch(bounded, { ...REQUEST, timeoutMs: 250 })
    expect(bounded.spawned[0]?.timeoutMs).toBe(250)

    const unbounded = new MemoryHost({ home: HOME, env: { PATH: '' }, scripts: [{ stdout: [], code: 0 }] })
    await dispatch(unbounded, REQUEST, runContext(unbounded, { config: { timeoutMs: 0 } }))
    expect(unbounded.spawned[0]).not.toHaveProperty('timeoutMs')
  })

  it('projects timed-out runs and bounds captured failure output', async () => {
    const timedOut = new MemoryHost({
      home: HOME,
      env: { PATH: '' },
      scripts: [{ stdout: [line('end', { sessionId: 'sess-timeout' })], code: null, timedOut: true }],
    })
    const timeoutResult = await dispatch(timedOut)
    expect(timeoutResult.result.status).toBe('timeout')
    expect(timeoutResult.result.error?.code).toBe('run/timeout')

    const stderr = `start${'x'.repeat(2_100)}end`
    const failed = new MemoryHost({
      home: HOME,
      env: { PATH: '' },
      scripts: [{ stdout: [line('end', { sessionId: 'sess-error' })], code: 1, stderr }],
    })
    const failedResult = await dispatch(failed)
    expect(failedResult.result.status).toBe('failed')
    expect(failedResult.result.error?.output).toHaveLength(2_000)
    expect(failedResult.result.error?.output).toBe(stderr.slice(-2_000))
  })

  it('truncates a tool payload and reports a tool call without a call id', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '' },
      scripts: [{
        stdout: [
          line('tool_call', { title: 'shell', rawInput: { cmd: 'x'.repeat(MAX_EVENT_TEXT_BYTES + 10) } }),
          line('end', { sessionId: 'sess-5' }),
        ],
        code: 0,
      }],
    })
    const { events, result } = await dispatch(host)

    const started = events.find(event => event.kind === 'tool.started')
    expect(started?.kind === 'tool.started' && started.input).toHaveLength(MAX_EVENT_TEXT_BYTES)
    expect(started).toMatchObject({ toolName: 'shell' })
    expect(started).not.toHaveProperty('callId')
    expect(result.status).toBe('succeeded')
  })

  it('declares the run notes a plan-less and subagent-less configuration adds', async () => {
    const host = new MemoryHost({
      home: HOME,
      env: { PATH: '' },
      scripts: [{ stdout: [line('end', { sessionId: 'sess-6' })], code: 0 }],
    })
    const { result } = await dispatch(host, { ...REQUEST, approval: 'default' }, runContext(host, { config: { noPlan: true, noSubagents: true } }))

    expect(result.notes).toEqual([
      'grok accepts --no-plan/--no-subagents in headless mode but only its interactive pager applies them',
      'grok reported no token usage for this run',
    ])
  })
})

describe('grok run identity', () => {
  it('mints a distinct id per dispatch from the host clock', () => {
    const host = new MemoryHost({ env: { PATH: '' }, now: 1_700_000_000_000 })

    expect(mintRunId(host, 1)).toBe('grok-1700000000000-1')
    expect(mintRunId(host, 2)).toBe('grok-1700000000000-2')
  })
})

describe('grok child environment', () => {
  it('forwards the ambient credential names, the store home and the sandbox', () => {
    const host = new MemoryHost({
      home: HOME,
      env: {
        PATH: '',
        XAI_API_KEY: 'xai-key',
        GROK_AUTH: '',
        GROK_AUTH_PATH: '/secrets/auth.json',
        GROK_HOME: '/store/grok',
      },
    })
    const paths = resolveGrokPaths(host)
    const env = runEnvironment(host, paths, resolveGrokConfig({ env: { CONFIGURED: 'yes' } }), 'workspace', { CALLER: 'yes' })

    expect(env).toEqual({
      XAI_API_KEY: 'xai-key',
      GROK_HOME: '/store/grok',
      GROK_AUTH_PATH: '/secrets/auth.json',
      GROK_SANDBOX: 'workspace',
      CONFIGURED: 'yes',
      CALLER: 'yes',
    })
    expect(env).not.toHaveProperty('GROK_AUTH')
  })

  it('omits the credential path variable when the store resolves to its default', () => {
    const host = new MemoryHost({ home: HOME, env: { PATH: '' } })
    const env = runEnvironment(host, resolveGrokPaths(host), resolveGrokConfig(), undefined)

    expect(env).toEqual({ GROK_HOME: `${HOME}/.grok` })
  })
})

describe('grok stream state', () => {
  it('starts empty and unbound', () => {
    const state: GrokStreamState = createStreamState()

    expect(state).toEqual({
      text: '',
      sessionId: undefined,
      stopReason: undefined,
      usage: undefined,
      cacheCreationTokens: undefined,
      toolNames: new Map<string, string>(),
      errorMessage: undefined,
      ended: false,
      notes: [],
    })
  })
})
