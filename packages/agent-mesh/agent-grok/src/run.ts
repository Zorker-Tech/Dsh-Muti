/**
 * `grok -p … --output-format streaming-json` dispatch and event projection.
 *
 * One line of the child's NDJSON stream becomes zero or more mesh run events, and one
 * process exit becomes one classified run result. Line shapes are those of xAI's
 * streaming-json reducer: a `type`-tagged envelope whose leaf names follow ACP
 * (`toolCallId`, `kind`, `rawInput`, `rawOutput`) plus xAI's own `toolName`. `text` and
 * `thought` chunks carry their payload in `data`, and `end` always carries `sessionId`.
 * A native type this module does not model becomes `kind: 'unknown'` with its raw JSON
 * rather than being dropped, so a protocol revision degrades into a visible gap.
 *
 * Every dispatch passes `--cwd`, so the session grok records cannot drift from the
 * directory the caller chose, and grok's own `-w/--worktree` is never used.
 * @module @deepseek-ai/dsh-agent-grok/run
 */

import { join } from 'node:path'
import type {
  AgentHost,
  AgentId,
  AgentRun,
  AgentRunEvent,
  AgentRunId,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  AgentSessionKey,
  AgentTodoStatus,
  AgentUsage,
  HostExit,
  HostProcess,
} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { GROK_CREDENTIAL_ENV_KEYS, redactGrokOutput } from './auth.ts'
import type { ResolvedGrokConfig } from './config.ts'
import { GROK_APPROVAL_MODES, GROK_SANDBOX_PROFILES } from './detect.ts'
import { sessionKey } from './sessions.ts'
import type { GrokPaths } from './sessions.ts'

/** Streaming-json lines can carry one large tool payload; the splitter bounds each line. */
export const MAX_STREAM_LINE_BYTES = 8 * 1024 * 1024

/** Cap on any single text field copied out of a native event into a run event. */
export const MAX_EVENT_TEXT_BYTES = 8 * 1024

/** Cap on the stderr tail carried in a run's error record. */
const ERROR_OUTPUT_CHARS = 2_000

/** Non-terminal events the run queue holds before it starts dropping the oldest. */
const MAX_PENDING_EVENTS = 4_096

/** Grok's own refusal message when a resume changes the session's sandbox profile. */
const SANDBOX_CONFLICT = /cannot resume this session under sandbox profile/i

/** Patterns that identify a rate-limit refusal in grok's own error evidence. */
const RATE_LIMITED = /rate.?limit|too many requests|\b429\b|quota (?:exceeded|exhausted)|usage limit/i

/** Patterns that identify a missing credential in grok's own error evidence. */
const UNAUTHENTICATED = /not authenticated|not signed in|unauthorized|\b401\b|invalid api key|login required/i

/** Patterns that identify a policy refusal in grok's own error evidence. */
const POLICY_BLOCKED = /policy|not allowed|disallowed|refus(?:ed|al)|forbidden|\b403\b|moderation|blocked/i

/** Mutable per-run mapping state threaded across successive stream lines. */
export interface GrokStreamState {
  /** Assistant text accumulated from `text` lines; the run's final message. */
  text: string
  /** Native session id, once a line carried one. */
  sessionId: string | undefined
  /** Turn stop reason from the `end` line (`end_turn`, `max_tokens`, `refusal`, …). */
  stopReason: string | undefined
  /** Usage projected from `usage`/`end` lines; the latest one wins. */
  usage: AgentUsage | undefined
  /** Cache-creation input tokens reported alongside usage; no mesh field carries them. */
  cacheCreationTokens: number | undefined
  /** Tool name by call id, because `tool_call_update` omits the name. */
  toolNames: Map<string, string>
  /** `message` of the first `error` line, for failure classification. */
  errorMessage: string | undefined
  /** Whether the terminal `end` line was seen. */
  ended: boolean
  /** Declared projection gaps observed while mapping. */
  notes: string[]
}

