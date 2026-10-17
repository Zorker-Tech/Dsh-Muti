import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  AgentId,
  AgentRunApprovalOutcome,
  AgentRunApprovalRequest,
  AgentRunEvent,
  AgentRunId,
  AgentRunRequest,
  HostDirEntry,
} from '@deepseek-ai/dsh-agent-mesh'
import { resolveOmpConfig, type OmpAdapterConfig } from '../src/config.ts'
import { buildOmpRpcRunArgs, startOmpRpcRun } from '../src/rpc-run.ts'
import { resolveOmpStore } from '../src/sessions.ts'
import { sessionFile, sessionHeader } from './support/fixtures.ts'
import { OmpRpcHost } from './support/rpc-host.ts'

const HOME = '/home/tester'
const BUCKET = `${HOME}/.omp/agent/sessions/-work-repo`
const agentId = brandString<AgentId>('omp')

/** A request with every optional field absent. */
function request(prompt = 'do the work'): AgentRunRequest {
  return { prompt, cwd: '/work/repo' }
}

/** Start one run using the test host's store layout. */
function dispatch(host: OmpRpcHost, runRequest: AgentRunRequest = request(), configInput: OmpAdapterConfig = {}) {
  const config = resolveOmpConfig(configInput)
  return startOmpRpcRun({
    host,
    config,
    layout: resolveOmpStore({ host, config }),
    agentId,
    runId: brandString<AgentRunId>(`omp-rpc-${String(host.now())}`),
  }, runRequest)
}

