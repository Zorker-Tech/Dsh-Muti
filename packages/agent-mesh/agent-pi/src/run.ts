/**
 * `pi --mode json` dispatch, its NDJSON event stream mapped onto mesh run events, and the
 * terminal classification of one finished process.
 *
 * Three verified behaviours shape this module:
 *
 * - The prompt is written to **stdin**, never argv: that keeps it out of the process table
 *   and out of `ARG_MAX`, and Pi reads piped stdin as its initial message.
 * - A resume passes the session **file path** rather than the bare id. With an id, Pi
 *   resolves the session and, when it does not belong to the process's project directory,
 *   asks an interactive "fork this session into current directory?" question; with stdin
 *   closed that question is never answered and Pi exits 0 having done nothing. The path form
 *   skips resolution entirely, so a resume in the session's own directory is quiet and
 *   reliable. A resume whose recorded cwd is somewhere else is refused before spawning, in
 *   {@link startPiRun}, because this adapter never drives a TUI.
 * - Pi's JSON mode exits 0 even when the last assistant response failed, so the terminal
 *   classification also reads the stream's own stop reason, not only the exit code.
 *
 * A native record this module does not model is preserved as `kind: 'unknown'` with its raw
 * JSON rather than dropped. `bash_execution_update` in particular is a stream the mesh run
 * vocabulary has no channel for, so it is preserved as an `unknown` event carrying its raw
 * record instead of being discarded.
 *
 * `AgentRun.result` must settle for a caller that never iterates the events, so the producer
 * never blocks on the consumer: {@link RunEventQueue} drops the oldest non-terminal events
 * past its cap and always delivers the terminal one.
 * @module @deepseek-ai/dsh-agent-pi/run
 */

import { randomBytes } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type {
  AgentHost,
  AgentId,
  AgentRun,
  AgentRunEvent,
  AgentRunId,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  AgentUsage,
  HostProcess,
} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResolvedPiConfig } from './config.ts'
import {
  findPiSessionFile,
  isRecord,
  MAX_RAW_CHARS,
  parseJsonLine,
  readArray,
  readNumber,
  readPiSessionHeader,
  readPiSessionHeaderAt,
  readRecord,
  readString,
  sessionKey,
  type PiStoreLayout,
} from './sessions.ts'

/** Cap on any single text field copied out of a native event into a run event. */
export const MAX_EVENT_TEXT_CHARS = MAX_RAW_CHARS

/** Non-terminal events the run queue holds before it starts dropping the oldest. */
export const DEFAULT_MAX_PENDING_EVENTS = 4_096

/** Cap on the stderr tail carried in a run's error record. */
const ERROR_OUTPUT_CHARS = 2_000

/** How a finished `pi --mode json` process is classified. */
export type PiRunFailure =
  | 'cancelled'
  | 'timeout'
  | 'start-failed'
  | 'context-unavailable'
  | 'session-not-found'
  | 'auth-not-configured'
  | 'rate-limited'
  | 'agent-crashed'

/** Classification of one finished process, with the mesh error it maps to. */
export type PiRunClassification =
  | { readonly ok: true }
  | {
    readonly ok: false
    /** Failure class, derived from the host's flags and Pi's own stderr. */
    readonly failure: PiRunFailure
    /** Mesh error code for the run record. */
    readonly code: string
    /** Message naming what happened. */
    readonly message: string
    /** Actionable next step for the human. */
    readonly remediation: string
  }

/** Run state the projection accumulates for the terminal result. */
export interface PiRunState {
  /** Native session id, once the stream has announced one. */
  readonly sessionId?: string
  /** Assistant text of the last completed message. */
  readonly finalText?: string
  /** Usage summed over completed assistant messages and `usage` entries. */
  readonly usage?: AgentUsage
  /** `stopReason` of the last completed assistant message. */
  readonly lastStopReason?: string
  /** Provider message of the last failed assistant message, verbatim. */
  readonly lastErrorMessage?: string
  /** Whether Pi reported its settled (idle) state. */
  readonly settled: boolean
  /** Whether Pi reported the last turn as aborted. */
  readonly aborted: boolean
  /** Tool calls completed. */
  readonly toolCalls: number
  /** Tool calls that finished with an error. */
  readonly toolFailures: number
  /** Cache-write tokens, which `AgentUsage` cannot carry. */
  readonly cacheWriteTokens: number
  /** Projection gaps worth recording on the run result. */
  readonly notes: readonly string[]
}

