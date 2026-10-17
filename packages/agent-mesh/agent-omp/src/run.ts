/**
 * `omp --mode json` dispatch and event projection.
 *
 * One native record per line: the session header first, then one OMP `AgentSessionEvent`
 * per line, serialized through OMP's printable-event shape (the `message_update` partial
 * snapshots and the provider replay payload are stripped; each incremental delta stays).
 * One native record becomes zero or more mesh run events, and one process exit becomes one
 * classified run result. A native type this module does not model is preserved as
 * `kind: 'unknown'` with its raw JSON rather than dropped, so an OMP protocol revision
 * degrades into a visible gap.
 *
 * Two OMP shape facts shape the code: `message_update` in JSON mode carries only the
 * delta, so `toolcall_start` cannot name the tool and the authoritative announcement is
 * `tool_execution_start`; and OMP's idle boundary is `agent_end` with
 * `isTerminal !== false`.
 *
 * The reference adapter's `--approval-mode` vocabulary, argv order, stdin prompt, derived
 * child environment and exit classification are ported verbatim; the mesh run-request
 * union has no `isolation` field and this adapter's Config has no default-model or
 * timeout field, so those reference settings have no counterpart here (see the README).
 * @module @deepseek-ai/dsh-agent-omp/run
 */

import type {
  AgentHost,
  AgentId,
  AgentRun,
  AgentRunEvent,
  AgentRunId,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  AgentTodoStatus,
  AgentUsage,
  HostProcess,
} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolve as resolvePath } from 'node:path'
import type { ResolvedOmpConfig } from './config.ts'
import { OMP_APPROVAL_MODES, splitOmpModel } from './detect.ts'
import {
  findOmpSessionFile,
  isRecord,
  readArray,
  readNumber,
  readOmpSessionHeader,
  readOmpSessionLeadAt,
  readRecord,
  readString,
  sessionKey,
  type OmpSessionHeader,
  type OmpStoreLayout,
} from './sessions.ts'

/** Cap on any single text field copied out of a native record into a run event. */
export const MAX_EVENT_TEXT_BYTES = 8 * 1024

/** Non-terminal events the run queue holds before it starts dropping the oldest. */
export const DEFAULT_MAX_PENDING_EVENTS = 4_096

/** Cap on the stderr tail carried in a run's error record. */
const ERROR_OUTPUT_CHARS = 2_000

/** Run state the projection accumulates for the terminal result. */
export interface OmpRunState {
  /** Native session id from the header, once it has been seen. */
  readonly sessionId?: string
  /** Header of the session this run wrote into. */
  readonly header?: OmpSessionHeader
  /** Assistant text of the last completed message. */
  readonly finalText?: string
  /** Usage summed over completed assistant messages. */
  readonly usage?: AgentUsage
  /** `stopReason` of the last completed assistant message. */
  readonly lastStopReason?: string
  /** Provider message of the last failed assistant message, verbatim. */
  readonly lastErrorMessage?: string
  /** Whether OMP reported a terminal (non-continuing) `agent_end`. */
  readonly settled: boolean
  /** Whether the last turn ended aborted rather than stopping cleanly. */
  readonly aborted: boolean
  /** Tool calls completed. */
  readonly toolCalls: number
  /** Tool calls that finished with an error. */
  readonly toolFailures: number
  /** Cache-write tokens, which the mesh usage type cannot carry. */
  readonly cacheWriteTokens: number
  /** Projection gaps worth recording on the run result. */
  readonly notes: readonly string[]
}

/** Options for {@link OmpRunProjection}. */
export interface OmpRunProjectionOptions {
  /** Run id echoed on every emitted event. */
  readonly runId: AgentRunId
}

/**
 * Stateful projection of one `omp --mode json` stream.
 *
 * The projection is single-run state: one instance per dispatched run.
 */
export class OmpRunProjection {
  private readonly runId: AgentRunId
  private readonly runState: {
    sessionId?: string
    header?: OmpSessionHeader
    finalText?: string
    usage?: AgentUsage
    lastStopReason?: string
    lastErrorMessage?: string
    settled: boolean
    aborted: boolean
    toolCalls: number
    toolFailures: number
    cacheWriteTokens: number
    notes: string[]
  } = {
    settled: false,
    aborted: false,
    toolCalls: 0,
    toolFailures: 0,
    cacheWriteTokens: 0,
    notes: [],
  }

