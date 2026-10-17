/**
 * An in-memory {@link CodexHost} for the adapter's unit tests.
 *
 * Files and directories are nodes in one map, children are derived from path prefixes, and
 * spawned processes replay a script the test enqueues. Nothing here touches the real
 * filesystem or spawns a real process.
 * @module @deepseek-ai/dsh-agent-codex/tests/fake-host
 */

import type { HostDirEntry, HostExit, HostProcess, HostSpawnSpec, HostStat } from '../src/types.ts'
import type { CodexHost } from '../src/types.ts'

/** One in-memory path. */
interface FakeNode {
  /** Whether the node is a directory. */
  readonly isDirectory: boolean
  /** File content; empty for a directory. */
  content: string
  /** Modification time in epoch milliseconds. */
  mtimeMs: number
}

/** What one scripted child process does. */
export interface ProcessScript {
  /** Lines the child writes to standard output, in order. */
  readonly lines?: readonly string[]
  /** Text the child writes to standard error. */
  readonly stderr?: string
  /** Exit facts; defaults to a successful exit. */
  readonly exit?: HostExit
  /** Value `stderr()` rejects with instead of returning output. */
  readonly stderrFailure?: unknown
  /** Value the observed exit promise rejects with. */
  readonly exitFailure?: unknown
  /** Value `writeStdin()` throws before forwarding a frame. */
  readonly writeFailure?: unknown
  /** Value `closeStdin()` throws before closing the scripted output. */
  readonly closeFailure?: unknown
  /** Resolve the exit only after `cancel()` is called, for cancellation tests. */
  readonly holdUntilCancelled?: boolean
  /** Resolve the exit only after interactive stdin closes. */
  readonly holdUntilStdinClosed?: boolean
  /** Observe one host-to-child write and optionally emit protocol lines. */
  readonly onStdin?: (data: string, process: FakeProcess) => void
}

/** One spawn the host recorded. */
export interface RecordedSpawn {
  /** The fully specified spawn request. */
  readonly spec: HostSpawnSpec
  /** The process handle the adapter received. */
  readonly process: FakeProcess
}

/** A scripted child process. */
export class FakeProcess implements HostProcess {
  /** The spawn request this process answers. */
  readonly spec: HostSpawnSpec

  private readonly script: ProcessScript

  private readonly held: Promise<HostExit>

  private releaseHeld: ((exit: HostExit) => void) | undefined

  private readonly finished: Promise<HostExit>

  private readonly outputQueue: string[] = []

  private readonly outputWaiters: (() => void)[] = []

  private outputEnded = false

  /** Whether `cancel()` was called. */
  cancelled = false

  /** The reason `cancel()` was called with. */
  cancelReason: string | undefined

  /**
   * @param spec - The spawn request.
   * @param script - What the process does.
   */
  constructor(spec: HostSpawnSpec, script: ProcessScript) {
    this.spec = spec
    this.script = script
    this.finished = Promise.resolve(
      script.exit ?? { code: 0, signal: null, timedOut: false, cancelled: false },
    )
    this.held = new Promise<HostExit>((resolve) => {
      this.releaseHeld = resolve
    })
  }

  /** The child's standard output, line by line. */
  get lines(): AsyncIterable<string> {
    return this.replayLines(this.script.lines ?? [])
  }

  private async *replayLines(lines: readonly string[]): AsyncGenerator<string> {
    for (const line of lines) yield line
    if (this.script.onStdin === undefined) return
    while (this.outputQueue.length > 0 || !this.outputEnded) {
      if (this.outputQueue.length > 0) {
        yield this.outputQueue.shift()!
      } else {
        await new Promise<void>(resolve => this.outputWaiters.push(resolve))
      }
    }
  }

  /** The child's standard error. */
  async stderr(): Promise<string> {
    if (this.script.stderrFailure !== undefined) throw this.script.stderrFailure
    return this.script.stderr ?? ''
  }

  /** The child's exit facts. */
  get exit(): Promise<HostExit> {
    if (this.script.exitFailure !== undefined) {
      return new Promise<HostExit>((_resolve, reject) => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- This fixture models a host rejecting with a non-Error value.
        reject(this.script.exitFailure)
      })
    }
    return this.script.holdUntilCancelled === true || this.script.holdUntilStdinClosed === true
      ? this.held
      : this.finished
  }

  /**
   * Terminate the child.
   * @param reason - Why the caller cancelled.
   */
  cancel(reason?: string): void {
    this.cancelled = true
    this.cancelReason = reason
    this.releaseHeld?.({ code: null, signal: 'SIGTERM', timedOut: false, cancelled: true })
    this.endOutput()
  }

  /** Accept one interactive protocol frame. */
  writeStdin(data: string): void {
    if (this.spec.interactive !== true) throw new Error('stdin is not interactive')
    if (this.script.writeFailure !== undefined) throw this.script.writeFailure
    this.script.onStdin?.(data, this)
  }

  /** Close interactive stdin and end the scripted child. */
  closeStdin(): void {
    if (this.spec.interactive !== true) throw new Error('stdin is not interactive')
    if (this.script.closeFailure !== undefined) throw this.script.closeFailure
    this.endOutput()
    if (this.script.holdUntilStdinClosed === true) {
      this.releaseHeld?.(this.script.exit ?? { code: 0, signal: null, timedOut: false, cancelled: false })
    }
  }

  /** Emit one stdout line from the scripted child. */
  sendLine(line: string): void {
    if (this.outputEnded) return
    this.outputQueue.push(line)
    this.outputWaiters.shift()?.()
  }

  /** End the scripted stdout stream. */
  endOutput(): void {
    this.outputEnded = true
    for (const resolve of this.outputWaiters.splice(0)) resolve()
  }
}