/** Mutable accumulator behind {@link PiRunProjection}. */
interface PiRunDraft {
  sessionId: string | undefined
  finalText: string | undefined
  usage: AgentUsage | undefined
  lastStopReason: string | undefined
  lastErrorMessage: string | undefined
  settled: boolean
  aborted: boolean
  toolCalls: number
  toolFailures: number
  cacheWriteTokens: number
  notes: string[]
}

/**
 * Maps Pi's JSON event stream onto mesh run events, accumulating the state a terminal
 * result needs.
 *
 * Mapping rules, all verified against pi 1.2.0:
 *
 * | Pi record | Mesh event |
 * |---|---|
 * | session header `{type:'session',id,cwd}` | `session.bound` |
 * | `message_update` + `assistantMessageEvent.text_delta` | `message.delta` |
 * | `message_update` + `assistantMessageEvent.thinking_delta` | `reasoning.delta` |
 * | `message_update` + `assistantMessageEvent.toolcall_start` | `tool.started` |
 * | `message_update` + `assistantMessageEvent.error` | `warning` |
 * | `message_end` (assistant) | `message.completed`, `usage.updated` |
 * | `tool_execution_start` | `tool.started`, deduplicated by call id |
 * | `tool_execution_end` | `tool.completed` |
 * | `entry_appended` (`usage` entry) | `usage.updated` |
 * | `compaction_start` / `compaction_end` (failure) | `warning` |
 * | `auto_retry_start` / `auto_retry_end` (failure) | `warning` |
 * | `agent_settled` (aborted) | `warning` |
 * | `bash_execution_update`, unmodelled and informational records | `unknown`, raw record preserved |
 *
 * Lifecycle records with no content (`agent_start`, `turn_start`, `queue_update`,
 * `message_start`, `turn_end`, `tool_execution_update`, the delta brackets), the echo of the
 * prompt itself (`message_end` with role `user`) and the duplicate result of a tool call
 * (`message_end` with role `toolResult`) are deliberate no-ops, so the run record is not
 * noise.
 *
 * The projection is single-run state: one instance per dispatched run.
 */
export class PiRunProjection {
  private readonly draft: PiRunDraft = {
    sessionId: undefined,
    finalText: undefined,
    usage: undefined,
    lastStopReason: undefined,
    lastErrorMessage: undefined,
    settled: false,
    aborted: false,
    toolCalls: 0,
    toolFailures: 0,
    cacheWriteTokens: 0,
    notes: [],
  }

  private readonly announcedToolCalls = new Set<string>()

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
   * @param runId - Run id echoed on every emitted event.
   */
  constructor(private readonly runId: AgentRunId) {}

  /**
   * A snapshot of the accumulated state; the optional members are absent until observed.
   * @returns the run's final accumulated state, read once the child has exited.
   */
  state(): PiRunState {
    return {
      ...(this.draft.sessionId === undefined ? {} : { sessionId: this.draft.sessionId }),
      ...(this.draft.finalText === undefined ? {} : { finalText: this.draft.finalText }),
      ...(this.draft.usage === undefined ? {} : { usage: this.draft.usage }),
      ...(this.draft.lastStopReason === undefined ? {} : { lastStopReason: this.draft.lastStopReason }),
      ...(this.draft.lastErrorMessage === undefined ? {} : { lastErrorMessage: this.draft.lastErrorMessage }),
      settled: this.draft.settled,
      aborted: this.draft.aborted,
      toolCalls: this.draft.toolCalls,
      toolFailures: this.draft.toolFailures,
      cacheWriteTokens: this.draft.cacheWriteTokens,
      notes: [...this.draft.notes],
    }
  }