  private readonly usageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    costUsd: 0,
  }

  /**
   * @param options - Run identity.
   */
  constructor(options: OmpRunProjectionOptions) {
    this.runId = options.runId
  }

  /**
   * A read-only snapshot of the accumulated state.
   * @returns the state as of this call.
   */
  state(): OmpRunState {
    return this.runState
  }

  /**
   * Bind a session whose identity came from OMP's RPC state response.
   * @param sessionId - Native session id.
   * @param at - ISO 8601 time to stamp on the event.
   * @returns the session event, or undefined when the same session is already bound.
   */
  bindSession(sessionId: string, at: string): AgentRunEvent | undefined {
    if (this.runState.sessionId === sessionId) return undefined
    this.runState.sessionId = sessionId
    return { kind: 'session.bound', runId: this.runId, at, nativeSessionId: sessionId }
  }

  /**
   * Map one stdout record.
   *
   * @param value - Decoded JSON record; a malformed line never reaches this method.
   * @param raw - The raw line, bounded, for `unknown` projection.
   * @param at - ISO 8601 time to stamp on emitted events.
   * @returns the events to emit, in order; empty for a declared no-op.
   */
  observe(value: unknown, raw: string, at: string): readonly AgentRunEvent[] {
    const header = readOmpSessionHeader(value)
    if (header !== undefined) {
      this.runState.header = header
      this.runState.sessionId = header.id
      const unprojected = [
        header.cwd === '' ? undefined : 'cwd',
        header.parentSession === undefined ? undefined : 'parentSession',
        header.version === undefined ? undefined : 'version',
        header.title === undefined ? undefined : 'title',
      ].filter((field): field is string => field !== undefined)
      if (unprojected.length > 0) {
        this.addNote(`the session header also records ${unprojected.join(', ')}, which session.bound has no field for`)
      }
      return [{ kind: 'session.bound', runId: this.runId, at, nativeSessionId: header.id }]
    }
    if (!isRecord(value)) {
      // A JSON line that is not an object (for example a bare `null`) is preserved.
      return [this.unknown(undefined, raw, at)]
    }

    const type = readString(value, 'type')
    if (type === undefined) {
      this.addNote('a stdout record had no event type and was preserved as an unknown event')
      return [this.unknown(undefined, raw, at)]
    }

    switch (type) {
      case 'message_update':
        return this.mapMessageUpdate(value, raw, at)
      case 'message_end':
        return this.mapMessageEnd(value, raw, at)
      case 'tool_execution_start': {
        const callId = readString(value, 'toolCallId')
        const args = value['args']
        return [
          {
            kind: 'tool.started',
            runId: this.runId,
            at,
            ...(callId === undefined ? {} : { callId }),
            toolName: readString(value, 'toolName') ?? 'tool',
            ...(args === undefined ? {} : { input: boundedJson(args) }),
          },
        ]
      }
      case 'tool_execution_end': {
        this.runState.toolCalls += 1
        const failed = value['isError'] === true
        if (failed) this.runState.toolFailures += 1
        const result = value['result']
        const callId = readString(value, 'toolCallId')
        return [
          {
            kind: 'tool.completed',
            runId: this.runId,
            at,
            ...(callId === undefined ? {} : { callId }),
            toolName: readString(value, 'toolName') ?? 'tool',
            ...(result === undefined ? {} : { output: boundedJson(result) }),
            ...(failed ? { failed: true } : {}),
          },
        ]
      }
      case 'todo_reminder': {
        const todos = (readArray(value, 'todos') ?? [])
          .map(item => (isRecord(item) ? { content: readString(item, 'content'), status: readString(item, 'status') } : undefined))
          .filter(
            (item): item is { readonly content: string; readonly status: string } =>
              item !== undefined && item.content !== undefined && item.status !== undefined,
          )
        if (todos.length === 0) return [this.unknown(type, raw, at)]
        return [
          {
            kind: 'todos.updated',
            runId: this.runId,
            at,
            todos: todos.map(todo => ({ content: todo.content, status: todoStatusOf(todo.status) })),
          },
        ]
      }
      case 'todo_auto_clear':
        return [{ kind: 'todos.updated', runId: this.runId, at, todos: [] }]
      case 'auto_compaction_start':
        return [
          this.warning(
            `omp started compacting the conversation (${readString(value, 'action') ?? 'unknown'} action, ` +
              `${readString(value, 'reason') ?? 'unknown'} reason)`,
            at,
          ),
        ]
      case 'auto_compaction_end': {
        if (value['aborted'] === true) return []
        const errorMessage = readString(value, 'errorMessage')
        if (errorMessage === undefined) return []
        this.addNote(`omp's compaction failed: ${errorMessage}`)
        return [this.warning(`omp's compaction failed: ${errorMessage}`, at)]
      }
      case 'auto_retry_start': {
        const attempt = readNumber(value, 'attempt')
        const max = readNumber(value, 'maxAttempts')
        const message = readString(value, 'errorMessage') ?? 'provider error'
        return [
          this.warning(
            `omp is retrying after ${message} (attempt ${attempt === undefined ? '?' : String(attempt)}/${max === undefined ? '?' : String(max)})`,
            at,
          ),
        ]
      }
      case 'auto_retry_end': {
        if (value['success'] === true) return []
        const finalError = readString(value, 'finalError') ?? 'the retry budget was exhausted'
        this.addNote(`omp's automatic retry failed: ${finalError}`)
        return [this.warning(`omp's automatic retry failed: ${finalError}`, at)]
      }
      case 'retry_fallback_applied': {
        const from = readString(value, 'from') ?? 'the configured model'
        const to = readString(value, 'to') ?? 'a fallback model'
        const reason = readString(value, 'reason')
        return [this.warning(`omp switched from ${from} to ${to}${reason === undefined ? '' : ` (${reason})`}`, at)]
      }
      case 'notice': {
        const level = readString(value, 'level') ?? 'info'
        const message = readString(value, 'message') ?? 'a session notice'
        const source = readString(value, 'source')
        return [this.warning(`omp ${level} notice${source === undefined ? '' : ` from ${source}`}: ${message}`, at)]
      }
      case 'agent_end': {
        // OMP's idle boundary: `isTerminal` is false only while the session resumes its
        // own work (retry, compaction continuation, a scheduled follow-up).
        if (value['isTerminal'] !== false) this.runState.settled = true
        return []
      }
      // Lifecycle records with no content and no consumer-visible state.
      case 'agent_start':
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'queue_update':
      case 'tool_execution_update':
      case 'tool_stream_update':
      case 'config_warnings_changed':
      case 'advisor_cost_changed':
      case 'advisor_yielded':
        return []
      // Records OMP models as state but the mesh run-event union cannot carry.
      case 'thinking_level_changed':
      case 'model_changed':
      case 'ttsr_triggered':
      case 'goal_updated':
      case 'irc_message':
      case 'cache_warming_start':
      case 'cache_warming_end':
      case 'retry_fallback_succeeded':
        return [this.unknown(type, raw, at)]
      default:
        this.addNote(`an unrecognized omp event type (${type}) was preserved as an unknown event`)
        return [this.unknown(type, raw, at)]
    }
  }

  /**
   * Record a diagnostic the run loop detected outside the stream.
   *
   * @param message - What happened, phrased for a human.
   * @param at - ISO 8601 time to stamp on the event.
   * @returns the warning event to emit.
   */
  warn(message: string, at: string): AgentRunEvent {
    return this.warning(message, at)
  }

  /**
   * Record a projection gap on the terminal result.
   *
   * @param text - One line describing the gap.
   */
  addNote(text: string): void {
    if (!this.runState.notes.includes(text)) this.runState.notes.push(text)
  }

  /** Map `message_update`, which carries delta-only content in JSON mode. */
  private mapMessageUpdate(value: Record<string, unknown>, raw: string, at: string): readonly AgentRunEvent[] {
    const deltaEvent = readRecord(value, 'assistantMessageEvent')
    if (deltaEvent === undefined) return [this.unknown('message_update', raw, at)]
    const deltaType = readString(deltaEvent, 'type')
    switch (deltaType) {
      case 'text_delta': {
        const text = readString(deltaEvent, 'delta')
        return text === undefined ? [] : [{ kind: 'message.delta', runId: this.runId, at, text: capEventText(text) }]
      }
      case 'thinking_delta': {
        const text = readString(deltaEvent, 'delta')
        return text === undefined ? [] : [{ kind: 'reasoning.delta', runId: this.runId, at, text: capEventText(text) }]
      }
      case 'error': {
        const reason = readString(deltaEvent, 'reason') ?? 'error'
        this.runState.lastStopReason = reason
        this.runState.aborted = reason === 'aborted'
        return [this.warning(`the assistant response failed (${reason})`, at)]
      }
      case 'done':
        // `message_end` carries the authoritative message and its usage.
        return []
      case 'start':
      case 'text_start':
      case 'text_end':
      case 'thinking_start':
      case 'thinking_end':
      case 'image_end':
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end':
        // `toolcall_*` deltas cannot name the tool in JSON mode (`partial` is stripped),
        // so `tool_execution_start` is the one announcement per call.
        return []
      default:
        return [this.unknown(deltaType === undefined ? 'message_update' : `message_update:${deltaType}`, raw, at)]
    }
  }

  /** Map `message_end`, the authoritative message boundary. */
  private mapMessageEnd(value: Record<string, unknown>, raw: string, at: string): readonly AgentRunEvent[] {
    const message = readRecord(value, 'message')
    if (message === undefined) return [this.unknown('message_end', raw, at)]
    switch (readString(message, 'role') ?? '') {
      case 'assistant': {
        const events: AgentRunEvent[] = []
        const text = assistantText(message)
        if (text !== undefined && text !== '') {
          this.runState.finalText = text
          events.push({ kind: 'message.completed', runId: this.runId, at, text: capEventText(text) })
        }
        const stopReason = readString(message, 'stopReason')
        if (stopReason !== undefined) {
          this.runState.lastStopReason = stopReason
          this.runState.aborted = stopReason === 'aborted'
        }
        const errorMessage = readString(message, 'errorMessage')
        if (errorMessage !== undefined && errorMessage !== '') {
          this.runState.lastErrorMessage = errorMessage
          events.push(this.warning(`omp reported: ${errorMessage}`, at))
        }
        const usage = this.accumulateUsage(readRecord(message, 'usage'))
        if (usage !== undefined) events.push({ kind: 'usage.updated', runId: this.runId, at, usage })
        return events
      }
      case 'user':
      case 'toolResult':
      case 'bashExecution':
      case 'pythonExecution':
      case 'fileMention':
      case 'developer':
      case 'custom':
      case 'hookMessage':
        // Records the transcript reader projects; the run stream already announced the
        // tool work they describe, and the prompt echo is text the caller sent itself.
        return []
      default:
        return [this.unknown('message_end', raw, at)]
    }
  }

  /** Add a native `Usage` record to the run totals and project the running total. */
  private accumulateUsage(usage: Record<string, unknown> | undefined): AgentUsage | undefined {
    if (usage === undefined) return undefined
    const totals = this.usageTotals
    totals.input += readNumber(usage, 'input') ?? 0
    totals.output += readNumber(usage, 'output') ?? 0
    totals.cacheRead += readNumber(usage, 'cacheRead') ?? 0
    totals.cacheWrite += readNumber(usage, 'cacheWrite') ?? 0
    totals.totalTokens += readNumber(usage, 'totalTokens') ?? 0
    const reasoning = readNumber(usage, 'reasoningTokens')
    if (reasoning !== undefined) totals.reasoning += reasoning
    const cost = readRecord(usage, 'cost')
    const costUsd = cost === undefined ? undefined : readNumber(cost, 'total')
    if (costUsd !== undefined) totals.costUsd += costUsd
    this.runState.cacheWriteTokens = totals.cacheWrite
    if (totals.cacheWrite > 0) {
      this.addNote('omp reports cache-write tokens, which the mesh usage type cannot carry')
    }
    const projected: AgentUsage = {
      inputTokens: totals.input,
      outputTokens: totals.output,
      cachedInputTokens: totals.cacheRead,
      totalTokens: totals.totalTokens,
      ...(totals.reasoning > 0 ? { reasoningTokens: totals.reasoning } : {}),
      ...(totals.costUsd > 0 ? { costUsd: totals.costUsd } : {}),
    }
    this.runState.usage = projected
    return projected
  }

  /** Build a `warning` event. */
  private warning(message: string, at: string): AgentRunEvent {
    return { kind: 'warning', runId: this.runId, at, message }
  }

  /** Build an `unknown` event preserving an unmodelled native record. */
  private unknown(nativeType: string | undefined, raw: string, at: string): AgentRunEvent {
    return {
      kind: 'unknown',
      runId: this.runId,
      at,
      ...(nativeType === undefined ? {} : { nativeType }),
      native: capEventText(raw),
    }
  }
}

