import { describe, expect, it } from 'vitest'
import type { AgentRunApprovalOutcome, AgentRunApprovalRequest, AgentRunEvent, HostExit, HostProcess } from '@deepseek-ai/dsh-agent-mesh'
import { createPiAdapter } from '../src/index.ts'
import { createFakeHost } from './host.ts'

interface RpcScriptOptions {
  readonly holdPrompt?: boolean
  readonly stateSuccess?: boolean
  readonly stateError?: string | null
  readonly stateSessionId?: string | null
  readonly stateMissingData?: boolean
  readonly promptSuccess?: boolean
  readonly settle?: boolean
  readonly turnFrames?: readonly unknown[]
  readonly initialFrames?: readonly unknown[]
  readonly stderr?: string
  readonly stderrFailure?: unknown
  readonly exitCode?: number
  readonly exitFailure?: unknown
  readonly timedOut?: boolean
  readonly omitInteractive?: boolean
  readonly sessionText?: string
  readonly abortFailure?: boolean
  readonly failExtensionUiResponse?: boolean
  readonly streamFailureAfterState?: boolean
  readonly disableStdinAfterState?: boolean
  readonly ignoreAbort?: boolean
}

function piRpcHost(options: RpcScriptOptions = {}) {
  const host = createFakeHost({
    files: {
      '/usr/bin/pi': 'binary',
      ...(options.sessionText === undefined ? {} : { '/sessions/time_s1.jsonl': options.sessionText }),
    },
    env: { PATH: '' },
  })
  const writes: string[] = []
  let notifyPrompt: (() => void) | undefined
  const promptReceived = new Promise<void>((resolve) => { notifyPrompt = resolve })
  host.queue(() => {
    const lines: string[] = []
    const readers: (() => void)[] = []
    let closed = false
    let failAfterState = false
    let settleExit: ((exit: HostExit) => void) | undefined
    let rejectExit: ((error: unknown) => void) | undefined
    const exit = new Promise<HostExit>((resolve, reject) => { settleExit = resolve; rejectExit = reject })
    const finishExit = (facts: HostExit): void => {
      if (options.exitFailure !== undefined) rejectExit?.(options.exitFailure)
      else settleExit?.(facts)
    }
    const wake = (): void => { for (const reader of readers.splice(0)) reader() }
    const push = (value: unknown): void => {
      lines.push(typeof value === 'string' ? value : JSON.stringify(value))
      wake()
    }
    for (const frame of options.initialFrames ?? []) push(frame)
    const child: HostProcess = {
      lines: {
        async *[Symbol.asyncIterator](): AsyncGenerator<string> {
          while (true) {
            if (lines.length > 0) {
              yield lines.shift() ?? ''
              continue
            }
            if (failAfterState) {
              closed = true
              finishExit({ code: 0, signal: null, timedOut: false, cancelled: false })
              throw new Error('scripted stdout failure')
            }
            if (closed) return
            await new Promise<void>(resolve => readers.push(resolve))
          }
        },
      },
      async stderr(): Promise<string> {
        if (options.stderrFailure !== undefined) throw options.stderrFailure
        return options.stderr ?? ''
      },
      exit,
      ...(options.omitInteractive ? {} : {
        writeStdin(data: string): void {
          writes.push(data)
          for (const encoded of data.trim().split('\n')) {
            if (encoded === '') continue
            const frame: unknown = JSON.parse(encoded)
            if (!isRecord(frame)) continue
            const id = frame['id']
            const type = frame['type']
            if (type === 'extension_ui_response' && options.failExtensionUiResponse) {
              throw new Error('scripted extension UI response write failure')
            }
            if (type === 'get_state') {
              push({
                type: 'response',
                command: type,
                success: options.stateSuccess ?? true,
                id,
                ...(options.stateSuccess === false
                  ? options.stateError === null ? {} : { error: options.stateError ?? 'state unavailable' }
                  : options.stateMissingData ? {} : { data: options.stateSessionId === null ? {} : { sessionId: options.stateSessionId ?? 'pi-rpc-session' } }),
              })
              if (options.disableStdinAfterState) Reflect.set(child, 'writeStdin', undefined)
              failAfterState = options.streamFailureAfterState === true
            } else if (type === 'prompt') {
              push({ type: 'response', command: type, success: options.promptSuccess ?? true, id, ...(options.promptSuccess === false ? { error: 'prompt rejected' } : { data: { disposition: 'started' } }) })
              notifyPrompt?.()
              if (!options.holdPrompt && options.settle !== false && options.promptSuccess !== false) {
                const turnFrames = options.turnFrames ?? [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'RPC answer' } }]
                for (const event of turnFrames) push(event)
                if (!turnFrames.some(event => isRecord(event) && event['type'] === 'agent_settled')) {
                  push({ type: 'agent_settled' })
                }
              } else if (options.settle === false && options.promptSuccess !== false) {
                setTimeout(() => {
                  closed = true
                  finishExit({ code: options.exitCode ?? 0, signal: null, timedOut: options.timedOut ?? false, cancelled: false })
                  wake()
                }, 0)
              }
            } else if (type === 'abort') {
              if (options.abortFailure) throw new Error('scripted abort write failure')
              if (!options.ignoreAbort) {
                push({ type: 'response', command: type, success: true, id })
                push({ type: 'agent_settled', aborted: true })
              }
            }
          }
        },
        closeStdin(): void {
          if (closed) return
          closed = true
          finishExit({ code: options.exitCode ?? 0, signal: null, timedOut: options.timedOut ?? false, cancelled: false })
          wake()
        },
      }),
      cancel(): void {
        if (closed) return
        closed = true
        finishExit({ code: null, signal: 'SIGTERM', timedOut: false, cancelled: true })
        wake()
      },
    }
    return child
  })
  return { host, writes, promptReceived }
}