/** An in-memory host: one node map, one script queue, one clock. */
export class FakeHost implements CodexHost {
  /** Environment the adapter inspects. */
  env: Record<string, string | undefined> = {}

  /** Home directory the adapter resolves `~` against. */
  home = '/home/tester'

  /** Every spawn the adapter requested, in order. */
  readonly spawns: RecordedSpawn[] = []

  /** Every diagnostic the adapter logged. */
  readonly logs: { readonly level: 'info' | 'warn'; readonly message: string }[] = []

  /** Synchronous spawn hook for lifecycle race tests. */
  beforeSpawn: ((process: FakeProcess) => void) | undefined

  private readonly nodes = new Map<string, FakeNode>()

  private readonly scripts: ProcessScript[] = []

  private clock = Date.parse('2026-10-16T12:00:00.000Z')

  /** Add or replace a file, creating any missing ancestor directories. */
  addFile(path: string, content = '', mtimeMs = this.clock): void {
    this.addAncestors(path, mtimeMs)
    this.nodes.set(path, { isDirectory: false, content, mtimeMs })
  }

  /** Add a directory, creating any missing ancestor directories. */
  addDir(path: string, mtimeMs = this.clock): void {
    this.addAncestors(path, mtimeMs)
    this.nodes.set(path, { isDirectory: true, content: '', mtimeMs })
  }

  /** Create every ancestor of a path that is not already present. */
  private addAncestors(path: string, mtimeMs: number): void {
    const segments = path.split('/').filter(segment => segment !== '')
    let current = ''
    for (const segment of segments.slice(0, -1)) {
      current += `/${segment}`
      if (!this.nodes.has(current)) this.nodes.set(current, { isDirectory: true, content: '', mtimeMs })
    }
  }

  /** Enqueue the script the next spawn consumes. */
  enqueue(script: ProcessScript): void {
    this.scripts.push(script)
  }

  /** Advance the clock. */
  advance(ms: number): void {
    this.clock += ms
  }

  /** Current time in epoch milliseconds. */
  now(): number {
    return this.clock
  }

  /**
   * Stat one path.
   * @param path - Absolute path.
   * @returns the metadata, or `undefined` when the path is absent.
   */
  async stat(path: string): Promise<HostStat | undefined> {
    const node = this.nodes.get(path)
    if (node === undefined) return undefined
    return {
      size: node.isDirectory ? 0 : Buffer.byteLength(node.content, 'utf8'),
      mtimeMs: node.mtimeMs,
      isDirectory: node.isDirectory,
    }
  }

  /**
   * List one directory level.
   * @param path - Absolute directory path.
   * @returns the direct children, newest first.
   */
  async listDir(path: string): Promise<readonly HostDirEntry[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`
    const entries: HostDirEntry[] = []
    for (const [nodePath, node] of this.nodes) {
      if (!nodePath.startsWith(prefix)) continue
      const remainder = nodePath.slice(prefix.length)
      if (remainder === '' || remainder.includes('/')) continue
      entries.push({ name: remainder, isDirectory: node.isDirectory, mtimeMs: node.mtimeMs })
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return entries
  }

  /**
   * Read the head of a file.
   * @param path - Absolute path.
   * @param maxBytes - Byte cap.
   * @returns the decoded prefix, or an empty string.
   */
  async readHead(path: string, maxBytes: number): Promise<string> {
    const node = this.nodes.get(path)
    if (node === undefined || node.isDirectory) return ''
    return Buffer.from(node.content, 'utf8').subarray(0, maxBytes).toString('utf8')
  }

  /**
   * Read the tail of a file, dropping a leading partial line.
   * @param path - Absolute path.
   * @param maxBytes - Byte cap.
   * @returns the decoded tail and whether a partial line was dropped.
   */
  async readTail(path: string, maxBytes: number): Promise<{ text: string; droppedPartialLine: boolean }> {
    const node = this.nodes.get(path)
    if (node === undefined || node.isDirectory) return { text: '', droppedPartialLine: false }
    const bytes = Buffer.from(node.content, 'utf8')
    if (bytes.length <= maxBytes) return { text: bytes.toString('utf8'), droppedPartialLine: false }
    const window = bytes.subarray(bytes.length - maxBytes).toString('utf8')
    const firstNewline = window.indexOf('\n')
    if (firstNewline === -1) return { text: '', droppedPartialLine: true }
    return { text: window.slice(firstNewline + 1), droppedPartialLine: true }
  }

  /**
   * Record the spawn and return the next scripted process.
   * @param spec - The spawn request.
   * @returns the scripted process.
   */
  spawn(spec: HostSpawnSpec): HostProcess {
    const script = this.scripts.shift() ?? {}
    const process = new FakeProcess(spec, script)
    this.spawns.push({ spec, process })
    this.beforeSpawn?.(process)
    return process
  }

  /**
   * Record one diagnostic line.
   * @param level - Severity.
   * @param message - Message text.
   */
  log(level: 'info' | 'warn', message: string): void {
    this.logs.push({ level, message })
  }
}
