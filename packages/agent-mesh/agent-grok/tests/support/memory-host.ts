/**
 * An in-memory {@link AgentHost} for adapter tests: a file map, a directory index, a
 * fixed clock and a queue of scripted child processes.
 * @module @deepseek-ai/dsh-agent-grok/tests/support/memory-host
 */

import type { AgentHost, HostDirEntry, HostExit, HostProcess, HostSpawnSpec, HostStat } from '@deepseek-ai/dsh-agent-mesh'

/** One scripted child process a test hands to {@link MemoryHost}. */
export interface ScriptedChild {
  /** Stdout lines, delivered in order. */
  readonly stdout?: readonly string[]
  /** Everything the child wrote to stderr. */
  readonly stderr?: string
  /** Exit code; defaults to `0`. */
  readonly code?: number | null
  /** Terminating signal, if any. */
  readonly signal?: string | null
  /** Whether the host's own deadline ended the child. */
  readonly timedOut?: boolean
  /** Whether the child stays alive until the run cancels it. */
  readonly hold?: boolean
  /** Value the stdout stream throws after its scripted lines; a non-Error value exercises the `String(cause)` arm. */
  readonly streamFailure?: unknown
  /** Value `stderr()` rejects with. */
  readonly stderrFailure?: unknown
  /** Value the exit promise rejects with. */
  readonly exitFailure?: unknown
}

/** Options for {@link MemoryHost}. */
export interface MemoryHostOptions {
  /** Environment the adapter sees; defaults to an empty PATH-only environment. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Home directory; defaults to `/home/tester`. */
  readonly home?: string
  /** Pinned clock, in epoch milliseconds. */
  readonly now?: number
  /** File contents by absolute path. */
  readonly files?: Readonly<Record<string, string>>
  /** Modification times by absolute path, in epoch milliseconds. */
  readonly mtimes?: Readonly<Record<string, number>>
  /** Directories that exist without holding a file. */
  readonly dirs?: readonly string[]
  /** Children returned by successive `spawn` calls. */
  readonly scripts?: readonly ScriptedChild[]
  /** Value `spawn` throws instead of returning a child. */
  readonly spawnFailure?: unknown
}

/** One child process under the scripted host. */
class FakeProcess implements HostProcess {
  readonly lines: AsyncIterable<string>
  readonly exit: Promise<HostExit>
  /** Whether `cancel()` ended this process. */
  cancelled = false
  /** Reason the caller gave to `cancel()`, when it gave one. */
  cancelReason: string | undefined

  private readonly script: ScriptedChild
  private readonly settleFn: ((fact: HostExit) => void) | undefined
  private readonly failFn: ((cause: unknown) => void) | undefined
  private settled = false
  private release: (() => void) | undefined

  constructor(script: ScriptedChild) {
    this.script = script
    let settle: ((fact: HostExit) => void) | undefined
    let fail: ((cause: unknown) => void) | undefined
    this.exit = new Promise<HostExit>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    this.settleFn = settle
    this.failFn = fail
    this.lines = this.produce()
  }

  private async *produce(): AsyncGenerator<string> {
    for (const line of this.script.stdout ?? []) {
      if (this.cancelled) return
      yield line
    }
    if (this.script.hold === true && !this.cancelled) {
      await new Promise<void>((resolve) => {
        this.release = resolve
      })
    }
    if (this.script.exitFailure !== undefined) {
      this.settled = true
      this.failFn?.(this.script.exitFailure)
    } else {
      this.settle({
        code: this.cancelled ? null : this.script.code ?? 0,
        signal: this.script.signal ?? null,
        timedOut: this.script.timedOut ?? false,
        cancelled: this.cancelled,
      })
    }
    if (this.script.streamFailure !== undefined) throw this.script.streamFailure
  }

  private settle(fact: HostExit): void {
    if (this.settled) return
    this.settled = true
    this.settleFn?.(fact)
  }

  cancel(reason?: string): void {
    if (this.settled) return
    this.cancelled = true
    this.cancelReason = reason
    this.release?.()
    this.release = undefined
    this.settle({ code: null, signal: 'SIGTERM', timedOut: false, cancelled: true })
  }

  async stderr(): Promise<string> {
    if (this.script.stderrFailure !== undefined) throw this.script.stderrFailure
    return this.script.stderr ?? ''
  }
}