describe('Pi RPC run', () => {
  it('binds the native session, streams events, and closes the duplex process after the turn settles', async () => {
    const { host, writes } = piRpcHost()
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'say hello', cwd: '/work', approval: 'approve', timeoutMs: 100 })
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)
    const result = await run.result

    expect(result).toMatchObject({ status: 'succeeded', nativeSessionKey: 'pi:pi-rpc-session' })
    expect(events).toContainEqual(expect.objectContaining({ kind: 'session.bound', nativeSessionId: 'pi-rpc-session' }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'message.delta', text: 'RPC answer' }))
    expect(host.spawns[0]?.spec).toMatchObject({ args: ['--mode', 'rpc', '--session-id', expect.any(String), '--approve'], interactive: true, timeoutMs: 100 })
    expect(writes.join('')).toContain('"message":"say hello"')
  })

  it('sends a native abort and reports cancellation after Pi settles', async () => {
    const { host, writes, promptReceived } = piRpcHost({ holdPrompt: true })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'keep working', cwd: '/work' })
    await promptReceived
    run.cancel('user stopped the run')
    const result = await run.result

    expect(result.status).toBe('cancelled')
    expect(writes.join('')).toContain('"type":"abort"')
  })

  it('declines unsupported and unanswered extension UI requests while preserving malformed stdout', async () => {
    const { host, writes } = piRpcHost({ initialFrames: [
      '{not json',
      7,
      { type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Run command?' },
      { type: 'extension_ui_request', id: 'ui-2', method: 'select' },
      { type: 'extension_ui_request', id: 'ui-input', method: 'input' },
      { type: 'extension_ui_request', id: 'ui-editor', method: 'editor' },
      { type: 'extension_ui_request', id: 'ui-other', method: 'future' },
    ] })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'say hello', cwd: '/work' })
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)

    expect(events.some(event => event.kind === 'warning' && event.message.includes('could not be parsed'))).toBe(true)
    expect(events.some(event => event.kind === 'warning' && event.message.includes('approval was unavailable'))).toBe(true)
    expect(events.some(event => event.kind === 'warning' && event.message.includes('DSH declined it'))).toBe(true)
    expect(events.some(event => event.kind === 'unknown')).toBe(true)
    expect(writes.join('')).toContain('"type":"extension_ui_response","id":"ui-1","cancelled":true')
    expect(writes.join('')).toContain('"type":"extension_ui_response","id":"ui-2","cancelled":true')
    expect(writes.join('')).toContain('"type":"extension_ui_response","id":"ui-input","cancelled":true')
    expect(writes.join('')).toContain('"type":"extension_ui_response","id":"ui-editor","cancelled":true')
    expect(writes.join('')).not.toContain('"id":"ui-other"')
  })

  it('maps rejected and one-shot selection outcomes to native UI responses', async () => {
    const { host, writes } = piRpcHost({ initialFrames: [
      { type: 'extension_ui_request', id: 'confirm-denied', method: 'confirm', title: 'Run a command?' },
      { type: 'extension_ui_request', id: 'select-allowed', method: 'select', options: ['Allow once', 'Deny'] },
      { type: 'extension_ui_request', id: 'select-cancelled', method: 'select', options: ['Allow once', 'Deny'] },
    ] })
    const outcomes: AgentRunApprovalOutcome[] = ['rejected', 'allowed-once', 'cancelled']
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({
      prompt: 'say hello',
      cwd: '/work',
      requestApproval: async () => outcomes.shift() ?? 'unavailable',
    })
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)
    await run.result

    expect(writes.join('')).toContain('"id":"confirm-denied","confirmed":false')
    expect(writes.join('')).toContain('"id":"select-allowed","value":"Allow once"')
    expect(writes.join('')).toContain('"id":"select-cancelled","cancelled":true')
    expect(events.some(event => event.kind === 'warning' && event.message.includes('approval was unavailable'))).toBe(true)
  })

  it('logs a failed DSH approval callback and cancels the Pi interaction', async () => {
    const { host, writes } = piRpcHost({ initialFrames: [
      { type: 'extension_ui_request', id: 'confirm-failed', method: 'confirm' },
    ] })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({
      prompt: 'say hello',
      cwd: '/work',
      requestApproval: async () => { throw new Error('approval service failed') },
    })
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)
    await run.result

    expect(host.logs).toContain('pi RPC DSH approval failed: approval service failed')
    expect(writes.join('')).toContain('"id":"confirm-failed","cancelled":true')
    expect(events.some(event => event.kind === 'warning' && event.message.includes('approval was unavailable'))).toBe(true)
  })

  it('reports a failed Pi approval response write as a protocol error', async () => {
    const { host } = piRpcHost({
      failExtensionUiResponse: true,
      initialFrames: [{ type: 'extension_ui_request', id: 'confirm-write-failed', method: 'confirm' }],
    })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({
      prompt: 'say hello',
      cwd: '/work',
      requestApproval: async () => 'allowed-once',
    })

    await expect(run.result).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'run/protocol-error', message: 'pi RPC UI response failed: scripted extension UI response write failure' },
    })
  })

  it('records when Pi cannot receive a UI cancellation response', async () => {
    const { host } = piRpcHost({
      failExtensionUiResponse: true,
      holdPrompt: true,
      initialFrames: [{ type: 'extension_ui_request', id: 'confirm-cancel-failed', method: 'confirm' }],
    })
    let notifyApprovalStarted: (() => void) | undefined
    const approvalStarted = new Promise<void>((resolve) => { notifyApprovalStarted = resolve })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({
      prompt: 'say hello',
      cwd: '/work',
      requestApproval: ({ signal }) => new Promise<AgentRunApprovalOutcome>((resolve) => {
        signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
        notifyApprovalStarted?.()
      }),
    })

    await approvalStarted
    run.cancel('stop after approval cancellation write failed')
    const result = await run.result

    expect(result.status).toBe('cancelled')
    expect(result.notes).toContain('pi RPC UI request could not be cancelled: scripted extension UI response write failure')
  })

  it('routes confirmation and explicit one-shot selections through DSH approval', async () => {
    const { host, writes } = piRpcHost({ initialFrames: [
      { type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'Run command?', message: 'npm test' },
      { type: 'extension_ui_request', id: 'select-1', method: 'select', title: 'File change', options: ['Allow once', 'Deny'] },
    ] })
    const approvals: AgentRunApprovalRequest[] = []
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({
      prompt: 'say hello',
      cwd: '/work',
      requestApproval: async (approval) => {
        approvals.push(approval)
        return approvals.length === 1 ? 'allowed-once' : 'rejected'
      },
    })
    await run.result

    expect(approvals).toMatchObject([
      { kind: 'interaction', title: 'Run command?', detail: 'npm test' },
      { kind: 'interaction', title: 'File change', detail: 'choices: Allow once, Deny' },
    ])
    expect(writes.join('')).toContain('"type":"extension_ui_response","id":"confirm-1","confirmed":true')
    expect(writes.join('')).toContain('"type":"extension_ui_response","id":"select-1","value":"Deny"')
  })

  it('cancels a pending DSH confirmation when the Pi run is cancelled', async () => {
    const { host, writes, promptReceived } = piRpcHost({ holdPrompt: true, initialFrames: [
      { type: 'extension_ui_request', id: 'confirm-pending', method: 'confirm', title: 'Run command?' },
    ] })
    let signalAborted = false
    let notifyApprovalStarted: (() => void) | undefined
    const approvalStarted = new Promise<void>((resolve) => { notifyApprovalStarted = resolve })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({
      prompt: 'say hello',
      cwd: '/work',
      requestApproval: ({ signal }) => new Promise<AgentRunApprovalOutcome>((resolve) => {
        signal.addEventListener('abort', () => {
          signalAborted = true
          resolve('cancelled')
        }, { once: true })
        notifyApprovalStarted?.()
      }),
    })
    await approvalStarted
    await promptReceived
    run.cancel('user stopped the run')
    await run.result

    expect(signalAborted).toBe(true)
    expect(writes.join('')).toContain('"type":"extension_ui_response","id":"confirm-pending","cancelled":true')
    expect(writes.join('')).toContain('"type":"abort"')
  })

  it('turns rejected state and prompt RPC responses into protocol failures', async () => {
    const stateHost = piRpcHost({ stateSuccess: false }).host
    const stateRun = createPiAdapter(stateHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    expectFailedResult(await stateRun.result, { code: 'run/protocol-error', messageIncludes: 'state unavailable' })

    const promptHost = piRpcHost({ promptSuccess: false }).host
    const promptRun = createPiAdapter(promptHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    expectFailedResult(await promptRun.result, { code: 'run/protocol-error', messageIncludes: 'prompt rejected' })
  })

  it('fails before spawning when the binary or requested interactive approval mode is unavailable', async () => {
    const missing = createPiAdapter(createFakeHost({ env: { PATH: '' } }))
    await expect(missing.startRun({ prompt: 'hello', cwd: '/work' }).result).resolves.toMatchObject({
      status: 'failed', error: { code: 'detection/not-found' },
    })

    const { host } = piRpcHost()
    const invalid = createPiAdapter(host, { binaryPath: '/usr/bin/pi' })
    await expect(invalid.startRun({ prompt: 'hello', cwd: '/work', approval: 'yolo' }).result).resolves.toMatchObject({
      status: 'failed', error: { code: 'schema/invalid' },
    })
    expect(host.spawns).toHaveLength(0)
  })

  it('reports a failed process launch and stderr read failure without losing the terminal result', async () => {
    const launchHost = createFakeHost({ files: { '/usr/bin/pi': 'binary' }, env: { PATH: '' } })
    launchHost.failNextSpawn('permission denied')
    const launchRun = createPiAdapter(launchHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    expectFailedResult(await launchRun.result, { code: 'run/start-failed', messageIncludes: 'permission denied' })

    const { host } = piRpcHost({ stderrFailure: new Error('stderr unavailable') })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    await expect(run.result).resolves.toMatchObject({ status: 'succeeded' })
    expect(host.logs.some(message => message.includes('stderr could not be read'))).toBe(true)
  })

  it('classifies Pi-reported assistant failures and aborted turns even when the process exits cleanly', async () => {
    const failedHost = piRpcHost({ turnFrames: [
      { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider rejected the request' } },
    ] }).host
    const failedRun = createPiAdapter(failedHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    await expect(failedRun.result).resolves.toMatchObject({
      status: 'failed', error: { code: 'run/agent-crashed', message: 'provider rejected the request' },
    })

    const abortedHost = piRpcHost({ turnFrames: [{ type: 'agent_settled', aborted: true }] }).host
    const abortedRun = createPiAdapter(abortedHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    await expect(abortedRun.result).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('records a clean process exit without agent_settled as a protocol failure', async () => {
    const { host } = piRpcHost({ settle: false })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })

    expectFailedResult(await run.result, { code: 'run/protocol-error', messageIncludes: 'agent_settled' })
  })

  it('rejects missing session ids and a host without interactive stdin', async () => {
    const missingSessionHost = piRpcHost({ stateSessionId: null }).host
    const missingSessionRun = createPiAdapter(missingSessionHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    expectFailedResult(await missingSessionRun.result, { code: 'run/protocol-error', messageIncludes: 'no sessionId' })

    const noStdinHost = piRpcHost({ omitInteractive: true }).host
    const noStdinRun = createPiAdapter(noStdinHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    await expect(noStdinRun.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/transport-unavailable' } })
  })

  it('classifies a nonzero child exit and reports an absent extension request id', async () => {
    const { host } = piRpcHost({
      exitCode: 1,
      stderr: 'Pi exited with an error',
      initialFrames: [
        { type: 'extension_ui_request', method: 'confirm' },
        { type: 'extension_ui_request', id: 'ui-2' },
        { type: 'response', success: true },
        { type: 'response', id: 'unknown-response', success: true },
        { type: 'agent_settled' },
      ],
    })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    const result = await run.result

    expect(result.status).toBe('failed')
    expect(result.error).toMatchObject({ code: 'run/agent-crashed', output: 'Pi exited with an error' })
    expect(await (async () => {
      const events: AgentRunEvent[] = []
      for await (const event of run) events.push(event)
      return events.some(event => event.kind === 'warning' && event.message.includes('declined the request'))
    })()).toBe(true)
  })

  it('resumes a matching Pi session file and refuses a session owned by another project', async () => {
    const sessionText = `${JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-10-16T00:00:00.000Z', cwd: '/work', version: 3 })}\n`
    const { host } = piRpcHost({ sessionText })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi', sessionDir: '/sessions' }).startRun({
      prompt: 'continue', cwd: '/work', resumeNativeId: 's1',
    })
    await expect(run.result).resolves.toMatchObject({ status: 'succeeded' })
    expect(host.spawns[0]?.spec.args).toContain('/sessions/time_s1.jsonl')

    const otherProjectText = `${JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-10-16T00:00:00.000Z', cwd: '/other', version: 3 })}\n`
    const otherProject = piRpcHost({ sessionText: otherProjectText }).host
    const refused = createPiAdapter(otherProject, { binaryPath: '/usr/bin/pi', sessionDir: '/sessions' }).startRun({
      prompt: 'continue', cwd: '/work', resumeNativeId: 's1',
    })
    expectFailedResult(await refused.result, { code: 'run/context-unavailable', messageIncludes: '/other' })
    expect(otherProject.spawns).toHaveLength(0)
  })

  it('uses Pi native lookup when a resume id has no local session file', async () => {
    const { host } = piRpcHost()
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({
      prompt: 'continue', cwd: '/work', resumeNativeId: 'remote-session',
    })

    await expect(run.result).resolves.toMatchObject({ status: 'succeeded' })
    expect(host.spawns[0]?.spec.args).toContain('remote-session')
  })

  it('accepts a session file without a recorded cwd and handles duplicate state binding', async () => {
    const sessionText = `${JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-10-16T00:00:00.000Z', cwd: '', version: 3 })}\n`
    const { host } = piRpcHost({
      sessionText,
      initialFrames: [{ type: 'session', id: 'pi-rpc-session', cwd: '/work', version: 3 }],
    })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi', sessionDir: '/sessions' }).startRun({
      prompt: 'continue', cwd: '/work', resumeNativeId: 's1',
    })
    await expect(run.result).resolves.toMatchObject({ status: 'succeeded' })
    expect(host.spawns[0]?.spec.args).toContain('/sessions/time_s1.jsonl')
  })

  it('handles cancellation before process setup and a rejected child exit promise', async () => {
    const { host: preCancelledHost } = piRpcHost()
    const preCancelledRun = createPiAdapter(preCancelledHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    preCancelledRun.cancel()
    await expect(preCancelledRun.result).resolves.toMatchObject({ status: 'cancelled' })

    const { host: exitFailureHost } = piRpcHost({ exitFailure: 'host exit failure' })
    const exitFailureRun = createPiAdapter(exitFailureHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    await expect(exitFailureRun.result).resolves.toMatchObject({
      status: 'failed', error: {
        code: 'run/protocol-error', message: 'the Pi RPC child process exit could not be confirmed',
      },
    })
    expect(exitFailureHost.logs).toContain(
      'pi RPC child exit could not be observed; the process may still be running: host exit failure',
    )
  })

  it('terminates if Pi refuses to accept an abort frame', async () => {
    const { host: abortHost, promptReceived } = piRpcHost({ holdPrompt: true, abortFailure: true })
    const abortRun = createPiAdapter(abortHost, { binaryPath: '/usr/bin/pi', interruptGraceMs: 50 }).startRun({ prompt: 'hello', cwd: '/work' })
    await promptReceived
    abortRun.cancel('stop')
    abortRun.cancel('repeat stop')
    await expect(abortRun.result).resolves.toMatchObject({ status: 'cancelled' })

    const { host: ignoredAbortHost, promptReceived: ignoredPromptReceived } = piRpcHost({ holdPrompt: true, ignoreAbort: true })
    const ignoredAbortRun = createPiAdapter(ignoredAbortHost, { binaryPath: '/usr/bin/pi', interruptGraceMs: 10 }).startRun({ prompt: 'hello', cwd: '/work' })
    await ignoredPromptReceived
    ignoredAbortRun.cancel('stop')
    await expect(ignoredAbortRun.result).resolves.toMatchObject({ status: 'cancelled' })

    const { host: vanishedStdinHost } = piRpcHost({ disableStdinAfterState: true })
    const vanishedStdinRun = createPiAdapter(vanishedStdinHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    await expect(vanishedStdinRun.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })
  })

  it('records an abnormal stdout stream as a protocol error', async () => {
    const { host } = piRpcHost({ streamFailureAfterState: true })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })

    expectFailedResult(await run.result, { code: 'run/protocol-error', messageIncludes: 'stdout could not be read' })
  })

  it('bounds long protocol diagnostics and handles a non-Error startup failure', async () => {
    const longError = `x${'e'.repeat(9_000)}`
    const { host } = piRpcHost({ stateSuccess: false, stateError: longError })
    const childRun = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    const childResult = await childRun.result
    expect(childResult.error?.message.length).toBeLessThanOrEqual(8_193)

    const fallbackErrorHost = piRpcHost({ stateSuccess: false, stateError: null }).host
    const fallbackErrorRun = createPiAdapter(fallbackErrorHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    expectFailedResult(await fallbackErrorRun.result, { messageIncludes: 'pi rejected the RPC command' })

    const missingDataHost = piRpcHost({ stateMissingData: true }).host
    const missingDataRun = createPiAdapter(missingDataHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    expectFailedResult(await missingDataRun.result, { messageIncludes: 'no sessionId' })

    const badHost = createFakeHost({ files: { '/usr/bin/pi': 'binary' }, env: { PATH: '' } })
    badHost.stat = async () => { throw 'filesystem unavailable' }
    const failedRun = createPiAdapter(badHost, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })
    await expect(failedRun.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })
    expect(longError.length).toBeGreaterThan(8_192)
  })

  it('maps a host timeout to the Pi run timeout status', async () => {
    const { host } = piRpcHost({ timedOut: true })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work', timeoutMs: 25 })

    await expect(run.result).resolves.toMatchObject({ status: 'timeout', error: { code: 'run/timeout' } })
  })

  it('uses a fallback message for an assistant error with no provider text', async () => {
    const { host } = piRpcHost({ turnFrames: [
      { type: 'message_end', message: { role: 'assistant', stopReason: 'error' } },
    ] })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })

    await expect(run.result).resolves.toMatchObject({
      status: 'failed', error: { code: 'run/agent-crashed', message: 'the assistant response failed' },
    })
  })

  it('returns completed assistant text and usage from the native message end event', async () => {
    const { host } = piRpcHost({ turnFrames: [{
      type: 'message_end',
      message: {
        role: 'assistant',
        content: 'Completed answer',
        stopReason: 'stop',
        usage: { input: 12, output: 7, totalTokens: 19, cost: { total: 0.02 } },
      },
    }] })
    const run = createPiAdapter(host, { binaryPath: '/usr/bin/pi' }).startRun({ prompt: 'hello', cwd: '/work' })

    await expect(run.result).resolves.toMatchObject({
      status: 'succeeded', finalText: 'Completed answer', usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19, costUsd: 0.02 },
    })
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
