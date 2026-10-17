/**
 * OMP's line-oriented RPC transport for one mesh run.
 *
 * The process owns one native session, reads one prompt, and closes stdin after the
 * prompt reaches its native terminal state. Cancellation sends OMP's `abort` command;
 * teardown still drains stdout and waits for process exit.
 * @module @deepseek-ai/dsh-agent-omp/rpc-run
 */

import type {
  AgentRun,
  AgentRunApprovalOutcome,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  HostExit,
  HostProcess,
} from '@deepseek-ai/dsh-agent-mesh'
import {
  OMP_APPROVAL_MODES,
  splitOmpModel,
} from './detect.ts'
import {
  boundOmpDiagnostic,
  classifyOmpExit,
  OmpRunProjection,
  parseOmpRunLine,
  resolveOmpResume,
  RunEventQueue,
  runEnvironment,
  type OmpRunContext,
} from './run.ts'
import {
  isRecord,
  readRecord,
  readString,
  sessionKey,
} from './sessions.ts'

const RPC_READY_TIMEOUT_MESSAGE = 'omp RPC closed before its ready frame'
const NEW_SESSION_COMMAND_ID = 'dsh-new-session'
const STATE_COMMAND_ID = 'dsh-get-state'
const PROMPT_COMMAND_ID = 'dsh-prompt'

/** The supported prompt terminal states returned by OMP RPC. */
type OmpPromptStatus = 'completed' | 'aborted' | 'error'

/** One parsed line from the OMP RPC stdout stream. */
interface OmpRpcLine {
  readonly value: unknown
  readonly raw: string
}

/** Build the argv for one OMP RPC process. */
export interface OmpRpcRunArgs {
  /** Resume argument OMP should receive, when the run continues a session. */
  readonly resumeArgument?: string
  /** Model override, in OMP's own naming. */
  readonly model?: string
  /** Approval mode the caller asked for, before validation. */
  readonly approval?: string
}

/**
 * Build the argv for one `omp --mode rpc-ui` process.
 *
 * `rpc-ui` exposes OMP approval requests to the host; `provider/id` models become the
 * explicit provider and model pair, and resume targets pass through unchanged.
 * @param args - The run's resolved inputs.
 * @returns the argument vector, without the binary.
 */
export function buildOmpRpcRunArgs(args: OmpRpcRunArgs): readonly string[] {
  const out = ['--mode', 'rpc-ui']
  if (args.resumeArgument !== undefined) out.push('--resume', args.resumeArgument)
  const model = args.model
  if (model !== undefined && model.trim() !== '') {
    const split = splitOmpModel(model)
    if (split.provider !== undefined) out.push('--provider', split.provider)
    out.push('--model', split.model)
  }
  const approval = args.approval
  if (approval !== undefined && OMP_APPROVAL_MODES.includes(approval)) out.push('--approval-mode', approval)
  return out
}

/**
 * Dispatch one prompt over OMP's duplex RPC transport.
 *
 * A failure to resolve a resume target, start the child, establish a session, or complete
 * the RPC prompt settles `result` with a terminal failure. The child receives no model
 * prompt when `request.prompt` is empty. After a successful prompt, this function closes
 * stdin and continues reading stdout until OMP exits; callers receive one run per process.
 * @param context - Host, configuration, store layout and run identity.
 * @param request - What the caller asked OMP to run.
 * @returns the live run handle.
 */
