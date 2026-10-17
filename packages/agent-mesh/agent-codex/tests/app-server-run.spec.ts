import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentId, AgentRunApprovalRequest, AgentRunEvent, AgentRunId, AgentRunRequest, HostProcess } from '@deepseek-ai/dsh-agent-mesh'
import { asRecord } from '../src/json.ts'
import { startCodexAppServerRun } from '../src/app-server-run.ts'
import { resolveCodexConfig } from '../src/config.ts'
import type { CodexRunContext } from '../src/run.ts'
import { FakeHost, type FakeProcess, type ProcessScript } from './fake-host.ts'

const THREAD = 'thread-codex-1'
const TURN = 'turn-codex-1'

interface WireFrame {
  readonly id?: unknown
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: unknown
}

function context(host: FakeHost, overrides: Parameters<typeof resolveCodexConfig>[0] = {}): CodexRunContext {
  return {
    host,
    config: resolveCodexConfig(overrides),
    agentId: brandString<AgentId>('codex'),
    runId: brandString<AgentRunId>('codex-run-1'),
    resolve: async () => ({
      binary: '/opt/bin/codex',
      home: {
        path: '/home/tester/.codex',
        sessionsRoot: '/home/tester/.codex/sessions',
        archivedRoot: '/home/tester/.codex/archived_sessions',
        indexFile: '/home/tester/.codex/session_index.jsonl',
        credentialFile: '/home/tester/.codex/auth.json',
        fromEnv: false,
      },
    }),
  }
}

function processHost(
  onFrame: (frame: WireFrame, child: FakeProcess) => void,
  options: {
    readonly exitCode?: number
    readonly holdUntilStdinClosed?: boolean
    readonly script?: Omit<ProcessScript, 'onStdin'>
  } = {},
): { readonly host: FakeHost; readonly child: () => FakeProcess | undefined } {
  const host = new FakeHost()
  let process: FakeProcess | undefined
  host.enqueue({
    holdUntilStdinClosed: options.holdUntilStdinClosed ?? true,
    ...(options.script ?? {}),
    ...(options.exitCode === undefined ? {} : { exit: { code: options.exitCode, signal: null, timedOut: false, cancelled: false } }),
    onStdin(data, spawned) {
      process = spawned
      if (data.trim() === '') return
      for (const line of data.trim().split('\n')) {
        const frame = asRecord(JSON.parse(line)) ?? {}
        onFrame(frame, spawned)
      }
    },
  })
  return { host, child: () => process }
}

/** A host whose child omits one required interactive operation. */
function withoutInteractiveOperation(host: FakeHost, operation: 'write' | 'close'): void {
  const spawn = host.spawn.bind(host)
  host.spawn = (spec) => {
    const child = spawn(spec)
    const process: HostProcess = {
      lines: child.lines,
      stderr: () => child.stderr(),
      exit: child.exit,
      cancel: (reason) =>{  child.cancel(reason) },
      ...(operation === 'write' ? {} : { writeStdin: data => child.writeStdin?.(data) }),
      ...(operation === 'close' ? {} : { closeStdin: () => child.closeStdin?.() }),
    }
    return process
  }
}

function send(child: FakeProcess, value: object): void {
  child.sendLine(JSON.stringify(value))
}

function completeTurn(child: FakeProcess, status: 'completed' | 'interrupted' | 'failed' = 'completed'): void {
  send(child, {
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: {
      threadId: THREAD,
      turn: {
        id: TURN,
        status,
        ...(status === 'failed' ? { error: { message: 'Codex returned a product error' } } : {}),
        usage: { input_tokens: 12, output_tokens: 7, cached_input_tokens: 3 },
      },
    },
  })
}

function defaultFrameHandler(frame: WireFrame, child: FakeProcess): void {
  if (frame.method === 'initialized') return
  if (frame.method === 'initialize') {
    send(child, { jsonrpc: '2.0', id: frame.id, result: { protocolVersion: '2025-03-26' } })
    return
  }
  if (frame.method === 'thread/start') {
    send(child, { jsonrpc: '2.0', id: frame.id, result: { thread: { id: THREAD, ephemeral: false } } })
    return
  }
  if (frame.method === 'thread/resume') {
    send(child, { jsonrpc: '2.0', id: frame.id, result: { thread: { id: THREAD, ephemeral: false } } })
    return
  }
  if (frame.method === 'turn/start') {
    send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
    send(child, { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, delta: 'hello' } })
    send(child, { jsonrpc: '2.0', method: 'item/started', params: { threadId: THREAD, turnId: TURN, item: { id: 'msg-1', type: 'agentMessage', text: 'hello' } } })
    send(child, { jsonrpc: '2.0', method: 'item/completed', params: { threadId: THREAD, turnId: TURN, item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text: 'hello world' } } })
    completeTurn(child)
    return
  }
  if (frame.method === 'turn/interrupt') {
    send(child, { jsonrpc: '2.0', id: frame.id, result: {} })
    completeTurn(child, 'interrupted')
    return
  }
  if (frame.method === undefined && frame.id !== undefined) return
  throw new Error(`unexpected test frame ${JSON.stringify(frame)}`)
}

async function collect(
  run: ReturnType<typeof startCodexAppServerRun>,
): Promise<{ readonly events: AgentRunEvent[]; readonly result: Awaited<typeof run.result> }> {
  const events: AgentRunEvent[] = []
  for await (const event of run) events.push(event)
  return { events, result: await run.result }
}