/** An in-memory host implementing the shared {@link AgentHost} port. */
export class MemoryHost implements AgentHost {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  /** Every spawned child spec, in order. */
  readonly spawned: HostSpawnSpec[] = []
  /** Every recorded diagnostic, as `level: message`. */
  readonly logs: string[] = []
  /** Every process this host returned, in spawn order. */
  readonly processes: FakeProcess[] = []

  private readonly files = new Map<string, string>()
  private readonly mtimes = new Map<string, number>()
  private readonly dirs = new Set<string>()
  private readonly scripts: ScriptedChild[]
  private readonly spawnFailure: unknown
  private clock: number

  /**
   * @param options - Files, directories, environment, clock, home and scripted children.
   */
  constructor(options: MemoryHostOptions = {}) {
    this.env = options.env ?? { PATH: '' }
    this.home = options.home ?? '/home/tester'
    this.clock = options.now ?? Date.parse('2026-05-01T00:00:00.000Z')
    this.scripts = [...(options.scripts ?? [])]
    this.spawnFailure = options.spawnFailure
    for (const [path, text] of Object.entries(options.files ?? {})) this.writeFile(path, text)
    for (const [path, mtimeMs] of Object.entries(options.mtimes ?? {})) this.mtimes.set(path, mtimeMs)
    for (const path of options.dirs ?? []) this.addDir(path)
  }

  /** Add or replace one file. */
  writeFile(path: string, text: string): void {
    this.files.set(path, text)
    for (const dir of ancestorsOf(path)) this.dirs.add(dir)
  }

  /** Mark one directory as existing. */
  addDir(path: string): void {
    for (const dir of [...ancestorsOf(path), path]) this.dirs.add(dir)
  }

  /** Set one file's modification time. */
  setMtime(path: string, mtimeMs: number): void {
    this.mtimes.set(path, mtimeMs)
  }

  /** Move the clock to another instant. */
  setNow(nowMs: number): void {
    this.clock = nowMs
  }

  now(): number {
    return this.clock
  }

  async stat(path: string): Promise<HostStat | undefined> {
    const text = this.files.get(path)
    const mtimeMs = this.mtimes.get(path) ?? 0
    if (text !== undefined) return { size: Buffer.byteLength(text), mtimeMs, isDirectory: false }
    if (this.dirs.has(path)) return { size: 0, mtimeMs, isDirectory: true }
    return undefined
  }

  async listDir(path: string): Promise<readonly HostDirEntry[]> {
    if (!this.dirs.has(path)) return []
    const entries: HostDirEntry[] = []
    for (const candidate of [...this.dirs, ...this.files.keys()]) {
      if (parentOf(candidate) !== path) continue
      entries.push({
        name: candidate.slice(candidate.lastIndexOf('/') + 1),
        isDirectory: !this.files.has(candidate),
        mtimeMs: this.mtimes.get(candidate) ?? 0,
      })
    }
    return entries
  }

  async readHead(path: string, maxBytes: number): Promise<string> {
    const text = this.files.get(path)
    return text === undefined ? '' : text.slice(0, maxBytes)
  }

  async readTail(path: string, maxBytes: number): Promise<{ text: string; droppedPartialLine: boolean }> {
    const text = this.files.get(path)
    if (text === undefined) return { text: '', droppedPartialLine: false }
    if (text.length <= maxBytes) return { text, droppedPartialLine: false }
    const tail = text.slice(text.length - maxBytes)
    const firstBreak = tail.indexOf('\n')
    if (firstBreak < 0) return { text: '', droppedPartialLine: true }
    return { text: tail.slice(firstBreak + 1), droppedPartialLine: true }
  }

  spawn(spec: HostSpawnSpec): HostProcess {
    this.spawned.push(spec)
    if (this.spawnFailure !== undefined) throw this.spawnFailure
    const process_ = new FakeProcess(this.scripts.shift() ?? {})
    this.processes.push(process_)
    return process_
  }

  log(level: 'info' | 'warn', message: string): void {
    this.logs.push(`${level}: ${message}`)
  }
}

/** Every ancestor directory of a path, including `/`. */
function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(part => part !== '')
  const ancestors: string[] = ['/']
  let current = ''
  for (const part of parts.slice(0, -1)) {
    current = `${current}/${part}`
    ancestors.push(current)
  }
  return ancestors
}

/** The parent directory of a path. */
function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  if (index <= 0) return '/'
  return path.slice(0, index)
}