describe('OMP RPC run dispatch', () => {
  it('builds one explicit duplex argv without a JSON-mode fallback', () => {
    expect(buildOmpRpcRunArgs({})).toEqual(['--mode', 'rpc-ui'])
    expect(buildOmpRpcRunArgs({ resumeArgument: '/sessions/session.jsonl', model: '  ', approval: '' })).toEqual([
      '--mode', 'rpc-ui', '--resume', '/sessions/session.jsonl',
    ])
    expect(buildOmpRpcRunArgs({ model: '@slow' })).toEqual(['--mode', 'rpc-ui', '--model', '@slow'])
    expect(buildOmpRpcRunArgs({ model: 'openai/gpt-5.2' })).toEqual([
      '--mode', 'rpc-ui', '--provider', 'openai', '--model', 'gpt-5.2',
    ])
    expect(buildOmpRpcRunArgs({ approval: 'on-request' })).toEqual(['--mode', 'rpc-ui'])
    expect(buildOmpRpcRunArgs({ approval: 'write' })).toEqual(['--mode', 'rpc-ui', '--approval-mode', 'write'])
  })

  it('starts a native session, projects RPC events and waits for prompt completion', async () => {
    const host = new OmpRpcHost({ home: HOME })
    host.scriptRpc({
      sessionId: 'session-1',
      lines: [
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Working' } }),
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input: 10, output: 4, totalTokens: 14 } },
        }),
        JSON.stringify({ type: 'agent_end', isTerminal: true }),
      ],
    })

    const run = dispatch(host, { ...request(), model: 'openai/gpt-5.2', approval: 'write' })
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)
    const result = await run.result
    run.cancel('too late')

    expect(host.spawns[0]).toMatchObject({
      command: 'omp',
      args: ['--mode', 'rpc-ui', '--provider', 'openai', '--model', 'gpt-5.2', '--approval-mode', 'write'],
      cwd: '/work/repo',
      interactive: true,
    })
    expect(host.commands.map(command => command['type'])).toEqual(['new_session', 'get_state', 'prompt'])
    expect(events.map(event => event.kind)).toEqual([
      'run.started', 'session.bound', 'message.delta', 'message.completed', 'usage.updated', 'run.finished',
    ])
    expect(events[1]).toMatchObject({ kind: 'session.bound', nativeSessionId: 'session-1' })
    expect(result).toMatchObject({
      status: 'succeeded',
      finalText: 'Done.',
      nativeSessionKey: 'omp:session-1',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      exitCode: 0,
    })
    expect(host.processCancellations).toEqual([])
  })

  it('resumes the exact native session path without creating a new session', async () => {
    const host = new OmpRpcHost({ home: HOME })
    const path = `${BUCKET}/1750000000000_session-1.jsonl`
    host.addFile(path, sessionFile({ header: sessionHeader({ id: 'session-1', cwd: '/work/repo' }) }))
    host.scriptRpc({ sessionId: 'session-1' })

    const run = dispatch(host, { ...request('continue'), resumeNativeId: 'session-1' })
    const result = await run.result

    expect(host.spawns[0]?.args).toEqual(['--mode', 'rpc-ui', '--resume', path])
    expect(host.commands.map(command => command['type'])).toEqual(['get_state', 'prompt'])
    expect(result.nativeSessionKey).toBe('omp:session-1')
    expect(result.status).toBe('succeeded')
  })

  it('aborts the prompt over RPC without killing the OMP process', async () => {
    const host = new OmpRpcHost({ home: HOME })
    host.scriptRpc({ holdPrompt: true, sessionId: 'session-1' })
    const run = dispatch(host)

    await host.waitForCommand('prompt')
    run.cancel('user asked to stop')
    const result = await run.result

    expect(host.commands.map(command => command['type'])).toEqual(['new_session', 'get_state', 'prompt', 'abort'])
    expect(result).toMatchObject({
      status: 'cancelled',
      error: { code: 'run/cancelled' },
      nativeSessionKey: 'omp:session-1',
      notes: ['cancelled by the caller: user asked to stop'],
    })
    expect(host.processCancellations).toEqual([])
  })

  it('routes confirmation and explicit one-shot selections through DSH approval', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      sessionId: 'session-1',
      lines: [
        JSON.stringify({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'Run command?', message: 'npm test' }),
        JSON.stringify({ type: 'extension_ui_request', id: 'select-1', method: 'select', title: 'File change', options: ['Allow once', 'Deny'] }),
        JSON.stringify({ type: 'agent_end', isTerminal: true }),
      ],
    })
    const approvals: AgentRunApprovalRequest[] = []
    const run = dispatch(host, {
      ...request(),
      requestApproval: async (approval) => {
        approvals.push(approval)
        return approvals.length === 1 ? 'allowed-once' : 'rejected'
      },
    })
    const result = await run.result

    expect(result.status).toBe('succeeded')
    expect(approvals).toMatchObject([
      { kind: 'interaction', title: 'Run command?', detail: 'npm test' },
      { kind: 'interaction', title: 'File change', detail: 'choices: Allow once, Deny' },
    ])
    expect(host.commands.filter(command => command['type'] === 'extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'confirm-1', confirmed: true },
      { type: 'extension_ui_response', id: 'select-1', value: 'Deny' },
    ])
  })

  it('cancels a pending DSH confirmation when the OMP run is cancelled', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      holdPrompt: true,
      sessionId: 'session-1',
      commandPreludeLines: {
        prompt: [JSON.stringify({ type: 'extension_ui_request', id: 'confirm-pending', method: 'confirm', title: 'Run command?' })],
      },
    })
    let signalAborted = false
    let notifyApprovalStarted: (() => void) | undefined
    const approvalStarted = new Promise<void>((resolve) => { notifyApprovalStarted = resolve })
    const run = dispatch(host, {
      ...request(),
      requestApproval: ({ signal }) => new Promise<AgentRunApprovalOutcome>((resolve) => {
        signal.addEventListener('abort', () => {
          signalAborted = true
          resolve('cancelled')
        }, { once: true })
        notifyApprovalStarted?.()
      }),
    })

    await approvalStarted
    await host.waitForCommand('prompt')
    run.cancel('user stopped the run')
    await run.result

    expect(signalAborted).toBe(true)
    expect(host.commands).toContainEqual({ type: 'extension_ui_response', id: 'confirm-pending', cancelled: true })
    expect(host.commands).toContainEqual({ type: 'abort' })
  })

  it('does not write a UI cancellation response after OMP closes stdin', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      sessionId: 'session-1',
      commandPreludeLines: {
        prompt: [JSON.stringify({ type: 'extension_ui_request', id: 'confirm-closed', method: 'confirm' })],
      },
    })
    let notifyApprovalStarted: (() => void) | undefined
    const approvalStarted = new Promise<void>((resolve) => { notifyApprovalStarted = resolve })
    const run = dispatch(host, {
      ...request(),
      requestApproval: ({ signal }) => new Promise<AgentRunApprovalOutcome>((resolve) => {
        signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
        notifyApprovalStarted?.()
      }),
    })

    await approvalStarted
    await host.waitForStdinClose()
    run.cancel('cancel after terminal response')
    const result = await run.result

    expect(result.status).toBe('cancelled')
    expect(host.commands.some(command => command['type'] === 'extension_ui_response')).toBe(false)
  })

  it('reports a failed OMP approval response write as a protocol error', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      holdPrompt: true,
      sessionId: 'session-1',
      writeErrorForType: 'extension_ui_response',
      commandPreludeLines: {
        prompt: [JSON.stringify({ type: 'extension_ui_request', id: 'confirm-write-failed', method: 'confirm' })],
      },
    })
    const result = await dispatch(host, { ...request(), requestApproval: async () => 'allowed-once' }).result

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'run/protocol-error', message: 'OMP UI response failed: write failed for extension_ui_response' },
    })
    expect(host.processCancellations).toEqual(['OMP UI response failed'])
  })

  it('records when OMP cannot receive a UI cancellation response', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      holdPrompt: true,
      sessionId: 'session-1',
      writeErrorForType: 'extension_ui_response',
      commandPreludeLines: {
        prompt: [JSON.stringify({ type: 'extension_ui_request', id: 'confirm-cancel-failed', method: 'confirm' })],
      },
    })
    let notifyApprovalStarted: (() => void) | undefined
    const approvalStarted = new Promise<void>((resolve) => { notifyApprovalStarted = resolve })
    const run = dispatch(host, {
      ...request(),
      requestApproval: ({ signal }) => new Promise<AgentRunApprovalOutcome>((resolve) => {
        signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
        notifyApprovalStarted?.()
      }),
    })

    await approvalStarted
    await host.waitForCommand('prompt')
    run.cancel('stop after approval cancellation write failed')
    const result = await run.result

    expect(result.status).toBe('cancelled')
    expect(result.notes).toContain("OMP's UI cancellation response could not be delivered: write failed for extension_ui_response")
    expect(host.commands).toContainEqual({ type: 'abort' })
  })

  it('uses the structured prompt error returned by OMP RPC', async () => {
    const host = new OmpRpcHost({ home: HOME })
    host.scriptRpc({ promptStatus: 'error', promptError: 'provider returned 429' })
    const result = await dispatch(host).result
    expect(result).toMatchObject({ status: 'failed', error: { code: 'run/rate-limited', message: 'provider returned 429' } })
  })

  it('finishes a local OMP command without waiting for prompt_result', async () => {
    const host = new OmpRpcHost({ home: HOME })
    host.scriptRpc({
      localPrompt: true,
      lines: [JSON.stringify({ type: 'command_output', command: 'model', text: 'openai/gpt-5.2' })],
    })
    const run = dispatch(host, request('/model'))
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)
    const result = await run.result

    expect(result.status).toBe('succeeded')
    expect(events.some(event => event.kind === 'unknown' && event.nativeType === 'command_output')).toBe(true)
    expect(host.commands.map(command => command['type'])).toEqual(['new_session', 'get_state', 'prompt'])
  })

  it('does not start OMP for an empty prompt', async () => {
    const host = new OmpRpcHost({ home: HOME })
    const result = await dispatch(host, request('  ')).result
    expect(result).toMatchObject({ status: 'succeeded', notes: ['the prompt was empty, so no model turn was started'] })
    expect(host.spawns).toEqual([])
  })

  it('cancels before spawning and keeps the caller reason', async () => {
    const host = new OmpRpcHost({ home: HOME })
    const run = dispatch(host)
    run.cancel('stop before launch')
    run.cancel('ignore duplicate')
    const result = await run.result

    expect(result).toMatchObject({ status: 'cancelled', notes: ['cancelled by the caller: stop before launch'] })
    expect(host.spawns).toEqual([])
  })

  it('cancels an in-flight startup before the ready frame without sending abort', async () => {
    const host = new OmpRpcHost({ home: HOME })
    const run = dispatch(host)
    await host.waitForSpawn()
    run.cancel()
    const result = await run.result

    expect(result).toMatchObject({ status: 'cancelled', notes: [] })
    expect(host.commands).toEqual([])
  })

  it('cancels while the ready handshake is absent', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({ readyLine: null })
    const run = dispatch(host)
    await host.waitForSpawn()
    run.cancel()
    expect(await run.result).toMatchObject({ status: 'cancelled' })
  })

  it('reports unsupported sandbox, approval and unresolved resume options', async () => {
    const host = new OmpRpcHost({ home: HOME })
    host.scriptRpc({ sessionId: 'session-1' })
    const result = await dispatch(host, {
      ...request(),
      sandbox: 'strict',
      approval: 'manual',
      resumeNativeId: 'missing-session',
    }).result

    expect(result.status).toBe('succeeded')
    expect(result.notes).toEqual(expect.arrayContaining([
      expect.stringContaining('requested sandbox profile was ignored'),
      expect.stringContaining('is not one of omp\'s modes'),
    ]))
  })

  it('warns when a resumed native session belongs to another working directory', async () => {
    const host = new OmpRpcHost({ home: HOME })
    const path = `${BUCKET}/1750000000000_session-1.jsonl`
    host.addFile(path, sessionFile({ header: sessionHeader({ id: 'session-1', cwd: '/other/project' }) }))
    host.scriptRpc({ sessionId: 'session-1' })
    const result = await dispatch(host, { ...request(), resumeNativeId: 'session-1' }).result

    expect(result.status).toBe('succeeded')
    expect(result.notes).toEqual(expect.arrayContaining([expect.stringContaining('records cwd /other/project')]))
  })

  it('starts with the explicit binary and reports an ignored profile home override', async () => {
    const host = new OmpRpcHost({ home: HOME, env: { OMP_PROFILE: 'work' } })
    host.scriptRpc({ sessionId: 'session-1' })
    const result = await dispatch(host, { ...request(), timeoutMs: 1_200, env: { EXTRA: 'yes' } }, { binaryPath: '/bin/omp', homeDir: '/omp/agent' }).result

    expect(host.spawns[0]).toMatchObject({ command: '/bin/omp', timeoutMs: 1_200, env: { EXTRA: 'yes', OMP_PROFILE: '' } })
    expect(result.notes).toEqual(expect.arrayContaining([expect.stringContaining('would ignore the adapter\'s homeDir override')]))
  })

  it('settles a spawn exception as a start failure', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({ spawnFailure: new Error('not executable') })
    const result = await dispatch(host).result
    expectFailedResult(result, { code: 'run/start-failed', messageIncludes: 'not executable' })

    const nonErrorHost = new OmpRpcHost({ home: HOME }).scriptRpc({ spawnFailure: 'host denied spawn' })
    const nonError = await dispatch(nonErrorHost).result
    expectFailedResult(nonError, { messageIncludes: 'host denied spawn' })
  })

  it.each([
    ['invalid ready frame', { readyLine: JSON.stringify({ type: 'not-ready' }) }],
    ['missing ready frame', { readyLine: null }],
  ])('rejects an OMP process with an %s', async (_name, script) => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc(script)
    const result = await dispatch(host).result
    expect(result.status).toBe('failed')
    expect(host.commands).toEqual([])
  })

  it('does not hide a failed new-session command', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      commandResponses: { new_session: { success: false, error: 'session creation denied' } },
    })
    const result = await dispatch(host).result
    expect(result).toMatchObject({ status: 'failed', error: { message: 'session creation denied' } })
    expect(host.commands.map(command => command['type'])).toEqual(['new_session'])
  })

  it('does not send a prompt when new-session or get-state setup ends early', async () => {
    const newSessionHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      commandResponses: { new_session: { omit: true } },
    })
    const newSession = await dispatch(newSessionHost).result
    expect(newSession).toMatchObject({ status: 'failed', error: { code: 'run/context-unavailable' } })
    expect(newSessionHost.commands.map(command => command['type'])).toEqual(['new_session'])

    const getStateHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      commandResponses: { get_state: { omit: true } },
    })
    const getState = await dispatch(getStateHost).result
    expect(getState).toMatchObject({ status: 'failed', error: { code: 'run/context-unavailable' } })
    expect(getStateHost.commands.map(command => command['type'])).toEqual(['new_session', 'get_state'])
  })

  it('keeps cancellation during setup from being reclassified as a setup failure', async () => {
    const newSessionHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      commandResponses: { new_session: { omit: true } },
    })
    const newSessionRun = dispatch(newSessionHost)
    await newSessionHost.waitForCommand('new_session')
    newSessionRun.cancel()
    expect(await newSessionRun.result).toMatchObject({ status: 'cancelled', notes: [] })

    const stateHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      commandResponses: { get_state: { omit: true } },
    })
    const stateRun = dispatch(stateHost)
    await stateHost.waitForCommand('get_state')
    stateRun.cancel()
    expect(await stateRun.result).toMatchObject({ status: 'cancelled', notes: [] })
  })

  it('handles OMP rejecting or omitting the get-state session id', async () => {
    const rejectedHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      commandResponses: { get_state: { success: false } },
    })
    const rejected = await dispatch(rejectedHost).result
    expect(rejected).toMatchObject({ status: 'failed', error: { message: 'OMP rejected an RPC command' } })

    const missingHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      commandResponses: { get_state: { data: {} } },
    })
    const missing = await dispatch(missingHost).result
    expect(missing).toMatchObject({ status: 'failed', error: { message: 'OMP RPC did not report a session id' } })

    const missingDataHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      commandResponses: { get_state: { omitData: true } },
    })
    const missingData = await dispatch(missingDataHost).result
    expect(missingData).toMatchObject({ status: 'failed', error: { message: 'OMP RPC did not report a session id' } })
  })

  it('treats a cancelled new-session response as a setup failure', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      commandResponses: { new_session: { data: { cancelled: true } } },
    })
    const result = await dispatch(host).result
    expect(result).toMatchObject({ status: 'failed', error: { message: 'OMP cancelled the requested new session' } })
  })

  it('preserves malformed stdout lines as diagnostic notes', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      preludeLines: ['', 'not JSON'],
      sessionId: 'session-1',
    })
    const result = await dispatch(host).result
    expect(result.status).toBe('succeeded')
    expect(result.notes).toEqual(expect.arrayContaining([expect.stringContaining('stdout line(s) were not valid JSON')]))
  })

  it('preserves session headers and ignores unrelated RPC responses during setup', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      sessionId: 'session-1',
      commandPreludeLines: {
        new_session: [
          JSON.stringify({ type: 'session', id: 'session-1', cwd: '/work/repo' }),
          JSON.stringify({ type: 'response', id: 'some-other-request', success: true }),
          JSON.stringify(null),
          JSON.stringify({}),
        ],
      },
    })
    const run = dispatch(host)
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)
    const result = await run.result

    expect(result.status).toBe('succeeded')
    expect(events.filter(event => event.kind === 'session.bound')).toHaveLength(1)
    expect(events.some(event => event.kind === 'unknown')).toBe(true)
  })

  it('declines unanswered or unsupported OMP dialogs and preserves unknown events', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      sessionId: 'session-1',
      lines: [
        JSON.stringify({ type: 'available_commands_update', commands: [] }),
        JSON.stringify({ type: 'advisor_cost_changed', cost: 0 }),
        JSON.stringify({ type: 'advisor_yielded' }),
        JSON.stringify({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm' }),
        JSON.stringify({ type: 'extension_ui_request', id: 'select-1', method: 'select', options: ['Always allow', 'Cancel'] }),
        JSON.stringify({ type: 'extension_ui_request', id: 'select-empty-1', method: 'select' }),
        JSON.stringify({ type: 'extension_ui_request', id: 'dialog-1', method: 'input' }),
        JSON.stringify({ type: 'extension_ui_request', id: 'editor-1', method: 'editor' }),
        JSON.stringify({ type: 'extension_ui_request', id: 'ask-1', method: 'ask' }),
        JSON.stringify({ type: 'extension_ui_request', id: 'future-1', method: 'future' }),
        JSON.stringify({ type: 'extension_ui_request', id: 'unknown-method-1' }),
        JSON.stringify({ type: 'extension_ui_request', method: 'confirm' }),
        JSON.stringify({ type: 'future_event', value: 1 }),
      ],
    })
    const run = dispatch(host)
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)
    await run.result

    expect(events.some(event => event.kind === 'warning' && event.message.includes('approval was unavailable'))).toBe(true)
    expect(events.some(event => event.kind === 'warning' && event.message.includes('without explicit one-shot allow and deny choices'))).toBe(true)
    expect(events.some(event => event.kind === 'warning' && event.message.includes('unsupported interactive input'))).toBe(true)
    expect(events.some(event => event.kind === 'warning' && event.message.includes('had no response id'))).toBe(true)
    expect(events.some(event => event.kind === 'unknown' && event.nativeType === 'future_event')).toBe(true)
    expect(host.commands).toContainEqual({ type: 'extension_ui_response', id: 'confirm-1', cancelled: true })
    expect(host.commands).toContainEqual({ type: 'extension_ui_response', id: 'select-1', cancelled: true })
    expect(host.commands).toContainEqual({ type: 'extension_ui_response', id: 'select-empty-1', cancelled: true })
    expect(host.commands).toContainEqual({ type: 'extension_ui_response', id: 'dialog-1', cancelled: true })
    expect(host.commands).toContainEqual({ type: 'extension_ui_response', id: 'editor-1', cancelled: true })
    expect(host.commands).toContainEqual({ type: 'extension_ui_response', id: 'ask-1', cancelled: true })
    expect(host.commands.some(command => command['id'] === 'future-1')).toBe(false)
  })

  it('routes rejected, one-shot, and unavailable approval outcomes through OMP RPC', async () => {
    const longDetail = 'x'.repeat(5_000)
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      sessionId: 'session-1',
      lines: [
        JSON.stringify({ type: 'extension_ui_request', id: 'confirm-denied', method: 'confirm', message: longDetail }),
        JSON.stringify({ type: 'extension_ui_request', id: 'select-allowed', method: 'select', options: ['Allow once', 'Deny'] }),
        JSON.stringify({ type: 'extension_ui_request', id: 'select-cancelled', method: 'select', options: ['Allow once', 'Deny'] }),
      ],
    })
    const outcomes: AgentRunApprovalOutcome[] = ['rejected', 'allowed-once', 'cancelled']
    const approvals: AgentRunApprovalRequest[] = []
    const run = dispatch(host, {
      ...request(),
      requestApproval: async (approval) => {
        approvals.push(approval)
        return outcomes.shift() ?? 'unavailable'
      },
    })
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)
    const result = await run.result

    expect(result.status).toBe('succeeded')
    expect(approvals[0]?.detail).toHaveLength(4_097)
    expect(approvals[0]?.detail?.endsWith('…')).toBe(true)
    expect(host.commands.filter(command => command['type'] === 'extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'confirm-denied', confirmed: false },
      { type: 'extension_ui_response', id: 'select-allowed', value: 'Allow once' },
      { type: 'extension_ui_response', id: 'select-cancelled', cancelled: true },
    ])
    expect(events.some(event => event.kind === 'warning' && event.message.includes('approval was unavailable'))).toBe(true)
  })

  it('logs an approval callback failure and declines the native request', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      sessionId: 'session-1',
      lines: [JSON.stringify({ type: 'extension_ui_request', id: 'confirm-error', method: 'confirm' })],
    })
    const run = dispatch(host, {
      ...request(),
      requestApproval: async () => { throw new Error('approval service failed') },
    })
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)
    await run.result

    expect(host.logs.some(log => log.message.includes('OMP DSH approval failed: approval service failed'))).toBe(true)
    expect(host.commands).toContainEqual({ type: 'extension_ui_response', id: 'confirm-error', cancelled: true })
    expect(events.some(event => event.kind === 'warning' && event.message.includes('approval was unavailable'))).toBe(true)
  })

  it('projects non-record and untyped JSON lines without dropping them', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      sessionId: 'session-1',
      lines: ['null', '{}'],
    })
    const run = dispatch(host)
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)
    const result = await run.result
    expect(result.status).toBe('succeeded')
    expect(events.filter(event => event.kind === 'unknown')).toHaveLength(2)
  })

  it('settles stdout read and stderr read failures visibly', async () => {
    const stdoutHost = new OmpRpcHost({ home: HOME }).scriptRpc({ throwOnRead: 1 })
    const stdoutResult = await dispatch(stdoutHost).result
    expect(stdoutResult).toMatchObject({ status: 'failed', notes: [expect.stringContaining('stdout could not be read')] })

    const stderrHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      stderrError: 'stderr unavailable',
      sessionId: 'session-1',
    })
    const stderrResult = await dispatch(stderrHost).result
    expect(stderrResult.status).toBe('succeeded')
    expect(stderrResult.notes).toEqual(expect.arrayContaining([expect.stringContaining('stderr could not be read')]))
  })

  it('fails loudly when an interactive stdin operation is unavailable', async () => {
    const writeHost = new OmpRpcHost({ home: HOME }).scriptRpc({ omitStdinMethod: 'writeStdin' })
    const writeResult = await dispatch(writeHost).result
    expect(writeResult).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })

    const closeHost = new OmpRpcHost({ home: HOME }).scriptRpc({ omitStdinMethod: 'closeStdin' })
    const closeResult = await dispatch(closeHost).result
    expect(closeResult).toMatchObject({ status: 'cancelled', error: { code: 'run/cancelled' } })
  })

  it('settles local command errors and unknown prompt terminal states', async () => {
    const rejectedHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      commandResponses: { prompt: { success: false, error: 'command rejected' } },
    })
    const rejected = await dispatch(rejectedHost).result
    expect(rejected).toMatchObject({ status: 'failed', error: { message: 'command rejected' } })

    const unknownHost = new OmpRpcHost({ home: HOME }).scriptRpc({ promptResultStatus: 'later' })
    const unknown = await dispatch(unknownHost).result
    expect(unknown).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })
  })

  it('waits for a session-settled frame after a non-terminal prompt result', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      sessionId: 'session-1',
      sessionSettled: false,
    })
    const result = await dispatch(host).result
    expect(result.status).toBe('succeeded')
    expect(result.notes).not.toContain(expect.stringContaining('before omp reported a terminal'))
  })

  it('accepts a settled event that arrives before the prompt result', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      sessionId: 'session-1',
      promptResultSettled: false,
      settledBeforePromptResult: true,
    })
    const result = await dispatch(host).result
    expect(result.status).toBe('succeeded')
  })

  it('omits the prompt result as a protocol error and keeps an unclosed-session note on success', async () => {
    const missingHost = new OmpRpcHost({ home: HOME }).scriptRpc({ omitPromptResult: true })
    const missing = await dispatch(missingHost).result
    expect(missing).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })

    const unsettledHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      sessionId: 'session-1',
      promptResultSettled: false,
    })
    const unsettled = await dispatch(unsettledHost).result
    expect(unsettled.status).toBe('succeeded')
    expect(unsettled.notes).toEqual(expect.arrayContaining([expect.stringContaining('before omp reported a terminal')]))
  })

  it('classifies process timeouts, nonzero exits and signals with bounded stderr', async () => {
    const timeoutHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      exit: { code: null, signal: 'SIGTERM', timedOut: true, cancelled: false },
    })
    const timeout = await dispatch(timeoutHost, { ...request(), timeoutMs: 900 }).result
    expect(timeout).toMatchObject({ status: 'timeout', notes: [expect.stringContaining('killed after 900 ms')] })

    const nonzeroHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      exit: { code: 2, signal: null, timedOut: false, cancelled: false },
      stderr: 'process failed',
    })
    const nonzero = await dispatch(nonzeroHost).result
    expect(nonzero).toMatchObject({ status: 'failed', exitCode: 2, error: { output: 'process failed' } })

    const signalHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      exit: { code: null, signal: 'SIGKILL', timedOut: false, cancelled: false },
    })
    const signal = await dispatch(signalHost).result
    expect(signal).toMatchObject({ status: 'failed', signal: 'SIGKILL', error: { code: 'run/agent-crashed' } })

    const untimedTimeoutHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      exit: { code: null, signal: 'SIGTERM', timedOut: true, cancelled: false },
    })
    const untimedTimeout = await dispatch(untimedTimeoutHost).result
    expect(untimedTimeout).toMatchObject({ status: 'timeout', error: { message: 'the run exceeded its configured budget' } })
  })

  it('falls back when a host reports no exit code or signal', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      exit: { code: null, signal: null, timedOut: false, cancelled: false },
    })
    const result = await dispatch(host).result
    expect(result).toMatchObject({ status: 'failed', error: { code: 'run/start-failed' } })
  })

  it('classifies model errors from OMP events and supplies the final fallback message', async () => {
    const stateErrorHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      omitPromptResult: true,
      lines: [JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'native model failure' },
      })],
    })
    const stateError = await dispatch(stateErrorHost).result
    expect(stateError).toMatchObject({ status: 'failed', error: { message: 'native model failure' } })

    const fallbackHost = new OmpRpcHost({ home: HOME }).scriptRpc({
      promptResultStatus: 'error',
      omitPromptResultError: true,
    })
    const fallback = await dispatch(fallbackHost).result
    expect(fallback).toMatchObject({ status: 'failed', error: { message: 'the assistant response failed' } })
  })

  it('reports a live-session stdout failure as a protocol error', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      sessionId: 'session-1',
      throwOnRead: 5,
    })
    const result = await dispatch(host).result
    expectFailedResult(result, { code: 'run/protocol-error', messageIncludes: 'stdout could not be read' })
  })

  it('cancels when the host cannot close stdin after the prompt', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({ closeStdinError: 'stdin pipe failed' })
    const result = await dispatch(host).result
    expect(result).toMatchObject({ status: 'cancelled', error: { code: 'run/cancelled' } })
    expect(host.processCancellations).toEqual(['OMP RPC stdin could not be closed'])
  })

  it('falls back to process termination when the RPC abort frame cannot be written', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({ holdPrompt: true, writeErrorForType: 'abort' })
    const run = dispatch(host)
    await host.waitForCommand('prompt')
    run.cancel('caller stopped the turn')
    const result = await run.result

    expect(result.status).toBe('cancelled')
    expect(result.notes).toContain('cancelled by the caller: caller stopped the turn')
    expect(result.notes.some(note => note.includes('abort command could not be delivered'))).toBe(true)
    expect(host.processCancellations).toEqual(['OMP RPC abort could not be sent'])
  })

  it('drains after a producer failure and reports both termination and drain errors', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({
      writeErrorForType: 'prompt',
      throwOnRead: 4,
      cancelError: 'termination failed',
    })
    const result = await dispatch(host).result
    expect(result).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })
    expect(host.logs.map(log => log.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('process termination failed: termination failed'),
      expect.stringContaining('stdout drain failed: stdout read failed at 4'),
    ]))
  })

  it('settles resume-store read failures before a child exists', async () => {
    class StoreFailureHost extends OmpRpcHost {
      override async listDir(_path: string): Promise<readonly HostDirEntry[]> {
        throw new Error('store read failed')
      }
    }
    const host = new StoreFailureHost({ home: HOME })
    const result = await dispatch(host, { ...request(), resumeNativeId: 'session-1' }).result
    expect(result).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })
    expect(host.spawns).toEqual([])

    const cancelledHost = new StoreFailureHost({ home: HOME })
    const run = dispatch(cancelledHost, { ...request(), resumeNativeId: 'session-1' })
    run.cancel()
    const cancelled = await run.result
    expect(cancelled).toMatchObject({ status: 'cancelled', notes: [] })
  })

  it('classifies an OMP-aborted prompt as cancelled', async () => {
    const host = new OmpRpcHost({ home: HOME }).scriptRpc({ promptStatus: 'aborted' })
    const result = await dispatch(host).result
    expect(result).toMatchObject({ status: 'cancelled', error: { code: 'run/cancelled' } })
  })
})

function expectFailedResult(
  result: { readonly status: string; readonly error?: { readonly code?: string; readonly message?: string } },
  expected: { readonly code?: string; readonly messageIncludes?: string },
): void {
  expect(result.status).toBe('failed')
  if (result.status !== 'failed' || result.error === undefined) throw new Error('expected a failed run result')
  if (expected.code !== undefined) expect(result.error.code).toBe(expected.code)
  if (expected.messageIncludes !== undefined) expect(result.error.message).toContain(expected.messageIncludes)
}
