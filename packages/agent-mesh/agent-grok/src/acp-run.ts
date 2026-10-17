/**
 * Grok Build ACP stdio dispatch, including authentication, native session load, permission
 * forwarding, streaming projection, cancellation and process teardown.
 * @module @deepseek-ai/dsh-agent-grok/acp-run
 */

import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientContext,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import type {
  AgentRun,
  AgentRunApprovalOutcome,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  AgentUsage,
  HostProcess,
} from '@deepseek-ai/dsh-agent-mesh'
import type { ResolvedGrokConfig } from './config.ts'
import { redactGrokOutput } from './auth.ts'
import { sessionKey } from './sessions.ts'
import { GROK_APPROVAL_MODES, GROK_SANDBOX_PROFILES } from './detect.ts'
import { MAX_EVENT_TEXT_BYTES, RunEventQueue, classifyGrokOutcome, runEnvironment, type GrokRunContext } from './run.ts'

const ACP_STDIO_ARGS = ['--no-auto-update', 'agent', 'stdio'] as const
const MAX_ERROR_OUTPUT_CHARS = 2_000
const MAX_PERMISSION_TITLE_CHARS = 256

/** State accumulated from the agent updates for one Grok turn. */
interface GrokAcpState {
  text: string
  usage: AgentUsage | undefined
  sessionId: string | undefined
  notes: string[]
  stopReason: string | undefined
}

/**
 * Dispatch one prompt through Grok's ACP stdio mode.
 * @param context - The resolved Grok run context.
 * @param request - The prompt, directory, and run settings.
 * @returns A live run handle with events, result, and cancellation.
 */
