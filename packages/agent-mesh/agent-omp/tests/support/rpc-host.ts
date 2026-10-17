/** Interactive fake host for OMP's command and event protocol. */

import type { HostExit, HostProcess, HostSpawnSpec } from '@deepseek-ai/dsh-agent-mesh'
import { FakeHost, type FakeHostOptions } from './fake-host.ts'

/** A scripted response to one RPC command. */
export interface OmpRpcResponseScript {
  /** Whether OMP accepted the command. */
  readonly success?: boolean
  /** Error text returned for a rejected command. */
  readonly error?: string
  /** Data returned for an accepted command. */
  readonly data?: Readonly<Record<string, unknown>>
  /** Omit the response's `data` field. */
  readonly omitData?: boolean
  /** End stdout without returning a response. */
  readonly omit?: boolean
}

/** One scripted OMP RPC turn. */
export interface OmpRpcScript {
  /** Native session id returned by `get_state`. */
  readonly sessionId?: string
  /** Event frames emitted after the prompt response. */
  readonly lines?: readonly string[]
  /** Terminal status returned for the prompt command. */
  readonly promptStatus?: 'completed' | 'aborted' | 'error'
  /** Message carried by an error prompt result. */
  readonly promptError?: string
  /** Whether prompt processing remains pending until `abort` arrives. */
  readonly holdPrompt?: boolean
  /** Reply that the prompt completed locally without invoking the model. */
  readonly localPrompt?: boolean
  /** Whether OMP reports that background session work has settled. */
  readonly sessionSettled?: boolean
  /** Text to emit before the ready frame. */
  readonly preludeLines?: readonly string[]
  /** Replace the ready frame; `undefined` means the normal frame and `null` means no frame. */
  readonly readyLine?: string | null
  /** Per-command responses, useful for errors and incomplete setup. */
  readonly commandResponses?: Readonly<Record<string, OmpRpcResponseScript>>
  /** Lines to emit immediately before a command response. */
  readonly commandPreludeLines?: Readonly<Record<string, readonly string[]>>
  /** Status in the prompt-result frame, including an unknown value. */
  readonly promptResultStatus?: string
  /** Settlement value in the prompt-result frame. */
  readonly promptResultSettled?: boolean
  /** Error in the prompt-result frame. */
  readonly promptResultError?: string
  /** Omit the error object even when the prompt-result status is `error`. */
  readonly omitPromptResultError?: boolean
  /** Omit the prompt-result frame. */
  readonly omitPromptResult?: boolean
  /** Emit `session_settled` before the prompt-result frame. */
  readonly settledBeforePromptResult?: boolean
  /** Exit facts returned when stdin closes. */
  readonly exit?: HostExit
  /** Error returned while reading stderr. */
  readonly stderrError?: string
  /** Throw while writing this command type. */
  readonly writeErrorForType?: string
  /** Throw when stdin is closed. */
  readonly closeStdinError?: string
  /** Omit one interactive stdin method. */
  readonly omitStdinMethod?: 'writeStdin' | 'closeStdin'
  /** Throw on this stdout iterator read. */
  readonly throwOnRead?: number
  /** Throw after force-stopping the child. */
  readonly cancelError?: string
  /** Fail the next interactive spawn instead of returning a process. */
  readonly spawnFailure?: unknown
  /** Text returned by the process stderr reader. */
  readonly stderr?: string
}

/** Host that keeps the regular fake filesystem and simulates `omp --mode rpc-ui`. */
export class OmpRpcHost extends FakeHost {
  /** Frames the adapter wrote to OMP, in arrival order. */
  readonly commands: Record<string, unknown>[] = []
  /** Reasons the simulated process was forcibly terminated. */
  readonly processCancellations: string[] = []

  private readonly rpcScripts: OmpRpcScript[] = []
  private readonly commandWaiters = new Map<string, (() => void)[]>()
  private readonly spawnWaiters: (() => void)[] = []
  private stdinCloseCount = 0
  private readonly stdinCloseWaiters: (() => void)[] = []

  /** @param options - Fake host environment and clock. */
  constructor(options: FakeHostOptions = {}) {
    super(options)
  }

  /** Queue one RPC process behavior. */
  scriptRpc(script: OmpRpcScript): this {
    this.rpcScripts.push(script)
    return this
  }

