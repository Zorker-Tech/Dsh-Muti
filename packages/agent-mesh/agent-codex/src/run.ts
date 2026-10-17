/**
 * `codex exec --json` dispatch and event projection.
 *
 * One native `ThreadEvent` JSONL line becomes zero or more mesh run events, and one
 * process exit becomes one classified run result. A native type this module does not model
 * is preserved as `kind: 'unknown'` with its raw JSON rather than dropped, so a Codex
 * protocol revision degrades into a visible gap.
 *
 * The prompt is the final positional argument, after `--` when it begins with `-`; the
 * child's working directory is set *and* `-C` is passed with the same value, so the
 * session Codex records cannot drift from the directory the caller chose.
 * @module @deepseek-ai/dsh-agent-codex/run
 */

import type {
  AgentId,
  AgentRun,
  AgentRunEvent,
  AgentRunId,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  AgentTodoStatus,
  AgentUsage,
} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { type AgentSessionKey } from '@deepseek-ai/dsh-agent-mesh'
import { RUN_INHERIT_ENV_KEYS } from './auth.ts'
import { CODEX_APPROVAL_MODES, CODEX_SANDBOX_PROFILES } from './detect.ts'
import type { CodexHost, HostExit, HostProcess } from './types.ts'
import { asRecord, jsonText, normalizeToken, str } from './json.ts'
import { note } from './notes.ts'
import type { ResolvedCodexConfig } from './config.ts'
import { sessionKey, type CodexHome } from './sessions.ts'

/** Cap on any single text field copied out of a native event into a run event. */
export const MAX_EVENT_TEXT_BYTES = 8 * 1024

/** Non-terminal events the run queue holds before it starts dropping the oldest. */
export const DEFAULT_MAX_PENDING_EVENTS = 4_096

/** Cap on the stderr tail carried in a run's error record. */
const ERROR_OUTPUT_CHARS = 2_000

/** Per-command budget for the git repository check. */
const GIT_CHECK_TIMEOUT_MS = 60_000

/** Patterns that identify a rate-limit refusal in Codex's stderr or failure events. */
const RATE_LIMIT_PATTERN = /rate\s*limit|too many requests|429|usage limit|quota/i

/** Patterns that identify a policy refusal in Codex's stderr or failure events. */
const POLICY_PATTERN = /policy|refus|blocked|not permitted|not allowed|safety|disallowed/i

/** How a finished `codex exec` process is classified. */
export type CodexRunFailure = 'cancelled' | 'timeout' | 'rate-limited' | 'policy-blocked' | 'crashed'

/** Classification of one finished process, with the mesh error it maps to. */
export type CodexOutcomeClassification =
  | { readonly ok: true }
  | {
    readonly ok: false
    /** Failure class, derived from the host's flags and Codex's own stderr. */
    readonly failure: CodexRunFailure
    /** Mesh error code for the run record. */
    readonly code: string
    /** Message naming what happened. */
    readonly message: string
    /** Actionable next step for the human. */
    readonly remediation: string
  }

/**
 * Classify a finished `codex exec` process.
 *
 * The host's own flags decide cancellation and timeout; everything else is read off
 * Codex's stderr, because Codex exits non-zero for "not logged in", "rate limited",
 * "policy refused" and "crashed" alike.
 *
 * @param exit - The host's exit facts.
 * @param stderrText - Bounded stderr.
 * @param durationMs - Wall-clock duration of the run.
 * @returns `{ ok: true }` for a successful exit, else the failure class and its error code.
 */
export function classifyExecOutcome(exit: HostExit, stderrText: string, durationMs: number): CodexOutcomeClassification {
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
      message: `the run exceeded its ${String(durationMs)} ms budget`,
      remediation: 'Raise the adapter timeout in configuration, or split the task into smaller runs.',
    }
  }
  if (exit.code === 0) return { ok: true }
  const evidence = stderrText.trim()
  if (RATE_LIMIT_PATTERN.test(evidence)) {
    return {
      ok: false,
      failure: 'rate-limited',
      code: 'run/rate-limited',
      message: 'codex reported a rate limit or usage cap',
      remediation: 'Wait for the limit to reset, then dispatch the run again.',
    }
  }
  if (POLICY_PATTERN.test(evidence)) {
    return {
      ok: false,
      failure: 'policy-blocked',
      code: 'run/policy-blocked',
      message: 'codex refused the request on policy grounds',
      remediation: 'Reword the task, or run it in a session whose sandbox and approvals allow it.',
    }
  }
  return {
    ok: false,
    failure: 'crashed',
    code: 'run/agent-crashed',
    message:
      exit.code === null
        ? `codex was terminated by signal ${String(exit.signal)}`
        : `codex exited with code ${String(exit.code)}`,
    remediation: 'Read the captured output, then run `codex exec` once by hand to reproduce it.',
  }
}

