import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId, AgentRun, AgentRunEvent, AgentRunId } from '@deepseek-ai/dsh-agent-mesh'
import {
  buildExecArgs,
  capEventText,
  classifyExecOutcome,
  CodexExecEventMapper,
  isGitRepository,
  mintRunId,
  RunEventQueue,
  runEnvironment,
  startCodexRun,
  usageFromNative,
} from '../src/run.ts'
import { codexAdapter } from '../src/index.ts'
import { resolveCodexConfig } from '../src/config.ts'
import type { CodexRunContext } from '../src/run.ts'
import type { CodexHome } from '../src/sessions.ts'
import type { HostProcess } from '../src/types.ts'
import { FakeHost } from './fake-host.ts'

const THREAD = '01920000-aaaa-bbbb-cccc-ddddeeeeffff'

/** A host with the binary, a git answer queued and the version probe queued. */
function runHost(): FakeHost {
  const host = new FakeHost()
  host.env['PATH'] = '/opt/bin'
  host.addFile('/opt/bin/codex')
  host.addDir('/home/tester/.codex')
  host.enqueue({ lines: ['codex-cli 0.50.0'] })
  host.enqueue({ lines: ['true'] })
  return host
}

/** Collect a run's events and its terminal record. */
async function drain(run: AgentRun): Promise<{ events: AgentRunEvent[]; result: Awaited<AgentRun['result']> }> {
  const events: AgentRunEvent[] = []
  for await (const event of run) events.push(event)
  return { events, result: await run.result }
}

/** The spawn the adapter used for `codex exec`, if it reached that point. */
function execSpawn(host: FakeHost): (typeof host.spawns)[number] | undefined {
  return host.spawns.find(entry => entry.spec.args[0] === 'exec')
}

/** Build a direct run context without binary detection. */
function directRunContext(host: FakeHost, resolve?: CodexRunContext['resolve']): CodexRunContext {
  const home: CodexHome = {
    path: '/home/tester/.codex',
    sessionsRoot: '/home/tester/.codex/sessions',
    archivedRoot: '/home/tester/.codex/archived_sessions',
    indexFile: '/home/tester/.codex/session_index.jsonl',
    credentialFile: '/home/tester/.codex/auth.json',
    fromEnv: false,
  }
  return {
    host,
    config: resolveCodexConfig(),
    agentId: brandString<AgentId>('codex'),
    runId: brandString<AgentRunId>('run-direct'),
    resolve: resolve ?? (async () => ({ binary: '/opt/bin/codex', home })),
  }
}