  /**
   * Record that the run binds to a native session, returning the event when it is new.
   *
   * A run that knows the session id up front (a generated `--session-id`, or a resume id)
   * announces the binding before Pi's own header arrives; the header then contributes no
   * second `session.bound` for the same id.
   *
   * @param nativeSessionId - The native session id.
   * @param at - ISO 8601 time to stamp on the event.
   * @returns the `session.bound` event, or `undefined` when this session was already bound.
   */
  bind(nativeSessionId: string, at: string): AgentRunEvent | undefined {
    if (this.draft.sessionId === nativeSessionId) return undefined
    this.draft.sessionId = nativeSessionId
    return { kind: 'session.bound', runId: this.runId, at, nativeSessionId }
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
    const header = readPiSessionHeader(value)
    if (header !== undefined) {
      const bound = this.bind(header.id, at)
      return bound === undefined ? [] : [bound]
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
        // A call the model already announced on the wire is not announced twice: the mesh
        // union has one `tool.started` per call, and the transcript keeps the arguments this
        // record carries.
        if (callId !== undefined && this.announcedToolCalls.has(callId)) return []
        if (callId !== undefined) this.announcedToolCalls.add(callId)
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
        this.draft.toolCalls += 1
        const failed = value['isError'] === true
        if (failed) this.draft.toolFailures += 1
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
      case 'entry_appended':
        return this.mapEntryAppended(value, at)
      case 'compaction_start':
        return [
          this.warning(`pi started compacting the conversation (${readString(value, 'reason') ?? 'unknown'} reason)`, at),
        ]
      case 'compaction_end': {
        const errorMessage = readString(value, 'errorMessage')
        if (errorMessage === undefined) return []
        this.addNote(`pi's compaction failed: ${errorMessage}`)
        return [this.warning(`pi's compaction failed: ${errorMessage}`, at)]
      }
      case 'auto_retry_start': {
        const attempt = readNumber(value, 'attempt')
        const max = readNumber(value, 'maxAttempts')
        const message = readString(value, 'errorMessage') ?? 'provider error'
        return [this.warning(`pi is retrying after ${message} (attempt ${attempt ?? '?'}/${max ?? '?'})`, at)]
      }
      case 'auto_retry_end': {
        if (value['success'] === true) return []
        const finalError = readString(value, 'finalError') ?? 'the retry budget was exhausted'
        this.addNote(`pi's automatic retry failed: ${finalError}`)
        return [this.warning(`pi's automatic retry failed: ${finalError}`, at)]
      }
      case 'bash_execution_update': {
        // The mesh run vocabulary has no stdout channel, so a shell stream is preserved
        // whole rather than folded into assistant text.
        return [this.unknown('bash_execution_update', raw, at)]
      }
      case 'agent_settled': {
        this.draft.settled = true
        const aborted = value['aborted'] === true
        this.draft.aborted = aborted
        if (!aborted) return []
        this.addNote('pi reported the turn as aborted')
        return [this.warning('pi reported the turn as aborted', at)]
      }
      // Lifecycle records with no content and no consumer-visible state.
      case 'agent_start':
      case 'agent_end':
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'queue_update':
      case 'tool_execution_update':
        return []
      // Records this adapter models as state but the mesh union cannot carry.
      case 'session_info_changed':
      case 'thinking_level_changed':
      case 'summarization_retry_scheduled':
      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
        return [this.unknown(type, raw, at)]
      default:
        this.addNote(`an unrecognized pi event type (${type}) was preserved as an unknown event`)
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
   * @param noteText - One line describing the gap.
   */
  addNote(noteText: string): void {
    if (!this.draft.notes.includes(noteText)) this.draft.notes.push(noteText)
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
        return text === undefined
          ? []
          : [{ kind: 'reasoning.delta', runId: this.runId, at, text: capEventText(text) }]
      }
      case 'toolcall_start': {
        const callId = readString(deltaEvent, 'id')
        if (callId !== undefined) this.announcedToolCalls.add(callId)
        return [
          {
            kind: 'tool.started',
            runId: this.runId,
            at,
            ...(callId === undefined ? {} : { callId }),
            toolName: readString(deltaEvent, 'toolName') ?? 'tool',
          },
        ]
      }
      case 'error': {
        const error = readRecord(deltaEvent, 'error')
        const message = error === undefined ? undefined : readString(error, 'errorMessage')
        this.draft.lastStopReason = readString(deltaEvent, 'reason') ?? 'error'
        if (message !== undefined) this.draft.lastErrorMessage = message
        return [this.warning(message ?? 'the assistant response failed', at)]
      }
      case 'done':
        // `message_end` carries the authoritative message and its usage.
        return []
      case 'start':
      case 'text_start':
      case 'text_end':
      case 'thinking_start':
      case 'thinking_end':
      case 'toolcall_delta':
      case 'toolcall_end':
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
          this.draft.finalText = text
          events.push({ kind: 'message.completed', runId: this.runId, at, text: capEventText(text) })
        }
        const stopReason = readString(message, 'stopReason')
        if (stopReason !== undefined) this.draft.lastStopReason = stopReason
        const errorMessage = readString(message, 'errorMessage')
        if (errorMessage !== undefined && errorMessage !== '') {
          this.draft.lastErrorMessage = errorMessage
          events.push(this.warning(`pi reported: ${errorMessage}`, at))
        }
        const usage = this.accumulateUsage(readRecord(message, 'usage'))
        if (usage !== undefined) events.push({ kind: 'usage.updated', runId: this.runId, at, usage })
        return events
      }
      case 'user':
        // The prompt echo: the caller already holds the text it sent.
        return []
      case 'toolResult':
        // Already reported by `tool_execution_end`.
        return []
      default:
        return [this.unknown('message_end', raw, at)]
    }
  }

  /** Map `entry_appended`, which is the only carrier of standalone `usage` records. */
  private mapEntryAppended(value: Record<string, unknown>, at: string): readonly AgentRunEvent[] {
    const entry = readRecord(value, 'entry')
    if (entry === undefined || readString(entry, 'type') !== 'usage') return []
    const usage = this.accumulateUsage(readRecord(entry, 'usage'))
    if (usage === undefined) return []
    this.addNote('a standalone pi `usage` entry (cache-warming accounting) is included in the run totals')
    return [{ kind: 'usage.updated', runId: this.runId, at, usage }]
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
    const reasoning = readNumber(usage, 'reasoning')
    if (reasoning !== undefined) totals.reasoning += reasoning
    const cost = readRecord(usage, 'cost')
    const costUsd = cost === undefined ? undefined : readNumber(cost, 'total')
    if (costUsd !== undefined) totals.costUsd += costUsd
    this.draft.cacheWriteTokens = totals.cacheWrite
    if (totals.cacheWrite > 0) {
      this.addNote('pi reports cache-write tokens, which the mesh usage record cannot carry')
    }
    const projected: {
      inputTokens?: number
      outputTokens?: number
      cachedInputTokens?: number
      reasoningTokens?: number
      totalTokens?: number
      costUsd?: number
    } = {
      inputTokens: totals.input,
      outputTokens: totals.output,
      cachedInputTokens: totals.cacheRead,
      totalTokens: totals.totalTokens,
    }
    if (totals.reasoning > 0) projected.reasoningTokens = totals.reasoning
    if (totals.costUsd > 0) projected.costUsd = totals.costUsd
    this.draft.usage = projected
    return projected
  }

  private warning(message: string, at: string): AgentRunEvent {
    return { kind: 'warning', runId: this.runId, at, message }
  }

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