/** The concatenated text blocks of an assistant message record. */
function assistantText(message: Record<string, unknown>): string | undefined {
  const content = message['content']
  if (typeof content === 'string') return content
  const blocks = readArray(message, 'content')
  if (blocks === undefined) return undefined
  const parts: string[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (readString(block, 'type') !== 'text') continue
    const text = readString(block, 'text')
    if (text !== undefined) parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/**
 * OMP's todo status vocabulary mapped onto the mesh run event's status vocabulary.
 *
 * @param status - Native status, verbatim.
 * @returns the mesh status; an unrecognized native status is `pending`.
 */
function todoStatusOf(status: string): AgentTodoStatus {
  switch (status) {
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked'
    case 'abandoned':
      return 'cancelled'
    default:
      return 'pending'
  }
}

/** Serialize a native value for a mesh string field, bounded. */
function boundedJson(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'function' || typeof value === 'symbol' ? String(value) : JSON.stringify(value)
  } catch {
    text = '<unserializable>'
  }
  return capEventText(text)
}

/**
 * Truncate a native string to the event cap.
 * @param text - Native text.
 * @returns the text, marked when it was cut.
 */
export function capEventText(text: string): string {
  if (text.length <= MAX_EVENT_TEXT_BYTES) return text
  return `${text.slice(0, MAX_EVENT_TEXT_BYTES)}\n[truncated by dsh-agent-omp at ${String(MAX_EVENT_TEXT_BYTES)} characters]`
}

/** Everything one dispatched run needs from the adapter. */
export interface OmpRunContext {
  /** Host providing the filesystem, the clock and process spawning. */
  readonly host: AgentHost
  /** Resolved adapter configuration. */
  readonly config: ResolvedOmpConfig
  /** Resolved store layout. */
  readonly layout: OmpStoreLayout
  /** Owning agent id. */
  readonly agentId: AgentId
  /** Identity of this run. */
  readonly runId: AgentRunId
}

/**
 * Dispatch one `omp --mode json` run.
 *
 * The returned handle is live immediately: its producer resolves a resume target, builds
 * the argv and the derived environment, starts the child and projects its stream. A
 * failure in any of those steps still settles `result` with a classified terminal record
 * rather than rejecting it.
 *
 * @param context - Host, configuration, layout and identity of the run.
 * @param request - What the caller asked to run.
 * @returns the live run handle.
 */
export function startOmpJsonRun(context: OmpRunContext, request: AgentRunRequest): AgentRun {
  const host = context.host
  const queue = new RunEventQueue()
  const startedMs = host.now()
  const startedAt = new Date(startedMs).toISOString()
  const controller = new AbortController()
  let cancelReason: string | undefined
  let process: HostProcess | undefined

  const finish = (result: AgentRunResult): void => {
    queue.emit({ kind: 'run.finished', runId: context.runId, at: result.finishedAt, result })
  }

  const failed = (
    code: string,
    message: string,
    remediation: string,
  ): AgentRunResult => {
    const finishedAt = new Date(host.now()).toISOString()
    return {
      runId: context.runId,
      agentId: context.agentId,
      status: 'failed',
      startedAt,
      finishedAt,
      durationMs: host.now() - startedMs,
      cwd: request.cwd,
      error: { code, message, remediation },
      notes: [],
    }
  }

  const producer = async (): Promise<void> => {
    queue.emit({ kind: 'run.started', runId: context.runId, agentId: context.agentId, at: startedAt })
    const projection = new OmpRunProjection({ runId: context.runId })
    const binary = context.config.binaryPath ?? 'omp'
    const resume = await resolveOmpResume(host, context.layout, request.resumeNativeId, request.cwd)
    if (context.layout.profile !== undefined && context.config.homeDir !== undefined) {
      // A named profile derives its own agent directory and ignores PI_CODING_AGENT_DIR, so
      // the run's environment selects the default profile for the override to take effect.
      projection.addNote(
        `the host environment selects profile "${context.layout.profile}", which would ignore the adapter's homeDir ` +
          'override, so the run was started with the default profile selected',
      )
    }
    if (resume.warning !== undefined) {
      projection.addNote(resume.warning)
      queue.emit(projection.warn(resume.warning, new Date(host.now()).toISOString()))
    }
    if (request.prompt.trim() === '') {
      // OMP's print mode sends nothing and exits 0 when it receives neither argv nor
      // stdin content, so an empty prompt would look like a successful no-op turn.
      projection.addNote('the prompt was empty, so omp was started with nothing to send')
      queue.emit(projection.warn('the prompt is empty: omp will exit without doing work', new Date(host.now()).toISOString()))
    }
    if (request.sandbox !== undefined && request.sandbox !== '') {
      projection.addNote('omp has no sandbox, so the requested sandbox profile was ignored')
      queue.emit(
        projection.warn(
          `omp has no sandbox; the requested profile "${request.sandbox}" was ignored`,
          new Date(host.now()).toISOString(),
        ),
      )
    }
    const approval = request.approval
    if (approval !== undefined && approval !== '' && !OMP_APPROVAL_MODES.includes(approval)) {
      projection.addNote(
        `approval "${approval}" is not one of omp's modes (${OMP_APPROVAL_MODES.join(', ')}), so no ` +
          'approval flag was passed and omp uses its configured mode',
      )
    }

    const args = buildJsonRunArgs({
      ...(resume.argument === undefined ? {} : { resumeArgument: resume.argument }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(approval === undefined ? {} : { approval }),
    })
    const env = runEnvironment(context, request.env)
    const timeoutMs = request.timeoutMs
    let child: HostProcess
    try {
      child = host.spawn({
        command: binary,
        args: [...args],
        cwd: request.cwd,
        env,
        stdin: request.prompt,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
    } catch (cause) {
      finish(
        failed(
          'run/start-failed',
          `the omp process could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
          'Check that the resolved binary is executable and that the working directory exists.',
        ),
      )
      return
    }
    process = child
    if (controller.signal.aborted) child.cancel(cancelReason)

    let streamError: string | undefined
    let malformed = 0
    try {
      for await (const line of child.lines) {
        if (line.trim() === '') continue
        const at = new Date(host.now()).toISOString()
        const parsed = parseOmpRunLine(line)
        if (!parsed.ok) {
          malformed += 1
          projection.addNote(`stdout line was not valid JSON (${parsed.error})`)
          continue
        }
        for (const event of projection.observe(parsed.value, line, at)) queue.emit(event)
      }
    } catch (cause) {
      streamError = cause instanceof Error ? cause.message : String(cause)
      queue.emit(
        projection.warn(
          `reading omp's event stream failed: ${streamError}`,
          new Date(host.now()).toISOString(),
        ),
      )
    }
    let stderrText = ''
    try {
      stderrText = await child.stderr()
    } catch (cause) {
      streamError ??= `stderr could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
    }
    const exit = await child.exit
    const stderrTail = boundOmpDiagnostic(stderrText.trim())
    const state = projection.state()

    let status: AgentRunStatus = 'succeeded'
    let error: { readonly code: string; readonly message: string; readonly remediation: string } | undefined
    if (exit.cancelled) {
      status = 'cancelled'
      error = { code: 'run/cancelled', message: 'the run was cancelled', remediation: 'Nothing to do; the run stopped on request.' }
    } else if (exit.timedOut) {
      status = 'timeout'
      error = {
        code: 'run/timeout',
        message: `the run exceeded ${timeoutMs === undefined ? 'its configured budget' : `its ${String(timeoutMs)} ms budget`}`,
        remediation: 'Raise the run timeout, or split the task into smaller runs.',
      }
    } else if (exit.code === null && exit.signal === null) {
      // The host reports no exit status when the child could not be started at all (a
      // missing binary or a working directory that does not exist).
      status = 'failed'
      error = {
        code: 'run/start-failed',
        message: `omp could not be started in ${request.cwd}`,
        remediation: 'Check that the omp binary exists and is executable, and that the working directory exists.',
      }
    } else if (exit.code !== null && exit.code !== 0) {
      status = 'failed'
      error = classifyOmpExit(exit.code, stderrTail)
    } else if (exit.code === null) {
      status = 'failed'
      error = {
        code: 'run/agent-crashed',
        message: `omp was terminated by signal ${String(exit.signal)}`,
        remediation: 'Inspect the attached stderr tail; a killed provider request or an out-of-memory child are the usual causes.',
      }
    } else if (state.lastStopReason === 'error') {
      // OMP's JSON mode exits non-zero for a terminal failure, but stays 0 for a silent
      // abort (a plan-mode compaction transition), which the stream's own reason reports.
      status = 'failed'
      error = {
        code: 'run/agent-crashed',
        message: state.lastErrorMessage ?? 'the assistant response failed',
        remediation: 'Check the model and provider credentials configured for this agent; the run itself started cleanly.',
      }
    } else if (state.sessionId === undefined) {
      // No session header means OMP never established a session at all: the signature of a
      // resume it could not resolve before any turn work.
      status = 'failed'
      error = {
        code: 'run/context-unavailable',
        message: 'omp exited without starting a session and produced no events',
        remediation:
          'Check the session id and the working directory: omp resolves a resume id against the ' +
          "project's session bucket and then globally, and reports an unknown id as an error.",
      }
    } else if (state.aborted) {
      status = 'cancelled'
      error = { code: 'run/cancelled', message: 'omp aborted the turn', remediation: 'Nothing to do; the turn stopped on request.' }
    }
    if (state.sessionId !== undefined && !state.settled && status === 'succeeded') {
      projection.addNote('the stream ended before omp reported a terminal agent_end, so the turn may not have finished')
    }

    const notes: string[] = [...state.notes]
    if (cancelReason !== undefined) notes.push(`cancelled by the caller: ${cancelReason}`)
    if (timeoutMs !== undefined && exit.timedOut) notes.push(`the run was killed after ${String(timeoutMs)} ms`)
    const dropped = queue.droppedCount
    if (dropped > 0) notes.push(`${String(dropped)} event(s) were dropped because nothing was reading the stream`)
    if (malformed > 0) notes.push(`${String(malformed)} stdout line(s) were not valid JSON and are recorded as notes`)
    if (streamError !== undefined) notes.push(`the stdout stream ended abnormally: ${streamError}`)

    finish({
      runId: context.runId,
      agentId: context.agentId,
      status,
      startedAt,
      finishedAt: new Date(host.now()).toISOString(),
      durationMs: host.now() - startedMs,
      cwd: request.cwd,
      ...(exit.code === null ? {} : { exitCode: exit.code }),
      ...(exit.signal === null ? {} : { signal: exit.signal }),
      ...(state.finalText === undefined ? {} : { finalText: state.finalText }),
      ...(state.usage === undefined ? {} : { usage: state.usage }),
      ...(state.sessionId === undefined ? {} : { nativeSessionKey: sessionKey(context.agentId, state.sessionId) }),
      ...(error === undefined
        ? {}
        : {
          error: {
            ...error,
            ...(stderrTail === '' ? {} : { output: stderrTail }),
          },
        }),
      notes,
    })
  }

  producer().catch((cause: unknown) => {
    // The producer must never leave `result` pending and never reject it for a failed run:
    // a protocol failure settles the same way every other failure does.
    host.log('warn', `omp run producer failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    finish(
      failed(
        'run/protocol-error',
        'the run ended without a terminal result',
        'Re-dispatch the run; if it repeats, capture the omp stdout stream for diagnosis.',
      ),
    )
  })

  return {
    id: context.runId,
    result: queue.result,
    cancel: (reason?: string): void => {
      // Idempotent: the first caller's reason is the one the run record keeps.
      if (reason !== undefined && cancelReason === undefined) cancelReason = reason
      controller.abort()
      process?.cancel(reason)
    },
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  }
}

/** The argv inputs one run resolved. */
export interface OmpRunArgs {
  /** Resume argument OMP should receive, when the run continues a session. */
  readonly resumeArgument?: string
  /** Model override, in OMP's own naming. */
  readonly model?: string
  /** Approval mode the caller asked for, before validation. */
  readonly approval?: string
}

/**
 * Build the argv for one `omp --mode json` invocation.
 *
 * `--mode json` is the headless transport; a resume passes `--resume <id-or-path>` and
 * never silently starts a fresh session instead. A `provider/id` model is split into
 * `--provider` and `--model`; a bare pattern is passed verbatim.
 *
 * @param args - The run's resolved inputs.
 * @returns the argument vector, without the binary.
 */
export function buildJsonRunArgs(args: OmpRunArgs): readonly string[] {
  const out = ['--mode', 'json']
  if (args.resumeArgument !== undefined) out.push('--resume', args.resumeArgument)
  const model = args.model
  if (model !== undefined && model.trim() !== '') {
    // OMP accepts `provider/model` and a bare id through `--model`; `--provider` is the
    // explicit form and keeps a provider whose ids contain a slash unambiguous.
    const split = splitOmpModel(model)
    if (split.provider !== undefined) out.push('--provider', split.provider)
    out.push('--model', split.model)
  }
  const approval = args.approval
  if (approval !== undefined && OMP_APPROVAL_MODES.includes(approval)) out.push('--approval-mode', approval)
  return out
}

/**
 * The environment for a run: the variables OMP itself resolves, then the adapter's
 * configured entries, then the caller's.
 *
 * `PI_CODING_AGENT_DIR` always names the resolved agent directory. A `homeDir` override
 * is expressed through that variable, which OMP honours only for the default profile, so
 * an explicitly-empty `OMP_PROFILE` is set alongside it.
 *
 * @param context - Resolved configuration and store layout.
 * @param requestEnv - Extra entries from the run request, layered last.
 * @returns the child environment entries.
 */
export function runEnvironment(
  context: { readonly config: ResolvedOmpConfig; readonly layout: OmpStoreLayout },
  requestEnv: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string | undefined>> {
  const layout = context.layout
  return {
    PI_CODING_AGENT_DIR: layout.agentDir,
    ...(layout.sessionDirOverride === undefined ? {} : { PI_CODING_AGENT_SESSION_DIR: layout.sessionDirOverride }),
    ...(context.config.homeDir === undefined ? {} : { OMP_PROFILE: '' }),
    ...context.config.env,
    ...(requestEnv ?? {}),
  }
}

/**
 * Resolve a resume id to the argument OMP should receive, and to any warning its own
 * resolution implies.
 *
 * OMP resolves a path verbatim and an id against the project bucket first, then globally;
 * it adopts the session's recorded cwd when that directory is enterable, so a session
 * from another project continues there. That is a divergence the caller should see, not a
 * reason to refuse the resume.
 *
 * @param host - Host providing the reads.
 * @param layout - Resolved store layout.
 * @param resumeNativeId - Native session to continue, when the caller asked for one.
 * @param cwd - Working directory the caller requested.
 * @returns the resume argument and the warning its own cwd implies.
 */
export async function resolveOmpResume(
  host: AgentHost,
  layout: OmpStoreLayout,
  resumeNativeId: string | undefined,
  cwd: string,
): Promise<{ readonly argument?: string; readonly warning?: string }> {
  if (resumeNativeId === undefined || resumeNativeId === '') return {}
  const path = await findOmpSessionFile(host, layout, resumeNativeId)
  if (path === undefined) {
    // OMP's own lookup may still succeed: it falls back to a global scan by id prefix,
    // and the terminal classification catches a resume that never started a session.
    return { argument: resumeNativeId }
  }
  const header = await readOmpSessionLeadAt(host, path)
  const sessionCwd = header.header === undefined || header.header.cwd === '' ? undefined : header.header.cwd
  if (sessionCwd === undefined || resolvePath(sessionCwd) === resolvePath(cwd)) return { argument: path }
  return {
    argument: path,
    warning:
      `session ${resumeNativeId} records cwd ${sessionCwd}, which differs from the requested ${cwd}; ` +
      "omp adopts a session's recorded cwd when that directory is enterable, so the run may execute there",
  }
}

/**
 * Classify a non-zero `omp` exit from its captured stderr.
 *
 * OMP exits non-zero for a missing session, a missing credential, a provider rate limit
 * and an internal crash alike, so the captured stderr is the evidence that separates
 * them; the fallback classification is `run/agent-crashed`.
 *
 * @param code - The process exit code, non-zero.
 * @param stderr - Captured standard error, bounded by the caller.
 * @returns the mesh error code, its message, and the remediation for the human.
 */
export function classifyOmpExit(
  code: number,
  stderr: string,
): { readonly code: string; readonly message: string; readonly remediation: string } {
  if (/session .* not found|no sessions found|session file not found/i.test(stderr)) {
    return {
      code: 'run/session-not-found',
      message: 'omp could not find the requested session',
      remediation:
        "Check the session id, or resume within the session's own project directory; this adapter reads the same store omp does.",
    }
  }
  if (/no api key|invalid api key|not (logged in|authenticated)|unauthorized|\b401\b|no models available/i.test(stderr)) {
    return {
      code: 'run/auth-not-configured',
      message: `omp exited with code ${String(code)} without a usable credential`,
      remediation: 'Authenticate omp (run `omp login`, or use /login) or export the API key its models.yml names.',
    }
  }
  if (/rate.?limit|\b429\b|quota/i.test(stderr)) {
    return {
      code: 'run/rate-limited',
      message: `omp exited with code ${String(code)} after a provider rate limit`,
      remediation: 'Retry after the quota resets, or configure a different model for this agent.',
    }
  }
  return {
    code: 'run/agent-crashed',
    message: `omp exited with code ${String(code)}`,
    remediation: 'Inspect the attached stderr tail; a missing model or an unreadable extension are the usual causes.',
  }
}

/**
 * Parse one nonblank stdout line, keeping the raw text for `unknown` events.
 * @param line - JSON text from one OMP event line.
 * @returns The parsed value, or the JSON parser error.
 */
export function parseOmpRunLine(
  line: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, value: JSON.parse(line) }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Bound a diagnostic string for a run record, keeping its tail.
 * @param text - Diagnostic text to retain.
 * @returns The text or its last {@link ERROR_OUTPUT_CHARS} characters.
 */
export function boundOmpDiagnostic(text: string): string {
  return text.length > ERROR_OUTPUT_CHARS ? text.slice(text.length - ERROR_OUTPUT_CHARS) : text
}

/**
 * Mint a run identity.
 * @param host - Host providing the clock.
 * @param sequence - Monotonic per-adapter counter, so two runs in one millisecond differ.
 * @returns the branded run id.
 */
export function mintRunId(host: AgentHost, sequence: number): AgentRunId {
  return brandString<AgentRunId>(`omp-${String(host.now())}-${String(sequence)}`)
}

/**
 * Push/pull queue between a run's producer and its consumer.
 *
 * `AgentRun.result` must settle for a caller that never iterates the events, so the
 * producer cannot block on the consumer. Past {@link DEFAULT_MAX_PENDING_EVENTS} pending
 * events with no consumer waiting, the oldest non-terminal events are dropped and
 * counted; the terminal `run.finished` event is never dropped and resolves `result`.
 */
export class RunEventQueue implements AsyncIterable<AgentRunEvent> {
  private readonly pending: AgentRunEvent[] = []
  private readonly terminal: Promise<AgentRunResult>
  private resolveTerminal: ((result: AgentRunResult) => void) | undefined
  private waiter: (() => void) | undefined
  private closed = false
  private dropped = 0

  /** Create an empty queue. */
  constructor() {
    this.terminal = new Promise<AgentRunResult>((resolve) => {
      this.resolveTerminal = resolve
    })
  }

  /** Events dropped so far because no consumer was reading. */
  get droppedCount(): number {
    return this.dropped
  }

  /** The terminal run result, resolved by the terminal event. */
  get result(): Promise<AgentRunResult> {
    return this.terminal
  }

  /**
   * Append one event; ignored once the queue has delivered its terminal event.
   * @param event - The event to enqueue.
   */
  emit(event: AgentRunEvent): void {
    if (this.closed) return
    const terminal = event.kind === 'run.finished'
    if (!terminal && this.pending.length >= DEFAULT_MAX_PENDING_EVENTS && this.waiter === undefined) {
      this.pending.shift()
      this.dropped += 1
    }
    this.pending.push(event)
    if (terminal) {
      this.closed = true
      this.resolveTerminal?.(event.result)
      this.resolveTerminal = undefined
    }
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  /** Consume events in order; completes after the terminal event has been yielded. */
  async *[Symbol.asyncIterator](): AsyncGenerator<AgentRunEvent> {
    while (true) {
      while (this.pending.length > 0) {
        for (const event of this.pending.splice(0)) yield event
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}