export function startOmpRpcRun(context: OmpRunContext, request: AgentRunRequest): AgentRun {
  const { host } = context
  const queue = new RunEventQueue()
  const projection = new OmpRunProjection({ runId: context.runId })
  const startedMs = host.now()
  const startedAt = new Date(startedMs).toISOString()
  const controller = new AbortController()
  const uiRequestIds = new Set<string>()
  const pendingUiRequests = new Set<Promise<void>>()
  let child: HostProcess | undefined
  let iterator: AsyncIterator<string> = {
    next: () => Promise.resolve({ done: true as const, value: undefined }),
  }
  let cancelReason: string | undefined
  let cancelRequested = false
  let promptSent = false
  let promptTerminal = false
  let inputClosed = false
  let finished = false
  let abortWriteError: string | undefined
  let uiCancelWriteError: string | undefined
  let uiResponseError: string | undefined
  let malformedLines = 0
  let streamError: string | undefined
  let setupError: string | undefined
  let promptStatus: OmpPromptStatus | undefined
  let promptError: string | undefined
  let promptSessionSettled: boolean | undefined
  let sessionSettledEvent = false
  let localPrompt = false

  const finish = (result: AgentRunResult): void => {
    finished = true
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
    notes: [],
  })

  const closeInput = (): void => {
    if (inputClosed) return
    inputClosed = true
    if (child?.closeStdin === undefined) {
      streamError ??= 'the host cannot close stdin for this interactive OMP process'
      child?.cancel('OMP RPC stdin could not be closed')
      return
    }
    try {
      child.closeStdin()
    } catch (cause) {
      streamError ??= `OMP RPC stdin could not be closed: ${errorText(cause)}`
      child.cancel('OMP RPC stdin could not be closed')
    }
  }

  const writeFrame = (frame: Readonly<Record<string, unknown>>): void => {
    if (child?.writeStdin === undefined) throw new Error('the host cannot write to an interactive OMP process')
    child.writeStdin(`${JSON.stringify(frame)}\n`)
  }

  const cancelUiRequests = (): void => {
    for (const id of uiRequestIds) {
      try {
        if (!inputClosed) writeFrame({ type: 'extension_ui_response', id, cancelled: true })
      } catch (cause) {
        uiCancelWriteError ??= errorText(cause)
      }
    }
    uiRequestIds.clear()
  }

  const cancel = (reason?: string): void => {
    if (finished || cancelRequested) return
    cancelRequested = true
    cancelReason = reason
    cancelUiRequests()
    controller.abort()
    if (child === undefined) return
    if (!promptSent || promptTerminal) {
      closeInput()
      return
    }
    try {
      writeFrame({ type: 'abort' })
    } catch (cause) {
      abortWriteError = errorText(cause)
      host.log('warn', `omp RPC abort could not be sent: ${abortWriteError}`)
      child.cancel('OMP RPC abort could not be sent')
    }
  }

  const producer = async (): Promise<void> => {
    queue.emit({ kind: 'run.started', runId: context.runId, agentId: context.agentId, at: startedAt })
    const resume = await resolveOmpResume(host, context.layout, request.resumeNativeId, request.cwd)
    if (context.layout.profile !== undefined && context.config.homeDir !== undefined) {
      projection.addNote(
        `the host environment selects profile "${context.layout.profile}", which would ignore the adapter's homeDir ` +
          'override, so the run was started with the default profile selected',
      )
    }
    if (resume.warning !== undefined) {
      projection.addNote(resume.warning)
      queue.emit(projection.warn(resume.warning, nowIso()))
    }
    if (request.prompt.trim() === '') {
      projection.addNote('the prompt was empty, so no model turn was started')
      queue.emit(projection.warn('the prompt is empty: omp will not start a model turn', nowIso()))
    }
    if (request.sandbox !== undefined && request.sandbox !== '') {
      projection.addNote('omp has no sandbox, so the requested sandbox profile was ignored')
      queue.emit(projection.warn(`omp has no sandbox; the requested profile "${request.sandbox}" was ignored`, nowIso()))
    }
    const approval = request.approval
    if (approval !== undefined && approval !== '' && !OMP_APPROVAL_MODES.includes(approval)) {
      projection.addNote(
        `approval "${approval}" is not one of omp's modes (${OMP_APPROVAL_MODES.join(', ')}), so no ` +
          'approval flag was passed and omp uses its configured mode',
      )
    }
    if (controller.signal.aborted) {
      finishCancelled()
      return
    }
    if (request.prompt.trim() === '') {
      finish({
        runId: context.runId,
        agentId: context.agentId,
        status: 'succeeded',
        startedAt,
        finishedAt: nowIso(),
        durationMs: host.now() - startedMs,
        cwd: request.cwd,
        notes: [...projection.state().notes],
      })
      return
    }

    const binary = context.config.binaryPath ?? 'omp'
    const args = buildOmpRpcRunArgs({
      ...(resume.argument === undefined ? {} : { resumeArgument: resume.argument }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(approval === undefined ? {} : { approval }),
    })
    let process: HostProcess
    try {
      process = host.spawn({
        command: binary,
        args,
        cwd: request.cwd,
        env: runEnvironment(context, request.env),
        interactive: true,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      })
    } catch (cause) {
      finish(failed(
        'run/start-failed',
        `the omp process could not be started: ${errorText(cause)}`,
        'Check that the resolved binary is executable and that the working directory exists.',
      ))
      return
    }
    child = process
    iterator = process.lines[Symbol.asyncIterator]()

    const ready = await nextLine()
    if (ready === undefined || !isRecord(ready.value) || readString(ready.value, 'type') !== 'ready') {
      if (!isSignalAborted(controller.signal)) streamError ??= RPC_READY_TIMEOUT_MESSAGE
      closeInput()
    } else if (!isSignalAborted(controller.signal)) {
      if (resume.argument === undefined) {
        const created = await command(NEW_SESSION_COMMAND_ID, 'new_session')
        if (created === undefined) {
          setupError = 'OMP RPC closed before new_session completed'
          if (!isSignalAborted(controller.signal)) {
            streamError ??= setupError
            promptError = setupError
            promptStatus = 'error'
          }
        } else if (!responseSucceeded(created)) {
          setupError = responseError(created)
          promptError = responseError(created)
          promptStatus = 'error'
        } else if (readRecord(created, 'data')?.['cancelled'] === true) {
          setupError = 'OMP cancelled the requested new session'
          promptError = setupError
          promptStatus = 'error'
        }
      }
      if (!isSignalAborted(controller.signal) && promptStatus === undefined) {
        const state = await command(STATE_COMMAND_ID, 'get_state')
        if (state === undefined) {
          setupError = 'OMP RPC closed before get_state completed'
          if (!isSignalAborted(controller.signal)) {
            streamError ??= setupError
            promptError = setupError
            promptStatus = 'error'
          }
        } else if (!responseSucceeded(state)) {
          setupError = responseError(state)
          promptError = responseError(state)
          promptStatus = 'error'
        } else {
          const data = readRecord(state, 'data')
          const sessionId = data === undefined ? undefined : readString(data, 'sessionId')
          if (sessionId === undefined || sessionId === '') {
            setupError = 'OMP RPC did not report a session id'
            promptError = setupError
            promptStatus = 'error'
          } else {
            const event = projection.bindSession(sessionId, nowIso())
            if (event !== undefined) queue.emit(event)
          }
        }
      }
      if (!isSignalAborted(controller.signal) && promptStatus === undefined) {
        promptSent = true
        writeFrame({ id: PROMPT_COMMAND_ID, type: 'prompt', message: request.prompt })
      } else {
        closeInput()
      }
    }

    if (promptSent && promptStatus === undefined) {
      while (true) {
        const line = await nextLine()
        if (line === undefined) break
        const record = isRecord(line.value) ? line.value : undefined
        const type = record === undefined ? undefined : readString(record, 'type')
        if (record !== undefined && type === 'response' && readString(record, 'id') === PROMPT_COMMAND_ID) {
          if (!responseSucceeded(record)) {
            promptError = responseError(record)
            promptStatus = 'error'
            promptTerminal = true
            closeInput()
          } else {
            const data = readRecord(record, 'data')
            if (data?.['agentInvoked'] === false) {
              localPrompt = true
              promptStatus = 'completed'
              promptTerminal = true
              closeInput()
            }
          }
          continue
        }
        if (record !== undefined && type === 'prompt_result' && readString(record, 'id') === PROMPT_COMMAND_ID) {
          promptStatus = promptStatusOf(readString(record, 'status'))
          promptError = promptErrorOf(record)
          promptSessionSettled = record['sessionSettled'] === true
          promptTerminal = true
          if (promptStatus !== 'completed' ||  promptSessionSettled || sessionSettledEvent) closeInput()
          continue
        }
        if (type === 'session_settled') {
          sessionSettledEvent = true
          promptSessionSettled = true
          if (promptTerminal) closeInput()
          continue
        }
        observeLine(line)
      }
    }

    if (!inputClosed) closeInput()
    const stderrTail = await readStderr()
    const exit = await child.exit
    controller.abort('OMP RPC process ended')
    uiRequestIds.clear()
    await Promise.all(pendingUiRequests)
    const state = projection.state()
    const result = resultFromExit({
      context,
      request,
      startedMs,
      startedAt,
      exit,
      stderrTail,
      promptStatus,
      promptError,
      setupError,
      localPrompt,
      cancelReason,
      cancelRequested,
      abortWriteError,
      uiCancelWriteError,
      uiResponseError,
      malformedLines,
      streamError,
      state,
    })
    finish(result)

    async function nextLine(): Promise<OmpRpcLine | undefined> {
      while (true) {
        let next: IteratorResult<string>
        try {
          next = await iterator.next()
        } catch (cause) {
          streamError ??= `stdout could not be read: ${errorText(cause)}`
          return undefined
        }
        if (next.done) return undefined
        const raw = next.value
        if (raw.trim() === '') continue
        const parsed = parseOmpRunLine(raw)
        if (!parsed.ok) {
          malformedLines += 1
          projection.addNote(`stdout line was not valid JSON (${parsed.error})`)
          continue
        }
        return { value: parsed.value, raw }
      }
    }

    async function command(id: string, type: string): Promise<Record<string, unknown> | undefined> {
      writeFrame({ id, type })
      while (true) {
        const line = await nextLine()
        if (line === undefined) return undefined
        const record = isRecord(line.value) ? line.value : undefined
        if (record !== undefined && readString(record, 'type') === 'response' && readString(record, 'id') === id) {
          return record
        }
        observeLine(line)
      }
    }

    function queueUiRequest(record: Record<string, unknown>): void {
      const work = answerUiRequest(record).catch((cause: unknown) => {
        uiResponseError ??= `OMP UI response failed: ${errorText(cause)}`
        streamError ??= uiResponseError
        queue.emit(projection.warn(uiResponseError, nowIso()))
        child?.cancel('OMP UI response failed')
      })
      pendingUiRequests.add(work)
      void work.then(() => { pendingUiRequests.delete(work) })
    }

    async function answerUiRequest(record: Record<string, unknown>): Promise<void> {
      const id = readString(record, 'id')
      const method = readString(record, 'method') ?? 'unknown'
      if (id === undefined) {
        queue.emit(projection.warn(`OMP ${method} UI request had no response id`, nowIso()))
        return
      }
      if (method !== 'confirm' && method !== 'select') {
        if (method === 'input' || method === 'editor' || method === 'ask') {
          writeFrame({ type: 'extension_ui_response', id, cancelled: true })
        }
        queue.emit(projection.warn(`OMP requested unsupported interactive ${method} input; DSH declined the request`, nowIso()))
        return
      }

      const options = record['options']
      const allowedOption = method === 'select' ? permissionOption(options, true) : undefined
      const rejectedOption = method === 'select' ? permissionOption(options, false) : undefined
      if (method === 'select' && (allowedOption === undefined || rejectedOption === undefined)) {
        writeFrame({ type: 'extension_ui_response', id, cancelled: true })
        queue.emit(projection.warn('OMP requested a selection without explicit one-shot allow and deny choices; DSH declined it', nowIso()))
        return
      }

      const title = approvalText(readString(record, 'title') ?? 'OMP requested confirmation', 256)
      const detailParts = [readString(record, 'message'), readString(record, 'toolName')]
      if (method === 'select' && Array.isArray(options)) {
        detailParts.push(`choices: ${options.filter((option: unknown): option is string => typeof option === 'string').join(', ')}`)
      }
      const detail = approvalText(detailParts.filter((part): part is string => part !== undefined).join('\n'), 4_096)
      uiRequestIds.add(id)
      let outcome: AgentRunApprovalOutcome = 'unavailable'
      try {
        if (request.requestApproval !== undefined && !controller.signal.aborted) {
          outcome = await request.requestApproval({ kind: 'interaction', title, detail, signal: controller.signal })
        }
      } catch (cause: unknown) {
        host.log('warn', `OMP DSH approval failed: ${errorText(cause)}`)
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
        queue.emit(projection.warn(`OMP ${method} request was declined because DSH approval was unavailable`, nowIso()))
      }
      writeFrame({ type: 'extension_ui_response', id, ...response })
    }

    function observeLine(line: OmpRpcLine): void {
      const record = isRecord(line.value) ? line.value : undefined
      const type = record === undefined ? undefined : readString(record, 'type')
      if (type === 'ready' || type === 'response' || type === 'session_settled') return
      if (type === 'available_commands_update' || type === 'advisor_cost_changed' || type === 'advisor_yielded') return
      if (type === 'extension_ui_request') {
        /* v8 ignore next -- type is derived from this non-null record immediately above. */
        if (record !== undefined) queueUiRequest(record)
        return
      }
      for (const event of projection.observe(line.value, line.raw, nowIso())) queue.emit(event)
    }

    function readStderr(): Promise<string> {
      return process.stderr().then(
        text => boundOmpDiagnostic(text.trim()),
        (cause: unknown) => {
          streamError ??= `stderr could not be read: ${errorText(cause)}`
          return ''
        },
      )
    }
  }

  producer().catch(async (cause: unknown) => {
    const error = errorText(cause)
    host.log('warn', `omp RPC run producer failed: ${error}`)
    cancelUiRequests()
    controller.abort('OMP RPC run failed')
    if (child !== undefined) {
      try {
        child.cancel('OMP RPC run failed')
      } catch (cancelCause) {
        host.log('warn', `omp RPC process termination failed: ${errorText(cancelCause)}`)
      }
      await child.exit
    }
    try {
      while (!(await iterator.next()).done) {
        // Drain stdout to let the managed process and its readers settle.
      }
    } catch (drainCause) {
      host.log('warn', `omp RPC stdout drain failed: ${errorText(drainCause)}`)
    }
    await Promise.all(pendingUiRequests)
    if (cancelRequested) {
      finishCancelled()
      return
    }
    finish(failed(
      'run/protocol-error',
      'the run ended without a terminal result',
      'Re-dispatch the run; if it repeats, capture the OMP RPC stdout stream for diagnosis.',
    ))
  })

  return {
    id: context.runId,
    result: queue.result,
    cancel,
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  }

  function nowIso(): string {
    return new Date(host.now()).toISOString()
  }

  function finishCancelled(): void {
    const notes = cancelReason === undefined ? [] : [`cancelled by the caller: ${cancelReason}`]
    const stateNotes = [...projection.state().notes]
    finish({
      runId: context.runId,
      agentId: context.agentId,
      status: 'cancelled',
      startedAt,
      finishedAt: nowIso(),
      durationMs: host.now() - startedMs,
      cwd: request.cwd,
      error: { code: 'run/cancelled', message: 'the run was cancelled', remediation: 'Nothing to do; OMP stopped on request.' },
      notes: [...stateNotes, ...notes],
    })
  }

  /** Read cancellation after asynchronous work without retaining an obsolete narrowing. */
  function isSignalAborted(signal: AbortSignal): boolean {
    return signal.aborted
  }
}