/**
 * Classify a finished `pi --mode json` process.
 *
 * The host's own flags decide cancellation and timeout; everything else is read off Pi's
 * stderr, because Pi exits non-zero for "no session found", "not logged in", "rate limited"
 * and "crashed" alike.
 *
 * @param exit - The host's exit facts.
 * @param stderrText - Bounded stderr.
 * @param timeoutMs - The run's wall-clock budget, when it had one.
 * @returns `{ ok: true }` for a successful exit, else the failure class and its error code.
 */
export function classifyPiExit(
  exit: { readonly code: number | null; readonly signal: string | null; readonly timedOut: boolean; readonly cancelled: boolean },
  stderrText: string,
  timeoutMs: number | undefined,
): PiRunClassification {
  if (exit.cancelled) {
    return {
      ok: false,
      failure: 'cancelled',
      code: 'run/cancelled',
      message: 'the run was cancelled',
      remediation: 'Nothing to do; the run stopped on request.',
    }
  }
  if (exit.timedOut) {
    return {
      ok: false,
      failure: 'timeout',
      code: 'run/timeout',
      message: `the run exceeded its ${String(timeoutMs ?? 0)} ms budget`,
      remediation: 'Raise the run timeout in the request, or split the task into smaller runs.',
    }
  }
  if (exit.code === null && exit.signal === null) {
    // A process that never reported an exit status is how the host reports a spawn failure
    // (a missing binary, or a working directory that does not exist).
    return {
      ok: false,
      failure: 'start-failed',
      code: 'run/start-failed',
      message: 'pi could not be started',
      remediation: 'Check that the pi binary exists and is executable, and that the working directory exists.',
    }
  }
  if (exit.code === 0) return { ok: true }
  const code = exit.code === null ? `signal ${String(exit.signal)}` : `code ${String(exit.code)}`
  const stderr = stderrText.trim()
  if (/no session found matching/i.test(stderr)) {
    return {
      ok: false,
      failure: 'session-not-found',
      code: 'run/session-not-found',
      message: 'pi could not find the requested session',
      remediation:
        "Check the session id, or resume within the session's own project directory; this adapter reads the same store pi does.",
    }
  }
  if (
    /no api key|invalid api key|not (logged in|authenticated)|unauthorized|\b401\b|no models available|use \/login/i.test(
      stderr,
    )
  ) {
    return {
      ok: false,
      failure: 'auth-not-configured',
      code: 'run/auth-not-configured',
      message: `pi exited with ${code} without a usable credential`,
      remediation: 'Authenticate pi (run `pi` and use /login) or set the provider API key for this agent.',
    }
  }
  if (/rate.?limit|\b429\b|quota/i.test(stderr)) {
    return {
      ok: false,
      failure: 'rate-limited',
      code: 'run/rate-limited',
      message: `pi exited with ${code} after a provider rate limit`,
      remediation: 'Retry after the quota resets, or configure a different model for this agent.',
    }
  }
  return {
    ok: false,
    failure: 'agent-crashed',
    code: 'run/agent-crashed',
    message: `pi exited with ${code}`,
    remediation: 'Inspect the attached stderr tail; a missing model or an unreadable extension are the usual causes.',
  }
}