describe('exec argv', () => {
  it('places every option before the prompt and adds the safe separator', () => {
    expect(
      buildExecArgs({
        cwd: '/repo',
        model: 'gpt-5-codex',
        sandbox: 'workspace-write',
        approval: 'never',
        resumeNativeId: THREAD,
        prompt: '-please fix',
        skipGitRepoCheck: true,
      }),
    ).toEqual([
      'exec',
      '--json',
      '-C',
      '/repo',
      '-m',
      'gpt-5-codex',
      '-s',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '--skip-git-repo-check',
      'resume',
      THREAD,
      '--',
      '-please fix',
    ])
    expect(buildExecArgs({ cwd: '/repo', model: undefined, sandbox: undefined, approval: undefined, resumeNativeId: undefined, prompt: 'hi', skipGitRepoCheck: false })).toEqual([
      'exec',
      '--json',
      '-C',
      '/repo',
      'hi',
    ])
  })

  it('maps native usage', () => {
    expect(usageFromNative({ input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 })).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      reasoningTokens: 1,
      totalTokens: 15,
    })
    expect(usageFromNative({})).toBeUndefined()
    expect(usageFromNative(null)).toBeUndefined()
    expect(usageFromNative({ input_tokens: 3 })).toEqual({ inputTokens: 3, totalTokens: 3 })
    expect(usageFromNative({ output_tokens: 4 })).toEqual({ outputTokens: 4, totalTokens: 4 })
    expect(usageFromNative({ cached_input_tokens: 2 })).toEqual({ cachedInputTokens: 2 })
  })

  it('classifies process outcomes', () => {
    expect(classifyExecOutcome({ code: 0, signal: null, timedOut: false, cancelled: false }, '', 10)).toEqual({ ok: true })
    expect(classifyExecOutcome({ code: null, signal: 'SIGTERM', timedOut: false, cancelled: true }, '', 10)).toMatchObject({
      ok: false,
      failure: 'cancelled',
      code: 'run/cancelled',
    })
    expect(classifyExecOutcome({ code: null, signal: 'SIGKILL', timedOut: true, cancelled: false }, '', 42)).toMatchObject({
      ok: false,
      failure: 'timeout',
      code: 'run/timeout',
      message: 'the run exceeded its 42 ms budget',
    })
    expect(classifyExecOutcome({ code: 1, signal: null, timedOut: false, cancelled: false }, 'stream error: 429 too many requests', 10)).toMatchObject({
      ok: false,
      failure: 'rate-limited',
      code: 'run/rate-limited',
    })
    expect(classifyExecOutcome({ code: 1, signal: null, timedOut: false, cancelled: false }, 'request refused by policy', 10)).toMatchObject({
      ok: false,
      failure: 'policy-blocked',
      code: 'run/policy-blocked',
    })
    expect(classifyExecOutcome({ code: 3, signal: null, timedOut: false, cancelled: false }, 'boom', 10)).toMatchObject({
      ok: false,
      failure: 'crashed',
      code: 'run/agent-crashed',
      message: 'codex exited with code 3',
    })
    expect(classifyExecOutcome({ code: null, signal: 'SIGABRT', timedOut: false, cancelled: false }, '', 10)).toMatchObject({
      ok: false,
      message: 'codex was terminated by signal SIGABRT',
    })
  })
})

