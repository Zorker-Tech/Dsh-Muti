import { describe, expect, it } from 'vitest'
import type { PermissionOption, SessionConfigOption, SessionUpdate, ToolKind } from '@agentclientprotocol/sdk'
import type {
  AgentRunApprovalOutcome,
  AgentRunApprovalRequest,
  AgentRunEvent,
  AgentRunId,
  AgentRunRequest,
  HostExit,
  HostProcess,
} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveGrokConfig, type GrokAdapterConfig } from '../src/config.ts'
import { GROK_AGENT_ID, resolveGrokPaths } from '../src/sessions.ts'
import { startGrokAcpRun } from '../src/acp-run.ts'
import type { GrokRunContext } from '../src/run.ts'
import { MemoryHost } from './support/memory-host.ts'

interface AcpScriptOptions {
  readonly permission?: boolean
  readonly omitApproval?: boolean
  readonly permissionDecision?: AgentRunApprovalOutcome
  readonly permissionFailure?: unknown
  readonly permissionNever?: boolean
  readonly permissionOptions?: readonly PermissionOption[]
  readonly cancelOnApproval?: boolean
  readonly exitDuringApproval?: boolean
  readonly permissionTitle?: string
  readonly permissionName?: string | null
  readonly permissionKind?: ToolKind | null
  readonly updates?: readonly SessionUpdate[]
  readonly updateSessionId?: string
  readonly stopReason?: 'end_turn' | 'max_turns' | 'cancelled' | 'refusal'
  readonly authMethods?: readonly { readonly id: string; readonly name: string }[] | null
  readonly apiKey?: string
  readonly loadSessionCapability?: boolean
  readonly sessionId?: string
  readonly configOptions?: readonly SessionConfigOption[]
  readonly failMethod?: string
  readonly failMessage?: string
  readonly stderr?: string
  readonly stderrFailure?: unknown
  readonly exit?: Partial<HostExit>
  readonly resolveBinary?: string | null
  readonly spawnFailure?: unknown
  readonly nonInteractive?: boolean
  readonly holdPrompt?: boolean
  readonly ignoreCancel?: boolean
  readonly failNotifyCancel?: boolean
  readonly omitConfigOptions?: boolean
  readonly earlyUpdate?: SessionUpdate
  readonly exitBeforeMethod?: string
  readonly unknownExitStatus?: boolean
  readonly failOutputAfterMethod?: string
  readonly resolveFailure?: unknown
  readonly config?: GrokAdapterConfig
  readonly request?: Partial<AgentRunRequest>
}