/**
 * Project a native `Usage` payload (`turn.completed`) onto mesh usage.
 *
 * `cached_input_tokens` becomes the mesh's cache-read count and `reasoning_output_tokens`
 * the reasoning count; the total is codex's own input-plus-output sum, left absent when
 * neither is present.
 * @param value - The raw `usage` object of a native record.
 * @returns the canonical usage, or `undefined` when the payload carries no token count.
 */
export function usageFromNative(value: unknown): AgentUsage | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const inputTokens = numberField(record, 'input_tokens')
  const cachedInputTokens = numberField(record, 'cached_input_tokens')
  const outputTokens = numberField(record, 'output_tokens')
  const reasoningTokens = numberField(record, 'reasoning_output_tokens')
  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined
  }
  const usage: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    totalTokens?: number
  } = {}
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens
  if (inputTokens !== undefined || outputTokens !== undefined) {
    usage.totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0)
  }
  return usage
}

/** A finite number field of a record. */
function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Options for {@link CodexExecEventMapper}. */
export interface CodexEventMapperOptions {
  /** Run id echoed on every emitted event. */
  readonly runId: AgentRunId
  /** Clock, injectable so fixtures produce stable timestamps. */
  readonly now: () => string
}

/**
 * Stateful projection of one `codex exec --json` stream.
 *
 * State is what the terminal result needs: the thread id Codex announced, the last
 * completed assistant message, the last reported usage, and the error evidence. The
 * mapper is single-run: one instance per process.
 */
export class CodexExecEventMapper {
  private readonly runId: AgentRunId
  private readonly now: () => string
  private thread: string | undefined
  private completedText: string | undefined
  private usage: AgentUsage | undefined
  private readonly failures: string[] = []
  private readonly unmodelledTypes = new Set<string>()
  private readonly reasoningByItem = new Map<string, string>()
  private readonly messageByItem = new Map<string, string>()
  private readonly openedTools = new Set<string>()
  private todoSignature: string | undefined

  /**
   * @param options - Run identity and the clock.
   */
  constructor(options: CodexEventMapperOptions) {
    this.runId = options.runId
    this.now = options.now
  }

  /** Native thread id Codex announced, once it has. */
  get nativeSessionId(): string | undefined {
    return this.thread
  }

  /** Last completed assistant message text. */
  get finalText(): string | undefined {
    return this.completedText
  }

  /** Usage from the most recent `turn.completed`. */
  get reportedUsage(): AgentUsage | undefined {
    return this.usage
  }

  /** Error evidence from `turn.failed`, `error` and error items, oldest first. */
  get errorEvidence(): readonly string[] {
    return this.failures
  }

  /** Native item types this mapper does not model, sorted. */
  get unmodelledItemTypes(): readonly string[] {
    return [...this.unmodelledTypes].sort()
  }