/** Everything one dispatched run needs from the adapter. */
export interface PiRunContext {
  /** Host providing the filesystem, the clock and process spawning. */
  readonly host: AgentHost
  /** Resolved adapter configuration. */
  readonly config: ResolvedPiConfig
  /** Owning agent id. */
  readonly agentId: AgentId
  /** Identity of this run. */
  readonly runId: AgentRunId
  /** Resolve the executable and the store layout, once the producer starts. */
  readonly resolve: () => Promise<{ readonly binary: string | undefined; readonly layout: PiStoreLayout }>
}

/**
 * Dispatch one `pi --mode json` run.
 *
 * The returned handle is live immediately: the producer resolves the binary, refuses a
 * resume that Pi could only answer interactively, spawns the child and projects its stream.
 * A failure in any of those steps still settles `result` with a classified terminal record
 * rather than rejecting it.
 *
 * @param context - Host, configuration and identity of the run.
 * @param request - What the caller asked to run.
 * @returns the live run handle.
 */
export function startPiRun(context: PiRunContext, request: AgentRunRequest): AgentRun {
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

  const settle = (status: AgentRunStatus, notes: readonly string[], details: PiTerminalDetails): AgentRunResult => {
    const finishedMs = host.now()
    return {
      runId: context.runId,
      agentId: context.agentId,
      status,
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - startedMs,
      cwd: request.cwd,
      ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
      ...(details.signal === undefined ? {} : { signal: details.signal }),
      ...(details.finalText === undefined ? {} : { finalText: details.finalText }),
      ...(details.usage === undefined ? {} : { usage: details.usage }),
      ...(details.nativeSessionKey === undefined ? {} : { nativeSessionKey: details.nativeSessionKey }),
      ...(details.error === undefined ? {} : { error: details.error }),
      notes,
    }
  }

  const producer = async (): Promise<void> => {
    queue.emit({ kind: 'run.started', runId: context.runId, agentId: context.agentId, at: startedAt })
    const { binary, layout } = await context.resolve()
    if (binary === undefined) {
      finish(
        settle('failed', [], {
          error: {
            code: 'detection/not-found',
            message: 'the pi binary is not available',
            remediation: "Install Pi, or set the pi binary path in this adapter's configuration.",
          },
        }),
      )
      return
    }

    const projection = new PiRunProjection(context.runId)
    const resumeId = request.resumeNativeId
    let resumePath: string | undefined
    if (resumeId !== undefined && resumeId !== '') {
      const located = await findPiSessionFile(host, layout, resumeId)
      if (located !== undefined) {
        const header = await readPiSessionHeaderAt(host, located)
        const sessionCwd = header === undefined || header.cwd === '' ? undefined : header.cwd
        if (sessionCwd !== undefined && resolvePath(sessionCwd) !== resolvePath(request.cwd)) {
          // A resume Pi cannot perform non-interactively must not become a silent no-op or a
          // run in the wrong directory, so it is reported as a classified, spawnless failure.
          const message = `pi session ${resumeId} belongs to ${sessionCwd} and cannot be continued in ${request.cwd}`
          projection.addNote(
            'the run was not spawned: pi cannot continue a session in another directory non-interactively',
          )
          queue.emit(projection.warn(message, new Date(host.now()).toISOString()))
          finish(
            settle('failed', projection.state().notes, {
              error: {
                code: 'run/context-unavailable',
                message,
                remediation:
                  `Dispatch this resume with cwd set to ${sessionCwd}, or start a new session there ` +
                  '(omit resumeNativeId): pi requires an interactive confirmation to fork a session ' +
                  'into another project, and this adapter never drives a TUI.',
              },
            }),
          )
          return
        }
        resumePath = located
      }
    }

    const plannedSessionId = resumeId === undefined || resumeId === ''
      ? generatePiSessionId(host.now())
      : resumeId
    const newSessionId = resumeId === undefined || resumeId === '' ? plannedSessionId : undefined
    const args = buildPiRunArgs({
      resumePath,
      resumeId: resumeId === undefined || resumeId === '' ? undefined : resumeId,
      newSessionId,
      model: request.model,
      approval: request.approval,
    })
    // Every run either generates an id or carries a non-empty resume id, so this
    // new projection cannot already have announced the planned binding.
    const binding = projection.bind(plannedSessionId, new Date(host.now()).toISOString())
    if (binding !== undefined) queue.emit(binding)
    let nativeSessionId = plannedSessionId
    if (request.prompt.trim() === '') {
      // Pi's print mode sends nothing and exits 0 when it receives neither argv nor stdin
      // content, so an empty prompt would look like a successful no-op turn.
      projection.addNote('the prompt was empty, so pi was started with nothing to send')
      queue.emit(projection.warn('the prompt is empty: pi will exit without doing work', new Date(host.now()).toISOString()))
    }
    if (request.sandbox !== undefined && request.sandbox !== '') {
      // Declaration over detection: the declared capability record has no sandbox profile,
      // so one can only arrive from a caller that ignored the declaration.
      projection.addNote('pi has no sandbox, so the requested sandbox profile was ignored')
      queue.emit(
        projection.warn(
          `pi has no sandbox; the requested profile "${request.sandbox}" was ignored`,
          new Date(host.now()).toISOString(),
        ),
      )
    }
    if (request.approval !== undefined && request.approval !== '' && request.approval !== 'approve' && request.approval !== 'default') {
      projection.addNote(`"${request.approval}" is not a pi approval mode, so no approval flag was passed`)
      queue.emit(
        projection.warn(
          `"${request.approval}" is not a pi approval mode; pi ran with its own trust store`,
          new Date(host.now()).toISOString(),
        ),
      )
    }

    const child = spawnPi(host, {
      command: binary,
      args,
      cwd: request.cwd,
      stdin: request.prompt,
      env: runEnv(context, layout, request),
      ...(request.timeoutMs === undefined || request.timeoutMs <= 0 ? {} : { timeoutMs: request.timeoutMs }),
    })
    if (child === undefined) {
      finish(
        settle('failed', projection.state().notes, {
          error: {
            code: 'run/start-failed',
            message: `pi could not be started in ${request.cwd}`,
            remediation: 'Check that the pi binary exists and is executable, and that the working directory exists.',
          },
        }),
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
        const parsed = parseJsonLine(line)
        if (!parsed.ok) {
          malformed += 1
          queue.emit({
            kind: 'warning',
            runId: context.runId,
            at: new Date(host.now()).toISOString(),
            message: `unparsable json on stdout: ${parsed.error}`,
          })
          continue
        }
        const at = new Date(host.now()).toISOString()
        for (const event of projection.observe(parsed.value, line, at)) {
          if (event.kind === 'session.bound') nativeSessionId = event.nativeSessionId
          queue.emit(event)
        }
      }
    } catch (cause) {
      streamError = cause instanceof Error ? cause.message : String(cause)
    }

    let stderrText = ''
    try {
      stderrText = await child.stderr()
    } catch (cause) {
      streamError ??= `stderr could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
    }
    const exit = await child.exit
    const state = projection.state()
    const stderrTail = bounded(stderrText.trim())
    const classification = classifyPiExit(exit, stderrTail, request.timeoutMs)
    let status: AgentRunStatus = classification.ok ? 'succeeded' : classification.failure === 'cancelled' ? 'cancelled' : classification.failure === 'timeout' ? 'timeout' : 'failed'
    let error: AgentRunResult['error']
    if (!classification.ok) {
      error = {
        code: classification.code,
        message: classification.message,
        remediation: classification.remediation,
        ...(stderrTail === '' ? {} : { output: stderrTail }),
      }
    } else if (state.lastStopReason === 'error') {
      // Pi's JSON mode exits 0 even when the last assistant response failed.
      status = 'failed'
      error = {
        code: 'run/agent-crashed',
        message: state.lastErrorMessage ?? 'the assistant response failed',
        remediation:
          'Check the model and provider credentials configured for this agent; the run itself started cleanly.',
        ...(stderrTail === '' ? {} : { output: stderrTail }),
      }
    } else if (state.aborted) {
      status = 'cancelled'
      error = { code: 'run/cancelled', message: 'pi aborted the turn' }
    }
    if (state.sessionId !== undefined && !state.settled && status === 'succeeded') {
      projection.addNote('the stream ended before pi reported agent_settled, so the turn may not have finished')
    }

    const notes = [...projection.state().notes]
    if (cancelReason !== undefined) notes.push(`cancelled by the caller: ${cancelReason}`)
    if (exit.timedOut && request.timeoutMs !== undefined) {
      notes.push(`the run was killed after ${String(request.timeoutMs)} ms`)
    }
    const dropped = queue.droppedCount
    if (dropped > 0) notes.push(`${dropped} event(s) were dropped because nothing was reading the stream`)
    if (malformed > 0) notes.push(`${malformed} stdout line(s) were not valid JSON and are reported as warning events`)
    if (streamError !== undefined) notes.push(`the stdout stream ended abnormally: ${streamError}`)

    finish(
      settle(status, notes, {
        ...(exit.code === null ? {} : { exitCode: exit.code }),
        ...(exit.signal === null ? {} : { signal: exit.signal }),
        ...(state.finalText === undefined ? {} : { finalText: state.finalText }),
        ...(state.usage === undefined ? {} : { usage: state.usage }),
        nativeSessionKey: sessionKey(context.agentId, nativeSessionId),
        ...(error === undefined ? {} : { error }),
      }),
    )
  }

  producer().catch((cause: unknown) => {
    // The producer must never leave `result` pending and never reject it for a failed run:
    // a protocol failure settles the same way every other failure does.
    host.log('warn', `pi run producer failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    finish(
      settle('failed', [], {
        error: {
          code: 'run/protocol-error',
          message: 'the run stream ended without a terminal event',
          remediation: 'Re-dispatch the run; if it repeats, capture the pi stdout stream for diagnosis.',
        },
      }),
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

/** Everything terminal-result construction needs. */
interface PiTerminalDetails {
  /** Process exit code, when the process exited. */
  readonly exitCode?: number
  /** Terminating signal, when one terminated the process. */
  readonly signal?: string
  /** The answer the run produced, when it produced one. */
  readonly finalText?: string
  /** Usage the run reported. */
  readonly usage?: AgentUsage
  /** Native session the run bound to, when it bound one. */
  readonly nativeSessionKey?: AgentRunResult['nativeSessionKey']
  /** Classified failure, when the run did not succeed. */
  readonly error?: AgentRunResult['error']
}

/** Spawn the child, turning a spawn failure into `undefined`. */
function spawnPi(
  host: AgentHost,
  spec: {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly stdin: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs?: number
  },
): HostProcess | undefined {
  try {
    return host.spawn({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      stdin: spec.stdin,
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    })
  } catch (cause) {
    host.log('warn', `pi could not be started: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  }
}

/**
 * The environment for a run: the variables this adapter derives, then the adapter's own
 * configured entries, then the caller's, each layer overriding the one before.
 * @param context - Run context carrying the adapter configuration.
 * @param layout - Resolved store layout.
 * @param request - The run request.
 * @returns the explicit environment for the child.
 */
export function runEnv(
  context: PiRunContext,
  layout: PiStoreLayout,
  request: AgentRunRequest,
): Record<string, string> {
  return {
    PI_CODING_AGENT_DIR: layout.agentDir,
    ...(layout.sessionDirOverride === undefined ? {} : { PI_CODING_AGENT_SESSION_DIR: layout.sessionDirOverride }),
    ...context.config.env,
    ...(request.env ?? {}),
  }
}

/** Arguments for one `pi --mode json` invocation. */
export interface PiRunArgsOptions {
  /** Output transport; omitted to keep the one-shot JSON command. */
  readonly mode?: 'json' | 'rpc'
  /** Session file path to continue, when the resume resolved to one. */
  readonly resumePath: string | undefined
  /** Native session id to continue, when no file was resolved for it. */
  readonly resumeId: string | undefined
  /** Generated session id for a new run. */
  readonly newSessionId: string | undefined
  /** Model override, when the request names one. */
  readonly model: string | undefined
  /** Approval mode, as the request states it. */
  readonly approval: string | undefined
}

/**
 * Build the arguments for one headless run.
 *
 * `--mode json` is the headless transport; a resume passes the session file path when one
 * was resolved, else the id for Pi's own lookup, and never silently starts a fresh session
 * instead. `--provider` is passed separately from `--model` when the model has the
 * `provider/id` shape, which keeps a provider whose model ids contain a slash unambiguous;
 * `default` means "obey Pi's own trust store", which is exactly Pi's no-flag behaviour.
 *
 * @param options - The run's resolved inputs.
 * @returns the argument vector, without the binary.
 */
export function buildPiRunArgs(options: PiRunArgsOptions): readonly string[] {
  const args: string[] = ['--mode', options.mode ?? 'json']
  if (options.resumePath !== undefined) args.push('--session', options.resumePath)
  else if (options.resumeId !== undefined) args.push('--session', options.resumeId)
  else if (options.newSessionId !== undefined) args.push('--session-id', options.newSessionId)

  const model = options.model?.trim()
  if (model !== undefined && model !== '') {
    const split = splitPiModel(model)
    if (split.provider !== undefined) args.push('--provider', split.provider)
    args.push('--model', split.model)
  }
  if (options.approval === 'approve') args.push('--approve')
  return args
}

/**
 * Split a configured model string into Pi's `--provider` and `--model` values.
 *
 * `provider/id` is split at the first slash; anything else is passed verbatim, because a
 * bare pattern is legal (Pi also accepts fuzzy patterns and a `:<thinking>` suffix), and
 * guessing would silently select a different model.
 *
 * @param model - Model string from the run request.
 * @returns the provider, when the string has the `provider/id` shape, and the model value.
 */
export function splitPiModel(model: string): { provider?: string; model: string } {
  const trimmed = model.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return { model: trimmed }
  const provider = trimmed.slice(0, slash)
  const id = trimmed.slice(slash + 1)
  if (id === '' || !/^[A-Za-z0-9._-]+$/.test(provider)) return { model: trimmed }
  return { provider, model: id }
}

/**
 * Generate a session id Pi accepts: uuid-v7-shaped, so ids sort by creation time and match
 * Pi's `[A-Za-z0-9][A-Za-z0-9._-]*` pattern.
 *
 * @param now - Creation time in milliseconds; injected for testability.
 * @returns the session id.
 */
export function generatePiSessionId(now: number = Date.now()): string {
  const time = Math.trunc(now).toString(16).padStart(12, '0').slice(-12)
  const random = randomBytes(15).toString('hex')
  const versionGroup = `7${random.slice(0, 3)}`
  const variantNibble = ((Number.parseInt(random.slice(3, 4), 16) & 0x3) | 0x8).toString(16)
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-${versionGroup}-${variantNibble}${random.slice(4, 7)}-${random.slice(7, 19)}`
}

/**
 * Mint a run identity.
 * @param host - Host providing the clock.
 * @param sequence - Monotonic per-adapter counter, so two runs in one millisecond differ.
 * @returns the branded run id.
 */
export function mintRunId(host: AgentHost, sequence: number): AgentRunId {
  return brandString<AgentRunId>(`pi-${String(host.now())}-${String(sequence)}`)
}

/**
 * Push/pull queue between a run's producer and its consumer.
 *
 * Past {@link DEFAULT_MAX_PENDING_EVENTS} pending events with no consumer waiting, the
 * *oldest* non-terminal events are dropped and counted; the terminal `run.finished` event is
 * never dropped and resolves `result`.
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
    const terminalEvent = event.kind === 'run.finished'
    if (!terminalEvent && this.pending.length >= DEFAULT_MAX_PENDING_EVENTS && this.waiter === undefined) {
      this.pending.shift()
      this.dropped += 1
    }
    this.pending.push(event)
    if (terminalEvent) {
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
      while (this.pending.length > 0) yield* this.pending.splice(0)
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
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
 * Truncate a native string to the event cap.
 * @param text - Native text.
 * @returns the text, marked when it was cut.
 */
export function capEventText(text: string): string {
  if (text.length <= MAX_EVENT_TEXT_CHARS) return text
  return `${text.slice(0, MAX_EVENT_TEXT_CHARS)}\n[truncated by dsh-agent-pi at ${String(MAX_EVENT_TEXT_CHARS)} characters]`
}

/** Serialize a native value for a canonical string field, bounded. */
function boundedJson(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'function' || typeof value === 'symbol' ? String(value) : JSON.stringify(value)
  } catch {
    text = '<unserializable>'
  }
  return capEventText(text)
}

/** Bound a diagnostic string for a run record, keeping its tail. */
function bounded(text: string): string {
  return text.length > ERROR_OUTPUT_CHARS ? text.slice(text.length - ERROR_OUTPUT_CHARS) : text
}