function scriptedAcpRun(options: AcpScriptOptions = {}) {
  const host = new MemoryHost({
    home: '/home/tester',
    env: { PATH: '', ...(options.apiKey === undefined ? {} : { XAI_API_KEY: options.apiKey }) },
  })
  const writes: string[] = []
  const permissionResponses: unknown[] = []
  const cancelCalls: (string | undefined)[] = []
  let settleExit: ((facts: HostExit) => void) | undefined
  let activePromptId: unknown
  const cancelRun: { current?: () => void } = {}
  let activeSessionId = options.sessionId ?? 'grok-acp-session'
  let promptCompleted = false
  let cancelRequested = false
  let closed = false
  let failOutput = false
  const exit = new Promise<HostExit>((resolve) => { settleExit = resolve })
  const lines: string[] = []
  const readers: (() => void)[] = []
  const wake = (): void => { for (const reader of readers.splice(0)) reader() }
  const push = (value: unknown): void => {
    lines.push(JSON.stringify(value))
    wake()
  }
  const sendResponse = (id: unknown, result: unknown): void =>{  push({ jsonrpc: '2.0', id, result }) }
  const sendError = (id: unknown, message: string): void =>{  push({ jsonrpc: '2.0', id, error: { code: -32_000, message } }) }
  const finishPrompt = (stopReason: 'end_turn' | 'max_turns' | 'cancelled' | 'refusal' = 'end_turn'): void => {
    if (promptCompleted || activePromptId === undefined) return
    promptCompleted = true
    const updates = options.updates ?? [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP answer' } }]
    for (const update of updates) {
      push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: options.updateSessionId ?? activeSessionId, update } })
    }
    sendResponse(activePromptId, { stopReason: options.stopReason ?? stopReason })
  }
  const child: HostProcess = {
    lines: {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        while (true) {
          if (lines.length > 0) {
            yield lines.shift() ?? ''
            continue
          }
          if (failOutput) {
            closed = true
            settleExit?.({ code: null, signal: 'SIGTERM', timedOut: false, cancelled: true })
            wake()
            throw new Error('scripted ACP stdout failure')
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
    ...(options.nonInteractive ? {} : {
      writeStdin(data: string): void {
        writes.push(data)
        for (const encoded of data.trim().split('\n')) {
          if (encoded === '') continue
          const frame: unknown = JSON.parse(encoded)
          if (!isRecord(frame)) continue
          const id = frame['id']
          const method = frame['method']
          if (typeof method === 'string' && method === options.exitBeforeMethod) {
            closed = true
            settleExit?.({
              code: options.unknownExitStatus ? null : 2,
              signal: options.unknownExitStatus ? null : 'SIGTERM',
              timedOut: false,
              cancelled: false,
            })
            wake()
          } else if (typeof method === 'string' && method === options.failMethod) {
            sendError(id, options.failMessage ?? 'scripted ACP error')
          } else if (method === 'initialize') {
            if (options.earlyUpdate !== undefined) {
              push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'early-session', update: options.earlyUpdate } })
            }
            sendResponse(id, {
              protocolVersion: 1,
              ...(options.authMethods === null ? {} : {
                authMethods: options.authMethods ?? [
                  { id: 'cached_token', name: 'Local login' },
                  { id: 'xai.api_key', name: 'API key' },
                ],
              }),
              agentCapabilities: { loadSession: options.loadSessionCapability ?? true },
            })
            failOutput = options.failOutputAfterMethod === 'initialize'
          } else if (method === 'authenticate') {
            sendResponse(id, {})
          } else if (method === 'session/new') {
            activeSessionId = options.sessionId ?? 'grok-acp-session'
            sendResponse(id, {
              sessionId: activeSessionId,
              ...(options.omitConfigOptions ? {} : { configOptions: options.configOptions ?? [] }),
            })
            failOutput = options.failOutputAfterMethod === 'session/new'
          } else if (method === 'session/load') {
            sendResponse(id, options.omitConfigOptions ? {} : { configOptions: options.configOptions ?? [] })
          } else if (method === 'session/set_config_option') {
            sendResponse(id, {})
          } else if (method === 'session/prompt') {
            activePromptId = id
            const params = frame['params']
            const sessionId = isRecord(params) ? params['sessionId'] : undefined
            if (typeof sessionId === 'string') activeSessionId = sessionId
            if (options.permission === true) {
              push({
                jsonrpc: '2.0',
                id: 'dsh-permission',
                method: 'session/request_permission',
                params: {
                  sessionId: activeSessionId,
                  toolCall: {
                    toolCallId: 'tool-1',
                    ...(options.permissionKind === null ? {} : { kind: options.permissionKind ?? 'execute' }),
                    ...(options.permissionName === null ? {} : { name: options.permissionName ?? 'shell' }),
                    title: options.permissionTitle ?? 'Run a command',
                    rawInput: { token: 'do-not-forward' },
                  },
                  options: options.permissionOptions ?? [
                    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
                    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
                  ],
                },
              })
              if (options.exitDuringApproval) {
                closed = true
                settleExit?.({ code: 2, signal: null, timedOut: false, cancelled: false })
                wake()
              }
            } else if (!options.holdPrompt && !cancelRequested) {
              finishPrompt()
            }
          } else if (typeof method !== 'string' && frame['id'] === 'dsh-permission') {
            permissionResponses.push(frame)
            const result = frame['result']
            const outcome = isRecord(result) ? result['outcome'] : undefined
            const selected = isRecord(outcome) && outcome['outcome'] === 'selected'
            finishPrompt(cancelRequested || !selected ? 'cancelled' : 'end_turn')
          } else if (method === 'session/cancel') {
            if (options.failNotifyCancel) throw new Error('cancel notification could not be sent')
            cancelRequested = true
            if (!options.permission && !options.ignoreCancel) finishPrompt('cancelled')
          }
        }
      },
      closeStdin(): void {
        if (closed) return
        closed = true
        settleExit?.({
          code: options.exit?.code ?? 0,
          signal: options.exit?.signal ?? null,
          timedOut: options.exit?.timedOut ?? false,
          cancelled: false,
        })
        wake()
      },
    }),
    cancel(reason?: string): void {
      if (closed) return
      cancelCalls.push(reason)
      closed = true
      settleExit?.({
        code: options.exit?.code ?? null,
        signal: options.exit?.signal ?? 'SIGTERM',
        timedOut: options.exit?.timedOut ?? false,
        cancelled: true,
      })
      wake()
    },
  }
  host.spawn = (spec) => {
    host.spawned.push(spec)
    if (options.spawnFailure !== undefined) throw options.spawnFailure
    return child
  }
  const context: GrokRunContext = {
    host,
    config: resolveGrokConfig(options.config),
    agentId: GROK_AGENT_ID,
    runId: brandString<AgentRunId>('grok-acp-protocol-test'),
    paths: resolveGrokPaths(host, undefined),
    resolveBinary: async () => {
      if (options.resolveFailure !== undefined) throw options.resolveFailure
      return options.resolveBinary === null ? undefined : options.resolveBinary ?? '/usr/bin/grok'
    },
  }
  const approvalRequests: AgentRunApprovalRequest[] = []
  const request: AgentRunRequest = {
    prompt: 'do something',
    cwd: '/work',
    ...(options.request ?? {}),
    ...(options.permission && !options.omitApproval ? {
      requestApproval: async (approval) => {
        approvalRequests.push(approval)
        if (options.cancelOnApproval) cancelRun.current?.()
        if (options.permissionNever) return await new Promise<AgentRunApprovalOutcome>(() => undefined)
        if (options.permissionFailure !== undefined) throw options.permissionFailure
        return options.permissionDecision ?? 'allowed-once'
      },
    } : {}),
  }
  const run = startGrokAcpRun(context, request)
  cancelRun.current = () => { run.cancel('cancelled during DSH approval') }
  return { run, host, writes, permissionResponses, approvalRequests, cancelCalls }
}