/** Convert the final RPC and process state into one mesh run result. */
function resultFromExit(args: {
  readonly context: OmpRunContext
  readonly request: AgentRunRequest
  readonly startedMs: number
  readonly startedAt: string
  readonly exit: HostExit
  readonly stderrTail: string
  readonly promptStatus: OmpPromptStatus | undefined
  readonly promptError: string | undefined
  readonly setupError: string | undefined
  readonly localPrompt: boolean
  readonly cancelReason: string | undefined
  readonly cancelRequested: boolean
  readonly abortWriteError: string | undefined
  readonly uiCancelWriteError: string | undefined
  readonly uiResponseError: string | undefined
  readonly malformedLines: number
  readonly streamError: string | undefined
  readonly state: ReturnType<OmpRunProjection['state']>
}): AgentRunResult {
  const { context, request, startedMs, startedAt, exit, stderrTail, state } = args
  let status: AgentRunStatus = 'succeeded'
  let error: AgentRunResult['error']
  if (args.uiResponseError !== undefined) {
    status = 'failed'
    error = {
      code: 'run/protocol-error',
      message: args.uiResponseError,
      remediation: 'Re-dispatch the run; if it repeats, capture the OMP RPC stdout stream for diagnosis.',
    }
  } else if (exit.timedOut) {
    status = 'timeout'
    error = {
      code: 'run/timeout',
      message: `the run exceeded ${request.timeoutMs === undefined ? 'its configured budget' : `its ${String(request.timeoutMs)} ms budget`}`,
      remediation: 'Raise the run timeout, or split the task into smaller runs.',
    }
  } else if (args.cancelRequested || exit.cancelled || args.promptStatus === 'aborted' || state.aborted) {
    status = 'cancelled'
    error = { code: 'run/cancelled', message: 'OMP aborted the turn', remediation: 'Nothing to do; the turn stopped on request.' }
  } else if (exit.code !== null && exit.code !== 0) {
    status = 'failed'
    error = classifyOmpExit(exit.code, stderrTail)
  } else if (exit.code === null && exit.signal === null) {
    status = 'failed'
    error = {
      code: 'run/start-failed',
      message: `omp could not be started in ${request.cwd}`,
      remediation: 'Check that the omp binary exists and is executable, and that the working directory exists.',
    }
  } else if (exit.code === null) {
    status = 'failed'
    error = {
      code: 'run/agent-crashed',
      message: `omp was terminated by signal ${String(exit.signal)}`,
      remediation: 'Inspect the attached stderr tail; the RPC child may have been killed before completing the turn.',
    }
  } else if (args.setupError !== undefined) {
    status = 'failed'
    error = {
      code: 'run/context-unavailable',
      message: args.setupError,
      remediation: 'Check the session id and the OMP store; RPC did not report a session for this run.',
    }
  } else if (args.promptStatus === 'error' || state.lastStopReason === 'error') {
    status = 'failed'
    const failure = args.promptError ?? state.lastErrorMessage ?? 'the assistant response failed'
    error = {
      ...classifyOmpExit(1, failure),
      message: failure,
    }
  } else if (state.sessionId === undefined) {
    status = 'failed'
    error = {
      code: 'run/context-unavailable',
      message: 'omp exited without establishing a session',
      remediation: 'Check the session id and the OMP store; RPC did not report a session for this run.',
    }
  } else if (args.promptStatus === undefined && !args.localPrompt) {
    status = 'failed'
    error = {
      code: 'run/protocol-error',
      message: args.streamError ?? 'OMP RPC ended before the prompt reached a terminal state',
      remediation: 'Re-dispatch the run; if it repeats, capture the OMP RPC stdout stream for diagnosis.',
    }
  }

  const notes = [...state.notes]
  if (args.cancelReason !== undefined) notes.push(`cancelled by the caller: ${args.cancelReason}`)
  if (args.abortWriteError !== undefined) {
    notes.push(`OMP's abort command could not be delivered; the child was terminated: ${args.abortWriteError}`)
  }
  if (args.uiCancelWriteError !== undefined) {
    notes.push(`OMP's UI cancellation response could not be delivered: ${args.uiCancelWriteError}`)
  }
  if (request.timeoutMs !== undefined && exit.timedOut) notes.push(`the run was killed after ${String(request.timeoutMs)} ms`)
  if (args.malformedLines > 0) notes.push(`${String(args.malformedLines)} stdout line(s) were not valid JSON and are recorded as notes`)
  if (args.streamError !== undefined) notes.push(`the OMP RPC stream ended abnormally: ${args.streamError}`)
  if (state.sessionId !== undefined && !state.settled && status === 'succeeded') {
    notes.push('the stream ended before omp reported a terminal agent_end, so the turn may not have finished')
  }

  return {
    runId: context.runId,
    agentId: context.agentId,
    status,
    startedAt,
    finishedAt: new Date(context.host.now()).toISOString(),
    durationMs: context.host.now() - startedMs,
    cwd: request.cwd,
    ...(exit.code === null ? {} : { exitCode: exit.code }),
    ...(exit.signal === null ? {} : { signal: exit.signal }),
    ...(state.finalText === undefined ? {} : { finalText: state.finalText }),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    ...(state.sessionId === undefined ? {} : { nativeSessionKey: sessionKey(context.agentId, state.sessionId) }),
    ...(error === undefined ? {} : { error: { ...error, ...(stderrTail === '' ? {} : { output: stderrTail }) } }),
    notes,
  }
}