describe('CodexExecEventMapper', () => {
  it('projects thread, turn, message, reasoning, command, file, tool, todo, and unknown records', () => {
    const mapper = new CodexExecEventMapper({
      runId: brandString<AgentRunId>('mapper-run'),
      now: () => '2026-10-16T12:00:00.000Z',
    })
    const item = (
      nativeType: string | undefined,
      payload: Record<string, unknown> = {},
      phase: 'item.started' | 'item.updated' | 'item.completed' = 'item.started',
    ): readonly AgentRunEvent[] => {
      const value = {
        type: phase,
        item: { ...payload, ...(nativeType === undefined ? {} : { type: nativeType }) },
      }
      return mapper.mapLine(value, JSON.stringify(value))
    }

    expect(mapper.mapLine(null, 'null')).toMatchObject([{ kind: 'unknown', native: 'null' }])
    expect(mapper.mapLine({ type: 'thread.started' }, '{}')).toMatchObject([{ kind: 'unknown', nativeType: 'thread.started' }])
    expect(mapper.mapLine({ type: 'thread.started', thread_id: THREAD }, '{}'))
      .toMatchObject([{ kind: 'session.bound', nativeSessionId: THREAD }])
    expect(mapper.mapLine({ type: 'turn.started' }, '{}')).toEqual([])
    expect(mapper.mapLine({ type: 'turn.completed', usage: {} }, '{}'))
      .toMatchObject([{ kind: 'unknown', nativeType: 'turn.completed' }])
    expect(mapper.mapLine({ type: 'turn.failed', error: { message: 'failed turn' } }, '{}'))
      .toMatchObject([{ kind: 'warning', message: 'codex turn failed: failed turn' }])
    expect(mapper.mapLine({ type: 'turn.failed', error: 'native failure' }, '{}'))
      .toMatchObject([{ kind: 'warning', message: 'codex turn failed: "native failure"' }])
    expect(mapper.mapLine({ type: 'error', message: 'top-level failure' }, '{}'))
      .toMatchObject([{ kind: 'warning', message: 'codex error: top-level failure' }])
    expect(mapper.mapLine({ type: 'error' }, 'raw error')).toMatchObject([{ kind: 'warning', message: 'codex error: raw error' }])
    expect(mapper.mapLine({ type: 'future.event' }, 'future')).toMatchObject([{ kind: 'unknown', nativeType: 'future.event' }])
    expect(mapper.mapLine({}, 'untyped')).toMatchObject([{ kind: 'unknown', native: 'untyped' }])

    expect(item('agent_message')).toEqual([])
    expect(item('agent_message', { text: '' }, 'item.updated')).toEqual([])
    expect(item('agent_message', { id: 'message-1', text: 'hello' })).toMatchObject([
      { kind: 'message.delta', text: 'hello' },
    ])
    expect(item('agent_message', { id: 'message-1', text: 'hello world' }, 'item.updated')).toMatchObject([
      { kind: 'message.delta', text: ' world' },
    ])
    expect(item('agent_message', { id: 'message-1', text: 'hello world' }, 'item.updated')).toEqual([])
    expect(item('agent_message', { id: 'message-1', text: 'replaced' }, 'item.updated')).toEqual([])
    expect(item('agent_message', { text: 'anonymous' }, 'item.updated')).toMatchObject([
      { kind: 'message.delta', text: 'anonymous' },
    ])
    expect(item('agent_message', { text: 'completed answer' }, 'item.completed')).toMatchObject([
      { kind: 'message.completed', text: 'completed answer' },
    ])
    expect(item('reasoning', { id: 'reason-1' })).toEqual([])
    expect(item('reasoning', { text: 'thinking' }, 'item.completed')).toEqual([])
    expect(item('reasoning', { id: 'reason-1', text: 'thinking' }, 'item.updated')).toMatchObject([
      { kind: 'reasoning.delta', text: 'thinking' },
    ])
    expect(item('reasoning', { id: 'reason-1', text: 'thinking harder' }, 'item.updated')).toMatchObject([
      { kind: 'reasoning.delta', text: ' harder' },
    ])
    expect(item('reasoning', { id: 'reason-1', text: 'thinking harder' }, 'item.updated')).toEqual([])

    expect(item('command_execution', { id: 'command-1', command: 'ls -la' })).toMatchObject([
      { kind: 'tool.started', callId: 'command-1', toolName: 'shell', input: 'ls -la' },
    ])
    expect(item('command_execution', { id: 'command-1', status: 'completed', aggregated_output: 'file.txt' }, 'item.completed'))
      .toMatchObject([{ kind: 'tool.completed', callId: 'command-1', output: 'file.txt', failed: false }])
    expect(item('command_execution', { id: 'command-2', status: 'declined', command: '', aggregated_output: '' }, 'item.completed'))
      .toMatchObject([
        { kind: 'tool.started', callId: 'command-2', toolName: 'shell' },
        { kind: 'tool.completed', callId: 'command-2', failed: true },
      ])
    expect(item('command_execution', { id: 'command-3', command: 'echo x', status: 'completed' }, 'item.completed'))
      .toMatchObject([
        { kind: 'tool.started', callId: 'command-3', input: 'echo x' },
        { kind: 'tool.completed', failed: false },
      ])
    expect(item('command_execution', { status: 'failed' }, 'item.completed')).toMatchObject([
      { kind: 'tool.started', toolName: 'shell' },
      { kind: 'tool.completed', failed: true },
    ])
    expect(item('file_change', { changes: 'not an array' }, 'item.completed')).toEqual([])
    expect(item('file_change', { changes: [{ other: 'x' }] }, 'item.completed')).toEqual([])
    expect(item('file_change', { status: 'failed', changes: [{ path: 'src/a.ts' }] }, 'item.completed'))
      .toMatchObject([{ kind: 'files.changed', paths: ['src/a.ts'] }, { kind: 'warning' }])
    expect(item('file_change', { changes: [{ path: 'src/b.ts' }] }, 'item.completed'))
      .toMatchObject([{ kind: 'files.changed', paths: ['src/b.ts'] }])

    expect(item('mcp_tool_call', { id: 'mcp-1', server: 'fs', tool: 'read', arguments: { path: '/a' } }))
      .toMatchObject([{ kind: 'tool.started', toolName: 'fs/read', input: '{"path":"/a"}' }])
    expect(item('mcp_tool_call', { status: 'failed', error: 'failed call', error_detail: 'x' }, 'item.completed'))
      .toMatchObject([{ kind: 'tool.started', toolName: 'mcp' }, { kind: 'tool.completed', failed: true }])
    expect(item('mcp_tool_call', { id: 'mcp-output', error: { message: 'tool failure' } }, 'item.completed'))
      .toMatchObject([
        { kind: 'tool.started', callId: 'mcp-output' },
        { kind: 'tool.completed', output: 'tool failure', failed: false },
      ])
    expect(item('mcp_tool_call', { id: 'mcp-result', result: 'ok' }, 'item.completed'))
      .toMatchObject([
        { kind: 'tool.started', callId: 'mcp-result' },
        { kind: 'tool.completed', output: '"ok"' },
      ])
    expect(item('collab_tool_call', { tool: 'delegate', prompt: 'ask the worker' }))
      .toMatchObject([{ kind: 'tool.started', toolName: 'collab:delegate', input: 'ask the worker' }])
    expect(item('collab_tool_call', { status: 'errored', agents_states: { worker: 'failed' } }, 'item.completed'))
      .toMatchObject([
        { kind: 'tool.started', toolName: 'collab:collab' },
        { kind: 'tool.completed', failed: true, output: '{"worker":"failed"}' },
      ])
    expect(item('web_search', { query: 'Codex docs' })).toMatchObject([
      { kind: 'tool.started', toolName: 'web_search', input: 'Codex docs' },
    ])
    expect(item('web_search', { results: [{ title: 'Docs' }] }, 'item.completed'))
      .toMatchObject([
        { kind: 'tool.started' },
        { kind: 'tool.completed', output: '[{"title":"Docs"}]', failed: false },
      ])
    expect(item('web_search', { action: { query: 'status' } })).toMatchObject([
      { kind: 'tool.started', input: '{"query":"status"}' },
    ])
    expect(item('web_search', {}, 'item.completed')).toMatchObject([
      { kind: 'tool.started', toolName: 'web_search' },
      { kind: 'tool.completed', failed: false },
    ])

    expect(item('todo_list', { items: [] }, 'item.started')).toEqual([])
    expect(item('todo_list', { items: 'invalid' }, 'item.completed')).toMatchObject([{ kind: 'todos.updated', todos: [] }])
    expect(item('todo_list', { items: [{ text: 'done', completed: true }, { text: 'next', completed: false }, { completed: true }] }, 'item.completed'))
      .toMatchObject([{ kind: 'todos.updated', todos: [{ content: 'done', status: 'completed' }, { content: 'next', status: 'pending' }] }])
    expect(item('todo_list', { items: [{ text: 'done', completed: true }, { text: 'next', completed: false }, { completed: true }] }, 'item.completed'))
      .toEqual([])
    expect(item('todo_list', { items: [{ text: 'changed' }] }, 'item.completed'))
      .toMatchObject([{ kind: 'todos.updated', todos: [{ content: 'changed', status: 'pending' }] }])
    expect(item('error', { message: 'item failure' }, 'item.completed')).toMatchObject([
      { kind: 'warning', message: 'codex error: item failure' },
    ])
    expect(item('error', {}, 'item.completed')).toMatchObject([{ kind: 'warning', message: 'codex error: {"type":"error"}' }])
    expect(item(undefined, {}, 'item.completed')).toMatchObject([{ kind: 'unknown', nativeType: 'item.unknown' }])
    expect(mapper.mapLine({ type: 'item.completed', item: null }, 'invalid item'))
      .toMatchObject([{ kind: 'unknown', nativeType: 'item' }])
    expect(mapper.unmodelledItemTypes).toContain('(untyped item)')
    expect(mapper.nativeSessionId).toBe(THREAD)
    expect(mapper.finalText).toBe('completed answer')
    expect(mapper.errorEvidence.length).toBeGreaterThan(0)
  })
})

