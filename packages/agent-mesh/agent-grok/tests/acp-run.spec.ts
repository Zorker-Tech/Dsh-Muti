import { describe, expect, it } from 'vitest'
import type { AgentRunApprovalRequest, AgentRunId, HostExit, HostProcess } from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveGrokConfig } from '../src/config.ts'
import { GROK_AGENT_ID, resolveGrokPaths } from '../src/sessions.ts'
import { startGrokAcpRun } from '../src/acp-run.ts'
import type { GrokRunContext } from '../src/run.ts'
import { MemoryHost } from './support/memory-host.ts'

interface AcpScriptOptions {
  readonly permission?: boolean
}

function acpRun(options: AcpScriptOptions = {}) {
  const host = new MemoryHost({ home: '/home/tester', env: { PATH: '' } })
  const writes: string[] = []
  const permissionResponses: unknown[] = []
  let settleExit: ((exit: HostExit) => void) | undefined
  let activePromptId: unknown
  const exit = new Promise<HostExit>((resolve) => { settleExit = resolve })
  const lines: string[] = []
  const readers: (() => void)[] = []
  let closed = false
  const wake = (): void => { for (const reader of readers.splice(0)) reader() }
  const push = (value: unknown): void => {
    lines.push(JSON.stringify(value))
    wake()
  }
  const sendResponse = (id: unknown, result: unknown): void =>{  push({ jsonrpc: '2.0', id, result }) }
  const process: HostProcess = {
    lines: {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        while (true) {
          if (lines.length > 0) {
            yield lines.shift() ?? ''
            continue
          }
          if (closed) return
          await new Promise<void>(resolve => readers.push(resolve))
        }
      },
    },
    async stderr(): Promise<string> { return '' },
    exit,
    writeStdin(data: string): void {
      writes.push(data)
      for (const encoded of data.trim().split('\n')) {
        if (encoded === '') continue
        const frame: unknown = JSON.parse(encoded)
        if (!isRecord(frame)) continue
        const id = frame['id']
        const method = frame['method']
        if (method === 'initialize') {
          sendResponse(id, { protocolVersion: 1, authMethods: [{ id: 'cached_token', name: 'Local login' }], agentCapabilities: { loadSession: true } })
        } else if (method === 'authenticate') {
          sendResponse(id, {})
        } else if (method === 'session/new') {
          sendResponse(id, { sessionId: 'grok-acp-session', configOptions: [] })
        } else if (method === 'session/prompt') {
          activePromptId = id
          const params = frame['params']
          const sessionId = isRecord(params) ? params['sessionId'] : undefined
          if (options.permission) {
            push({
              jsonrpc: '2.0',
              id: 'dsh-permission',
              method: 'session/request_permission',
              params: {
                sessionId,
                toolCall: { toolCallId: 'tool-1', kind: 'execute', name: 'shell', title: 'Run a command', rawInput: { token: 'do-not-forward' } },
                options: [
                  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
                  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
                ],
              },
            })
          } else {
            push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP answer' } } } })
            sendResponse(activePromptId, { stopReason: 'end_turn' })
          }
        } else if (typeof method !== 'string' && frame['id'] === 'dsh-permission') {
          permissionResponses.push(frame)
          const result = frame['result']
          const outcome = isRecord(result) ? result['outcome'] : undefined
          if (options.permission && typeof outcome === 'object' && outcome !== null) {
            expect(isRecord(outcome) ? outcome['optionId'] : undefined).toBe('once')
            push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'grok-acp-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Approved' } } } })
            sendResponse(activePromptId, { stopReason: 'end_turn' })
          }
        } else if (method === 'session/cancel') {
          sendResponse(id, {})
        }
      }
    },
    closeStdin(): void {
      if (closed) return
      closed = true
      settleExit?.({ code: 0, signal: null, timedOut: false, cancelled: false })
      wake()
    },
    cancel(): void {
      if (closed) return
      closed = true
      settleExit?.({ code: null, signal: 'SIGTERM', timedOut: false, cancelled: true })
      wake()
    },
  }
  host.spawn = (spec) => {
    host.spawned.push(spec)
    return process
  }
  const context: GrokRunContext = {
    host,
    config: resolveGrokConfig(),
    agentId: GROK_AGENT_ID,
    runId: brandString<AgentRunId>('grok-acp-test'),
    paths: resolveGrokPaths(host, undefined),
    resolveBinary: async () => '/usr/bin/grok',
  }
  const approvalRequests: AgentRunApprovalRequest[] = []
  const run = startGrokAcpRun(context, {
    prompt: 'do something',
    cwd: '/work',
    ...(options.permission ? { requestApproval: async (approval) => {
      approvalRequests.push(approval)
      return 'allowed-once'
    } } : {}),
  })
  return { run, host, writes, permissionResponses, approvalRequests }
}

describe('Grok ACP run', () => {
  it('authenticates, binds a native session, and projects streamed assistant text', async () => {
    const { run, host, writes } = acpRun()
    const result = await run.result

    expect(result).toMatchObject({ status: 'succeeded', nativeSessionKey: 'grok:grok-acp-session', finalText: 'ACP answer' })
    expect(host.spawned[0]).toMatchObject({ command: '/usr/bin/grok', args: ['--no-auto-update', 'agent', 'stdio'], interactive: true })
    expect(writes.join('')).toContain('"method":"authenticate"')
    expect(writes.join('')).toContain('"method":"session/prompt"')
  })

  it('forwards only a one-shot DSH decision and leaves raw permission input out of the prompt', async () => {
    const { run, approvalRequests, permissionResponses } = acpRun({ permission: true })
    const result = await run.result

    expect(result.status).toBe('succeeded')
    expect(approvalRequests).toHaveLength(1)
    expect(approvalRequests[0]?.detail).not.toContain('do-not-forward')
    expect(permissionResponses).toHaveLength(1)
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