/** Whether OMP acknowledged one RPC command successfully. */
function responseSucceeded(response: Record<string, unknown>): boolean {
  return response['success'] === true
}

/** Error text returned by one failed OMP RPC response. */
function responseError(response: Record<string, unknown>): string {
  return readString(response, 'error') ?? 'OMP rejected an RPC command'
}

/** Read the terminal prompt failure, when OMP included one. */
function promptErrorOf(frame: Record<string, unknown>): string | undefined {
  const error = readRecord(frame, 'error')
  return error === undefined ? undefined : readString(error, 'message')
}

/** Bound one DSH-visible native UI detail and remove control characters. */
function approvalText(value: string, maxBytes: number): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ')
  const bytes = Buffer.from(clean, 'utf8')
  if (bytes.byteLength <= maxBytes) return clean
  return `${bytes.subarray(0, maxBytes).toString('utf8')}…`
}

/** Find only an explicitly one-shot permission choice in an OMP selector. */
function permissionOption(options: unknown, allowed: boolean): string | undefined {
  if (!Array.isArray(options)) return undefined
  const labels = allowed
    ? new Set(['allow', 'allow once', 'approve', 'approve once', 'accept', 'accept once', '允许', '允许一次', '批准', '批准一次'])
    : new Set(['deny', 'reject', 'cancel', 'block', 'decline', '拒绝', '取消', '不允许'])
  return options.find((option: unknown): option is string => typeof option === 'string'
    && labels.has(option.trim().normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ')))
}

/** Narrow a remote prompt status to the values OMP documents. */
function promptStatusOf(value: string | undefined): OmpPromptStatus | undefined {
  switch (value) {
    case 'completed':
    case 'aborted':
    case 'error':
      return value
    default:
      return undefined
  }
}

/** Describe a thrown value without assuming it is an Error instance. */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