describe('Codex native app-server run', () => {
  it('initializes a persistent thread and projects streamed messages, usage and terminal result', async () => {
    const { host, child } = processHost(defaultFrameHandler)
    const { events, result } = await collect(startCodexAppServerRun(context(host), { prompt: 'fix the bug', cwd: '/repo' }))

    expect(host.spawns).toHaveLength(1)
    expect(host.spawns[0]?.spec).toMatchObject({
      command: '/opt/bin/codex',
      args: ['app-server', '--stdio'],
      cwd: '/repo',
      interactive: true,
      env: { CODEX_HOME: '/home/tester/.codex' },
    })
    expect(child()?.spec.interactive).toBe(true)
    expect(result).toMatchObject({
      status: 'succeeded',
      finalText: 'hello world',
      nativeSessionKey: 'codex:thread-codex-1',
      usage: { inputTokens: 12, outputTokens: 7, cachedInputTokens: 3, totalTokens: 19 },
    })
    expect(events.map(event => event.kind)).toEqual([
      'run.started', 'session.bound', 'message.delta', 'message.completed', 'usage.updated', 'run.finished',
    ])
  })

  it('cancels before startup and after spawn but before the protocol handshake', async () => {
    const host = new FakeHost()
    const deferredContext = context(host)
    let release!: (value: Awaited<ReturnType<CodexRunContext['resolve']>>) => void
    const resolved = new Promise<Awaited<ReturnType<CodexRunContext['resolve']>>>((resolve) => { release = resolve })
    const waiting = startCodexAppServerRun({ ...deferredContext, resolve: () => resolved }, { prompt: 'stop', cwd: '/repo' })
    waiting.cancel()
    release(await deferredContext.resolve())
    const waitingResult = await waiting.result
    expect(waitingResult.status).toBe('cancelled')
    expect(host.spawns).toHaveLength(0)

    const spawned = new FakeHost()
    spawned.enqueue({ holdUntilCancelled: true })
    const spawnedRun: { current?: ReturnType<typeof startCodexAppServerRun> } = {}
    spawned.beforeSpawn = () => spawnedRun.current?.cancel('before handshake')
    const run = startCodexAppServerRun(context(spawned), { prompt: 'stop', cwd: '/repo' })
    spawnedRun.current = run
    const spawnedResult = await run.result
    expect(spawnedResult.status).toBe('cancelled')
    expect(spawned.spawns[0]?.process.cancelled).toBe(true)

    const handshakeRunState: { current?: ReturnType<typeof startCodexAppServerRun> } = {}
    const handshake = processHost((frame, child) => {
      if (frame.method === 'initialize') {
        handshakeRunState.current?.cancel('during handshake')
        send(child, { jsonrpc: '2.0', id: frame.id, result: {} })
      }
    })
    const handshakeRun = startCodexAppServerRun(context(handshake.host), { prompt: 'stop', cwd: '/repo' })
    handshakeRunState.current = handshakeRun
    const handshakeResult = await handshakeRun.result
    handshakeRun.cancel('after completion')
    expect(handshakeResult.status).toBe('cancelled')
    expect(handshake.host.spawns[0]?.process.cancelled).toBe(true)
  })

  it('does not send an interrupt after the turn is terminal or the protocol is closed', async () => {
    const terminal = processHost(defaultFrameHandler, { script: { holdUntilCancelled: true, holdUntilStdinClosed: false } })
    const run = startCodexAppServerRun(context(terminal.host), { prompt: 'finish', cwd: '/repo' })
    for await (const event of run) {
      if (event.kind === 'usage.updated') {
        run.cancel('after terminal')
        run.cancel('repeat')
      }
    }
    const result = await run.result
    expect(result.status).toBe('cancelled')
    expect(result.notes).toContain('cancelled by the caller: after terminal')

    const closed = processHost(defaultFrameHandler, { script: { holdUntilCancelled: true, holdUntilStdinClosed: false } })
    const closedRunState: { current?: ReturnType<typeof startCodexAppServerRun> } = {}
    const spawn = closed.host.spawn.bind(closed.host)
    closed.host.spawn = (spec) => {
      const child = spawn(spec)
      const process: HostProcess = {
        lines: child.lines,
        stderr: () => child.stderr(),
        get exit() {
          setImmediate(() => closedRunState.current?.cancel('while exit is pending'))
          return child.exit
        },
        cancel: (reason) =>{  child.cancel(reason) },
        writeStdin: data => child.writeStdin?.(data),
        closeStdin: () => child.closeStdin?.(),
      }
      return process
    }
    const closedRun = startCodexAppServerRun(context(closed.host), { prompt: 'finish', cwd: '/repo' })
    closedRunState.current = closedRun
    const closedResult = await closedRun.result
    expect(closedResult.status).toBe('cancelled')
    expect(closed.host.spawns[0]?.process.cancelled).toBe(true)
  })

  it('fails closed when a host omits either interactive stdin operation', async () => {
    for (const operation of ['write', 'close'] as const) {
      const host = new FakeHost()
      host.enqueue({})
      withoutInteractiveOperation(host, operation)
      const result = await startCodexAppServerRun(context(host), { prompt: 'x', cwd: '/repo' }).result
      expect(result).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })
      expect(host.spawns).toHaveLength(1)
    }
  })

  it('resumes the supplied native thread and forwards run options to the official protocol', async () => {
    const requests: WireFrame[] = []
    const handler = (frame: WireFrame, child: FakeProcess): void => {
      requests.push(frame)
      defaultFrameHandler(frame, child)
    }
    const { host } = processHost(handler)
    const run = startCodexAppServerRun(context(host, { model: 'gpt-5-codex', sandbox: 'workspace-write', approval: 'on-request' }), {
      prompt: 'continue', cwd: '/repo', resumeNativeId: THREAD, model: 'gpt-5.5', timeoutMs: 5_000,
      env: { CODEX_HOME: '/other/codex', CODEX_ACCESS_TOKEN: 'token' },
    })
    const { result } = await collect(run)

    expect(result.status).toBe('succeeded')
    expect(requests.find(frame => frame.method === 'thread/resume')?.params).toEqual({
      threadId: THREAD,
      cwd: '/repo',
      model: 'gpt-5.5',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    expect(host.spawns[0]?.spec.timeoutMs).toBe(5_000)
    expect(host.spawns[0]?.spec.env).toMatchObject({ CODEX_HOME: '/home/tester/.codex', CODEX_ACCESS_TOKEN: 'token' })
  })

  it('uses configured model, policies, and timeout when the request omits them', async () => {
    const requests: WireFrame[] = []
    const { host } = processHost((frame, child) => {
      requests.push(frame)
      defaultFrameHandler(frame, child)
    })
    const result = await startCodexAppServerRun(context(host, {
      model: 'gpt-5-codex', sandbox: 'read-only', approval: 'never', timeoutMs: 2_000,
    }), { prompt: 'configured', cwd: '/repo' }).result
    expect(result.status).toBe('succeeded')
    expect(host.spawns[0]?.spec.timeoutMs).toBe(2_000)
    expect(requests.find(frame => frame.method === 'thread/start')?.params).toMatchObject({
      model: 'gpt-5-codex', sandbox: 'read-only', approvalPolicy: 'never',
    })
  })

  it('routes a command request to the one-shot DSH approval callback', async () => {
    let requestSeen: AgentRunApprovalRequest | undefined
    let decision: unknown
    const { host, child: getChild } = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        send(child, {
          jsonrpc: '2.0',
          id: 'approval-1',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: THREAD,
            turnId: TURN,
            command: 'npm run build',
            cwd: '/repo',
            reason: 'The build is required for the requested change.',
            availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
          },
        })
        return
      }
      if (frame.method === undefined && frame.id === 'approval-1') {
        decision = asRecord(frame.result)?.decision
        completeTurn(child)
        return
      }
      defaultFrameHandler(frame, child)
    })
    const request: AgentRunRequest = {
      prompt: 'build it', cwd: '/repo',
      requestApproval: async (value) => {
        requestSeen = value
        expect(value.signal).toBeInstanceOf(AbortSignal)
        return 'allowed-once'
      },
    }
    const { result } = await collect(startCodexAppServerRun(context(host), request))

    expect(decision).toBe('accept')
    expect(requestSeen?.signal.aborted).toBe(true)
    expect(requestSeen).toMatchObject({
      kind: 'command',
      title: 'Codex command approval',
      detail: 'Command: npm run build\nDirectory: /repo\nReason: The build is required for the requested change.',
    })
    expect(result.status).toBe('succeeded')
    expect(getChild()?.cancelled).toBe(false)
  })

  it('never turns a one-shot grant into a session grant', async () => {
    const decisions: unknown[] = []
    const { host } = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        send(child, {
          jsonrpc: '2.0', id: 'approval-file',
          method: 'item/fileChange/requestApproval',
          params: { threadId: THREAD, turnId: TURN, grantRoot: '/repo', availableDecisions: ['acceptForSession', 'decline'] },
        })
        return
      }
      if (frame.method === undefined && frame.id !== undefined) {
        decisions.push(asRecord(frame.result)?.decision)
        if (decisions.length === 1) completeTurn(child)
        return
      }
      defaultFrameHandler(frame, child)
    })
    let callbackCount = 0
    const request: AgentRunRequest = {
      prompt: 'edit files', cwd: '/repo',
      requestApproval: async () => {
        callbackCount += 1
        return 'allowed-once'
      },
    }
    const run = startCodexAppServerRun(context(host), request)
    const { result } = await collect(run)

    expect(decisions).toEqual(['decline'])
    expect(callbackCount).toBe(1)
    expect(result.status).toBe('succeeded')
    expect(result.notes).toContain('Codex file change approval was declined after the DSH approval outcome "allowed-once".')
  })

  it('fails a native request closed when DSH approval is unavailable', async () => {
    let decision: unknown
    const { host } = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        send(child, {
          jsonrpc: '2.0', id: 'approval-no-answer', method: 'item/commandExecution/requestApproval',
          params: { threadId: THREAD, turnId: TURN, command: 'rm -rf target', availableDecisions: ['accept', 'decline'] },
        })
        return
      }
      if (frame.method === undefined && frame.id === 'approval-no-answer') {
        decision = asRecord(frame.result)?.decision
        completeTurn(child)
        return
      }
      defaultFrameHandler(frame, child)
    })
    const { result } = await collect(startCodexAppServerRun(context(host), { prompt: 'clean', cwd: '/repo' }))
    expect(decision).toBe('decline')
    expect(result.status).toBe('succeeded')
    expect(result.notes).toContain('Codex command approval was declined after the DSH approval outcome "unavailable".')
  })

  it('chooses only native one-shot approval decisions and formats requests without detail fields', async () => {
    const decisions: unknown[] = []
    let requestDetail = ''
    let approvalCall = 0
    const { host } = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        for (const [id, availableDecisions] of [
          ['cancel', ['accept', 'cancel']],
          ['fallback-cancel', ['cancel']],
          ['empty', null],
        ] as const) {
          send(child, {
            jsonrpc: '2.0', id, method: 'item/fileChange/requestApproval',
            params: { threadId: THREAD, turnId: TURN, availableDecisions },
          })
        }
        return
      }
      if (frame.method === undefined && frame.id !== undefined) {
        decisions.push(asRecord(frame.result)?.decision)
        if (decisions.length === 3) completeTurn(child)
        return
      }
      defaultFrameHandler(frame, child)
    })
    const result = await startCodexAppServerRun(context(host), {
      prompt: 'review', cwd: '/repo',
      requestApproval: async (request) => {
        requestDetail = request.detail
        approvalCall += 1
        return approvalCall === 1 ? 'cancelled' : 'unavailable'
      },
    }).result
    expect(decisions).toEqual(['cancel', 'cancel', 'decline'])
    expect(requestDetail).toContain('"threadId":"thread-codex-1"')
    expect(result.status).toBe('succeeded')
    expect(result.notes).toContain('Codex file change approval was declined after the DSH approval outcome "cancelled".')
  })

  it('fails a native approval when the server offers no safe one-shot choice', async () => {
    const { host } = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        send(child, {
          jsonrpc: '2.0', id: 'unsafe-choice', method: 'item/commandExecution/requestApproval',
          params: { threadId: THREAD, turnId: TURN, availableDecisions: ['acceptForSession'] },
        })
        return
      }
      defaultFrameHandler(frame, child)
    })
    const result = await startCodexAppServerRun(context(host), {
      prompt: 'review', cwd: '/repo', requestApproval: async () => 'allowed-once',
    }).result
    expect(result).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })
    expect(result.notes.join('\n')).toContain('no safe one-shot approval decision')
  })

  it('rejects an approval whose provisional turn changes before its answer returns', async () => {
    let release!: () => void
    const approval = new Promise<void>((resolve) => { release = resolve })
    const { host } = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, {
          jsonrpc: '2.0', id: 'early-approval', method: 'item/commandExecution/requestApproval',
          params: { threadId: THREAD, turnId: TURN, availableDecisions: ['accept', 'decline'] },
        })
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        setImmediate(release)
        return
      }
      defaultFrameHandler(frame, child)
    })
    const result = await startCodexAppServerRun(context(host), {
      prompt: 'review', cwd: '/repo', requestApproval: async () => { await approval; return 'allowed-once' },
    }).result
    expect(result).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })
    expect(result.notes.join('\n')).toContain('approval turn committed unexpectedly')
  })

  it('declines interactive input, additional permission, and MCP elicitation requests', async () => {
    const responses: unknown[] = []
    const { host } = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        for (const [id, method, params] of [
          ['permissions', 'item/permissions/requestApproval', { permissions: { network: true } }],
          ['input', 'item/tool/requestUserInput', { questions: [] }],
          ['elicitation', 'mcpServer/elicitation/request', { turnId: null, message: 'Need input.' }],
        ] as const) {
          send(child, { jsonrpc: '2.0', id, method, params: { threadId: THREAD, turnId: TURN, ...params } })
        }
        return
      }
      if (frame.method === undefined && frame.id !== undefined) {
        responses.push(frame.result)
        if (responses.length === 3) completeTurn(child)
        return
      }
      defaultFrameHandler(frame, child)
    })
    const { result } = await collect(startCodexAppServerRun(context(host), { prompt: 'ask', cwd: '/repo' }))
    expect(responses).toEqual([
      { permissions: {}, scope: 'turn' },
      { answers: {} },
      { action: 'decline', content: null, _meta: null },
    ])
    expect(result.status).toBe('succeeded')
    expect(result.notes).toEqual([
      'Codex requested additional turn permissions; DSH granted none.',
      'Codex requested interactive input; DSH returned no answers.',
      'Codex requested interactive MCP input; DSH declined the elicitation.',
    ])
  })

  it('rejects server requests that name another thread or active turn', async () => {
    for (const params of [
      { threadId: 'other-thread', turnId: TURN },
      { threadId: THREAD, turnId: 'other-turn' },
    ]) {
      const host = processHost((frame, child) => {
        if (frame.method === 'turn/start') {
          send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
          setImmediate(() =>{  send(child, { jsonrpc: '2.0', id: 'bad-request', method: 'item/permissions/requestApproval', params }) })
        } else defaultFrameHandler(frame, child)
      })
      const result = await startCodexAppServerRun(context(host.host), { prompt: 'reject', cwd: '/repo' }).result
      expect(result.status).toBe('failed')
    }
  })

  it('waits for a pending native approval before completing the run', async () => {
    let approvalStarted!: () => void
    const started = new Promise<void>((resolve) => { approvalStarted = resolve })
    let closeSeen!: () => void
    const closed = new Promise<void>((resolve) => { closeSeen = resolve })
    let releaseApproval!: () => void
    const approval = new Promise<void>((resolve) => { releaseApproval = resolve })
    const scripted = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        setImmediate(() =>{  send(child, {
          jsonrpc: '2.0', id: 'pending-approval', method: 'item/commandExecution/requestApproval',
          params: { threadId: THREAD, turnId: TURN, availableDecisions: ['accept', 'decline'] },
        }) })
      } else defaultFrameHandler(frame, child)
    })
    const spawn = scripted.host.spawn.bind(scripted.host)
    scripted.host.spawn = (spec) => {
      const child = spawn(spec)
      return {
        lines: child.lines,
        stderr: () => child.stderr(),
        exit: child.exit,
        cancel: (reason) =>{  child.cancel(reason) },
        writeStdin: data => child.writeStdin?.(data),
        closeStdin() {
          child.closeStdin?.()
          closeSeen()
        },
      }
    }
    const run = startCodexAppServerRun(context(scripted.host), {
      prompt: 'approve', cwd: '/repo',
      requestApproval: async () => {
        approvalStarted()
        await approval
        return 'allowed-once'
      },
    })
    await started
    completeTurn(scripted.child()!)
    await closed
    scripted.child()!.endOutput()
    await new Promise<void>(resolve => setImmediate(resolve))
    releaseApproval()
    expect((await run.result).status).toBe('succeeded')
  })

  it('uses the native interrupt request and reports an interrupted turn as cancelled', async () => {
    let turnStarted!: () => void
    const started = new Promise<void>((resolve) => { turnStarted = resolve })
    let childProcess: FakeProcess | undefined
    const { host } = processHost((frame, child) => {
      childProcess = child
      if (frame.method === 'initialize') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: {} })
        return
      }
      if (frame.method === 'thread/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { thread: { id: THREAD } } })
        return
      }
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        turnStarted()
        return
      }
      defaultFrameHandler(frame, child)
    })
    const run = startCodexAppServerRun(context(host), { prompt: 'long work', cwd: '/repo' })
    await started
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    run.cancel('stop now')
    const result = await run.result

    expect(result.status).toBe('cancelled')
    expect(result.notes).toContain('cancelled by the caller: stop now')
    expect(childProcess?.cancelled).toBe(false)
  })

  it('terminates the process after the configured interrupt grace period', async () => {
    let turnStarted!: () => void
    const started = new Promise<void>((resolve) => { turnStarted = resolve })
    let childProcess: FakeProcess | undefined
    const { host } = processHost((frame, child) => {
      childProcess = child
      if (frame.method === 'initialize') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: {} })
      } else if (frame.method === 'thread/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { thread: { id: THREAD } } })
      } else if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        turnStarted()
      } else if (frame.method === 'turn/interrupt') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: {} })
      }
    })
    const run = startCodexAppServerRun(context(host, { interruptGraceMs: 1 }), { prompt: 'hang', cwd: '/repo' })
    await started
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    run.cancel('stop after grace')
    const result = await run.result

    expect(result.status).toBe('cancelled')
    expect(childProcess?.cancelled).toBe(true)
    expect(result.notes).toContain('Codex did not finish the interrupted turn before the configured grace period; the managed process was terminated.')
  })

  it('classifies forced cancellation even when the host reports a normal exit', async () => {
    let turnStarted!: () => void
    const started = new Promise<void>((resolve) => { turnStarted = resolve })
    const scripted = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        turnStarted()
      } else if (frame.method === 'turn/interrupt') {
        return
      } else {
        defaultFrameHandler(frame, child)
      }
    }, { script: { holdUntilCancelled: true, holdUntilStdinClosed: false } })
    const spawn = scripted.host.spawn.bind(scripted.host)
    scripted.host.spawn = (spec) => {
      const child = spawn(spec)
      let releaseExit!: (exit: { code: number | null; signal: string | null; timedOut: boolean; cancelled: boolean }) => void
      const exit = new Promise<{ code: number | null; signal: string | null; timedOut: boolean; cancelled: boolean }>(
        (resolve) => { releaseExit = resolve },
      )
      return {
        lines: child.lines,
        stderr: () => child.stderr(),
        exit,
        cancel(reason) {
          child.cancel(reason)
          releaseExit({ code: 0, signal: null, timedOut: false, cancelled: false })
        },
        writeStdin: data => child.writeStdin?.(data),
        closeStdin: () => child.closeStdin?.(),
      }
    }
    const run = startCodexAppServerRun(context(scripted.host, { interruptGraceMs: 1 }), { prompt: 'hang', cwd: '/repo' })
    await started
    run.cancel('force stop')
    const result = await run.result
    expect(result.status).toBe('cancelled')
    expect(result.notes).toContain('Codex did not finish the interrupted turn before the configured grace period; the managed process was terminated.')
  })

  it('retains notifications that arrive before the turn/start response', async () => {
    const { host } = processHost((frame, child) => {
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } })
      send(child, { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, delta: 'early' } })
      completeTurn(child)
      send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
    })
    const { events, result } = await collect(startCodexAppServerRun(context(host), { prompt: 'early', cwd: '/repo' }))
    expect(result.status).toBe('succeeded')
    expect(events.some(event => event.kind === 'message.delta' && event.text === 'early')).toBe(true)
  })

  it('fails when stdout closes before the terminal turn notification', async () => {
    const prematureEnd = processHost((frame, child) => {
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
      child.endOutput()
    })
    const result = await startCodexAppServerRun(context(prematureEnd.host), { prompt: 'close early', cwd: '/repo' }).result
    expect(result.status).toBe('failed')
    expect(result.notes.join('\n')).toContain('protocol stream closed before turn/completed')
  })

  it('ignores unrelated notifications, emits unknown native items, and tolerates missing usage', async () => {
    const { host } = processHost((frame, child) => {
      if (frame.method === 'thread/start') {
        send(child, { jsonrpc: '2.0', method: 'turn/started', params: { threadId: THREAD, turn: { id: 'too-early' } } })
        defaultFrameHandler(frame, child); return
      }
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
      send(child, { jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'other-thread', turn: { id: TURN } } })
      send(child, { jsonrpc: '2.0', method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } })
      send(child, { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'other-thread', turnId: TURN, delta: 'ignored' } })
      send(child, { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: 'other-turn', delta: 'ignored' } })
      send(child, { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN } })
      send(child, { jsonrpc: '2.0', method: 'turn/diff/updated', params: { threadId: THREAD, turnId: TURN } })
      send(child, { jsonrpc: '2.0', method: 'item/commandExecution/outputDelta', params: { threadId: THREAD, turnId: TURN } })
      send(child, { jsonrpc: '2.0', method: 'item/started', params: { threadId: THREAD, turnId: TURN, item: { id: 'message', type: 'agentMessage', text: 'ignored start' } } })
      send(child, { jsonrpc: '2.0', method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN } } })
      send(child, { jsonrpc: '2.0', method: 'item/updated', params: { threadId: THREAD, turnId: TURN, item: { id: 'native', type: 'futureWidget' } } })
      send(child, { jsonrpc: '2.0', method: 'custom/notification', params: { threadId: THREAD, turnId: TURN, detail: 'future' } })
      send(child, { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } } })
    })
    const { events, result } = await collect(startCodexAppServerRun(context(host), { prompt: 'events', cwd: '/repo' }))
    expect(result.status).toBe('succeeded')
    expect(events.filter(event => event.kind === 'unknown').map(event => event.kind === 'unknown' ? event.nativeType : ''))
      .toEqual(['item.futureWidget', 'custom/notification'])
    expect(result.notes.join('\n')).toContain('futureWidget')
    expect(events.some(event => event.kind === 'message.delta' && event.text === 'ignored')).toBe(false)
  })

  it('turns a final clock failure into a failed run and logs the producer error', async () => {
    const scripted = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        send(child, { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } } })
      } else defaultFrameHandler(frame, child)
    })
    const host = scripted.host
    let stdinClosed = false
    const spawn = host.spawn.bind(host)
    host.spawn = (spec) => {
      const child = spawn(spec)
      return {
        lines: child.lines,
        stderr: () => child.stderr(),
        exit: child.exit,
        cancel: (reason) =>{  child.cancel(reason) },
        writeStdin: data => child.writeStdin?.(data),
        closeStdin() {
          child.closeStdin?.()
          stdinClosed = true
        },
      }
    }
    const now = host.now.bind(host)
    host.now = () => {
      if (stdinClosed) {
        stdinClosed = false
        throw new Error('clock failed while building the result')
      }
      return now()
    }
    const result = await startCodexAppServerRun(context(host), { prompt: 'finish', cwd: '/repo' }).result
    expect(result).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error', message: 'the app-server producer failed' } })
    expect(host.logs).toContainEqual({ level: 'warn', message: 'codex app-server run producer failed: clock failed while building the result' })
  })

  it('normalizes a non-Error producer failure before a native thread exists', async () => {
    const host = new FakeHost()
    const now = host.now.bind(host)
    let calls = 0
    host.now = () => {
      calls += 1
      if (calls === 2) throw 'clock failed before thread binding'
      return now()
    }
    const result = await startCodexAppServerRun({
      ...context(host),
      resolve: async () => { throw 'configuration lookup failed' },
    }, { prompt: 'fail', cwd: '/repo' }).result
    expect(result).toMatchObject({ status: 'failed', error: { code: 'run/protocol-error', message: 'the app-server producer failed' } })
    expect(host.logs).toContainEqual({ level: 'warn', message: 'codex app-server run producer failed: clock failed before thread binding' })
  })

  it('normalizes a non-Error exception from a native notification handler', async () => {
    const scripted = processHost((frame, child) => {
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
      send(child, { jsonrpc: '2.0', method: 'custom/notification', params: { threadId: THREAD, turnId: TURN } })
    })
    const now = scripted.host.now.bind(scripted.host)
    let calls = 0
    scripted.host.now = () => {
      calls += 1
      if (calls === 3) throw 'notification clock failed'
      return now()
    }
    const result = await startCodexAppServerRun(context(scripted.host), { prompt: 'notify', cwd: '/repo' }).result
    expect(result.status).toBe('failed')
    expect(result.notes.join('\n')).toContain('notification clock failed')
  })

  it('normalizes a non-Error approval callback failure', async () => {
    const scripted = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        setImmediate(() =>{  send(child, {
          jsonrpc: '2.0', id: 'bad-approval', method: 'item/commandExecution/requestApproval',
          params: { threadId: THREAD, turnId: TURN, availableDecisions: ['accept', 'decline'] },
        }) })
      } else defaultFrameHandler(frame, child)
    })
    const result = await startCodexAppServerRun(context(scripted.host), {
      prompt: 'approve', cwd: '/repo', requestApproval: async () => { throw 'approval callback failed' },
    }).result
    expect(result.status).toBe('failed')
    expect(result.notes.join('\n')).toContain('approval callback failed')
  })

  it('accepts stream end after a terminal notification', async () => {
    const scripted = processHost((frame, child) => {
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
      completeTurn(child)
      child.endOutput()
    })
    const result = await startCodexAppServerRun(context(scripted.host), { prompt: 'finish', cwd: '/repo' }).result
    expect(result.status).toBe('succeeded')
  })

  it('classifies failed turns and nonzero process exits', async () => {
    const failed = processHost((frame, child) => {
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
      completeTurn(child, 'failed')
    })
    const failedResult = await startCodexAppServerRun(context(failed.host), { prompt: 'fail', cwd: '/repo' }).result
    expect(failedResult).toMatchObject({ status: 'failed', error: { code: 'run/agent-failed', message: 'Codex returned a product error' } })

    const crashed = processHost(defaultFrameHandler, { exitCode: 7 })
    const crashedResult = await startCodexAppServerRun(context(crashed.host), { prompt: 'crash', cwd: '/repo' }).result
    expect(crashedResult).toMatchObject({ status: 'failed', error: { code: 'run/agent-crashed' } })

    const failedWithoutMessage = processHost((frame, child) => {
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
      send(child, { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'failed' } } })
    }, { script: { stderr: 'Codex failure output' } })
    expect(await startCodexAppServerRun(context(failedWithoutMessage.host), { prompt: 'fail', cwd: '/repo' }).result)
      .toMatchObject({ status: 'failed', error: { code: 'run/agent-failed', message: 'Codex reported a failed turn', output: 'Codex failure output' } })
  })

  it('classifies timeout, stream-write, stdin-close, stderr, and exit failures', async () => {
    const timedOut = processHost(defaultFrameHandler, {
      script: {
        exit: { code: 124, signal: null, timedOut: true, cancelled: false },
        stderr: '\n wall clock expired \n',
      },
    })
    const timeoutResult = await startCodexAppServerRun(context(timedOut.host), { prompt: 'wait', cwd: '/repo' }).result
    expect(timeoutResult).toMatchObject({ status: 'timeout', error: { code: 'run/timeout', output: 'wall clock expired' } })

    const timedOutBeforeThread = processHost((frame, child) => {
      if (frame.method === 'initialize') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: {} })
        child.endOutput()
      }
    }, { script: { holdUntilStdinClosed: false, exit: { code: 124, signal: null, timedOut: true, cancelled: false } } })
    expect(await startCodexAppServerRun(context(timedOutBeforeThread.host), { prompt: 'wait', cwd: '/repo' }).result)
      .toMatchObject({ status: 'timeout', error: { code: 'run/timeout' } })

    const writeFailure = processHost(defaultFrameHandler, { script: { writeFailure: 'stdin pipe failed' } })
    const writeResult = await startCodexAppServerRun(context(writeFailure.host), { prompt: 'write', cwd: '/repo' }).result
    expect(writeResult.error?.message).toBe('the Codex app-server turn did not complete')
    expect(writeResult.notes.join('\n')).toContain('stdin pipe failed')

    const writeError = processHost(defaultFrameHandler, { script: { writeFailure: new Error('stdin error') } })
    expect((await startCodexAppServerRun(context(writeError.host), { prompt: 'write', cwd: '/repo' }).result).status).toBe('failed')

    const closeFailure = processHost(defaultFrameHandler, { script: { closeFailure: 'close failed' } })
    const closeResult = await startCodexAppServerRun(context(closeFailure.host), { prompt: 'close', cwd: '/repo' }).result
    expect(closeResult.notes.join('\n')).toContain('Codex stdin could not be closed: close failed')

    const closeError = processHost(defaultFrameHandler, { script: { closeFailure: new Error('close error') } })
    expect((await startCodexAppServerRun(context(closeError.host), { prompt: 'close', cwd: '/repo' }).result).notes.join('\n'))
      .toContain('Codex stdin could not be closed: close error')

    const stderrFailure = processHost(defaultFrameHandler, { script: { stderrFailure: new Error('stderr failed') } })
    const stderrResult = await startCodexAppServerRun(context(stderrFailure.host), { prompt: 'stderr', cwd: '/repo' }).result
    expect(stderrResult.notes.join('\n')).toContain('stderr could not be read: stderr failed')

    const stderrString = processHost(defaultFrameHandler, { script: { stderrFailure: 'stderr offline' } })
    expect((await startCodexAppServerRun(context(stderrString.host), { prompt: 'stderr', cwd: '/repo' }).result).notes.join('\n'))
      .toContain('stderr could not be read: stderr offline')

    const exitFailure = processHost(defaultFrameHandler, { script: { exitFailure: 'exit unavailable' } })
    const exitResult = await startCodexAppServerRun(context(exitFailure.host), { prompt: 'exit', cwd: '/repo' }).result
    expect(exitResult.notes.join('\n')).toContain('the app-server exit could not be observed: exit unavailable')

    const exitError = processHost(defaultFrameHandler, { script: { exitFailure: new Error('exit failed') } })
    expect((await startCodexAppServerRun(context(exitError.host), { prompt: 'exit', cwd: '/repo' }).result).notes.join('\n'))
      .toContain('the app-server exit could not be observed: exit failed')
  })

  it('reports a terminal interruption that the caller did not request', async () => {
    const interrupted = processHost((frame, child) => {
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
      completeTurn(child, 'interrupted')
    })
    const result = await startCodexAppServerRun(context(interrupted.host), { prompt: 'interrupted', cwd: '/repo' }).result
    expect(result).toMatchObject({ status: 'failed', error: { code: 'run/interrupted', message: 'Codex interrupted the turn' } })
  })

  it('classifies missing binaries, invalid policies, unsupported stdin, malformed responses and unknown requests', async () => {
    const missingHost = new FakeHost()
    const missing = await startCodexAppServerRun({
      ...context(missingHost), resolve: async () => ({ ...await context(missingHost).resolve(), binary: undefined }),
    }, { prompt: 'x', cwd: '/repo' }).result
    expect(missing.error?.code).toBe('detection/not-found')

    const invalidSandbox = await startCodexAppServerRun(context(new FakeHost()), { prompt: 'x', cwd: '/repo', sandbox: 'yolo' }).result
    expect(invalidSandbox.error?.code).toBe('schema/invalid')
    const invalidApproval = await startCodexAppServerRun(context(new FakeHost()), { prompt: 'x', cwd: '/repo', approval: 'always' }).result
    expect(invalidApproval.error?.code).toBe('schema/invalid')

    const malformed = processHost((frame, child) => {
      if (frame.method === 'initialize') send(child, { jsonrpc: '2.0', id: frame.id, result: null })
    })
    const malformedResult = await startCodexAppServerRun(context(malformed.host), { prompt: 'x', cwd: '/repo' }).result
    expect(malformedResult.error?.code).toBe('run/protocol-error')

    const unknown = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: 'unsupported', method: 'unknown/request', params: {} })
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
      } else defaultFrameHandler(frame, child)
    })
    const unknownResult = await startCodexAppServerRun(context(unknown.host), { prompt: 'x', cwd: '/repo' }).result
    expect(unknownResult.error?.code).toBe('run/protocol-error')

    const rejectedResolve = await startCodexAppServerRun({
      ...context(new FakeHost()),
      resolve: async () => { throw 'configuration lookup failed' },
    }, { prompt: 'x', cwd: '/repo' }).result
    expect(rejectedResolve.notes.join('\n')).toContain('configuration lookup failed')
  })

  it('routes a failing turn interrupt through the protocol error path', async () => {
    let turnStarted!: () => void
    const started = new Promise<void>((resolve) => { turnStarted = resolve })
    const { host } = processHost((frame, child) => {
      if (frame.method === 'initialize') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: {} })
      } else if (frame.method === 'thread/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { thread: { id: THREAD } } })
      } else if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
        turnStarted()
      } else if (frame.method === 'turn/interrupt') {
        throw new Error('interrupt write failed')
      } else {
        defaultFrameHandler(frame, child)
      }
    }, { script: { holdUntilCancelled: true, holdUntilStdinClosed: false } })
    const run = startCodexAppServerRun(context(host, { interruptGraceMs: 100 }), { prompt: 'interrupt', cwd: '/repo' })
    await started
    run.cancel('stop')
    const result = await run.result
    expect(result.status).toBe('cancelled')
    expect(result.notes.join('\n')).toContain('interrupt write failed')
  })

  it('rejects malformed thread, turn, and notification data and mismatched early turns', async () => {
    const malformedThread = processHost((frame, child) => {
      if (frame.method === 'thread/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { thread: { id: 42 } } })
      } else defaultFrameHandler(frame, child)
    })
    expect((await startCodexAppServerRun(context(malformedThread.host), { prompt: 'x', cwd: '/repo' }).result).status).toBe('failed')

    const mismatchedResume = processHost((frame, child) => {
      if (frame.method === 'thread/resume') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { thread: { id: 'another-thread' } } })
      } else defaultFrameHandler(frame, child)
    })
    expect((await startCodexAppServerRun(context(mismatchedResume.host), {
      prompt: 'x', cwd: '/repo', resumeNativeId: THREAD,
    }).result).status).toBe('failed')

    const malformedTurn = processHost((frame, child) => {
      if (frame.method === 'turn/start') {
        send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: 5 } } })
      } else defaultFrameHandler(frame, child)
    })
    expect((await startCodexAppServerRun(context(malformedTurn.host), { prompt: 'x', cwd: '/repo' }).result).status).toBe('failed')

    const invalidStatus = processHost((frame, child) => {
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
      send(child, { jsonrpc: '2.0', method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'working' } } })
    })
    expect((await startCodexAppServerRun(context(invalidStatus.host), { prompt: 'x', cwd: '/repo' }).result).status).toBe('failed')

    const malformedNotification = processHost((frame, child) => {
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: TURN } } })
      send(child, { jsonrpc: '2.0', method: 'item/completed', params: { threadId: THREAD, turnId: TURN, item: null } })
    })
    expect((await startCodexAppServerRun(context(malformedNotification.host), { prompt: 'x', cwd: '/repo' }).result).status).toBe('failed')

    const conflictingEarly = processHost((frame, child) => {
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, delta: 'early' } })
      send(child, { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: 'other-turn', delta: 'conflict' } })
    })
    expect((await startCodexAppServerRun(context(conflictingEarly.host), { prompt: 'x', cwd: '/repo' }).result).status).toBe('failed')

    const mismatchedEarly = processHost((frame, child) => {
      if (frame.method !== 'turn/start') {  defaultFrameHandler(frame, child); return }
      send(child, { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, delta: 'early' } })
      send(child, { jsonrpc: '2.0', id: frame.id, result: { turn: { id: 'other-turn' } } })
    })
    expect((await startCodexAppServerRun(context(mismatchedEarly.host), { prompt: 'x', cwd: '/repo' }).result).status).toBe('failed')
  })
})