const modelOption: SessionConfigOption = {
  type: 'select',
  id: 'model',
  category: 'model',
  name: 'Model',
  currentValue: 'grok-3',
  options: [{ value: 'grok-4', name: 'Grok 4' }],
}

describe('Grok ACP protocol paths', () => {
  it('projects ACP text, reasoning, tool, plan, usage, and unknown updates', async () => {
    const { run } = scriptedAcpRun({
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Answer' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', name: 'file', uri: 'file:///work/a' } },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'resource_link', name: 'file', uri: 'file:///work/a' } },
        { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read', rawInput: { path: '/work/a' } },
        { sessionUpdate: 'tool_call', toolCallId: 'tool-no-input', title: 'No input' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: { text: 'ok' }, locations: [{ path: '/work/a' }, { path: '' }] },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tool-2', status: 'failed' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tool-3', status: 'in_progress', locations: [{ path: '/work/b' }] },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tool-4', status: 'pending' },
        { sessionUpdate: 'plan', entries: [{ content: 'Write code', priority: 'high', status: 'in_progress' }] },
        { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.1, currency: 'USD' } },
        { sessionUpdate: 'usage_update', used: 11, size: 100, cost: { amount: 0.2, currency: 'EUR' } },
        { sessionUpdate: 'usage_update', used: 12, size: 100 },
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'prompt echo' } },
        { sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'plan-1', content: '## Plan' } },
      ],
    })
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)
    const result = await run.result

    expect(result).toMatchObject({ status: 'succeeded', finalText: 'Answer' })
    expect(events.some(event => event.kind === 'reasoning.delta' && event.text === 'Thinking')).toBe(true)
    expect(events.some(event => event.kind === 'tool.started' && event.callId === 'tool-1')).toBe(true)
    expect(events.some(event => event.kind === 'tool.started' && event.callId === 'tool-no-input' && event.input === undefined)).toBe(true)
    expect(events.some(event => event.kind === 'tool.completed' && event.callId === 'tool-1')).toBe(true)
    expect(events.some(event => event.kind === 'tool.completed' && event.failed === true)).toBe(true)
    expect(events.some(event => event.kind === 'files.changed' && event.paths.includes('/work/b'))).toBe(true)
    expect(events.some(event => event.kind === 'todos.updated')).toBe(true)
    expect(events.some(event => event.kind === 'usage.updated' && event.usage.costUsd === 0.1)).toBe(true)
    expect(events.filter(event => event.kind === 'unknown').length).toBeGreaterThanOrEqual(5)
  })

  it('preserves mismatched-session updates as warning and unknown events and bounds copied inputs', async () => {
    const { run } = scriptedAcpRun({
      updateSessionId: 'foreign-session',
      updates: [{ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Tool', rawInput: { detail: 'x'.repeat(20_000) } }],
    })
    const events: AgentRunEvent[] = []
    for await (const event of run) events.push(event)

    expect(events.some(event => event.kind === 'warning' && event.message.includes('different session'))).toBe(true)
    expect(events.some(event => event.kind === 'unknown')).toBe(true)
    expect(events.some(event => event.kind === 'tool.started' && event.input?.endsWith('…'))).toBe(false)
  })

  it('uses the API-key auth route and loads an existing native session with a grouped model option', async () => {
    const groupedOption: SessionConfigOption = {
      type: 'select', id: 'model', name: 'Model', currentValue: 'grok-3', options: [
        { group: 'grok', name: 'Grok', options: [{ value: 'grok-4', name: 'Grok 4' }] },
      ],
    }
    const { run, writes } = scriptedAcpRun({
      apiKey: 'test-key',
      sessionId: 'loaded-session',
      configOptions: [groupedOption],
      request: { resumeNativeId: 'loaded-session', model: 'grok-4' },
    })
    const result = await run.result

    expect(result).toMatchObject({ status: 'succeeded', nativeSessionKey: 'grok:loaded-session' })
    expect(writes.join('')).toContain('"methodId":"xai.api_key"')
    expect(writes.join('')).toContain('"method":"session/load"')
    expect(writes.join('')).toContain('"method":"session/set_config_option"')
  })

  it('maps one-shot allow and reject decisions while withholding persistent permission options', async () => {
    const allowed = scriptedAcpRun({ permission: true })
    await expect(allowed.run.result).resolves.toMatchObject({ status: 'succeeded' })
    expect(allowed.approvalRequests).toHaveLength(1)
    expect(allowed.approvalRequests[0]?.detail).not.toContain('do-not-forward')
    expect(allowed.permissionResponses).toHaveLength(1)

    const rejected = scriptedAcpRun({
      permission: true,
      permissionDecision: 'rejected',
      permissionOptions: [{ optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }],
    })
    await expect(rejected.run.result).resolves.toMatchObject({ status: 'succeeded' })
    expect(JSON.stringify(rejected.permissionResponses)).toContain('reject-once')
  })

  it('requires the matching one-shot option and maps file changes and missing tool labels', async () => {
    const missingAllow = scriptedAcpRun({
      permission: true,
      permissionOptions: [{ optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' }],
    })
    await expect(missingAllow.run.result).resolves.toMatchObject({ status: 'cancelled' })

    const missingReject = scriptedAcpRun({
      permission: true,
      permissionDecision: 'rejected',
      permissionOptions: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    })
    await expect(missingReject.run.result).resolves.toMatchObject({ status: 'cancelled' })

    const edit = scriptedAcpRun({ permission: true, permissionKind: 'edit', permissionTitle: '', permissionName: 'apply_patch' })
    await edit.run.result
    expect(edit.approvalRequests[0]).toMatchObject({ kind: 'file-change', title: 'apply_patch' })

    const unnamed = scriptedAcpRun({ permission: true, permissionKind: null, permissionTitle: '', permissionName: null })
    await unnamed.run.result
    expect(unnamed.approvalRequests[0]).toMatchObject({ kind: 'command', title: 'Grok tool request' })
    expect(unnamed.approvalRequests[0]?.detail).toContain('Grok requested tool:')
  })

  it('declines permission when no DSH callback exists, a choice is missing, or the callback fails', async () => {
    const noCallback = scriptedAcpRun({ permission: true, omitApproval: true })
    await expect(noCallback.run.result).resolves.toMatchObject({ status: 'cancelled' })

    const noChoice = scriptedAcpRun({ permission: true, permissionOptions: [{ optionId: 'always', name: 'Always', kind: 'allow_always' }] })
    await expect(noChoice.run.result).resolves.toMatchObject({ status: 'cancelled' })

    const failedCallback = scriptedAcpRun({ permission: true, permissionFailure: 'dialog unavailable' })
    await expect(failedCallback.run.result).resolves.toMatchObject({ status: 'cancelled' })
    expect(failedCallback.host.logs.some(line => line.includes('dialog unavailable'))).toBe(true)

    const errorCallback = scriptedAcpRun({ permission: true, permissionFailure: new Error('dialog unavailable') })
    await expect(errorCallback.run.result).resolves.toMatchObject({ status: 'cancelled' })
    expect(errorCallback.host.logs.some(line => line.includes('dialog unavailable'))).toBe(true)
  })

  it('unblocks a pending DSH approval when the run is cancelled', async () => {
    const { run, permissionResponses } = scriptedAcpRun({ permission: true, permissionNever: true, config: { interruptGraceMs: 100 } })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    run.cancel('cancel approval')
    await expect(run.result).resolves.toMatchObject({ status: 'cancelled' })
    expect(permissionResponses).toHaveLength(1)

    const alreadyCancelled = scriptedAcpRun({ permission: true, cancelOnApproval: true })
    await expect(alreadyCancelled.run.result).resolves.toMatchObject({ status: 'cancelled' })
    expect(alreadyCancelled.permissionResponses).toHaveLength(1)

    const processExit = scriptedAcpRun({ permission: true, permissionNever: true, exitDuringApproval: true })
    await expect(processExit.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })
  })

  it('cancels before session binding and terminates after the grace period when Grok ignores cancellation', async () => {
    const beforeStart = scriptedAcpRun()
    beforeStart.run.cancel('cancel before spawn')
    await expect(beforeStart.run.result).resolves.toMatchObject({ status: 'cancelled' })
    expect(beforeStart.writes.join('')).not.toContain('"method":"session/prompt"')

    const ignored = scriptedAcpRun({ holdPrompt: true, ignoreCancel: true, config: { interruptGraceMs: 10 } })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    ignored.run.cancel('grok did not settle')
    ignored.run.cancel('duplicate cancellation')
    await expect(ignored.run.result).resolves.toMatchObject({ status: 'cancelled' })
    expect(ignored.cancelCalls).toContain('grok did not settle')
  })

  it('fails closed for unsupported settings, invalid profiles, and unavailable binaries', async () => {
    const cases: readonly GrokAdapterConfig[] = [
      { maxTurns: 2 },
      { reasoningEffort: 'high' },
      { noPlan: true },
      { approval: 'auto' },
    ]
    for (const config of cases) {
      const { run, host } = scriptedAcpRun({ config })
      await expect(run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/config-unsupported' } })
      expect(host.spawned).toHaveLength(0)
    }

    const invalidSandbox = scriptedAcpRun({ request: { sandbox: 'wild-west' } })
    await expect(invalidSandbox.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'schema/invalid' } })

    const invalidApproval = scriptedAcpRun({ request: { approval: 'not-a-grok-mode' } })
    await expect(invalidApproval.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'schema/invalid' } })

    const noBinary = scriptedAcpRun({ resolveBinary: null })
    await expect(noBinary.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'detection/not-found' } })
  })

  it('reports launch, interactive transport, and authentication failures without prompting', async () => {
    const launchFailure = scriptedAcpRun({ spawnFailure: new Error('spawn denied') })
    await expect(launchFailure.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/start-failed' } })

    const nonInteractive = scriptedAcpRun({ nonInteractive: true })
    await expect(nonInteractive.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/transport-unavailable' } })

    const noAuth = scriptedAcpRun({ authMethods: [] })
    await expect(noAuth.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/auth-not-configured' } })

    const omittedAuthMethods = scriptedAcpRun({ authMethods: null })
    await expect(omittedAuthMethods.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/auth-not-configured' } })

    const noApiKeyMethod = scriptedAcpRun({ apiKey: 'test-key', authMethods: [{ id: 'cached_token', name: 'Local login' }] })
    await expect(noApiKeyMethod.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/auth-not-configured' } })
  })

  it('refuses unsupported resume, config options, and ACP request failures before sending a prompt', async () => {
    const noLoad = scriptedAcpRun({ loadSessionCapability: false, request: { resumeNativeId: 'session-1' } })
    expectFailedResult(await noLoad.run.result, { messageIncludes: 'session/load' })

    const missingModel = scriptedAcpRun({ config: { model: 'grok-4' } })
    expectFailedResult(await missingModel.run.result, { messageIncludes: 'unambiguous model' })

    const booleanModel: SessionConfigOption = { type: 'boolean', id: 'model', name: 'Model', currentValue: true }
    const wrongType = scriptedAcpRun({ config: { model: 'grok-4' }, configOptions: [booleanModel] })
    expectFailedResult(await wrongType.run.result, { messageIncludes: 'not a selector' })

    const noValue = scriptedAcpRun({
      config: { model: 'grok-4' },
      configOptions: [{ ...modelOption, options: [{ value: 'grok-3', name: 'Grok 3' }] }],
    })
    expectFailedResult(await noValue.run.result, { messageIncludes: 'does not offer' })

    const ambiguous = scriptedAcpRun({ config: { model: 'grok-4' }, configOptions: [modelOption, { ...modelOption, id: 'other' }] })
    expectFailedResult(await ambiguous.run.result, { messageIncludes: 'unambiguous' })

    const setFailure = scriptedAcpRun({ config: { model: 'grok-4' }, configOptions: [modelOption], failMethod: 'session/set_config_option' })
    await expect(setFailure.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })

    const authFailure = scriptedAcpRun({ failMethod: 'authenticate' })
    await expect(authFailure.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/auth-not-configured' } })

    const sessionFailure = scriptedAcpRun({ failMethod: 'session/new' })
    await expect(sessionFailure.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })

    const loadWithoutConfig = scriptedAcpRun({ omitConfigOptions: true, request: { resumeNativeId: 'existing-session' } })
    await expect(loadWithoutConfig.run.result).resolves.toMatchObject({ status: 'succeeded' })

    const newWithoutConfig = scriptedAcpRun({ omitConfigOptions: true })
    await expect(newWithoutConfig.run.result).resolves.toMatchObject({ status: 'succeeded' })

    const configuredModelWithoutOptions = scriptedAcpRun({ config: { model: 'grok-4' }, omitConfigOptions: true })
    expectFailedResult(await configuredModelWithoutOptions.run.result, {
      code: 'run/protocol-error', messageIncludes: 'unambiguous model',
    })

    const resumedFailure = scriptedAcpRun({ failMethod: 'initialize', request: { resumeNativeId: 'existing-session' } })
    await expect(resumedFailure.run.result).resolves.toMatchObject({ status: 'failed', nativeSessionKey: 'grok:existing-session' })
  })

  it('classifies refusal, cancellation, timeout, stderr failures, and redacts captured secrets', async () => {
    const refusal = scriptedAcpRun({ stopReason: 'refusal' })
    await expect(refusal.run.result).resolves.toMatchObject({ status: 'succeeded' })

    const cancelled = scriptedAcpRun({ stopReason: 'cancelled' })
    await expect(cancelled.run.result).resolves.toMatchObject({ status: 'cancelled' })

    const timedOut = scriptedAcpRun({ exit: { code: null, signal: 'SIGTERM', timedOut: true } })
    await expect(timedOut.run.result).resolves.toMatchObject({ status: 'timeout' })

    const stderrFailure = scriptedAcpRun({ stderrFailure: new Error('stderr read failed') })
    await expect(stderrFailure.run.result).resolves.toMatchObject({ status: 'succeeded' })
    expect(stderrFailure.host.logs.some(line => line.includes('stderr could not be read'))).toBe(true)

    const redacted = scriptedAcpRun({ exit: { code: 1 }, stderr: 'xai-supersecretkeymaterial123456' })
    const result = await redacted.run.result
    expect(result.status).toBe('failed')
    expect(result.error?.output).not.toContain('supersecretkeymaterial')
    expect(result.error?.output).toContain('<redacted:key>')

    const longStderr = scriptedAcpRun({ exit: { code: 1 }, stderr: `start${'x'.repeat(3_000)}` })
    const longResult = await longStderr.run.result
    expect(longResult.error?.output?.length).toBe(2_000)
  })

  it('handles early updates, timeout wiring, and an ACP stream that ends before initialize responds', async () => {
    const early = scriptedAcpRun({
      config: { sandbox: 'workspace' },
      request: { sandbox: '' , approval: 'default', timeoutMs: 250 },
      earlyUpdate: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'early' } },
    })
    const result = await early.run.result
    expect(result).toMatchObject({ status: 'succeeded' })
    expect(early.host.spawned[0]).toMatchObject({ timeoutMs: 250 })

    const noAuthMethod = scriptedAcpRun({ exitBeforeMethod: 'initialize', unknownExitStatus: true })
    expectFailedResult(await noAuthMethod.run.result, {
      code: 'run/protocol-error', messageIncludes: 'unknown status',
    })
  })

  it('reports stderr output, non-Error startup exceptions, and failed cancel notifications', async () => {
    const resolveFailure = scriptedAcpRun({ resolveFailure: 'binary resolver failed' })
    await expect(resolveFailure.run.result).resolves.toMatchObject({ status: 'failed', error: { code: 'run/protocol-error' } })

    const cancelFailure = scriptedAcpRun({ holdPrompt: true, ignoreCancel: true, failNotifyCancel: true, config: { interruptGraceMs: 10 } })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    cancelFailure.run.cancel('cancel after notify')
    await expect(cancelFailure.run.result).resolves.toMatchObject({ status: 'cancelled' })
    expect(cancelFailure.host.logs.some(line => line.includes('session cancellation failed'))).toBe(true)

    const brokenOutput = scriptedAcpRun({ failOutputAfterMethod: 'initialize' })
    await expect(brokenOutput.run.result).resolves.toMatchObject({ status: 'failed' })
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectFailedResult(
  result: { readonly status: string; readonly error?: { readonly code?: string; readonly message?: string } },
  expected: { readonly code?: string; readonly messageIncludes?: string },
): void {
  expect(result.status).toBe('failed')
  if (result.status !== 'failed' || result.error === undefined) throw new Error('expected a failed run result')
  if (expected.code !== undefined) expect(result.error.code).toBe(expected.code)
  if (expected.messageIncludes !== undefined) expect(result.error.message).toContain(expected.messageIncludes)
}