/**
 * Create the mapping state one run's stream lines accumulate into.
 *
 * One dispatched run owns one state: the line mapper mutates it as each NDJSON record
 * arrives, and the terminal record reads the accumulated text, session, stop reason,
 * usage and notes once the process exits.
 * @returns fresh mapping state for one run.
 */
export function createStreamState(): GrokStreamState {
  return {
    text: '',
    sessionId: undefined,
    stopReason: undefined,
    usage: undefined,
    cacheCreationTokens: undefined,
    toolNames: new Map<string, string>(),
    errorMessage: undefined,
    ended: false,
    notes: [],
  }
}

/** How a finished `grok -p` process is classified. */
export type GrokRunFailure = 'cancelled' | 'timeout' | 'rate-limited' | 'auth-not-configured' | 'policy-blocked' | 'crashed'

/** Classification of one finished process, with the mesh error it maps to. */
export type GrokOutcomeClassification =
  | { readonly ok: true }
  | {
    readonly ok: false
    /** Failure class, derived from the host's flags and grok's own evidence. */
    readonly failure: GrokRunFailure
    /** Mesh error code for the run record. */
    readonly code: string
    /** Message naming what happened. */
    readonly message: string
    /** Actionable next step for the human. */
    readonly remediation: string
  }

/**
 * Classify a finished `grok -p` process.
 *
 * The host's own flags decide cancellation and timeout; everything else is read off
 * grok's error evidence, because grok exits non-zero for "not authenticated", "rate
 * limited", "policy refused" and "crashed" alike.
 * @param exit - The host's exit facts.
 * @param stderrText - Bounded stderr.
 * @param errorMessage - The `message` of the last `error` line, when the stream carried one.
 * @returns `{ ok: true }` for a successful exit, else the failure class and its error code.
 */
export function classifyGrokOutcome(
  exit: HostExit,
  stderrText: string,
  errorMessage: string | undefined,
): GrokOutcomeClassification {
  if (exit.cancelled) {
    return {
      ok: false,
      failure: 'cancelled',
      code: 'run/cancelled',
      message: 'the run was cancelled',
      remediation: 'Re-dispatch the run when you want it to continue.',
    }
  }
  if (exit.timedOut) {
    return {
      ok: false,
      failure: 'timeout',
      code: 'run/timeout',
      message: 'the run exceeded its wall-clock budget',
      remediation: 'Raise the adapter timeout or split the task into smaller runs.',
    }
  }
  if (exit.code === 0) return { ok: true }

  const evidence = `${errorMessage ?? ''}\n${stderrText}`
  const failed = `grok exited with ${
    exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `code ${String(exit.code)}`
  }`

  if (SANDBOX_CONFLICT.test(evidence)) {
    return {
      ok: false,
      failure: 'policy-blocked',
      code: 'run/policy-blocked',
      message: failed,
      remediation:
        'grok refuses to resume a session under a different sandbox profile than it was created with. Omit the sandbox override for this session, or start a new session with the requested profile.',
    }
  }
  if (RATE_LIMITED.test(evidence)) {
    return {
      ok: false,
      failure: 'rate-limited',
      code: 'run/rate-limited',
      message: failed,
      remediation: 'Wait for the quota window to reset, or switch the model or account.',
    }
  }
  if (UNAUTHENTICATED.test(evidence)) {
    return {
      ok: false,
      failure: 'auth-not-configured',
      code: 'auth/not-configured',
      message: failed,
      remediation: 'Log in through the Grok Build credential panel (`grok login`) and retry.',
    }
  }
  if (POLICY_BLOCKED.test(evidence)) {
    return {
      ok: false,
      failure: 'policy-blocked',
      code: 'run/policy-blocked',
      message: failed,
      remediation: 'Review the request against the account policy or the session sandbox profile.',
    }
  }
  return {
    ok: false,
    failure: 'crashed',
    code: 'run/agent-crashed',
    message: failed,
    remediation: 'Inspect the captured stderr tail and the session record for the cause.',
  }
}