  /**
   * Project one parsed `ThreadEvent` line.
   *
   * @param value - The parsed JSON line.
   * @param raw - The raw line, preserved in `unknown` events.
   * @returns zero or more mesh events, in order.
   */
  mapLine(value: unknown, raw: string): readonly AgentRunEvent[] {
    const record = asRecord(value)
    const at = this.now()
    if (record === undefined) return [this.unknown(at, undefined, raw)]
    const type = str(record, 'type')
    switch (type) {
      case 'thread.started': {
        const threadId = str(record, 'thread_id')
        if (threadId === undefined) return [this.unknown(at, 'thread.started', raw)]
        this.thread = threadId
        return [{ kind: 'session.bound', runId: this.runId, at, nativeSessionId: threadId }]
      }
      case 'turn.started':
        return []
      case 'turn.completed': {
        const usage = usageFromNative(record['usage'])
        if (usage === undefined) {
          this.unmodelledTypes.add('turn.completed(no usage)')
          return [this.unknown(at, 'turn.completed', raw)]
        }
        this.usage = usage
        return [{ kind: 'usage.updated', runId: this.runId, at, usage }]
      }
      case 'turn.failed': {
        const message = str(asRecord(record['error']), 'message') ?? jsonText(record['error'])
        this.failures.push(message)
        return [{ kind: 'warning', runId: this.runId, at, message: capEventText(`codex turn failed: ${message}`) }]
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.mapItem(type === 'item.completed' ? 'completed' : 'open', record, raw, at)
      case 'error': {
        const message = str(record, 'message') ?? raw
        this.failures.push(message)
        return [{ kind: 'warning', runId: this.runId, at, message: capEventText(`codex error: ${message}`) }]
      }
      default: {
        this.unmodelledTypes.add(type ?? '(untyped)')
        return [this.unknown(at, type, raw)]
      }
    }
  }

  /** Project one `item.*` event through the native item table. */
  private mapItem(
    phase: 'open' | 'completed',
    record: Record<string, unknown>,
    raw: string,
    at: string,
  ): readonly AgentRunEvent[] {
    const item = asRecord(record['item'])
    if (item === undefined) {
      this.unmodelledTypes.add('item(no payload)')
      return [this.unknown(at, 'item', raw)]
    }
    const nativeType = str(item, 'type')
    const callId = str(item, 'id')
    const callIdFields = callId === undefined ? {} : { callId }
    switch (normalizeToken(nativeType)) {
      case 'agentmessage': {
        const text = str(item, 'text')
        if (text === undefined || text === '') return []
        if (phase === 'open') {
          const delta = this.takeDelta(this.messageByItem, callId, text)
          return delta === undefined ? [] : [{ kind: 'message.delta', runId: this.runId, at, text: delta }]
        }
        this.completedText = text
        return [{ kind: 'message.completed', runId: this.runId, at, text }]
      }
      case 'reasoning': {
        const text = str(item, 'text') ?? ''
        if (text === '') return []
        if (phase === 'completed') return []
        const delta = this.takeDelta(this.reasoningByItem, callId, text)
        return delta === undefined ? [] : [{ kind: 'reasoning.delta', runId: this.runId, at, text: delta }]
      }
      case 'commandexecution': {
        const command = str(item, 'command') ?? ''
        if (phase === 'open') return [this.toolStarted(at, callId, 'shell', capEventText(command))]
        const status = normalizeToken(str(item, 'status'))
        const output = str(item, 'aggregated_output')
        return [
          // A completed item whose start was never observed still yields a well-formed
          // pair, because a consumer that only sees `tool.completed` has nothing to key on.
          ...this.ensureToolStarted(at, callId, 'shell', command === '' ? undefined : capEventText(command)),
          {
            kind: 'tool.completed',
            runId: this.runId,
            at,
            ...callIdFields,
            toolName: 'shell',
            failed: status === 'failed' || status === 'declined',
            ...(output === undefined || output === '' ? {} : { output: capEventText(output) }),
          },
        ]
      }
      case 'filechange': {
        const changes = Array.isArray(item['changes']) ? item['changes'] : []
        const paths: string[] = []
        for (const change of changes) {
          const path = str(asRecord(change), 'path')
          if (path !== undefined) paths.push(path)
        }
        if (paths.length === 0) return []
        const failed = normalizeToken(str(item, 'status')) === 'failed'
        const events: AgentRunEvent[] = [{ kind: 'files.changed', runId: this.runId, at, paths }]
        if (failed) {
          events.push({
            kind: 'warning',
            runId: this.runId,
            at,
            message: `codex could not apply a patch to ${paths.join(', ')}`,
          })
        }
        return events
      }
      case 'mcptoolcall':
      case 'collabtoolcall':
      case 'websearch': {
        const name = this.toolName(nativeType, item)
        if (phase === 'open') return [this.toolStarted(at, callId, name, this.toolInput(item))]
        const output = this.toolOutput(item)
        const status = normalizeToken(str(item, 'status'))
        return [
          ...this.ensureToolStarted(at, callId, name, this.toolInput(item)),
          {
            kind: 'tool.completed',
            runId: this.runId,
            at,
            ...callIdFields,
            toolName: name,
            failed: status === 'failed' || status === 'errored' || str(item, 'error') !== undefined,
            ...(output === undefined ? {} : { output }),
          },
        ]
      }
      case 'todolist': {
        if (phase === 'open') return []
        const items = Array.isArray(item['items']) ? item['items'] : []
        const todos: { content: string; status: AgentTodoStatus }[] = []
        for (const entry of items) {
          const todo = asRecord(entry)
          const content = str(todo, 'text')
          if (content === undefined) continue
          todos.push({ content, status: todo?.['completed'] === true ? 'completed' : 'pending' })
        }
        const signature = JSON.stringify(todos)
        if (signature === this.todoSignature) return []
        this.todoSignature = signature
        return [{ kind: 'todos.updated', runId: this.runId, at, todos }]
      }
      case 'error': {
        const message = str(item, 'message') ?? jsonText(item)
        this.failures.push(message)
        return [{ kind: 'warning', runId: this.runId, at, message: capEventText(`codex error: ${message}`) }]
      }
      default: {
        this.unmodelledTypes.add(nativeType ?? '(untyped item)')
        return [this.unknown(at, `item.${nativeType ?? 'unknown'}`, raw)]
      }
    }
  }

  /** Build a `tool.started` event and remember that this call is open. */
  private toolStarted(at: string, callId: string | undefined, toolName: string, input: string | undefined): AgentRunEvent {
    if (callId !== undefined) this.openedTools.add(callId)
    return {
      kind: 'tool.started',
      runId: this.runId,
      at,
      ...(callId === undefined ? {} : { callId }),
      toolName,
      ...(input === undefined ? {} : { input }),
    }
  }

  /** A synthetic `tool.started` for a completed item whose start was never seen. */
  private ensureToolStarted(
    at: string,
    callId: string | undefined,
    toolName: string,
    input: string | undefined,
  ): readonly AgentRunEvent[] {
    if (callId !== undefined && this.openedTools.has(callId)) return []
    return [this.toolStarted(at, callId, toolName, input)]
  }

  /** Native tool name for an MCP, collab or web-search item. */
  private toolName(nativeType: string | undefined, item: Record<string, unknown>): string {
    switch (normalizeToken(nativeType)) {
      case 'mcptoolcall': {
        const server = str(item, 'server')
        const tool = str(item, 'tool') ?? 'mcp'
        return server === undefined ? tool : `${server}/${tool}`
      }
      case 'collabtoolcall': {
        const tool = str(item, 'tool') ?? 'collab'
        return `collab:${tool}`
      }
      default:
        return 'web_search'
    }
  }

  /** Serialized input for an MCP, collab or web-search item. */
  private toolInput(item: Record<string, unknown>): string | undefined {
    const argumentsValue = item['arguments']
    if (argumentsValue !== undefined) return jsonText(argumentsValue)
    const prompt = str(item, 'prompt')
    if (prompt !== undefined) return capEventText(prompt)
    const query = str(item, 'query')
    if (query !== undefined) return capEventText(query)
    const action = item['action']
    return action === undefined ? undefined : jsonText(action)
  }

  /** Serialized output for an MCP, collab or web-search item. */
  private toolOutput(item: Record<string, unknown>): string | undefined {
    const result = item['result']
    if (result !== undefined) return jsonText(result)
    const message = str(asRecord(item['error']), 'message')
    if (message !== undefined) return capEventText(message)
    const states = item['agents_states']
    if (states !== undefined) return jsonText(states)
    const results = item['results']
    return results === undefined ? undefined : jsonText(results)
  }

  /**
   * Text to emit as an incremental delta for one native item.
   *
   * Codex repeats the item's accumulated text on every update instead of sending
   * fragments, so the delta is the suffix beyond what this item already emitted.
   *
   * @param seen - Per-item memory of the text already emitted.
   * @param key - Native item id, or `undefined` for an anonymous item.
   * @param text - The native accumulated text.
   * @returns the new suffix, or `undefined` when nothing new is present.
   */
  private takeDelta(seen: Map<string, string>, key: string | undefined, text: string): string | undefined {
    const id = key ?? ''
    const previous = seen.get(id)
    seen.set(id, text)
    if (previous === undefined) return text
    if (!text.startsWith(previous)) return undefined
    const delta = text.slice(previous.length)
    return delta === '' ? undefined : delta
  }

  /** Build an `unknown` event preserving an unmodelled native record. */
  private unknown(at: string, nativeType: string | undefined, raw: string): AgentRunEvent {
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
 * Truncate a native string to the event cap.
 * @param text - Native text.
 * @returns the text, marked when it was cut.
 */
export function capEventText(text: string): string {
  if (text.length <= MAX_EVENT_TEXT_BYTES) return text
  return `${text.slice(0, MAX_EVENT_TEXT_BYTES)}\n[truncated by dsh-agent-codex at ${String(MAX_EVENT_TEXT_BYTES)} characters]`
}

/** Everything one dispatched run needs from the adapter. */
export interface CodexRunContext {
  /** Host providing the filesystem, the clock and process spawning. */
  readonly host: CodexHost
  /** Resolved adapter configuration. */
  readonly config: ResolvedCodexConfig
  /** Owning agent id. */
  readonly agentId: AgentId
  /** Identity of this run. */
  readonly runId: AgentRunId
  /** Resolve the executable and the home layout, once the producer starts. */
  readonly resolve: () => Promise<{ readonly binary: string | undefined; readonly home: CodexHome }>
}

/**
 * Dispatch one `codex exec --json` run.
 *
 * The returned handle is live immediately: the returned run's producer resolves the
 * binary, checks the working directory for a git repository, spawns the child and
 * projects its stream. A failure in any of those steps still settles `result` with a
 * classified terminal record rather than rejecting it.
 *
 * @param context - Host, configuration and identity of the run.
 * @param request - What the caller asked to run.
 * @returns the live run handle.
 */
export function startCodexRun(context: CodexRunContext, request: AgentRunRequest): AgentRun {
  const host = context.host
  const queue = new RunEventQueue()
  const startedMs = host.now()
  const startedAt = new Date(startedMs).toISOString()
  const controller = new AbortController()
  let cancelReason: string | undefined
  let cancelled = false
  let process: HostProcess | undefined

  const finish = (result: AgentRunResult): void => {
    queue.emit({ kind: 'run.finished', runId: context.runId, at: result.finishedAt, result })
  }

  const failed = (
    code: string,
    message: string,
    remediation: string,
    extras: { readonly output?: string } = {},
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
      error: { code, message, remediation, ...extras },
      notes: [],
    }
  }

  const producer = async (): Promise<void> => {
    queue.emit({ kind: 'run.started', runId: context.runId, agentId: context.agentId, at: startedAt })
    const { binary, home } = await context.resolve()
    if (binary === undefined) {
      finish(
        failed(
          'detection/not-found',
          'the codex binary is not available',
          'Install Codex, or set the codex binary path in this adapter\'s configuration.',
        ),
      )
      return
    }
    const sandbox = request.sandbox ?? context.config.sandbox
    const approval = request.approval ?? context.config.approval
    if (sandbox !== undefined && sandbox !== '' && !CODEX_SANDBOX_PROFILES.includes(sandbox)) {
      finish(
        failed('schema/invalid', `"${sandbox}" is not a Codex sandbox profile`, `Declared profiles: ${CODEX_SANDBOX_PROFILES.join(', ')}.`),
      )
      return
    }
    if (approval !== undefined && approval !== '' && !CODEX_APPROVAL_MODES.includes(approval)) {
      finish(
        failed('schema/invalid', `"${approval}" is not a Codex approval mode`, `Declared modes: ${CODEX_APPROVAL_MODES.join(', ')}.`),
      )
      return
    }
    // A `--skip-git-repo-check` that is not needed is harmless; one that is missing makes
    // Codex refuse to start, so a false negative from a missing git is the safe side.
    const inRepository = await isGitRepository(host, request.cwd)
    const model = request.model ?? context.config.model
    const args = buildExecArgs({
      cwd: request.cwd,
      model,
      sandbox: emptyToUndefined(sandbox),
      approval: emptyToUndefined(approval),
      resumeNativeId: request.resumeNativeId,
      prompt: request.prompt,
      skipGitRepoCheck: !inRepository,
    })
    const env = runEnvironment(host, context.config.env, request.env, home.path)
    const timeoutMs = request.timeoutMs ?? (context.config.timeoutMs > 0 ? context.config.timeoutMs : undefined)
    const mapper = new CodexExecEventMapper({ runId: context.runId, now: () => new Date(host.now()).toISOString() })
    let streamError: string | undefined
    let malformed = 0
    let child: HostProcess
    try {
      child = host.spawn({
        command: binary,
        args: [...args],
        cwd: request.cwd,
        env,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
    } catch (cause) {
      finish(
        failed(
          'run/start-failed',
          `the codex process could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
          'Check that the resolved binary is executable and that the working directory exists.',
        ),
      )
      return
    }
    process = child
    if (controller.signal.aborted) child.cancel(cancelReason)
    try {
      for await (const line of child.lines) {
        const parsed = parseRunLine(line)
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
        for (const event of mapper.mapLine(parsed.value, parsed.raw)) queue.emit(event)
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
    const exit = await child.exit.catch(
      (cause: unknown): HostExit => {
        streamError ??= `the process could not be observed to exit: ${cause instanceof Error ? cause.message : String(cause)}`
        return { code: null, signal: null, timedOut: false, cancelled: false }
      },
    )
    const durationMs = host.now() - startedMs
    const classification = classifyExecOutcome(exit, stderrText, durationMs)
    const status: AgentRunStatus = classification.ok
      ? 'succeeded'
      : classification.failure === 'cancelled'
        ? 'cancelled'
        : classification.failure === 'timeout'
          ? 'timeout'
          : 'failed'
    const thread = mapper.nativeSessionId
    const nativeSessionKey: AgentSessionKey | undefined =
      thread === undefined ? undefined : sessionKey(context.agentId, thread)
    const notes: string[] = [
      'assistant text arrives as item-level deltas plus one completed message; a consumer must apply them, not concatenate both',
      'interrupt is not available in this transport: cancellation kills the process group',
    ]
    if (cancelReason !== undefined) notes.push(`cancelled by the caller: ${cancelReason}`)
    if (timeoutMs !== undefined && exit.timedOut) notes.push(`the run was killed after ${String(timeoutMs)} ms`)
    const dropped = queue.droppedCount
    if (dropped > 0) notes.push(`${String(dropped)} event(s) were dropped because nothing was reading the stream`)
    if (malformed > 0) notes.push(`${String(malformed)} stdout line(s) were not valid JSON and are reported as warning events`)
    if (streamError !== undefined) notes.push(`the stdout stream ended abnormally: ${streamError}`)
    if (classification.ok && mapper.errorEvidence.length > 0) {
      notes.push(note('*', `the stream reported: ${capEventText(mapper.errorEvidence.join('; '))}`))
    }
    if (mapper.unmodelledItemTypes.length > 0) {
      notes.push(note('*', `native types emitted as \`unknown\` events: ${mapper.unmodelledItemTypes.join(', ')}`))
    }
    finish({
      runId: context.runId,
      agentId: context.agentId,
      status,
      startedAt,
      finishedAt: new Date(host.now()).toISOString(),
      durationMs,
      cwd: request.cwd,
      ...(exit.code === null ? {} : { exitCode: exit.code }),
      ...(exit.signal === null ? {} : { signal: exit.signal }),
      ...(mapper.finalText === undefined ? {} : { finalText: mapper.finalText }),
      ...(mapper.reportedUsage === undefined ? {} : { usage: mapper.reportedUsage }),
      ...(nativeSessionKey === undefined ? {} : { nativeSessionKey }),
      ...(classification.ok
        ? {}
        : {
          error: {
            code: classification.code,
            message: classification.message,
            remediation: classification.remediation,
            ...(stderrText.trim() === '' ? {} : { output: truncate(stderrText.trim(), ERROR_OUTPUT_CHARS) }),
          },
        }),
      notes,
    })
  }

  producer().catch((cause: unknown) => {
    // The producer must never leave `result` pending and never reject it for a failed
    // run: a protocol failure settles the same way every other failure does.
    host.log('warn', `codex run producer failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    finish(
      failed(
        'run/protocol-error',
        'the run stream ended without a terminal event',
        'Re-dispatch the run; if it repeats, capture the codex stdout stream for diagnosis.',
      ),
    )
  })

  return {
    id: context.runId,
    result: queue.result,
    cancel: (reason?: string): void => {
      // The first call wins; later calls do nothing, so the recorded reason is the one
      // the terminal record keeps.
      if (cancelled) return
      cancelled = true
      if (reason !== undefined) cancelReason = reason
      controller.abort()
      process?.cancel(reason)
    },
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  }
}

/** A validated empty-or-value selector. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/**
 * The environment a run receives.
 *
 * Ambient values of the names Codex itself reads are forwarded explicitly, because the
 * harness's subprocess seam scrubs credential-shaped names from the inherited
 * environment; configuration entries layer over them, caller entries over that, and
 * `CODEX_HOME` concludes the chain so a run cannot resolve a different home than the one
 * this adapter inspected.
 *
 * @param host - Host whose environment is the ambient source.
 * @param configured - Environment entries from adapter configuration.
 * @param overrides - Per-request entries from the caller.
 * @param homePath - Resolved Codex home, always placed last.
 * @returns the explicit environment entries for the child.
 */
export function runEnvironment(
  host: CodexHost,
  configured: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>> | undefined,
  homePath: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of RUN_INHERIT_ENV_KEYS) {
    const value = host.env[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  Object.assign(env, configured, overrides ?? {}, { CODEX_HOME: homePath })
  return env
}

/** Parse one stdout line, keeping the raw text for `unknown` events. */
function parseRunLine(line: string): { ok: true; value: unknown; raw: string } | { ok: false; error: string } {
  if (line.trim() === '') return { ok: false, error: 'empty line' }
  try {
    return { ok: true, value: JSON.parse(line), raw: line }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Arguments for one `codex exec` invocation. */
export interface ExecArgsOptions {
  /** Directory the session runs in; also passed as `-C`. */
  readonly cwd: string
  /** Model override, when one is configured. */
  readonly model: string | undefined
  /** Sandbox profile, already validated. */
  readonly sandbox: string | undefined
  /** Approval mode, already validated. */
  readonly approval: string | undefined
  /** Native session to continue, when resuming. */
  readonly resumeNativeId: string | undefined
  /** The task text. */
  readonly prompt: string
  /** Whether `--skip-git-repo-check` is required because the cwd is not a repository. */
  readonly skipGitRepoCheck: boolean
}

/**
 * Build `codex exec` arguments.
 *
 * Every option is placed before the `resume` subcommand and before the prompt, which is
 * the only position the CLI's own parser accepts for all of them; the prompt is passed
 * after `--` when it starts with `-` so it cannot be read as a flag.
 *
 * @param options - The run's resolved inputs.
 * @returns the argument vector, without the binary.
 */
export function buildExecArgs(options: ExecArgsOptions): readonly string[] {
  const args = ['exec', '--json', '-C', options.cwd]
  if (options.model !== undefined && options.model !== '') args.push('-m', options.model)
  if (options.sandbox !== undefined) args.push('-s', options.sandbox)
  if (options.approval !== undefined) args.push('-c', `approval_policy="${options.approval}"`)
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check')
  if (options.resumeNativeId !== undefined) args.push('resume', options.resumeNativeId)
  if (options.prompt.startsWith('-')) args.push('--')
  args.push(options.prompt)
  return args
}

/**
 * Whether a directory is inside a git work tree, asked of the real git binary.
 * @param host - Host used to start git.
 * @param cwd - Directory to inspect.
 * @returns `true` only when git answered affirmatively.
 */
export async function isGitRepository(host: CodexHost, cwd: string): Promise<boolean> {
  let child: HostProcess
  try {
    child = host.spawn({
      command: 'git',
      args: ['rev-parse', '--is-inside-work-tree'],
      cwd,
      env: {},
      timeoutMs: GIT_CHECK_TIMEOUT_MS,
    })
  } catch {
    return false
  }
  const lines: string[] = []
  try {
    for await (const line of child.lines) lines.push(line)
  } catch {
    // A git that dies mid-answer tells us nothing; the safe reading is "not a repository".
  }
  try {
    await child.stderr()
  } catch {
    // stderr is irrelevant to the answer; it is drained so the process can settle.
  }
  const exit = await child.exit
  return exit.code === 0 && lines.join('\n').trim() === 'true'
}

/**
 * Mint a run identity.
 * @param host - Host providing the clock.
 * @param sequence - Monotonic per-adapter counter, so two runs in one millisecond differ.
 * @returns the branded run id.
 */
export function mintRunId(host: CodexHost, sequence: number): AgentRunId {
  return brandString<AgentRunId>(`codex-${String(host.now())}-${String(sequence)}`)
}

/**
 * Push/pull queue between a run's producer and its consumer.
 *
 * `AgentRun.result` must settle for a caller that never iterates the events, so the
 * producer cannot block on the consumer. Past {@link DEFAULT_MAX_PENDING_EVENTS} pending
 * events with no consumer waiting, the *oldest* non-terminal events are dropped and
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
      while (this.pending.length > 0) yield* this.pending.splice(0)
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

/** The first `count` characters of a string, marked when it was cut. */
function truncate(text: string, count: number): string {
  return text.length <= count ? text : `${text.slice(0, count)}…`
}