describe('run helper edges', () => {
  it('bounds text, builds empty-option argv and environment values, and checks git safely', async () => {
    expect(capEventText('short')).toBe('short')
    expect(capEventText('x'.repeat(8_193))).toContain('[truncated by dsh-agent-codex at 8192 characters]')
    expect(buildExecArgs({
      cwd: '/repo', model: '', sandbox: undefined, approval: undefined, resumeNativeId: undefined,
      prompt: 'plain prompt', skipGitRepoCheck: false,
    })).toEqual(['exec', '--json', '-C', '/repo', 'plain prompt'])
    const host = new FakeHost()
    host.env['CODEX_API_KEY'] = 'ambient'
    host.env['CODEX_ACCESS_TOKEN'] = ''
    expect(runEnvironment(host, { CODEX_ACCESS_TOKEN: 'configured' }, { CODEX_API_KEY: 'caller', EXTRA: 'yes' }, '/home/codex'))
      .toEqual({ CODEX_API_KEY: 'caller', CODEX_ACCESS_TOKEN: 'configured', EXTRA: 'yes', CODEX_HOME: '/home/codex' })
    expect(mintRunId(host, 7)).toBe(`codex-${String(host.now())}-7`)

    vi.spyOn(host, 'spawn').mockImplementation(() => { throw new Error('git unavailable') })
    expect(await isGitRepository(host, '/repo')).toBe(false)
  })

  it('wakes queue waiters, retains the terminal event, and records overflow drops', async () => {
    const runId = brandString<AgentRunId>('queue-run')
    const waiting = new RunEventQueue()
    const iterator = waiting[Symbol.asyncIterator]()
    const pending = iterator.next()
    await Promise.resolve()
    const first: AgentRunEvent = { kind: 'message.delta', runId, at: 'now', text: 'first' }
    waiting.emit(first)
    expect(await pending).toMatchObject({ done: false, value: first })
    const result = {
      runId,
      agentId: brandString<AgentId>('codex'),
      status: 'succeeded' as const,
      startedAt: 'now',
      finishedAt: 'now',
      durationMs: 0,
      cwd: '/repo',
      notes: [],
    }
    waiting.emit({ kind: 'run.finished', runId, at: 'now', result })
    expect(await iterator.next()).toMatchObject({ done: false, value: { kind: 'run.finished' } })
    expect(await iterator.next()).toMatchObject({ done: true })
    expect(await waiting.result).toEqual(result)
    waiting.emit(first)
    expect(await waiting[Symbol.asyncIterator]().next()).toMatchObject({ done: true })

    const full = new RunEventQueue()
    for (let index = 0; index <= 4_096; index += 1) {
      full.emit({ kind: 'message.delta', runId, at: 'now', text: String(index) })
    }
    full.emit({ kind: 'run.finished', runId, at: 'now', result })
    expect(full.droppedCount).toBe(1)
    const retained: AgentRunEvent[] = []
    for await (const event of full) retained.push(event)
    expect(retained).toHaveLength(4_097)
    expect(retained.at(-1)?.kind).toBe('run.finished')
  })
})