/**
 * Project a `usage` line or an `end` line's merged usage fields.
 *
 * Wire keys are snake_case (`input_tokens`, `cache_read_input_tokens`, …); `input_tokens`
 * already excludes both cache buckets on the `end` line. `cache_creation_input_tokens`
 * has no mesh field and is deliberately dropped.
 * @param value - The raw `usage` object.
 * @returns the canonical usage, or `undefined` when nothing recognizable is present.
 */
export function usageFromWire(value: unknown): AgentUsage | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const input = num(record['input_tokens'])
  const output = num(record['output_tokens'])
  const cached = num(record['cache_read_input_tokens'])
  const reasoning = num(record['reasoning_tokens'])
  const total = num(record['total_tokens'])
  const cost = num(record['total_cost_usd'])
  const usage: AgentUsage = {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  }
  return Object.keys(usage).length === 0 ? undefined : usage
}

/**
 * Map one parsed streaming-json line onto mesh events.
 * @param line - Parsed JSON value of one NDJSON line.
 * @param context - Run id and the timestamp to stamp on every event from this line.
 * @param state - Per-run mapping state, mutated with what the line revealed.
 * @returns the events this line produced, in order.
 */
export function mapStreamingJsonLine(
  line: unknown,
  context: { readonly runId: AgentRunId; readonly at: string },
  state: GrokStreamState,
): readonly AgentRunEvent[] {
  const record = asRecord(line)
  const type = record === undefined ? undefined : str(record['type'])
  if (record === undefined || type === undefined) {
    state.notes.push('a streaming-json line carried no type and was preserved as unknown')
    return [unknownEvent(context, undefined, line)]
  }

  switch (type) {
    case 'text': {
      const data = str(record['data']) ?? ''
      if (data === '') return []
      state.text += data
      return [{ kind: 'message.delta', runId: context.runId, at: context.at, text: data }]
    }
    case 'thought': {
      const data = str(record['data']) ?? ''
      if (data === '') return []
      return [{ kind: 'reasoning.delta', runId: context.runId, at: context.at, text: data }]
    }
    case 'tool_call': {
      const callId = str(record['toolCallId'])
      const toolName = str(record['toolName']) ?? str(record['title']) ?? 'tool'
      if (callId !== undefined) state.toolNames.set(callId, toolName)
      const input = stringifyBounded(record['rawInput'], MAX_EVENT_TEXT_BYTES)
      const events: AgentRunEvent[] = [
        {
          kind: 'tool.started',
          runId: context.runId,
          at: context.at,
          toolName,
          ...(callId === undefined ? {} : { callId }),
          ...(input === undefined ? {} : { input }),
        },
      ]
      const paths = locationPaths(record['locations'])
      if (paths.length > 0) events.push({ kind: 'files.changed', runId: context.runId, at: context.at, paths })
      return events
    }
    case 'tool_call_update': {
      const callId = str(record['toolCallId'])
      const status = str(record['status'])
      // Only a terminal status closes the call; `pending`/`in_progress` are progress pings.
      if (status !== 'completed' && status !== 'failed') return []
      const toolName = (callId === undefined ? undefined : state.toolNames.get(callId)) ?? 'tool'
      const output = stringifyBounded(toolContentText(record['content']), MAX_EVENT_TEXT_BYTES)
        ?? stringifyBounded(record['rawOutput'], MAX_EVENT_TEXT_BYTES)
      const events: AgentRunEvent[] = [
        {
          kind: 'tool.completed',
          runId: context.runId,
          at: context.at,
          toolName,
          failed: status === 'failed',
          ...(callId === undefined ? {} : { callId }),
          ...(output === undefined ? {} : { output }),
        },
      ]
      const paths = locationPaths(record['locations'])
      if (paths.length > 0) events.push({ kind: 'files.changed', runId: context.runId, at: context.at, paths })
      return events
    }
    case 'plan': {
      const entries = planEntries(record['entries'])
      return [
        {
          kind: 'todos.updated',
          runId: context.runId,
          at: context.at,
          todos: entries.map(entry => ({ content: entry.content, status: entry.status })),
        },
      ]
    }
    case 'usage': {
      const usage = usageFromWire(record['usage'])
      trackCacheCreation(state, record['usage'])
      if (usage === undefined) return [unknownEvent(context, type, record)]
      state.usage = usage
      return [{ kind: 'usage.updated', runId: context.runId, at: context.at, usage }]
    }
    case 'end': {
      state.ended = true
      const sessionId = str(record['sessionId'])
      if (sessionId !== undefined) state.sessionId = sessionId
      const stopReason = str(record['stopReason'])
      if (stopReason !== undefined) state.stopReason = stopReason
      const merged = usageFromWire(record['usage'])
      if (merged !== undefined) state.usage = merged
      trackCacheCreation(state, record['usage'])
      const turns = num(record['num_turns'])
      if (turns !== undefined) {
        state.notes.push(`grok reported ${String(turns)} model turns for this dispatch; the mesh result has no turn count`)
      }
      return []
    }
    case 'error': {
      const message = str(record['message']) ?? 'grok reported an error'
      state.errorMessage = message
      return [{ kind: 'warning', runId: context.runId, at: context.at, message }]
    }
    case 'max_turns_reached': {
      state.stopReason = 'max_turns_reached'
      return [
        {
          kind: 'warning',
          runId: context.runId,
          at: context.at,
          message: 'grok reached its turn limit and stopped before finishing the task',
        },
      ]
    }
    default:
      return [unknownEvent(context, type, record)]
  }
}

