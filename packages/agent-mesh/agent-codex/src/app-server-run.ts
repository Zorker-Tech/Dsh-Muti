/**
 * Persistent Codex turns over the official `app-server --stdio` JSON-RPC protocol.
 *
 * The adapter owns one process per run and uses the native thread id for future
 * continuation. Native command and file-change requests can be routed through a
 * one-shot DSH approval callback; every other interactive request fails closed.
 * @module @deepseek-ai/dsh-agent-codex/app-server-run
 */

import { Readable, Writable } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type {
  AgentRun,
  AgentRunApprovalOutcome,
  AgentRunApprovalRequest,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  AgentUsage,
} from '@deepseek-ai/dsh-agent-mesh'
import { asRecord, jsonText, str } from './json.ts'
import { note } from './notes.ts'
import type { CodexRunContext } from './run.ts'
import { capEventText, CodexExecEventMapper, RunEventQueue, runEnvironment, usageFromNative } from './run.ts'
import { sessionKey } from './sessions.ts'
import type { HostProcess } from './types.ts'

type JsonObject = Record<string, unknown>

interface TurnTerminal {
  readonly status: 'completed' | 'interrupted' | 'failed'
  readonly error?: string
  readonly usage?: AgentUsage
}

/** Interactive input methods validated before the protocol reader starts. */
interface CodexAppServerInput {
  readonly lines: AsyncIterable<string>
  readonly writeStdin: (data: string) => void
}

/**
 * Start one native Codex app-server turn.
 * @param context - The resolved Codex run context.
 * @param request - The prompt, directory, and run settings.
 * @returns A live run handle with events, result, and cancellation.
 */
