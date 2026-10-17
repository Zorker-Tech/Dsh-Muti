/**
 * One Pi RPC process per mesh run, including session binding, prompt dispatch, abort and
 * event projection. RPC responses are control frames; Pi session events use the same JSON
 * event format as its one-shot JSON transport.
 * @module @deepseek-ai/dsh-agent-pi/rpc-run
 */

import { resolve as resolvePath } from 'node:path'
import type {
  AgentRun,
  AgentRunApprovalOutcome,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  HostExit,
  HostProcess,
} from '@deepseek-ai/dsh-agent-mesh'
import {
  classifyPiExit,
  buildPiRunArgs,
  generatePiSessionId,
  PiRunProjection,
  RunEventQueue,
  runEnv,
  type PiRunContext,
} from './run.ts'
import { findPiSessionFile, isRecord, parseJsonLine, readPiSessionHeaderAt, readRecord, readString, sessionKey } from './sessions.ts'

const RPC_STATE_ID = 'dsh-state'
const RPC_PROMPT_ID = 'dsh-prompt'
const RPC_ABORT_ID = 'dsh-abort'
const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024
const ERROR_OUTPUT_CHARS = 2_000

/** One pending response from Pi's line-oriented RPC protocol. */
interface PendingResponse {
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
}

/**
 * Dispatch one prompt through `pi --mode rpc`.
 * @param context - The resolved Pi run context.
 * @param request - The prompt, directory, and run settings.
 * @returns A live run handle with events, result, and cancellation.
 */