/** Extract the ACP plan entries carried by a `plan` line. */
function planEntries(value: unknown): readonly { readonly content: string; readonly status: AgentTodoStatus }[] {
  const items = Array.isArray(value) ? value : []
  const out: { content: string; status: AgentTodoStatus }[] = []
  for (const item of items) {
    const record = asRecord(item)
    if (record === undefined) continue
    const content = str(record['content'])
    if (content === undefined) continue
    out.push({ content, status: todoStatus(record['status']) })
  }
  return out
}

/**
 * Canonical todo status for a native token.
 * @param value - The native status token.
 * @returns the canonical status; an unknown token is reported as `pending`.
 */
export function todoStatus(value: unknown): AgentTodoStatus {
  switch (value) {
    case 'pending':
      return 'pending'
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'pending'
  }
}

/**
 * Text of an ACP tool content array.
 *
 * ACP wraps text as `{type:'content', content:{type:'text', text}}`; a `diff` entry
 * carries the touched path instead of text.
 * @param content - The raw `content` value.
 * @returns the joined text, or `undefined` when no entry carried any.
 */
export function toolContentText(content: unknown): string | undefined {
  const items = Array.isArray(content) ? content : []
  const parts: string[] = []
  for (const item of items) {
    const record = asRecord(item)
    if (record === undefined) continue
    const inner = asRecord(record['content']) ?? record
    const text = str(inner['text'])
    if (text !== undefined) parts.push(text)
    const path = str(record['path'])
    if (record['type'] === 'diff' && path !== undefined) parts.push(`[diff] ${path}`)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** Paths an ACP `locations` array names. */
function locationPaths(locations: unknown): readonly string[] {
  const items = Array.isArray(locations) ? locations : []
  const paths: string[] = []
  for (const item of items) {
    const record = asRecord(item)
    const path = record === undefined ? undefined : str(record['path'])
    if (path !== undefined && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/** Record a usage object's cache-creation count, which the mesh schema cannot carry. */
function trackCacheCreation(state: GrokStreamState, value: unknown): void {
  const record = asRecord(value)
  const creation = record === undefined ? undefined : num(record['cache_creation_input_tokens'])
  if (creation !== undefined && creation > 0) state.cacheCreationTokens = creation
}

/** Preserve a native line the union does not model. */
function unknownEvent(
  context: { readonly runId: AgentRunId; readonly at: string },
  nativeType: string | undefined,
  native: unknown,
): AgentRunEvent {
  return {
    kind: 'unknown',
    runId: context.runId,
    at: context.at,
    ...(nativeType === undefined ? {} : { nativeType }),
    native: stringifyBounded(native, MAX_EVENT_TEXT_BYTES) ?? '',
  }
}

/**
 * Build argv for one dispatch, in grok's own accepted order.
 *
 * Per-request model, sandbox, approval and resume id override the configured defaults;
 * the remaining flags come from the resolved configuration.
 * @param request - What the caller asked to run.
 * @param config - Resolved adapter configuration supplying the defaults.
 * @returns the argument vector, without the binary.
 */
export function buildRunArgs(request: AgentRunRequest, config: ResolvedGrokConfig): readonly string[] {
  const args: string[] = []
  if (request.prompt.startsWith('-')) {
    // clap reads a leading '-' as a flag; the equals form passes the value unambiguously.
    args.push(`--single=${request.prompt}`)
  } else {
    args.push('-p', request.prompt)
  }
  args.push('--output-format', 'streaming-json')
  // grok records the session's cwd; passing it explicitly keeps the record correct even
  // when the process cwd would differ.
  args.push('--cwd', request.cwd)

  const model = request.model ?? config.model
  if (model !== undefined && model !== '') args.push('-m', model)

  const sandbox = request.sandbox ?? config.sandbox
  if (sandbox !== undefined && sandbox !== '') args.push('--sandbox', sandbox)

  const approval = request.approval ?? config.approval
  if (approval === 'bypassPermissions') args.push('--always-approve')
  else if (approval !== undefined && approval !== '') args.push('--permission-mode', approval)

  if (config.maxTurns !== undefined) args.push('--max-turns', String(config.maxTurns))
  if (config.reasoningEffort !== undefined) args.push('--reasoning-effort', config.reasoningEffort)
  if (request.resumeNativeId !== undefined) args.push('-r', request.resumeNativeId)
  // Headless grok parses these but only its interactive pager consumes them; they are
  // passed anyway so a configured intent is visible in the run's argv.
  if (config.noPlan) args.push('--no-plan')
  if (config.noSubagents) args.push('--no-subagents')
  if (config.disableWebSearch) args.push('--disable-web-search')
  return args
}

/** Everything one dispatched run needs from the adapter. */
export interface GrokRunContext {
  /** Host providing the filesystem, the clock and process spawning. */
  readonly host: AgentHost
  /** Resolved adapter configuration. */
  readonly config: ResolvedGrokConfig
  /** Owning agent id. */
  readonly agentId: AgentId
  /** Identity of this run. */
  readonly runId: AgentRunId
  /** Resolved Grok store locations, for the child environment. */
  readonly paths: GrokPaths
  /** Resolves the executable, or `undefined` when no binary is installed. */
  readonly resolveBinary: () => Promise<string | undefined>
}

/**
 * Dispatch one `grok -p … --output-format streaming-json` run.
 *
 * The returned handle is live immediately: its producer resolves the binary, validates the
 * requested sandbox and approval, spawns the child and projects its stream. A failure in
 * any of those steps still settles `result` with a classified terminal record rather than
 * rejecting it.
 * @param context - Host, configuration and identity of the run.
 * @param request - What the caller asked to run.
 * @returns the live run handle.
 */
export function startGrokRun(context: GrokRunContext, request: AgentRunRequest): AgentRun {
  const { host, config, agentId, runId } = context
  const queue = new RunEventQueue()
  const startedMs = host.now()
  const startedAt = new Date(startedMs).toISOString()
  let cancelReason: string | undefined
  let cancelled = false
  let child: HostProcess | undefined

  const finish = (result: AgentRunResult): void => {
    queue.emit({ kind: 'run.finished', runId, at: result.finishedAt, result })
  }

  const baseNotes = runNotes(request, config)

  const failed = (code: string, message: string, remediation: string, extras: { readonly output?: string } = {}): AgentRunResult => ({
    runId,
    agentId,
    status: 'failed',
    startedAt,
    finishedAt: new Date(host.now()).toISOString(),
    durationMs: host.now() - startedMs,
    cwd: request.cwd,
    error: { code, message, remediation, ...extras },
    notes: [...baseNotes],
  })

  const producer = async (): Promise<void> => {
    queue.emit({ kind: 'run.started', runId, agentId, at: startedAt })
    const binary = await context.resolveBinary()
    if (binary === undefined) {
      finish(failed(
        'detection/not-found',
        'the grok binary is not available',
        'Install Grok Build, or set the adapter binary path in this adapter\'s configuration.',
      ))
      return
    }
    const sandbox = emptyToUndefined(request.sandbox) ?? config.sandbox
    const approval = emptyToUndefined(request.approval) ?? config.approval
    if (sandbox !== undefined && !GROK_SANDBOX_PROFILES.includes(sandbox)) {
      finish(failed(
        'schema/invalid',
        `"${sandbox}" is not a Grok sandbox profile`,
        `Declared profiles: ${GROK_SANDBOX_PROFILES.join(', ')}.`,
      ))
      return
    }
    if (approval !== undefined && !GROK_APPROVAL_MODES.includes(approval)) {
      finish(failed(
        'schema/invalid',
        `"${approval}" is not a Grok approval mode`,
        `Declared modes: ${GROK_APPROVAL_MODES.join(', ')}.`,
      ))
      return
    }
    const args = buildRunArgs(request, config)
    const env = runEnvironment(host, context.paths, config, sandbox, request.env)
    const timeoutMs = request.timeoutMs ?? (config.timeoutMs > 0 ? config.timeoutMs : undefined)
    const state = createStreamState()
    let process_: HostProcess
    try {
      process_ = host.spawn({
        command: binary,
        args: [...args],
        cwd: request.cwd,
        env,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        maxLineBytes: MAX_STREAM_LINE_BYTES,
      })
    } catch (cause) {
      finish(failed(
        'run/start-failed',
        `the grok process could not be started: ${messageOf(cause)}`,
        'Check that the resolved binary is executable and that the working directory exists.',
      ))
      return
    }
    child = process_
    // A cancel that arrived before the child existed still terminates it, so the run
    // cannot outlive the caller's request.
    if (cancelled) process_.cancel(cancelReason)

    let malformed = 0
    let lineNumber = 0
    try {
      for await (const line of process_.lines) {
        lineNumber += 1
        const parsed = parseJsonLine(line)
        if (!parsed.ok) {
          malformed += 1
          queue.emit({
            kind: 'warning',
            runId,
            at: new Date(host.now()).toISOString(),
            message: `streaming-json line ${String(lineNumber)} could not be parsed: ${parsed.error}`,
          })
          continue
        }
        const at = new Date(host.now()).toISOString()
        for (const event of mapStreamingJsonLine(parsed.value, { runId, at }, state)) queue.emit(event)
      }
    } catch (cause) {
      state.notes.push(`the streaming-json reader stopped early: ${messageOf(cause)}`)
    }

    let stderrText = ''
    try {
      stderrText = await process_.stderr()
    } catch (cause) {
      host.log('warn', `grok stderr could not be read: ${messageOf(cause)}`)
    }
    let exit: HostExit
    try {
      exit = await process_.exit
    } catch (cause) {
      host.log('warn', `the grok process could not be observed to exit: ${messageOf(cause)}`)
      exit = { code: null, signal: null, timedOut: false, cancelled: false }
    }

    const finishedAtMs = host.now()
    const finishedAt = new Date(finishedAtMs).toISOString()
    const observed = state.sessionId
    const finalId = observed ?? request.resumeNativeId
    if (observed !== undefined && observed !== request.resumeNativeId) {
      queue.emit({ kind: 'session.bound', runId, at: finishedAt, nativeSessionId: observed })
    }

    const notes: string[] = [...baseNotes]
    if (finalId === undefined) {
      queue.emit({
        kind: 'warning',
        runId,
        at: finishedAt,
        message: 'the native session id could not be observed: the `end` line carried no `sessionId`, so this run is unbound and cannot be resumed',
      })
      notes.push('the native session id could not be observed; the run cannot be resumed')
    }
    if (request.resumeNativeId === undefined && state.usage === undefined) {
      notes.push('grok reported no token usage for this run')
    }
    if (state.cacheCreationTokens !== undefined) {
      notes.push(`grok reported ${String(state.cacheCreationTokens)} cache-creation input tokens, which the mesh usage record has no field for`)
    }
    if (!state.ended) {
      notes.push('the streaming-json stream ended without an `end` line; terminal metadata and usage may be missing')
    }
    notes.push(...state.notes)
    const dropped = queue.droppedCount
    if (dropped > 0) notes.push(`${String(dropped)} event(s) were dropped because nothing was reading the stream`)
    if (malformed > 0) notes.push(`${String(malformed)} stdout line(s) were not valid JSON and are reported as warning events`)

    const classification = classifyGrokOutcome(exit, stderrText, state.errorMessage)
    if (classification.ok && state.stopReason === 'refusal') {
      queue.emit({
        kind: 'warning',
        runId,
        at: finishedAt,
        message: 'grok stopped with a refusal; the task was not completed',
      })
    }
    const status: AgentRunStatus = classification.ok
      ? 'succeeded'
      : classification.failure === 'cancelled'
        ? 'cancelled'
        : classification.failure === 'timeout'
          ? 'timeout'
          : 'failed'
    const nativeSessionKey: AgentSessionKey | undefined = finalId === undefined ? undefined : sessionKey(agentId, finalId)
    const redacted = redactGrokOutput(stderrText).trim()
    const output = redacted.length > ERROR_OUTPUT_CHARS ? redacted.slice(redacted.length - ERROR_OUTPUT_CHARS) : redacted
    const usage = state.usage
    const result: AgentRunResult = {
      runId,
      agentId,
      status,
      startedAt,
      finishedAt,
      durationMs: finishedAtMs - startedMs,
      cwd: request.cwd,
      ...(exit.code === null ? {} : { exitCode: exit.code }),
      ...(exit.signal === null ? {} : { signal: exit.signal }),
      ...(state.text === '' ? {} : { finalText: state.text }),
      ...(usage === undefined ? {} : { usage }),
      ...(nativeSessionKey === undefined ? {} : { nativeSessionKey }),
      ...(classification.ok
        ? {}
        : {
          error: {
            code: classification.code,
            message: classification.message,
            remediation: classification.remediation,
            ...(output === '' ? {} : { output }),
          },
        }),
      notes,
    }

    if (state.text !== '') {
      queue.emit({ kind: 'message.completed', runId, at: finishedAt, text: state.text })
    }
    finish(result)
  }

  producer().catch((cause: unknown) => {
    // The producer must never leave `result` pending and never reject it for a failed run:
    // a protocol failure settles the same way every other failure does.
    host.log('warn', `grok run producer failed: ${messageOf(cause)}`)
    finish(failed(
      'run/protocol-error',
      'the run stream ended without a terminal event',
      'Re-dispatch the run; if it repeats, capture the grok stdout stream for diagnosis.',
    ))
  })

  return {
    id: runId,
    result: queue.result,
    cancel: (reason?: string): void => {
      // Idempotent: the first caller's reason is the one the child is cancelled with.
      if (cancelled) return
      cancelled = true
      cancelReason = reason
      child?.cancel(reason)
    },
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  }
}

/**
 * Mint a run identity.
 * @param host - Host providing the clock.
 * @param sequence - Monotonic per-adapter counter, so two runs in one millisecond differ.
 * @returns the branded run id.
 */
export function mintRunId(host: AgentHost, sequence: number): AgentRunId {
  return brandString<AgentRunId>(`grok-${String(host.now())}-${String(sequence)}`)
}

/** Projection gaps that hold for every run matching this request. */
function runNotes(request: AgentRunRequest, config: ResolvedGrokConfig): readonly string[] {
  const notes: string[] = []
  if (config.noPlan || config.noSubagents) {
    notes.push('grok accepts --no-plan/--no-subagents in headless mode but only its interactive pager applies them')
  }
  if (emptyToUndefined(request.sandbox) === undefined && request.resumeNativeId !== undefined) {
    notes.push("no sandbox override was requested, so the resumed session's recorded profile applies")
  }
  if (emptyToUndefined(request.approval) === undefined) {
    notes.push("no approval mode was requested, so grok's own configured permission mode applies")
  }
  return notes
}

/**
 * The environment a run receives.
 *
 * Ambient values of the names grok itself reads are forwarded explicitly, because the
 * harness's subprocess seam scrubs credential-shaped names from the inherited
 * environment; configuration entries layer over them, caller entries over that, and
 * `GROK_HOME` concludes the chain so a run cannot resolve a different store than the one
 * this adapter inspected.
 * @param host - Host whose environment is the ambient source.
 * @param paths - Resolved Grok store locations.
 * @param config - Resolved adapter configuration.
 * @param sandbox - Sandbox profile the dispatch selected, when it selected one.
 * @param extra - Caller-supplied entries layered last.
 * @returns the environment entries the child receives over its inherited environment.
 */
export function runEnvironment(
  host: AgentHost,
  paths: GrokPaths,
  config: ResolvedGrokConfig,
  sandbox: string | undefined,
  extra?: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const name of GROK_CREDENTIAL_ENV_KEYS) {
    const value = host.env[name]
    if (value !== undefined && value !== '') env[name] = value
  }
  env['GROK_HOME'] = paths.home
  if (paths.credentialPath !== join(paths.home, 'auth.json')) env['GROK_AUTH_PATH'] = paths.credentialPath
  if (sandbox !== undefined) env['GROK_SANDBOX'] = sandbox
  for (const [name, value] of Object.entries(config.env)) env[name] = value
  for (const [name, value] of Object.entries(extra ?? {})) env[name] = value
  return env
}

/** Push/pull queue between a run's producer and its consumer. */
export class RunEventQueue implements AsyncIterable<AgentRunEvent> {
  private readonly pending: AgentRunEvent[] = []
  private readonly terminal: Promise<AgentRunResult>
  private resolveTerminal: ((result: AgentRunResult) => void) | undefined
  private waiter: (() => void) | undefined
  private closed = false
  private dropped = 0

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
   * Append one event.
   * @param event - The event to enqueue.
   */
  emit(event: AgentRunEvent): void {
    const terminal = event.kind === 'run.finished'
    if (!terminal && this.pending.length >= MAX_PENDING_EVENTS && this.waiter === undefined) {
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
      while (this.pending.length > 0) yield* this.pending.splice(0)
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

/** Parse one stdout line as JSON without throwing. */
function parseJsonLine(line: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  const trimmed = line.trim()
  if (trimmed === '') return { ok: false, error: 'empty line' }
  try {
    const value: unknown = JSON.parse(trimmed)
    return { ok: true, value }
  } catch (cause) {
    return { ok: false, error: messageOf(cause) }
  }
}

/** Narrow a JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

/** A non-empty string field. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A finite number field. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Serialize a native payload, capped so one event cannot carry an unbounded blob. */
function stringifyBounded(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    // Parsed JSONL values are JSON-serializable.
    text = JSON.stringify(value)
  }
  if (text === '') return undefined
  return text.length > max ? text.slice(0, max) : text
}

/** A validated empty-or-value selector. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/** A thrown value as a message string. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