export function startGrokAcpRun(context: GrokRunContext, request: AgentRunRequest): AgentRun {
  const { host, config, agentId, runId, paths } = context
  const queue = new RunEventQueue()
  const startedMs = host.now()
  const startedAt = new Date(startedMs).toISOString()
  const state: GrokAcpState = { text: '', usage: undefined, sessionId: undefined, notes: [], stopReason: undefined }
  const abortController = new AbortController()
  let process: HostProcess | undefined
  let notifyCancel: (() => void) | undefined
  let cancelTimer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  let cancelReason: string | undefined
  const callbackPromises = new Set<Promise<unknown>>()
  let connectionClosed: Promise<void> | undefined
  let protocolError: string | undefined
  let startupErrorCode = 'run/protocol-error'

  const finish = (result: AgentRunResult): void => {
    queue.emit({ kind: 'run.finished', runId, at: result.finishedAt, result })
  }

  const failed = (code: string, message: string, remediation: string): AgentRunResult => ({
    runId,
    agentId,
    status: 'failed',
    startedAt,
    finishedAt: new Date(host.now()).toISOString(),
    durationMs: host.now() - startedMs,
    cwd: request.cwd,
    error: { code, message, remediation },
    notes: [...state.notes],
  })

  const trackCallback = <T>(callback: () => T | PromiseLike<T>): Promise<T> => {
    const promise = Promise.resolve().then(callback)
    callbackPromises.add(promise)
    const remove = (): void => { callbackPromises.delete(promise) }
    void promise.then(remove, remove)
    return promise
  }

  const requestPermission = async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    if (abortController.signal.aborted || request.requestApproval === undefined) {
      return { outcome: { outcome: 'cancelled' } }
    }
    const title = bounded(params.toolCall.title || params.toolCall.name || 'Grok tool request', MAX_PERMISSION_TITLE_CHARS)
    const kind = params.toolCall.kind === 'edit' || params.toolCall.kind === 'delete' || params.toolCall.kind === 'move'
      ? 'file-change'
      : 'command'
    let decision: AgentRunApprovalOutcome
    try {
      const requestDecision = request.requestApproval({
        kind,
        title,
        detail: `Grok requested ${params.toolCall.kind ?? 'tool'}${params.toolCall.name == null ? '' : ` (${bounded(params.toolCall.name, 120)})`}: ${title}`,
        signal: abortController.signal,
      })
      decision = await raceWithAbort(requestDecision, abortController.signal)
    } catch (error: unknown) {
      host.log('warn', `grok ACP permission callback failed: ${errorMessage(error)}`)
      return { outcome: { outcome: 'cancelled' } }
    }
    if (decision === 'allowed-once') {
      const option = params.options.find(candidate => candidate.kind === 'allow_once')
      return option === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: option.optionId } }
    }
    if (decision === 'rejected') {
      const option = params.options.find(candidate => candidate.kind === 'reject_once')
      return option === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: option.optionId } }
    }
    return { outcome: { outcome: 'cancelled' } }
  }

  const onSessionUpdate = (notification: SessionNotification): void => {
    if (state.sessionId === undefined) state.sessionId = notification.sessionId
    else if (state.sessionId !== notification.sessionId) {
      queue.emit(warning(context, 'Grok ACP sent an update for a different session; the update was preserved as unknown'))
      queue.emit(unknown(context, notification.update))
      return
    }
    for (const event of mapUpdate(context, notification.update, state)) queue.emit(event)
  }

  const clientApp = client({ name: 'deepseek-harness-agent-grok' })
    .onRequest(methods.client.session.requestPermission, ({ params }) => trackCallback(() => requestPermission(params)))
    .onNotification(methods.client.session.update, ({ params }) => trackCallback(() =>{  onSessionUpdate(params) }))

  const requestCancel = (): void => {
    cancelled = true
    abortController.abort()
    notifyCancel?.()
    cancelTimer = setTimeout(() => process?.cancel(cancelReason), config.interruptGraceMs)
  }

  const producer = async (): Promise<void> => {
    queue.emit({ kind: 'run.started', runId, agentId, at: startedAt })
    const unsupported = unsupportedAcpOverrides(config, request)
    if (unsupported !== undefined) {
      finish(failed('run/config-unsupported', unsupported, 'Use runMode "headless-exec" for Grok options that ACP does not expose.'))
      return
    }
    const rawSandbox = request.sandbox === undefined || request.sandbox === '' ? config.sandbox : request.sandbox
    const selectedSandbox = rawSandbox
    if (selectedSandbox !== undefined && !GROK_SANDBOX_PROFILES.includes(selectedSandbox)) {
      finish(failed('schema/invalid', `"${selectedSandbox}" is not a Grok sandbox profile`, `Declared profiles: ${GROK_SANDBOX_PROFILES.join(', ')}.`))
      return
    }
    const approval = request.approval ?? config.approval
    if (approval !== undefined && approval !== '' && !GROK_APPROVAL_MODES.includes(approval)) {
      finish(failed('schema/invalid', `"${approval}" is not a Grok approval mode`, `Declared modes: ${GROK_APPROVAL_MODES.join(', ')}.`))
      return
    }
    const env = runEnvironment(host, paths, config, selectedSandbox, request.env)
    const binary = await context.resolveBinary()
    if (binary === undefined) {
      finish(failed('detection/not-found', 'the grok binary is not available', 'Install Grok Build, or set the adapter binary path in this adapter\'s configuration.'))
      return
    }

    try {
      process = host.spawn({
        command: binary,
        args: [...ACP_STDIO_ARGS],
        cwd: request.cwd,
        env,
        interactive: true,
        ...(request.timeoutMs === undefined || request.timeoutMs <= 0 ? {} : { timeoutMs: request.timeoutMs }),
        maxLineBytes: 8 * 1024 * 1024,
      })
    } catch (error: unknown) {
      finish(failed('run/start-failed', `the grok ACP process could not be started: ${errorMessage(error)}`, 'Check that the resolved binary is executable and that the working directory exists.'))
      return
    }
    if (process.writeStdin === undefined || process.closeStdin === undefined) {
      process.cancel('Grok ACP requires interactive stdin')
      await process.exit
      finish(failed('run/transport-unavailable', 'the host does not provide interactive stdin for Grok ACP', 'Use runMode "headless-exec" or enable interactive subprocess support.'))
      return
    }

    const stdout = lineStream(process)
    const stdin = new WritableStream<Uint8Array>({
      write(chunk) {
        process?.writeStdin?.(new TextDecoder().decode(chunk))
      },
    })
    const connection = clientApp.connect(ndJsonStream(stdin, stdout))
    connectionClosed = connection.closed
    const agent = connection.agent
    const cancelCurrentSession = (sessionId: string): void => {
      notifyCancel = () => {
        void agent.notify(methods.agent.session.cancel, { sessionId }).catch((error: unknown) => {
          host.log('warn', `grok ACP session cancellation failed: ${errorMessage(error)}`)
        })
      }
      if (cancelled) notifyCancel()
    }

    try {
      const initialization = await raceWithExit(
        agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
        process,
      )
      startupErrorCode = 'run/auth-not-configured'
      const apiKey = env['XAI_API_KEY'] ?? env['GROK_CODE_XAI_API_KEY']
      const authMethods = initialization.authMethods ?? []
      const authMethod = apiKey !== undefined && apiKey !== ''
        ? authMethods.find(method => method.id === 'xai.api_key')
        : authMethods.find(method => method.id === 'cached_token')
      if (authMethod === undefined) {
        throw new Error('Grok ACP advertised no usable cached-token or API-key authentication method')
      }
      await raceWithExit(
        agent.request(methods.agent.authenticate, { methodId: authMethod.id, _meta: { headless: true } }),
        process,
      )
      startupErrorCode = 'run/protocol-error'

      let sessionId: string
      let configOptions: readonly SessionConfigOption[] | undefined
      if (request.resumeNativeId !== undefined && request.resumeNativeId !== '') {
        if (initialization.agentCapabilities?.loadSession !== true) {
          throw new Error('Grok ACP does not advertise session/load; refusing to start a fresh session for a resume request')
        }
        const loaded = await raceWithExit(
          agent.request(methods.agent.session.load, { sessionId: request.resumeNativeId, cwd: request.cwd, mcpServers: [] }),
          process,
        )
        sessionId = request.resumeNativeId
        configOptions = loaded.configOptions ?? undefined
      } else {
        const created = await raceWithExit(
          agent.request(methods.agent.session.new, { cwd: request.cwd, mcpServers: [] }),
          process,
        )
        sessionId = created.sessionId
        configOptions = created.configOptions ?? undefined
      }
      state.sessionId = sessionId
      queue.emit({ kind: 'session.bound', runId, at: new Date(host.now()).toISOString(), nativeSessionId: sessionId })
      cancelCurrentSession(sessionId)
      await applySessionOverrides(agent, sessionId, configOptions, config, request)
      if (cancelled) {
        process.closeStdin()
      } else {
        const promptResult = await raceWithExit(
          agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: request.prompt }] }),
          process,
        )
        state.stopReason = promptResult.stopReason
      }
    } catch (error: unknown) {
      protocolError = errorMessage(error)
      abortController.abort()
      if (startupErrorCode === 'run/auth-not-configured') host.log('warn', `grok ACP authentication failed: ${protocolError}`)
      process.closeStdin()
      if (!cancelled) process.cancel('Grok ACP request failed')
    }

    if (cancelTimer !== undefined) clearTimeout(cancelTimer)
    process.closeStdin()
    const exit = await process.exit
    await connectionClosed
    while (callbackPromises.size > 0) await Promise.allSettled([...callbackPromises])
    let stderr = ''
    try {
      stderr = await process.stderr()
    } catch (error: unknown) {
      host.log('warn', `grok ACP stderr could not be read: ${errorMessage(error)}`)
    }
    const observedExit = cancelled ? { ...exit, cancelled: true } : exit
    const classified = classifyGrokOutcome(observedExit, stderr, protocolError)
    const finishedMs = host.now()
    const finishedAt = new Date(finishedMs).toISOString()
    if (state.sessionId === undefined && request.resumeNativeId !== undefined) state.sessionId = request.resumeNativeId
    if (state.stopReason === 'refusal') queue.emit(warning(context, 'Grok stopped with a refusal; the task was not completed'))
    const status: AgentRunStatus = cancelled || state.stopReason === 'cancelled'
      ? 'cancelled'
      : observedExit.timedOut
        ? 'timeout'
        : classified.ok && protocolError === undefined
          ? 'succeeded'
          : 'failed'
    const stderrText = redactGrokOutput(stderr).trim()
    const output = stderrText.length > MAX_ERROR_OUTPUT_CHARS ? stderrText.slice(-MAX_ERROR_OUTPUT_CHARS) : stderrText
    const error = protocolError === undefined
      ? classified.ok
        ? undefined
        : { code: classified.code, message: classified.message, remediation: classified.remediation }
      : {
        code: startupErrorCode,
        message: bounded(protocolError, MAX_EVENT_TEXT_BYTES),
        remediation: 'Check Grok authentication and ACP compatibility, then re-dispatch the run.',
      }
    const result: AgentRunResult = {
      runId,
      agentId,
      status,
      startedAt,
      finishedAt,
      durationMs: finishedMs - startedMs,
      cwd: request.cwd,
      ...(exit.code === null ? {} : { exitCode: exit.code }),
      ...(exit.signal === null ? {} : { signal: exit.signal }),
      ...(state.text === '' ? {} : { finalText: state.text }),
      ...(state.usage === undefined ? {} : { usage: state.usage }),
      ...(state.sessionId === undefined ? {} : { nativeSessionKey: sessionKey(agentId, state.sessionId) }),
      ...(error === undefined ? {} : { error: { ...error, ...(output === '' ? {} : { output }) } }),
      notes: [...state.notes],
    }
    if (state.text !== '') queue.emit({ kind: 'message.completed', runId, at: finishedAt, text: state.text })
    finish(result)
  }

  producer().catch((error: unknown) => {
    host.log('warn', `grok ACP run producer failed: ${errorMessage(error)}`)
    abortController.abort()
    process?.closeStdin?.()
    process?.cancel('Grok ACP run producer failed')
    finish(failed('run/protocol-error', 'the Grok ACP run could not complete', 'Re-dispatch the run; if it repeats, capture the grok ACP stream for diagnosis.'))
  })

  return {
    id: runId,
    result: queue.result,
    cancel(reason?: string): void {
      if (cancelled) return
      cancelReason = reason
      requestCancel()
    },
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  }
}