  /** Wait until one command type has been written. */
  waitForCommand(type: string): Promise<void> {
    if (this.commands.some(command => command['type'] === type)) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = this.commandWaiters.get(type) ?? []
      waiters.push(resolve)
      this.commandWaiters.set(type, waiters)
    })
  }

  /** Wait until the interactive child is created. */
  waitForSpawn(): Promise<void> {
    if (this.spawns.some(spec => spec.interactive === true)) return Promise.resolve()
    return new Promise(resolve => this.spawnWaiters.push(resolve))
  }

  /** Wait until one interactive child closes stdin. */
  waitForStdinClose(): Promise<void> {
    if (this.stdinCloseCount > 0) return Promise.resolve()
    return new Promise(resolve => this.stdinCloseWaiters.push(resolve))
  }

  /** Notify tests that the current interactive child closed stdin. */
  notifyStdinClosed(): void {
    this.stdinCloseCount += 1
    for (const resolve of this.stdinCloseWaiters.splice(0)) resolve()
  }

  override spawn(spec: HostSpawnSpec): HostProcess {
    if (spec.interactive !== true) return super.spawn(spec)
    this.spawns.push(spec)
    const script = this.rpcScripts.shift() ?? {}
    if (script.spawnFailure !== undefined) throw script.spawnFailure
    for (const resolve of this.spawnWaiters.splice(0)) resolve()
    return new RpcProcess(spec, script, this)
  }

  /** Record a command and wake tests waiting for its first occurrence. */
  recordCommand(command: Record<string, unknown>): void {
    this.commands.push(command)
    const type = command['type']
    if (typeof type !== 'string') return
    const waiters = this.commandWaiters.get(type)
    if (waiters === undefined) return
    this.commandWaiters.delete(type)
    for (const resolve of waiters) resolve()
  }
}

/** The line queue used by the fake OMP process. */
class LineQueue implements AsyncIterable<string> {
  private readonly values: string[] = []
  private readonly waiters: ((result: IteratorResult<string>) => void)[] = []
  private ended = false
  private reads = 0
  private throwAtRead: number | undefined

  /** Throw on one selected iterator read. */
  throwOnRead(read: number): void {
    this.throwAtRead = read
  }

  /** Add one stdout line. */
  push(value: string): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value })
    else this.values.push(value)
  }

  /** Finish stdout. */
  end(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  /** @returns an async iterator over stdout lines. */
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async (): Promise<IteratorResult<string>> => {
        this.reads += 1
        if (this.reads === this.throwAtRead) throw new Error(`stdout read failed at ${String(this.reads)}`)
        const value = this.values.shift()
        if (value !== undefined) return { done: false, value }
        if (this.ended) return { done: true, value: undefined }
        return await new Promise(resolve => this.waiters.push(resolve))
      },
    }
  }
}

/** One fake interactive OMP RPC child. */
class RpcProcess implements HostProcess {
  readonly lines: AsyncIterable<string>
  readonly exit: Promise<HostExit>
  private readonly stdout = new LineQueue()
  private readonly stdinOpen = true
  private resolveExit!: (exit: HostExit) => void
  private readonly stderrText: string
  private readonly host: OmpRpcHost
  private readonly script: OmpRpcScript
  private readonly sessionId: string
  private promptId: string | undefined
  private stopped = false