describe('run dispatch', () => {
  it('projects the exec stream into mesh events and one result', async () => {
    const host = runHost()
    host.enqueue({
      lines: [
        JSON.stringify({ type: 'thread.started', thread_id: THREAD }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: 'c1', command: 'ls -la' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'c1', status: 'completed', aggregated_output: 'a.txt' } }),
        JSON.stringify({ type: 'item.updated', item: { type: 'agent_message', id: 'm1', text: 'Hel' } }),
        JSON.stringify({ type: 'item.updated', item: { type: 'agent_message', id: 'm1', text: 'Hello!' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', id: 'm1', text: 'Hello!' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } }),
        JSON.stringify({ type: 'future.event', payload: 1 }),
      ],
    })
    const run = codexAdapter(host, { model: 'gpt-5-codex', runMode: 'headless-exec' }).startRun({ prompt: 'say hello', cwd: '/repo' })
    const { events, result } = await drain(run)

    expect(execSpawn(host)?.spec).toMatchObject({
      command: '/opt/bin/codex',
      args: ['exec', '--json', '-C', '/repo', '-m', 'gpt-5-codex', 'say hello'],
      cwd: '/repo',
      env: { CODEX_HOME: '/home/tester/.codex' },
    })
    expect(events.map(event => event.kind)).toEqual([
      'run.started',
      'session.bound',
      'tool.started',
      'tool.completed',
      'message.delta',
      'message.delta',
      'message.completed',
      'usage.updated',
      'unknown',
      'run.finished',
    ])
    expect(events[1]).toMatchObject({ kind: 'session.bound', nativeSessionId: THREAD })
    expect(events[2]).toMatchObject({ kind: 'tool.started', toolName: 'shell', input: 'ls -la', callId: 'c1' })
    expect(events[3]).toMatchObject({ kind: 'tool.completed', toolName: 'shell', output: 'a.txt', failed: false })
    expect(events[4]).toMatchObject({ kind: 'message.delta', text: 'Hel' })
    expect(events[5]).toMatchObject({ kind: 'message.delta', text: 'lo!' })
    expect(events[8]).toMatchObject({ kind: 'unknown', nativeType: 'future.event' })

    expect(result).toMatchObject({
      status: 'succeeded',
      cwd: '/repo',
      exitCode: 0,
      finalText: 'Hello!',
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, totalTokens: 15 },
      nativeSessionKey: `codex:${THREAD}`,
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeUndefined()
    expect(result.notes.join('\n')).toContain('native types emitted as `unknown` events: future.event')
  })

  it('forwards the ambient credential names and lets configuration and the caller override them', async () => {
    const host = runHost()
    host.env['CODEX_API_KEY'] = 'ambient-key'
    host.env['CODEX_HOME'] = '/somewhere/else'
    host.enqueue({ lines: [] })
    const run = codexAdapter(host, { env: { CODEX_ACCESS_TOKEN: 'configured' }, runMode: 'headless-exec' }).startRun({
      prompt: 'hi',
      cwd: '/repo',
      env: { EXTRA: 'caller' },
    })
    await drain(run)
    expect(execSpawn(host)?.spec.env).toEqual({
      CODEX_ACCESS_TOKEN: 'configured',
      CODEX_API_KEY: 'ambient-key',
      CODEX_HOME: '/home/tester/.codex',
      EXTRA: 'caller',
    })
  })

  it('reports a missing binary as a failed run instead of rejecting', async () => {
    const host = new FakeHost()
    host.env['PATH'] = '/usr/bin'
    const { events, result } = await drain(codexAdapter(host, { runMode: 'headless-exec' }).startRun({ prompt: 'hi', cwd: '/repo' }))
    expect(events.map(event => event.kind)).toEqual(['run.started', 'run.finished'])
    expect(result.status).toBe('failed')
    expect(result.error).toMatchObject({ code: 'detection/not-found', message: 'the codex binary is not available' })
  })

  it('rejects an undeclared sandbox or approval value', async () => {
    const sandbox = await drain(codexAdapter(runHost(), { runMode: 'headless-exec' }).startRun({ prompt: 'hi', cwd: '/repo', sandbox: 'yolo' }))
    expect(sandbox.result.error).toMatchObject({ code: 'schema/invalid', message: '"yolo" is not a Codex sandbox profile' })

    const approval = await drain(codexAdapter(runHost(), { runMode: 'headless-exec' }).startRun({ prompt: 'hi', cwd: '/repo', approval: 'always' }))
    expect(approval.result.error).toMatchObject({ code: 'schema/invalid', message: '"always" is not a Codex approval mode' })
  })

  it('resumes a native session and passes the policy values through', async () => {
    const host = new FakeHost()
    host.env['PATH'] = '/opt/bin'
    host.addFile('/opt/bin/codex')
    host.addDir('/home/tester/.codex')
    host.enqueue({ lines: ['codex-cli 0.50.0'] })
    host.enqueue({ lines: ['false'] })
    host.enqueue({ lines: [] })
    const run = codexAdapter(host, { sandbox: 'danger-full-access', approval: 'on-request', runMode: 'headless-exec' }).startRun({
      prompt: 'continue',
      cwd: '/repo',
      resumeNativeId: THREAD,
    })
    await drain(run)
    expect(execSpawn(host)?.spec.args).toEqual([
      'exec',
      '--json',
      '-C',
      '/repo',
      '-s',
      'danger-full-access',
      '-c',
      'approval_policy="on-request"',
      '--skip-git-repo-check',
      'resume',
      THREAD,
      'continue',
    ])
  })

  it('classifies a rate limit from stderr', async () => {
    const host = runHost()
    host.enqueue({ lines: [], stderr: 'Error: rate limit exceeded', exit: { code: 1, signal: null, timedOut: false, cancelled: false } })
    const { result } = await drain(codexAdapter(host, { runMode: 'headless-exec' }).startRun({ prompt: 'hi', cwd: '/repo' }))
    expect(result.status).toBe('failed')
    expect(result.error).toMatchObject({ code: 'run/rate-limited', output: 'Error: rate limit exceeded' })
  })

  it('cancels a run in flight and keeps the caller reason', async () => {
    const host = runHost()
    host.enqueue({ holdUntilCancelled: true })
    const run = codexAdapter(host, { runMode: 'headless-exec' }).startRun({ prompt: 'long task', cwd: '/repo' })
    const events: AgentRunEvent[] = []
    const collecting = (async (): Promise<void> => {
      for await (const event of run) events.push(event)
    })()
    await vi.waitFor(() => {
      expect(events.map(event => event.kind)).toContain('run.started')
    })
    run.cancel('user asked')
    await collecting
    const result = await run.result
    expect(events.at(-1)?.kind).toBe('run.finished')
    expect(result.status).toBe('cancelled')
    expect(result.error).toMatchObject({ code: 'run/cancelled' })
    expect(result.notes.join('\n')).toContain('cancelled by the caller: user asked')
    expect(execSpawn(host)?.process.cancelReason).toBe('user asked')
  })

  it('records malformed stdout as a warning and still settles', async () => {
    const host = runHost()
    host.enqueue({ lines: ['not json', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })] })
    const { events, result } = await drain(codexAdapter(host, { runMode: 'headless-exec' }).startRun({ prompt: 'hi', cwd: '/repo' }))
    expect(events.some(event => event.kind === 'warning' && event.message.includes('unparsable json'))).toBe(true)
    expect(result.notes.join('\n')).toContain('1 stdout line(s) were not valid JSON')
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
  })

  it('contains resolution and process-start failures as terminal run results', async () => {
    for (const cause of [new Error('home lookup failed'), 'home lookup failed']) {
      const host = new FakeHost()
      const context = directRunContext(host, async () => { throw cause })
      const { result } = await drain(startCodexRun(context, { prompt: 'run', cwd: '/repo' }))
      expect(result.error).toMatchObject({ code: 'run/protocol-error' })
      expect(host.logs.at(-1)?.message).toContain(cause instanceof Error ? cause.message : cause)
    }

    for (const cause of [new Error('spawn refused'), 'spawn refused']) {
      const host = new FakeHost()
      const spawn = host.spawn.bind(host)
      vi.spyOn(host, 'spawn').mockImplementation((spec) => {
        if (spec.command === '/opt/bin/codex') throw cause
        return spawn(spec)
      })
      const { result } = await drain(startCodexRun(directRunContext(host), { prompt: 'run', cwd: '/repo' }))
      expect(result.error?.code).toBe('run/start-failed')
      expect(result.error?.message).toContain('spawn refused')
    }
  })

  it('records errors from stdout, stderr, and process-exit observation', async () => {
    for (const mode of ['stdout', 'stderr', 'exit'] as const) {
      for (const cause of [new Error(`${mode} failed`), `${mode} failed`]) {
        const host = new FakeHost()
        const spawn = host.spawn.bind(host)
        vi.spyOn(host, 'spawn').mockImplementation((spec) => {
          if (spec.command !== '/opt/bin/codex') return spawn(spec)
          const lines: AsyncIterable<string> = {
            async *[Symbol.asyncIterator]() {
              if (mode === 'stdout') throw cause
            },
          }
          const process: HostProcess = {
            lines,
            async stderr() {
              if (mode === 'stderr') throw cause
              return ''
            },
            get exit() {
              if (mode === 'exit') return Promise.resolve().then(() => { throw cause })
              return Promise.resolve({ code: 0, signal: null, timedOut: false, cancelled: false })
            },
            cancel() {},
          }
          return process
        })
        const { result } = await drain(startCodexRun(directRunContext(host), { prompt: 'run', cwd: '/repo' }))
        expect(result.notes.join('\n')).toContain(`${mode} failed`)
      }
    }
  })

  it('uses request and configured timeouts and records timeout notes', async () => {
    for (const option of [
      { config: resolveCodexConfig(), request: { prompt: 'request budget', cwd: '/repo', timeoutMs: 200 }, timeoutMs: 200 },
      { config: resolveCodexConfig({ timeoutMs: 500 }), request: { prompt: 'default budget', cwd: '/repo' }, timeoutMs: 500 },
    ]) {
      const host = new FakeHost()
      host.enqueue({ lines: ['true'] })
      host.enqueue({ exit: { code: null, signal: 'SIGTERM', timedOut: true, cancelled: false } })
      const context = { ...directRunContext(host), config: option.config }
      const { result } = await drain(startCodexRun(context, option.request))
      expect(execSpawn(host)?.spec.timeoutMs).toBe(option.timeoutMs)
      expect(result.status).toBe('timeout')
      expect(result.notes.join('\n')).toContain(`the run was killed after ${String(option.timeoutMs)} ms`)
    }
  })

  it('cancels before process start, preserves only the first cancel reason, and handles empty stdout lines', async () => {
    const host = new FakeHost()
    host.enqueue({ lines: ['true'] })
    host.enqueue({ holdUntilCancelled: true })
    let releaseResolution: (resolution: Awaited<ReturnType<CodexRunContext['resolve']>>) => void = () => {}
    const context = directRunContext(host, () => new Promise((resolve) => { releaseResolution = resolve }))
    const resolution = await directRunContext(new FakeHost()).resolve()
    const run = startCodexRun(context, { prompt: 'stop before spawn', cwd: '/repo' })
    run.cancel()
    run.cancel('later reason')
    releaseResolution(resolution)
    const { result } = await drain(run)
    expect(result.status).toBe('cancelled')
    expect(result.notes).not.toContain('cancelled by the caller: later reason')
    expect(execSpawn(host)?.process.cancelReason).toBeUndefined()

    const empty = runHost()
    empty.enqueue({ lines: ['  '] })
    const drained = await drain(codexAdapter(empty, { runMode: 'headless-exec' }).startRun({ prompt: 'blank output', cwd: '/repo' }))
    expect(drained.events.some(event => event.kind === 'warning' && event.message.includes('empty line'))).toBe(true)
  })

  it('handles non-Error JSON parser failures, successful error events, oversized stderr, and unread queue overflow', async () => {
    const parserHost = runHost()
    parserHost.enqueue({ lines: ['{"type":"turn.started"}'] })
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw 'parser fault' })
    try {
      const { events } = await drain(codexAdapter(parserHost, { runMode: 'headless-exec' }).startRun({ prompt: 'parser fault', cwd: '/repo' }))
      expect(events.some(event => event.kind === 'warning' && event.message.includes('parser fault'))).toBe(true)
    } finally {
      parse.mockRestore()
    }

    const evidenceHost = new FakeHost()
    evidenceHost.enqueue({ lines: ['true'] })
    evidenceHost.enqueue({ lines: [JSON.stringify({ type: 'turn.failed', error: { message: 'model warning' } })] })
    const evidence = await drain(startCodexRun(directRunContext(evidenceHost), { prompt: 'evidence', cwd: '/repo' }))
    expect(evidence.result.status).toBe('succeeded')
    expect(evidence.result.notes.join('\n')).toContain('the stream reported: model warning')

    const stderrHost = runHost()
    stderrHost.enqueue({ stderr: 'x'.repeat(2_100), exit: { code: 1, signal: null, timedOut: false, cancelled: false } })
    const failed = await drain(codexAdapter(stderrHost, { runMode: 'headless-exec' }).startRun({ prompt: 'long stderr', cwd: '/repo' }))
    expect(failed.result.error?.output).toHaveLength(2_001)

    const overflowHost = new FakeHost()
    overflowHost.enqueue({ lines: ['true'] })
    overflowHost.enqueue({
      lines: Array.from({ length: 4_096 }, (_, index) => JSON.stringify({ type: 'future.event', index })),
    })
    const overflow = startCodexRun(directRunContext(overflowHost), { prompt: 'no reader', cwd: '/repo' })
    const result = await overflow.result
    expect(result.notes.join('\n')).toContain('1 event(s) were dropped')
  })
})