/** Build the line stream expected by ACP from the host's line-oriented process output. */
function lineStream(process: HostProcess): ReadableStream<Uint8Array> {
  const iterator = process.lines[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(`${next.value}\n`))
      } catch (error: unknown) {
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}

/** Wait for an ACP request or report that its child exited first. */
async function raceWithExit<T>(pending: Promise<T>, process: HostProcess): Promise<T> {
  return await Promise.race([
    pending,
    process.exit.then((exit) => {
      throw new Error(`Grok ACP exited before the request completed (${exit.code === null ? exit.signal ?? 'unknown status' : `code ${String(exit.code)}`})`)
    }),
  ])
}

/** Set exact advertised ACP session values or fail before sending the prompt. */
async function applySessionOverrides(
  agent: ClientContext,
  sessionId: string,
  options: readonly SessionConfigOption[] | undefined,
  config: ResolvedGrokConfig,
  request: AgentRunRequest,
): Promise<void> {
  const desired = [
    { id: 'model', category: 'model', value: request.model ?? config.model },
  ].filter((entry): entry is { id: string; category: string; value: string } => entry.value !== undefined && entry.value !== '')
  for (const setting of desired) {
    const matches = (options ?? []).filter(option => option.id === setting.id || option.category === setting.category)
    if (matches.length !== 1) throw new Error(`Grok ACP does not expose one unambiguous ${setting.id} configuration option`)
    const option = matches[0]
    if (option === undefined || option.type !== 'select') throw new Error(`Grok ACP ${setting.id} option is not a selector`)
    const valueExists = option.options.some(group => 'value' in group ? group.value === setting.value : group.options.some(value => value.value === setting.value))
    if (!valueExists) throw new Error(`Grok ACP ${setting.id} option does not offer the requested value`)
    await agent.request(methods.agent.session.setConfigOption, { sessionId, configId: option.id, value: setting.value })
  }
}