export function startPiRpcRun(context: PiRunContext, request: AgentRunRequest): AgentRun {
  const { host } = context
  const queue = new RunEventQueue()
  const startedMs = host.now()
  const startedAt = new Date(startedMs).toISOString()
  const projection = new PiRunProjection(context.runId)
  const pending = new Map<string, PendingResponse>()
  let child: HostProcess | undefined
  let reader: Promise<void> | undefined
  let cancelled = false
  let cancelReason: string | undefined
  let protocolError: string | undefined
  let uiCancelError: string | undefined
  let inputClosed = false
  let promptInFlight = false
  let interruptStarted = false
  const approvalController = new AbortController()
  const uiRequestIds = new Set<string>()
  const pendingUiRequests = new Set<Promise<void>>()
  let settledResolve: (() => void) | undefined
  let settledReject: ((error: Error) => void) | undefined
  const settled = new Promise<void>((resolve, reject) => {
    settledResolve = resolve
    settledReject = reject
  })
  void settled.catch(() => undefined)
  let cancelTimer: ReturnType<typeof setTimeout> | undefined

  const finish = (result: AgentRunResult): void => {
    queue.emit({ kind: 'run.finished', runId: context.runId, at: result.finishedAt, result })
  }

  const failed = (code: string, message: string, remediation: string): AgentRunResult => ({
    runId: context.runId,
    agentId: context.agentId,
    status: 'failed',
    startedAt,
    finishedAt: new Date(host.now()).toISOString(),
    durationMs: host.now() - startedMs,
    cwd: request.cwd,
    error: { code, message, remediation },
    notes: [...projection.state().notes],
  })

  const send = (frame: Readonly<Record<string, unknown>>): void => {
    if (child?.writeStdin === undefined) throw new Error('pi RPC stdin is unavailable')
    child.writeStdin(`${JSON.stringify(frame)}\n`)
  }

  const closeInput = (): void => {
    if (inputClosed) return
    inputClosed = true
    child?.closeStdin?.()
  }

  const rejectPending = (error: Error): void => {
    for (const response of pending.values()) response.reject(error)
    pending.clear()
    settledReject?.(error)
  }

  const cancelUiRequests = (): void => {
    for (const id of uiRequestIds) {
      try {
        send({ type: 'extension_ui_response', id, cancelled: true })
      } catch (error: unknown) {
        uiCancelError ??= `pi RPC UI request could not be cancelled: ${errorMessage(error)}`
      }
    }
    uiRequestIds.clear()
  }

  const answerUiRequest = async (frame: Record<string, unknown>): Promise<void> => {
    const id = readString(frame, 'id')
    const method = readString(frame, 'method') ?? 'unknown'
    if (id === undefined) {
      queue.emit(warning(context, `pi RPC ${method} UI request had no response id`))
      return
    }
    if (method !== 'confirm' && method !== 'select') {
      if (method === 'input' || method === 'editor') {
        send({ type: 'extension_ui_response', id, cancelled: true })
      }
      queue.emit(warning(context, `pi extension requested unsupported interactive ${method} input; DSH declined the request`))
      return
    }

    const options = frame['options']
    const allowedOption = method === 'select' ? permissionOption(options, true) : undefined
    const rejectedOption = method === 'select' ? permissionOption(options, false) : undefined
    if (method === 'select' && (allowedOption === undefined || rejectedOption === undefined)) {
      send({ type: 'extension_ui_response', id, cancelled: true })
      queue.emit(warning(context, 'pi requested a selection without explicit one-shot allow and deny choices; DSH declined it'))
      return
    }

    const title = approvalText(readString(frame, 'title') ?? 'Pi requested confirmation', 256)
    const detailParts = [readString(frame, 'message')]
    if (method === 'select' && Array.isArray(options)) {
      detailParts.push(`choices: ${options.filter((option: unknown): option is string => typeof option === 'string').join(', ')}`)
    }
    const detail = approvalText(detailParts.filter((part): part is string => part !== undefined).join('\n'), 4_096)
    uiRequestIds.add(id)
    let outcome: AgentRunApprovalOutcome = 'unavailable'
    try {
      if (request.requestApproval !== undefined && !approvalController.signal.aborted) {
        outcome = await request.requestApproval({ kind: 'interaction', title, detail, signal: approvalController.signal })
      }
    } catch (error: unknown) {
      host.log('warn', `pi RPC DSH approval failed: ${errorMessage(error)}`)
    }
    if (!uiRequestIds.delete(id)) return

    const response = method === 'confirm'
      ? outcome === 'allowed-once'
        ? { confirmed: true }
        : outcome === 'rejected'
          ? { confirmed: false }
          : { cancelled: true }
      : outcome === 'allowed-once'
        ? { value: allowedOption }
        : outcome === 'rejected'
          ? { value: rejectedOption }
          : { cancelled: true }
    if (outcome === 'unavailable' || outcome === 'cancelled') {
      queue.emit(warning(context, `pi ${method} request was declined because DSH approval was unavailable`))
    }
    send({ type: 'extension_ui_response', id, ...response })
  }

  const queueUiRequest = (frame: Record<string, unknown>): void => {
    const work = answerUiRequest(frame).catch((error: unknown) => {
      protocolError ??= `pi RPC UI response failed: ${errorMessage(error)}`
      queue.emit(warning(context, protocolError))
      cancelProcess()
    })
    pendingUiRequests.add(work)
    void work.then(() => { pendingUiRequests.delete(work) })
  }

  const waitForResponse = (id: string): Promise<Record<string, unknown>> => {
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
    // The child can exit before the caller reaches Promise.race after a synchronous write.
    void response.catch(() => undefined)
    return response
  }

  const cancelProcess = (): void => {
    if (cancelTimer !== undefined) clearTimeout(cancelTimer)
    cancelTimer = undefined
    child?.cancel(cancelReason)
  }

  const requestInterrupt = (): void => {
    if (interruptStarted) return
    interruptStarted = true
    try {
      // Pi aborts a live turn; closing stdin handles cancellation before prompt dispatch.
      if (promptInFlight) send({ type: 'abort', id: RPC_ABORT_ID })
    } catch (error: unknown) {
      protocolError ??= `pi RPC abort could not be sent: ${errorMessage(error)}`
      cancelProcess()
      return
    }
    cancelTimer = setTimeout(cancelProcess, context.config.interruptGraceMs)
  }

  const consume = async (process: HostProcess): Promise<void> => {
    let lineNumber = 0
    try {
      for await (const line of process.lines) {
        lineNumber += 1
        const parsed = parseJsonLine(line)
        if (!parsed.ok) {
          queue.emit(warning(context, `pi RPC line ${String(lineNumber)} could not be parsed: ${parsed.error}`))
          continue
        }
        const at = new Date(host.now()).toISOString()
        if (!isRecord(parsed.value)) {
          for (const event of projection.observe(parsed.value, line, at)) queue.emit(event)
          continue
        }
        const type = readString(parsed.value, 'type')
        if (type === 'response') {
          const id = readString(parsed.value, 'id')
          const response = id === undefined ? undefined : pending.get(id)
          if (id !== undefined && response !== undefined) {
            pending.delete(id)
            if (parsed.value['success'] === true) response.resolve(parsed.value)
            else response.reject(new Error(boundText(readString(parsed.value, 'error') ?? 'pi rejected the RPC command')))
          }
          continue
        }
        if (type === 'extension_ui_request') {
          queueUiRequest(parsed.value)
          continue
        }
        if (type === 'agent_settled' && promptInFlight) {
          projection.observe(parsed.value, line, at).forEach((event) =>{  queue.emit(event) })
          promptInFlight = false
          settledResolve?.()
          settledResolve = undefined
          closeInput()
          continue
        }
        for (const event of projection.observe(parsed.value, line, at)) queue.emit(event)
      }
    } catch (error: unknown) {
      const failure = new Error(`pi RPC stdout could not be read: ${errorMessage(error)}`)
      protocolError ??= failure.message
      rejectPending(failure)
    }
    const ended = new Error('pi RPC process exited before completing the run')
    rejectPending(ended)
  }

  const producer = async (): Promise<void> => {
    queue.emit({ kind: 'run.started', runId: context.runId, agentId: context.agentId, at: startedAt })
    const { binary, layout } = await context.resolve()
    if (binary === undefined) {
      finish(failed('detection/not-found', 'the pi binary is not available', 'Install Pi, or set the pi binary path in this adapter\'s configuration.'))
      return
    }

    let resumePath: string | undefined
    const resumeId = request.resumeNativeId
    if (resumeId !== undefined && resumeId !== '') {
      const located = await findPiSessionFile(host, layout, resumeId)
      if (located !== undefined) {
        const header = await readPiSessionHeaderAt(host, located)
        const sessionCwd = header === undefined || header.cwd === '' ? undefined : header.cwd
        if (sessionCwd !== undefined && resolvePath(sessionCwd) !== resolvePath(request.cwd)) {
          finish(failed(
            'run/context-unavailable',
            `pi session ${resumeId} belongs to ${sessionCwd} and cannot be continued in ${request.cwd}`,
            `Dispatch this resume with cwd set to ${sessionCwd}; Pi requires an interactive confirmation to fork a session into another project.`,
          ))
          return
        }
        resumePath = located
      }
    }

    if (request.approval !== undefined && request.approval !== '' && request.approval !== 'approve' && request.approval !== 'default') {
      finish(failed('schema/invalid', `"${request.approval}" is not a pi approval mode`, 'Use "default" or "approve" for Pi.'))
      return
    }

    const plannedSessionId = resumeId === undefined || resumeId === '' ? generatePiSessionId(host.now()) : resumeId
    const newSessionId = resumeId === undefined || resumeId === '' ? plannedSessionId : undefined
    const args = buildPiRunArgs({
      mode: 'rpc',
      resumePath,
      resumeId: resumePath === undefined ? resumeId : undefined,
      newSessionId,
      model: request.model,
      approval: request.approval,
    })
    let process: HostProcess
    try {
      process = host.spawn({
        command: binary,
        args,
        cwd: request.cwd,
        env: runEnv(context, layout, request),
        interactive: true,
        ...(request.timeoutMs === undefined || request.timeoutMs <= 0 ? {} : { timeoutMs: request.timeoutMs }),
        maxLineBytes: MAX_RPC_LINE_BYTES,
      })
    } catch (error: unknown) {
      finish(failed('run/start-failed', `pi could not be started: ${errorMessage(error)}`, 'Check that the pi binary exists and is executable, and that the working directory exists.'))
      return
    }
    child = process
    if (process.writeStdin === undefined || process.closeStdin === undefined) {
      process.cancel('pi RPC requires an interactive subprocess')
      await process.exit
      finish(failed('run/transport-unavailable', 'the host does not provide interactive stdin for pi RPC', 'Use runMode "headless-exec" or enable interactive subprocess support.'))
      return
    }

    reader = consume(process)
    if (cancelled) requestInterrupt()
    const stateResponse = waitForResponse(RPC_STATE_ID)
    try {
      send({ type: 'get_state', id: RPC_STATE_ID })
      const response = await Promise.race([stateResponse, process.exit.then(() => { throw new Error('pi RPC exited before get_state') })])
      const data = readRecord(response, 'data')
      const sessionId = data === undefined ? undefined : readString(data, 'sessionId')
      if (sessionId === undefined) throw new Error('pi RPC get_state response contained no sessionId')
      const binding = projection.bind(sessionId, new Date(host.now()).toISOString())
      if (binding !== undefined) queue.emit(binding)
      if (cancelled) {
        requestInterrupt()
        closeInput()
      } else {
        promptInFlight = true
        const promptResponse = waitForResponse(RPC_PROMPT_ID)
        send({ type: 'prompt', id: RPC_PROMPT_ID, message: request.prompt })
        await Promise.race([promptResponse, process.exit.then(() => { throw new Error('pi RPC exited before accepting the prompt') })])
        await Promise.race([settled, process.exit.then(() => { throw new Error('pi RPC exited before agent_settled') })])
      }
    } catch (error: unknown) {
      protocolError ??= `pi RPC request failed: ${errorMessage(error)}`
      closeInput()
      if (!cancelled) process.cancel('pi RPC protocol failed')
    }
    await reader
    approvalController.abort('pi RPC process ended')
    uiRequestIds.clear()
    await Promise.all(pendingUiRequests)
    if (cancelTimer !== undefined) clearTimeout(cancelTimer)
    closeInput()

    let stderr = ''
    try {
      stderr = await process.stderr()
    } catch (error: unknown) {
      host.log('warn', `pi RPC stderr could not be read: ${errorMessage(error)}`)
    }
    const observedExit = await process.exit
    const exit: HostExit = cancelled ? { ...observedExit, cancelled: true } : observedExit
    const state = projection.state()
    const classification = classifyPiExit(exit, stderr, request.timeoutMs)
    const finishedMs = host.now()
    const finishedAt = new Date(finishedMs).toISOString()
    const notes = [...state.notes]
    if (uiCancelError !== undefined) notes.push(uiCancelError)
    const failure = protocolError === undefined || cancelled ? undefined : {
      code: 'run/protocol-error',
      message: boundText(protocolError),
      remediation: 'Re-dispatch the run; if it repeats, capture the pi RPC stdout stream for diagnosis.',
    }
    let status: AgentRunStatus = classification.ok
      ? 'succeeded'
      : classification.failure === 'cancelled' ? 'cancelled' : classification.failure === 'timeout' ? 'timeout' : 'failed'
    let error = failure
    if (failure !== undefined) status = 'failed'
    if (failure === undefined && !classification.ok) {
      const stderrTail = boundText(stderr.trim(), ERROR_OUTPUT_CHARS)
      error = {
        code: classification.code,
        message: classification.message,
        remediation: classification.remediation,
        ...(stderrTail === '' ? {} : { output: stderrTail }),
      }
    } else if (failure === undefined && state.lastStopReason === 'error') {
      status = 'failed'
      error = {
        code: 'run/agent-crashed',
        message: state.lastErrorMessage ?? 'the assistant response failed',
        remediation: 'Check the model and provider credentials configured for this agent; the run itself started cleanly.',
      }
    } else if (state.aborted) {
      status = 'cancelled'
    }
    const result: AgentRunResult = {
      runId: context.runId,
      agentId: context.agentId,
      status,
      startedAt,
      finishedAt,
      durationMs: finishedMs - startedMs,
      cwd: request.cwd,
      ...(exit.code === null ? {} : { exitCode: exit.code }),
      ...(exit.signal === null ? {} : { signal: exit.signal }),
      ...(state.finalText === undefined ? {} : { finalText: state.finalText }),
      ...(state.usage === undefined ? {} : { usage: state.usage }),
      ...(state.sessionId === undefined ? {} : { nativeSessionKey: sessionKey(context.agentId, state.sessionId) }),
      ...(error === undefined ? {} : { error }),
      notes,
    }
    finish(result)
  }

  producer().catch(async (error: unknown) => {
    host.log('warn', `pi RPC run producer failed: ${errorMessage(error)}`)
    cancelUiRequests()
    approvalController.abort('Pi RPC run failed')
    uiRequestIds.clear()
    child?.cancel('pi RPC run producer failed')
    let childExitFailure: string | undefined
    if (child !== undefined) {
      try {
        await child.exit
      } catch (exitError: unknown) {
        childExitFailure = errorMessage(exitError)
        host.log('warn', `pi RPC child exit could not be observed; the process may still be running: ${childExitFailure}`)
      }
    }
    await reader
    await Promise.all(pendingUiRequests)
    const message = childExitFailure === undefined
      ? 'the Pi RPC run could not complete'
      : 'the Pi RPC child process exit could not be confirmed'
    const remediation = childExitFailure === undefined
      ? 'Re-dispatch the run; if it repeats, capture the pi RPC stdout stream for diagnosis.'
      : 'Check that the pi process stopped before retrying; if it repeats, capture the pi RPC stdout stream for diagnosis.'
    finish(failed('run/protocol-error', message, remediation))
  })

  return {
    id: context.runId,
    result: queue.result,
    cancel(reason?: string): void {
      if (cancelled) return
      cancelled = true
      cancelReason = reason
      cancelUiRequests()
      approvalController.abort(reason ?? 'the Pi run was cancelled')
      if (child === undefined) return
      requestInterrupt()
    },
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  }
}

/** Create a timestamped warning from a native RPC condition. */
function warning(context: PiRunContext, message: string): AgentRunEvent {
  return { kind: 'warning', runId: context.runId, at: new Date(context.host.now()).toISOString(), message }
}

/** Bound copied protocol and error text by its UTF-8 size. */
function boundText(value: string, maxBytes = 8_192): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return value
  return `${bytes.subarray(0, maxBytes).toString('utf8')}…`
}

/** Convert an unknown thrown value to a concise diagnostic. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Bound one DSH-visible native UI detail and remove control characters. */
function approvalText(value: string, maxBytes: number): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ')
  return boundText(clean, maxBytes)
}

/** Find only an explicitly one-shot permission choice in a Pi selector. */
function permissionOption(options: unknown, allowed: boolean): string | undefined {
  if (!Array.isArray(options)) return undefined
  const labels = allowed
    ? new Set(['allow', 'allow once', 'approve', 'approve once', 'accept', 'accept once', '允许', '允许一次', '批准', '批准一次'])
    : new Set(['deny', 'reject', 'cancel', 'block', 'decline', '拒绝', '取消', '不允许'])
  return options.find((option: unknown): option is string => typeof option === 'string'
    && labels.has(option.trim().normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ')))
}