export function startCodexAppServerRun(context: CodexRunContext, request: AgentRunRequest): AgentRun {
  const host = context.host
  const queue = new RunEventQueue()
  const startedMs = host.now()
  const startedAt = new Date(startedMs).toISOString()
  const approvalController = new AbortController()
  let child: HostProcess | undefined
  let closeInteractiveStdin: (() => void) | undefined
  let protocol: CodexAppServerProtocol | undefined
  let cancelReason: string | undefined
  let cancelRequested = false
  let forcedCancellation = false
  let settled = false
  let interruptTimer: ReturnType<typeof setTimeout> | undefined
  let reportedUsage: AgentUsage | undefined

  const finish = (result: AgentRunResult): void => {
    settled = true
    approvalController.abort('the Codex run has ended')
    if (interruptTimer !== undefined) clearTimeout(interruptTimer)
    queue.emit({ kind: 'run.finished', runId: context.runId, at: result.finishedAt, result })
  }

  const resultFor = (
    status: AgentRunStatus,
    message: string,
    remediation: string,
    extras: {
      readonly output?: string
      readonly nativeSessionId?: string
      readonly code?: string
      readonly notes?: readonly string[]
    } = {},
  ): AgentRunResult => {
    const finishedMs = host.now()
    const nativeSessionKey = extras.nativeSessionId === undefined
      ? undefined
      : sessionKey(context.agentId, extras.nativeSessionId)
    return {
      runId: context.runId,
      agentId: context.agentId,
      status,
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - startedMs,
      cwd: request.cwd,
      ...(nativeSessionKey === undefined ? {} : { nativeSessionKey }),
      ...(status === 'succeeded' ? {} : {
        error: {
          code: extras.code ?? `run/${status}`,
          message,
          remediation,
          ...(extras.output === undefined || extras.output === '' ? {} : { output: extras.output }),
        },
      }),
      ...(protocol?.mapper.finalText === undefined ? {} : { finalText: protocol.mapper.finalText }),
      ...(reportedUsage === undefined ? {} : { usage: reportedUsage }),
      notes: [...(extras.notes ?? []), ...(protocol?.notes ?? [])],
    }
  }

  const producer = async (): Promise<void> => {
    queue.emit({ kind: 'run.started', runId: context.runId, agentId: context.agentId, at: startedAt })
    let binary: string | undefined
    let home: Awaited<ReturnType<CodexRunContext['resolve']>>['home'] | undefined
    let protocolError: string | undefined
    let terminal: TurnTerminal | undefined

    try {
      const resolved = await context.resolve()
      binary = resolved.binary
      home = resolved.home
      if (binary === undefined) {
        finish(resultFor(
          'failed',
          'the codex binary is not available',
          'Install Codex, or set the codex binary path in this adapter\'s configuration.',
          { code: 'detection/not-found' },
        ))
        return
      }
      if (cancelRequested) {
        finish(resultFor('cancelled', 'the run was cancelled before startup', 'Nothing to do; the run stopped on request.'))
        return
      }
      const sandbox = request.sandbox ?? context.config.sandbox
      const approval = request.approval ?? context.config.approval
      if (sandbox !== undefined && sandbox !== '' && !['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
        finish(resultFor('failed', `"${sandbox}" is not a Codex sandbox profile`, 'Choose a declared Codex sandbox profile.', { code: 'schema/invalid' }))
        return
      }
      if (approval !== undefined && approval !== '' && !['on-request', 'never'].includes(approval)) {
        finish(resultFor('failed', `"${approval}" is not a Codex approval mode`, 'Choose a declared Codex approval mode.', { code: 'schema/invalid' }))
        return
      }
      const timeoutMs = request.timeoutMs ?? (context.config.timeoutMs > 0 ? context.config.timeoutMs : undefined)
      const spawned = host.spawn({
        command: binary,
        args: ['app-server', '--stdio'],
        cwd: request.cwd,
        env: runEnvironment(host, context.config.env, request.env, home.path),
        interactive: true,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
      child = spawned
      const writeStdin = spawned.writeStdin?.bind(spawned)
      const closeStdin = spawned.closeStdin?.bind(spawned)
      if (writeStdin === undefined || closeStdin === undefined) {
        throw new Error('the host does not support an interactive Codex app-server process')
      }
      closeInteractiveStdin = closeStdin
      protocol = new CodexAppServerProtocol({
        input: {
          lines: spawned.lines,
          writeStdin: (data) => { writeStdin(data) },
        },
        runId: context.runId,
        now: () => new Date(host.now()).toISOString(),
        emit: (event) => { queue.emit(event) },
        requestApproval: request.requestApproval,
        approvalSignal: approvalController.signal,
      })
      protocol.start()
      await protocol.initialize()
      const threadId = request.resumeNativeId === undefined
        ? await protocol.startThread({ cwd: request.cwd, model: request.model ?? context.config.model, sandbox, approval })
        : await protocol.resumeThread({
          threadId: request.resumeNativeId,
          cwd: request.cwd,
          model: request.model ?? context.config.model,
          sandbox,
          approval,
        })
      queue.emit({ kind: 'session.bound', runId: context.runId, at: new Date(host.now()).toISOString(), nativeSessionId: threadId })
      terminal = await protocol.runTurn(threadId, request.prompt)
      reportedUsage = terminal.usage
    } catch (cause) {
      protocolError = cause instanceof Error ? cause.message : String(cause)
    }

    if (protocolError !== undefined) {
      approvalController.abort(cancelReason ?? 'the Codex protocol did not complete')
      child?.cancel(cancelReason ?? 'the Codex protocol did not complete')
    } else {
      try {
        /* v8 ignore next -- a completed handshake requires the validated stdin close callback. */
        if (closeInteractiveStdin === undefined) throw new Error('Codex app-server stdin was not initialized')
        closeInteractiveStdin()
      } catch (cause) {
        protocolError = `Codex stdin could not be closed: ${cause instanceof Error ? cause.message : String(cause)}`
        /* v8 ignore next -- stdin validation sets the process and close callback together. */
        if (child === undefined) throw new Error('Codex app-server process was not initialized')
        child.cancel('Codex stdin could not be closed')
      }
    }
    approvalController.abort(cancelReason ?? 'the Codex turn has completed')
    await protocol?.settleServerRequests()
    protocol?.close()

    let stderr = ''
    if (child !== undefined) {
      try {
        stderr = await child.stderr()
      } catch (cause) {
        protocolError ??= `stderr could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    }
    const exit = child === undefined
      ? undefined
      : await child.exit.catch((cause: unknown) => {
        protocolError ??= `the app-server exit could not be observed: ${cause instanceof Error ? cause.message : String(cause)}`
        return { code: null, signal: null, timedOut: false, cancelled: false }
      })
    const nativeSessionId = protocol?.threadId
    const notes: string[] = []
    if (protocolError !== undefined) notes.push(`the app-server protocol ended abnormally: ${protocolError}`)
    if (cancelReason !== undefined) notes.push(`cancelled by the caller: ${cancelReason}`)
    if (forcedCancellation) notes.push('Codex did not finish the interrupted turn before the configured grace period; the managed process was terminated.')
    if (protocol?.mapper.unmodelledItemTypes.length) {
      notes.push(note('*', `native item types emitted as unknown events: ${protocol.mapper.unmodelledItemTypes.join(', ')}`))
    }

    if (exit?.timedOut === true) {
      finish(resultFor('timeout', 'the run exceeded its wall-clock budget', 'Raise the adapter timeout or split the task into smaller runs.', {
        code: 'run/timeout', ...(nativeSessionId === undefined ? {} : { nativeSessionId }), output: stderr.trim(), notes,
      }))
      return
    }
    if (cancelRequested && (terminal?.status === 'interrupted' || exit?.cancelled === true || forcedCancellation)) {
      finish(resultFor('cancelled', 'the run was cancelled', 'Nothing to do; the run stopped on request.', {
        code: 'run/cancelled', ...(nativeSessionId === undefined ? {} : { nativeSessionId }), output: stderr.trim(), notes,
      }))
      return
    }
    if (terminal === undefined || protocolError !== undefined) {
      finish(resultFor('failed', 'the Codex app-server turn did not complete', 'Re-dispatch the run; if it repeats, capture the app-server protocol stream.', {
        code: 'run/protocol-error', ...(nativeSessionId === undefined ? {} : { nativeSessionId }), output: stderr.trim(), notes,
      }))
      return
    }
    /* v8 ignore next -- runTurn cannot settle before the validated start or resume response sets threadId. */
    if (nativeSessionId === undefined) {
      finish(resultFor('failed', 'the Codex app-server completed a turn without a thread id', 'Re-dispatch the run; if it repeats, capture the app-server protocol stream.', {
        code: 'run/protocol-error', output: stderr.trim(), notes,
      }))
      return
    }
    if (terminal.status === 'interrupted') {
      finish(resultFor('failed', 'Codex interrupted the turn', 'Re-dispatch the task or resume the native session.', {
        code: 'run/interrupted', nativeSessionId, output: stderr.trim(), notes,
      }))
      return
    }
    if (terminal.status === 'failed') {
      finish(resultFor('failed', terminal.error ?? 'Codex reported a failed turn', 'Read the Codex output, then retry or resume the native session.', {
        code: 'run/agent-failed', nativeSessionId, output: stderr.trim(), notes,
      }))
      return
    }
    if (exit !== undefined && exit.code !== 0 && !exit.cancelled) {
      finish(resultFor('failed', `codex app-server exited with code ${String(exit.code)}`, 'Read the captured output, then run `codex app-server --stdio` once by hand to reproduce it.', {
        code: 'run/agent-crashed', nativeSessionId, output: stderr.trim(), notes,
      }))
      return
    }
    finish(resultFor('succeeded', '', '', { nativeSessionId, notes }))
  }

  void producer().catch((cause: unknown) => {
    host.log('warn', `codex app-server run producer failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    approvalController.abort(cancelReason ?? 'the Codex run failed')
    child?.cancel(cancelReason ?? 'the Codex run failed')
    finish(resultFor('failed', 'the app-server producer failed', 'Re-dispatch the run; if it repeats, capture the app-server protocol stream.', {
      code: 'run/protocol-error',
      ...(protocol?.threadId === undefined ? {} : { nativeSessionId: protocol.threadId }),
    }))
  })

  return {
    id: context.runId,
    result: queue.result,
    cancel: (reason?: string): void => {
      if (settled || cancelRequested) return
      cancelRequested = true
      cancelReason = reason
      approvalController.abort(reason ?? 'the caller cancelled the run')
      if (protocol?.interrupt() === true) {
        interruptTimer = setTimeout(() => {
          forcedCancellation = true
          child?.cancel(reason)
        }, context.config.interruptGraceMs)
      } else {
        child?.cancel(reason)
      }
    },
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  }
}

/** Inputs owned by one Codex protocol session. */
interface CodexAppServerOptions {
  readonly input: CodexAppServerInput
  readonly runId: import('@deepseek-ai/dsh-agent-mesh').AgentRunId
  readonly now: () => string
  readonly emit: (event: AgentRunEvent) => void
  readonly requestApproval: import('@deepseek-ai/dsh-agent-mesh').AgentRunRequest['requestApproval']
  readonly approvalSignal: AbortSignal
}

/** One process connection for initialize, a native thread, and a native turn. */
class CodexAppServerProtocol {
  readonly mapper: CodexExecEventMapper

  readonly notes: string[] = []

  private readonly input: Readable

  private readonly output: Writable

  private readonly transport: JsonRpcLineTransport

  private readonly fatal = Promise.withResolvers<never>()

  private readonly pendingServerRequests = new Set<Promise<unknown>>()

  private readonly earlyNotifications: { readonly method: string; readonly params: JsonObject }[] = []

  private completion: ReturnType<typeof Promise.withResolvers<TurnTerminal>> | undefined

  private thread: string | undefined

  private turn: string | undefined

  private pendingTurn: string | undefined

  private interruptRequested = false

  private interruptSent = false

  private terminalObserved = false

  private closed = false

  constructor(private readonly options: CodexAppServerOptions) {
    this.mapper = new CodexExecEventMapper({ runId: options.runId, now: options.now })
    this.input = Readable.from((async function* lines(): AsyncGenerator<string> {
      for await (const line of options.input.lines) yield `${line}\n`
    })())
    this.output = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        try {
          options.input.writeStdin(String(chunk))
          callback()
        } catch (cause) {
          callback(cause instanceof Error ? cause : new Error(String(cause)))
        }
      },
    })
    this.transport = new JsonRpcLineTransport(this.input, this.output)
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.trackServerRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (cause) {
        this.fail(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
    this.input.on('error', this.onStreamError)
    this.input.on('end', this.onInputEnd)
    this.output.on('error', this.onStreamError)
  }

  get threadId(): string | undefined {
    return this.thread
  }

  start(): void {
    this.transport.start()
  }

  async initialize(): Promise<void> {
    requireObject(await this.guarded(this.transport.request('initialize', {
      clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.2.1-alpha.4' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    })), 'initialize response')
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush())
  }

  async startThread(input: {
    readonly cwd: string
    readonly model: string | undefined
    readonly sandbox: string | undefined
    readonly approval: string | undefined
  }): Promise<string> {
    const result = await this.guarded(this.transport.request('thread/start', {
      cwd: input.cwd,
      ephemeral: false,
      ...input.model === undefined ? {} : { model: input.model },
      ...input.sandbox === undefined ? {} : { sandbox: input.sandbox },
      ...input.approval === undefined ? {} : { approvalPolicy: input.approval },
    }))
    const response = requireObject(result, 'thread/start response')
    const thread = requireObject(response.thread, 'thread/start thread')
    const threadId = requireString(thread.id, 'thread/start thread id')
    this.thread = threadId
    return threadId
  }

  async resumeThread(input: {
    readonly threadId: string
    readonly cwd: string
    readonly model: string | undefined
    readonly sandbox: string | undefined
    readonly approval: string | undefined
  }): Promise<string> {
    const result = await this.guarded(this.transport.request('thread/resume', {
      threadId: input.threadId,
      cwd: input.cwd,
      ...input.model === undefined ? {} : { model: input.model },
      ...input.sandbox === undefined ? {} : { sandbox: input.sandbox },
      ...input.approval === undefined ? {} : { approvalPolicy: input.approval },
    }))
    const response = requireObject(result, 'thread/resume response')
    const thread = requireObject(response.thread, 'thread/resume thread')
    const threadId = requireString(thread.id, 'thread/resume thread id')
    if (threadId !== input.threadId) throw new Error('codex app-server resumed a different thread')
    this.thread = threadId
    return threadId
  }

  async runTurn(threadId: string, prompt: string): Promise<TurnTerminal> {
    const completion = Promise.withResolvers<TurnTerminal>()
    this.completion = completion
    const result = await this.guarded(this.transport.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    }))
    const response = requireObject(result, 'turn/start response')
    const turn = requireObject(response.turn, 'turn/start turn')
    this.commitTurn(requireString(turn.id, 'turn/start turn id'))
    return this.guarded(completion.promise)
  }

  interrupt(): boolean {
    if (this.thread === undefined || this.closed || this.terminalObserved) return false
    this.interruptRequested = true
    this.sendInterrupt()
    return true
  }

  async settleServerRequests(): Promise<void> {
    while (this.pendingServerRequests.size > 0) {
      await Promise.allSettled([...this.pendingServerRequests])
    }
  }

  close(): void {
    this.closed = true
    this.input.off('error', this.onStreamError)
    this.input.off('end', this.onInputEnd)
    this.output.off('error', this.onStreamError)
    this.transport.close()
  }

  private async guarded<T>(pending: Promise<T>): Promise<T> {
    return Promise.race([this.fatal.promise, pending])
  }

  private trackServerRequest(method: string, params: JsonObject): Promise<unknown> {
    const pending = this.handleServerRequest(method, params)
    this.pendingServerRequests.add(pending)
    void pending.finally(() => this.pendingServerRequests.delete(pending)).catch(() => {})
    return pending
  }

  private async handleServerRequest(method: string, params: JsonObject): Promise<unknown> {
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval':
          return await this.decideNativeApproval(params, 'command')
        case 'item/fileChange/requestApproval':
          return await this.decideNativeApproval(params, 'file-change')
        case 'item/permissions/requestApproval':
          this.validateRequestTurn(params)
          this.notes.push('Codex requested additional turn permissions; DSH granted none.')
          return { permissions: {}, scope: 'turn' }
        case 'item/tool/requestUserInput':
          this.validateRequestTurn(params)
          this.notes.push('Codex requested interactive input; DSH returned no answers.')
          return { answers: {} }
        case 'mcpServer/elicitation/request':
          this.validateRequestTurn(params, true)
          this.notes.push('Codex requested interactive MCP input; DSH declined the elicitation.')
          return { action: 'decline', content: null, _meta: null }
        default:
          throw new Error(`unsupported Codex app-server request ${JSON.stringify(method)}`)
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      this.fail(error)
      throw error
    }
  }

  private async decideNativeApproval(params: JsonObject, kind: 'command' | 'file-change'): Promise<unknown> {
    const provisional = this.validateRequestTurn(params)
    const available = decisionList(params.availableDecisions)
    const request = this.approvalRequest(params, kind)
    const outcome = this.options.requestApproval === undefined
      ? 'unavailable'
      : await this.options.requestApproval({ ...request, signal: this.options.approvalSignal })
    const decision = nativeDecision(outcome, available)
    if (decision !== 'accept') {
      const subject = kind === 'command' ? 'command' : 'file change'
      this.notes.push(`Codex ${subject} approval was declined after the DSH approval outcome "${outcome}".`)
    }
    if (provisional && this.turn !== undefined) throw new Error('Codex app-server approval turn committed unexpectedly')
    return { decision }
  }

  private approvalRequest(params: JsonObject, kind: 'command' | 'file-change'): Omit<AgentRunApprovalRequest, 'signal'> {
    const detail: string[] = []
    const command = str(params, 'command')
    const cwd = str(params, 'cwd')
    const reason = str(params, 'reason')
    const grantRoot = str(params, 'grantRoot')
    if (command !== undefined) detail.push(`Command: ${command}`)
    if (cwd !== undefined) detail.push(`Directory: ${cwd}`)
    if (grantRoot !== undefined) detail.push(`Requested access root: ${grantRoot}`)
    if (reason !== undefined) detail.push(`Reason: ${reason}`)
    if (detail.length === 0) detail.push(jsonText(params))
    return {
      kind,
      title: kind === 'command' ? 'Codex command approval' : 'Codex file change approval',
      detail: capEventText(detail.join('\n')),
    }
  }

  private validateRequestTurn(params: JsonObject, nullableTurn = false): boolean {
    if (this.thread === undefined || params.threadId !== this.thread) throw new Error('Codex app-server request referenced another thread')
    if (nullableTurn && params.turnId === null) return false
    const turnId = requireString(params.turnId, 'server request turn id')
    if (this.turn === undefined) {
      this.observePendingTurn(turnId)
      return true
    }
    if (turnId !== this.turn) throw new Error('Codex app-server request referenced another turn')
    return false
  }

  private observePendingTurn(turnId: string): void {
    if (this.pendingTurn !== undefined && this.pendingTurn !== turnId) throw new Error('Codex app-server referenced conflicting turns')
    this.pendingTurn = turnId
  }

  private commitTurn(turnId: string): void {
    if (this.pendingTurn !== undefined && this.pendingTurn !== turnId) throw new Error('turn/start response did not match the active Codex turn')
    this.turn = turnId
    for (const notification of this.earlyNotifications.splice(0)) this.handleNotification(notification.method, notification.params)
    this.sendInterrupt()
  }

  private sendInterrupt(): void {
    if (!this.interruptRequested || this.interruptSent || this.turn === undefined
      || this.thread === undefined || this.terminalObserved) return
    this.interruptSent = true
    void this.transport.request('turn/interrupt', { threadId: this.thread, turnId: this.turn }).catch((cause: unknown) => {
      /* v8 ignore next -- JsonRpcLineTransport rejects failed requests with Error instances. */
      this.fail(cause instanceof Error ? cause : new Error(String(cause)))
    })
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method === 'turn/started') {
      if (this.thread === undefined || params.threadId !== this.thread) return
      const turn = requireObject(params.turn, 'turn/started turn')
      if (this.turn === undefined) this.observePendingTurn(requireString(turn.id, 'turn/started turn id'))
      return
    }
    if (!this.isActiveNotification(method, params)) return
    if (method === 'item/agentMessage/delta') {
      const delta = str(params, 'delta')
      if (delta !== undefined) this.options.emit({ kind: 'message.delta', runId: this.options.runId, at: this.options.now(), text: capEventText(delta) })
      return
    }
    if (method === 'turn/completed') {
      this.completeTurn(params)
      return
    }
    if (method === 'item/started' || method === 'item/updated' || method === 'item/completed') {
      const item = requireObject(params.item, `${method} item`)
      if (method === 'item/started' && str(item, 'type') === 'agentMessage') return
      const events = this.mapper.mapLine({ type: method.replace('/', '.'), item }, jsonText({ method, params }))
      for (const event of events) this.options.emit(event)
      return
    }
    if (method === 'turn/diff/updated' || method === 'item/commandExecution/outputDelta') return
    this.options.emit({
      kind: 'unknown',
      runId: this.options.runId,
      at: this.options.now(),
      nativeType: method,
      native: jsonText(params),
    })
  }

  private isActiveNotification(method: string, params: JsonObject): boolean {
    if (this.thread === undefined || params.threadId !== this.thread) return false
    const turnId = method === 'turn/completed'
      ? requireString(asRecord(params.turn)?.id, 'turn/completed turn id')
      : requireString(params.turnId, 'notification turn id')
    if (this.turn === undefined) {
      this.observePendingTurn(turnId)
      this.earlyNotifications.push({ method, params })
      return false
    }
    return turnId === this.turn
  }

  private completeTurn(params: JsonObject): void {
    const turn = requireObject(params.turn, 'turn/completed turn')
    const status = turn.status
    if (status !== 'completed' && status !== 'interrupted' && status !== 'failed') {
      throw new Error(`Codex app-server returned invalid terminal turn status ${String(status)}`)
    }
    this.terminalObserved = true
    const usage = usageFromNative(turn.usage)
    if (usage !== undefined) this.options.emit({ kind: 'usage.updated', runId: this.options.runId, at: this.options.now(), usage })
    const completion = this.completion
    /* v8 ignore next -- completeTurn runs only while runTurn owns an active completion promise. */
    if (completion === undefined) throw new Error('Codex completed a turn without an active runTurn request')
    const error = str(asRecord(turn.error), 'message')
    completion.resolve({
      status,
      ...(error === undefined ? {} : { error }),
      ...(usage === undefined ? {} : { usage }),
    })
  }

  private fail(error: Error): void {
    this.fatal.reject(error)
  }

  private readonly onStreamError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    if (!this.terminalObserved) this.fail(new Error('Codex app-server protocol stream closed before turn/completed'))
  }
}

/** Choose only one-shot allow, and decline when no safe decision is offered. */
function nativeDecision(outcome: AgentRunApprovalOutcome, available: readonly string[]): string {
  if (outcome === 'allowed-once' && available.includes('accept')) return 'accept'
  if (outcome === 'cancelled' && available.includes('cancel')) return 'cancel'
  if (available.includes('decline')) return 'decline'
  if (available.includes('cancel')) return 'cancel'
  if (available.length === 0) return 'decline'
  throw new Error('Codex app-server offered no safe one-shot approval decision')
}

/** Read the offered decision values from a native request. */
function decisionList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Require an object at a JSON protocol field. */
function requireObject(value: unknown, label: string): JsonObject {
  const record = asRecord(value)
  if (record === undefined) throw new Error(`Codex app-server returned invalid ${label}`)
  return record
}

/** Require a non-empty string at a JSON protocol field. */
function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`Codex app-server returned invalid ${label}`)
  return value
}