  /** Start the fake with the mandatory ready frame. */
  constructor(spec: HostSpawnSpec, script: OmpRpcScript, host: OmpRpcHost) {
    void spec
    this.lines = this.stdout
    this.host = host
    this.script = script
    this.sessionId = script.sessionId ?? 'sess-rpc'
    this.stderrText = script.stderr ?? ''
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve
    })
    for (const line of script.preludeLines ?? []) this.stdout.push(line)
    const ready = script.readyLine === undefined
      ? JSON.stringify({ type: 'ready', protocolVersion: 1 })
      : script.readyLine
    if (ready !== null) this.stdout.push(ready)
    else this.finishExit()
    if (script.omitStdinMethod === 'writeStdin') Object.defineProperty(this, 'writeStdin', { value: undefined })
    if (script.omitStdinMethod === 'closeStdin') Object.defineProperty(this, 'closeStdin', { value: undefined })
    if (script.throwOnRead !== undefined) this.stdout.throwOnRead(script.throwOnRead)
  }

  /** Read the scripted stderr. */
  async stderr(): Promise<string> {
    if (this.script.stderrError !== undefined) throw new Error(this.script.stderrError)
    return this.stderrText
  }

  /** Force-stop the fake child. */
  cancel(reason?: string): void {
    this.host.processCancellations.push(reason ?? '')
    if (this.stopped) return
    this.stopped = true
    this.stdout.end()
    this.finishExit({ code: null, signal: 'SIGTERM', timedOut: false, cancelled: true })
    if (this.script.cancelError !== undefined) throw new Error(this.script.cancelError)
  }

  /** Receive one or more command frames. */
  writeStdin(data: string): void {
    if (!this.stdinOpen || this.stopped) throw new Error('stdin is closed')
    for (const line of data.split('\n').filter(value => value !== '')) {
      const command: unknown = JSON.parse(line)
      if (!isRecord(command)) throw new Error('expected a JSON object command')
      const type = typeof command['type'] === 'string' ? command['type'] : undefined
      if (type === this.script.writeErrorForType) throw new Error(`write failed for ${type}`)
      this.host.recordCommand(command)
      this.handle(command)
    }
  }

  /** Mark EOF and let the process exit normally. */
  closeStdin(): void {
    if (this.stopped) return
    if (this.script.closeStdinError !== undefined) throw new Error(this.script.closeStdinError)
    this.stopped = true
    this.host.notifyStdinClosed()
    this.stdout.end()
    this.finishExit()
  }

  private handle(command: Record<string, unknown>): void {
    const type = command['type']
    const id = typeof command['id'] === 'string' ? command['id'] : undefined
    if (type === 'new_session') {
      this.commandResponse(id, 'new_session', { cancelled: false })
      return
    }
    if (type === 'get_state') {
      this.commandResponse(id, 'get_state', { sessionId: this.sessionId, sessionFile: `/sessions/${this.sessionId}.jsonl` })
      return
    }
    if (type === 'prompt') {
      this.promptId = id
      for (const line of this.script.commandPreludeLines?.['prompt'] ?? []) this.stdout.push(line)
      const response = this.script.commandResponses?.['prompt']
      if (response?.omit === true) {
        this.finishExit()
        return
      }
      if (response?.success === false) {
        this.response(id, 'prompt', response.data ?? {}, false, response.error, false)
        return
      }
      if (this.script.localPrompt === true) {
        this.emitScriptLines()
        this.response(id, 'prompt', response?.data ?? { agentInvoked: false }, response?.success ?? true, response?.error, response?.omitData !== true)
      } else {
        this.response(id, 'prompt', response?.data ?? { agentInvoked: true }, response?.success ?? true, response?.error, response?.omitData !== true)
        if (!this.script.holdPrompt) this.completePrompt(this.script.promptStatus ?? 'completed')
      }
      return
    }
    if (type === 'abort') {
      this.response(id, 'abort', { aborted: true })
      this.completePrompt('aborted')
    }
  }

  private commandResponse(id: string | undefined, type: 'new_session' | 'get_state', data: Readonly<Record<string, unknown>>): void {
    for (const line of this.script.commandPreludeLines?.[type] ?? []) this.stdout.push(line)
    const response = this.script.commandResponses?.[type]
    if (response?.omit === true) {
      this.finishExit()
      return
    }
    this.response(id, type, response?.data ?? data, response?.success ?? true, response?.error, response?.omitData !== true)
  }

  private response(
    id: string | undefined,
    command: string,
    data: Readonly<Record<string, unknown>>,
    success = true,
    error?: string,
    includeData = true,
  ): void {
    this.stdout.push(JSON.stringify({
      type: 'response',
      command,
      success,
      ...(id === undefined ? {} : { id }),
      ...(success && includeData ? { data } : {}),
      ...(error === undefined ? {} : { error }),
    }))
  }

  private completePrompt(status: 'completed' | 'aborted' | 'error'): void {
    this.emitScriptLines()
    const promptId = this.promptId
    const resultStatus = this.script.promptResultStatus ?? status
    if (this.script.settledBeforePromptResult === true) this.stdout.push(JSON.stringify({ type: 'session_settled' }))
    if (promptId !== undefined && this.script.omitPromptResult === true) {
      this.finishExit()
    } else if (promptId !== undefined) {
      this.stdout.push(JSON.stringify({
        type: 'prompt_result',
        id: promptId,
        status: resultStatus,
        sessionSettled: this.script.promptResultSettled ?? this.script.sessionSettled ?? true,
        ...(resultStatus === 'error' && this.script.omitPromptResultError !== true
          ? { error: { message: this.script.promptResultError ?? this.script.promptError ?? 'provider failed' } }
          : {}),
      }))
    }
    const sessionSettled = this.script.promptResultSettled ?? this.script.sessionSettled ?? true
    if (!sessionSettled) this.stdout.push(JSON.stringify({ type: 'session_settled' }))
  }

  private emitScriptLines(): void {
    for (const line of this.script.lines ?? []) this.stdout.push(line)
  }

  private finishExit(fallback?: HostExit): void {
    this.stopped = true
    this.stdout.end()
    this.resolveExit(fallback ?? this.script.exit ?? { code: 0, signal: null, timedOut: false, cancelled: false })
  }
}

/** Check whether one decoded value is a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