/** Identify Grok settings that ACP does not expose without silently dropping them. */
function unsupportedAcpOverrides(config: ResolvedGrokConfig, request: AgentRunRequest): string | undefined {
  if (config.maxTurns !== undefined) return 'Grok ACP does not accept maxTurns; the setting was not applied.'
  if (config.reasoningEffort !== undefined) return 'Grok ACP does not accept reasoningEffort; the setting was not applied.'
  if (config.noPlan || config.noSubagents || config.disableWebSearch) return 'Grok ACP does not accept the configured CLI-only feature flags.'
  const approval = request.approval ?? config.approval
  if (
    approval !== undefined
    && approval !== ''
    && approval !== 'default'
    && GROK_APPROVAL_MODES.includes(approval)
  ) {
    return `Grok ACP cannot safely apply approval mode "${approval}"; use headless-exec for that mode.`
  }
  return undefined
}

/** Resolve one DSH permission request when the run is cancelled. */
async function raceWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | 'cancelled'> {
  if (signal.aborted) return 'cancelled'
  return await new Promise<T | 'cancelled'>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve('cancelled')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      },
    )
  })
}

/** Map one ACP update to the mesh run event vocabulary. */
function mapUpdate(context: GrokRunContext, update: SessionUpdate, state: GrokAcpState): readonly AgentRunEvent[] {
  const at = new Date(context.host.now()).toISOString()
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = textBlock(update.content)
      if (text === undefined) return [unknown(context, update)]
      state.text += text
      return [{ kind: 'message.delta', runId: context.runId, at, text }]
    }
    case 'agent_thought_chunk': {
      const text = textBlock(update.content)
      return text === undefined ? [unknown(context, update)] : [{ kind: 'reasoning.delta', runId: context.runId, at, text }]
    }
    case 'tool_call':
      return [{
        kind: 'tool.started',
        runId: context.runId,
        at,
        callId: update.toolCallId,
        toolName: update.name ?? update.title,
        ...(update.rawInput === undefined ? {} : { input: stringifyBounded(update.rawInput) }),
      }]
    case 'tool_call_update': {
      const events: AgentRunEvent[] = []
      if (update.status === 'completed' || update.status === 'failed') {
        events.push({
          kind: 'tool.completed',
          runId: context.runId,
          at,
          callId: update.toolCallId,
          toolName: update.name ?? update.title ?? 'tool',
          ...(update.rawOutput === undefined ? {} : { output: stringifyBounded(update.rawOutput) }),
          ...(update.status === 'failed' ? { failed: true } : {}),
        })
      }
      const paths = (update.locations ?? []).map(location => location.path).filter(path => path !== '')
      if (paths.length > 0) events.push({ kind: 'files.changed', runId: context.runId, at, paths })
      return events.length === 0 ? [unknown(context, update)] : events
    }
    case 'plan':
      return [{
        kind: 'todos.updated',
        runId: context.runId,
        at,
        todos: update.entries.map(entry => ({ content: entry.content, status: entry.status })),
      }]
    case 'usage_update': {
      const costUsd = update.cost?.currency === 'USD' ? update.cost.amount : undefined
      if (costUsd === undefined) return [unknown(context, update)]
      state.usage = { ...(state.usage ?? {}), costUsd }
      return [{ kind: 'usage.updated', runId: context.runId, at, usage: state.usage }]
    }
    case 'user_message_chunk':
      return []
    default:
      return [unknown(context, update)]
  }
}

/** Return text content only for ACP text blocks. */
function textBlock(content: { readonly type: string; readonly text?: string }): string | undefined {
  return content.type === 'text' && content.text !== undefined ? content.text : undefined
}

/** Preserve an ACP update that has no mesh event equivalent. */
function unknown(context: GrokRunContext, update: SessionUpdate): AgentRunEvent {
  return {
    kind: 'unknown',
    runId: context.runId,
    at: new Date(context.host.now()).toISOString(),
    nativeType: update.sessionUpdate,
    native: stringifyBounded(update),
  }
}

/** Emit a diagnostic event with one timestamp. */
function warning(context: GrokRunContext, message: string): AgentRunEvent {
  return { kind: 'warning', runId: context.runId, at: new Date(context.host.now()).toISOString(), message }
}

/** Serialize a native value while bounding how much reaches the session log. */
function stringifyBounded(value: unknown): string {
  return bounded(JSON.stringify(value), MAX_EVENT_TEXT_BYTES)
}

/** Bound an external string by UTF-8 byte count. */
function bounded(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  return bytes.byteLength <= maxBytes ? value : `${bytes.subarray(0, maxBytes).toString('utf8')}…`
}

/** Format an unknown thrown value for logs and run results. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
