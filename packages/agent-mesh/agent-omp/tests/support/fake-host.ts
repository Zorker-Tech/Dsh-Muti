/**
 * An in-memory {@link AgentHost} for the adapter's tests: a virtual filesystem with
 * directory listings and modification times, a pinned clock, and scripted child
 * processes whose stdout lines, stderr and exit facts the test decides.
 * @module @deepseek-ai/dsh-agent-omp/tests/support/fake-host
 */

import type {
  AgentHost,
  HostDirEntry,
  HostExit,
  HostProcess,
  HostSpawnSpec,
  HostStat,
} from '@deepseek-ai/dsh-agent-mesh'

/** One registered file. */
interface FakeFile {
  readonly content: string
  readonly mtimeMs: number
}

/** What one spawned child does. */
export interface SpawnScript {
  /** Lines the child writes to stdout, then closes the stream. */
  readonly lines?: readonly string[]
  /**
   * Value the spawn call throws instead of returning a child. A string models an error
   * message; any other value models a host that throws a non-Error.
   */
  readonly spawnFailure?: unknown
  /** End the stdout stream abnormally with this message instead of closing it. */
  readonly linesError?: string
  /** Fail the stderr read with this message instead of answering. */
  readonly stderrError?: string
  /** Exit facts the child reports. */
  readonly exit?: HostExit
  /** Everything the child writes to stderr. */
  readonly stderr?: string
}

/** Options for {@link FakeHost}. */
export interface FakeHostOptions {
  /** Environment the adapter reads. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Home directory default stores resolve under. */
  readonly home?: string
  /** Pinned clock value in epoch milliseconds. */
  readonly now?: number
}

/**
 * A host backed by memory: files, directories, a clock and scripted processes.
 */
export class FakeHost implements AgentHost {
  /** Environment the adapter reads. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Home directory default stores resolve under. */
  readonly home: string
  /** Every spawn the adapter requested, in order. */
  readonly spawns: HostSpawnSpec[] = []
  /** Every diagnostic the adapter logged, in order. */
  readonly logs: { readonly level: 'info' | 'warn'; readonly message: string }[] = []

  private readonly files_ = new Map<string, FakeFile>()
  private readonly directories_ = new Set<string>()
  private readonly scripts_: SpawnScript[] = []
  private readonly cancelled_: string[] = []
  private readonly statFailures_ = new Map<string, string>()
  private clock: number

  /**
   * @param options - Environment, home directory and clock.
   */
  constructor(options: FakeHostOptions = {}) {
    this.env = options.env ?? {}
    this.home = options.home ?? '/home/tester'
    this.clock = options.now ?? 1_700_000_000_000
  }

  /**
   * Register a file, and every directory above it.
   * @param path - Absolute path.
   * @param content - File text.
   * @param mtimeMs - Modification time; defaults to the current clock.
   * @returns this host, for chaining.
   */
  addFile(path: string, content: string, mtimeMs?: number): this {
    this.files_.set(path, { content, mtimeMs: mtimeMs ?? this.clock })
    for (const parent of ancestors(path)) this.directories_.add(parent)
    return this
  }

  /**
   * Register an empty directory.
   * @param path - Absolute path.
   * @param mtimeMs - Modification time; defaults to the current clock.
   * @returns this host, for chaining.
   */
  addDirectory(path: string, mtimeMs?: number): this {
    this.directories_.add(path)
    for (const parent of ancestors(path)) this.directories_.add(parent)
    this.directoryTimes.set(path, mtimeMs ?? this.clock)
    return this
  }

  private readonly directoryTimes = new Map<string, number>()

  /**
   * Queue one scripted child process.
   * @param script - What the child prints and how it exits.
   * @returns this host, for chaining.
   */
  script(script: SpawnScript): this {
    this.scripts_.push(script)
    return this
  }

  /** Reasons every cancel call recorded, in order. */
  get cancels(): readonly string[] {
    return this.cancelled_
  }

  /**
   * Move the pinned clock.
   * @param ms - Milliseconds to add.
   */
  advance(ms: number): void {
    this.clock += ms
  }

  /**
   * Make the next `stat` probe of one path reject, as a host does for a transient
   * filesystem refusal.
   * @param path - Absolute path the next probe must fail for.
   * @param message - Failure message.
   * @returns this host, for chaining.
   */
  failNextStat(path: string, message: string): this {
    this.statFailures_.set(path, message)
    return this
  }

  /**
   * Stat one path.
   * @param path - Absolute path.
   * @returns the metadata, or `undefined` when the path is unknown.
   */
  async stat(path: string): Promise<HostStat | undefined> {
    const failure = this.statFailures_.get(path)
    if (failure !== undefined) {
      this.statFailures_.delete(path)
      throw new Error(failure)
    }
    const file = this.files_.get(path)
    if (file !== undefined) {
      return { size: Buffer.byteLength(file.content, 'utf8'), mtimeMs: file.mtimeMs, isDirectory: false }
    }
    if (this.directories_.has(path)) {
      return { size: 0, mtimeMs: this.directoryTimes.get(path) ?? 0, isDirectory: true }
    }
    return undefined
  }

  /**
   * List one directory.
   * @param path - Absolute directory path.
   * @returns the direct children, or an empty list when the directory is unknown.
   */
  async listDir(path: string): Promise<readonly HostDirEntry[]> {
    if (!this.directories_.has(path)) return []
    const out: HostDirEntry[] = []
    const prefix = path.endsWith('/') ? path : `${path}/`
    const names = new Set<string>()
    for (const file of this.files_.keys()) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      const name = rest.split('/')[0]
      if (name !== undefined && name !== '' && !rest.includes('/')) names.add(name)
    }
    for (const directory of this.directories_) {
      if (!directory.startsWith(prefix)) continue
      const rest = directory.slice(prefix.length)
      const name = rest.split('/')[0]
      if (name !== undefined && name !== '' && !rest.includes('/')) names.add(name)
    }
    for (const name of names) {
      const child = `${prefix}${name}`
      const file = this.files_.get(child)
      out.push({
        name,
        isDirectory: file === undefined,
        mtimeMs: file === undefined ? this.directoryTimes.get(child) ?? 0 : file.mtimeMs,
      })
    }
    return out
  }

  /**
   * Read the first bytes of a file.
   * @param path - Absolute path.
   * @param maxBytes - Maximum bytes to read.
   * @returns the decoded prefix, or an empty string when the file is absent.
   */
  async readHead(path: string, maxBytes: number): Promise<string> {
    const file = this.files_.get(path)
    if (file === undefined) return ''
    return Buffer.from(file.content, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8')
  }

  /**
   * Read the last bytes of a file, starting on a record boundary.
   * @param path - Absolute path.
   * @param maxBytes - Maximum bytes to read.
   * @returns the decoded tail and whether a leading partial line was dropped.
   */
  async readTail(path: string, maxBytes: number): Promise<{ text: string; droppedPartialLine: boolean }> {
    const file = this.files_.get(path)
    if (file === undefined) return { text: '', droppedPartialLine: false }
    const bytes = Buffer.from(file.content, 'utf8')
    const start = Math.max(0, bytes.length - Math.max(0, maxBytes))
    const text = bytes.subarray(start).toString('utf8')
    if (start === 0) return { text, droppedPartialLine: false }
    const firstBreak = text.indexOf('\n')
    if (firstBreak < 0) return { text: '', droppedPartialLine: true }
    return { text: text.slice(firstBreak + 1), droppedPartialLine: true }
  }

  /**
   * Start a scripted child process.
   * @param spec - The spawn request, recorded verbatim.
   * @returns the child.
   */
  spawn(spec: HostSpawnSpec): HostProcess {
    this.spawns.push(spec)
    const script = this.scripts_.shift() ?? {}
    if (script.spawnFailure !== undefined) throw script.spawnFailure
    return new ScriptedProcess(
      script,
      (reason) => {
        this.cancelled_.push(reason ?? '')
      },
    )
  }

  /**
   * The pinned time.
   * @returns milliseconds since the Unix epoch.
   */
  now(): number {
    return this.clock
  }

  /**
   * Record a diagnostic line.
   * @param level - Severity.
   * @param message - Message text.
   */
  log(level: 'info' | 'warn', message: string): void {
    this.logs.push({ level, message })
  }
}

/** Every directory above a path, excluding the path itself. */
function ancestors(path: string): string[] {
  const out: string[] = []
  let index = path.lastIndexOf('/')
  while (index > 0) {
    out.push(path.slice(0, index))
    index = path.lastIndexOf('/', index - 1)
  }
  return out
}

/** A child process whose output and exit facts the test scripted. */
class ScriptedProcess implements HostProcess {
  readonly lines: AsyncIterable<string>
  readonly exit: Promise<HostExit>
  private readonly stderrText: string
  private readonly stderrError: string | undefined
  private cancelled = false
  private readonly onCancel: (reason: string | undefined) => void

  /**
   * @param script - The scripted output and exit facts.
   * @param onCancel - Records a cancellation.
   */
  constructor(script: SpawnScript, onCancel: (reason: string | undefined) => void) {
    this.stderrText = script.stderr ?? ''
    this.stderrError = script.stderrError
    this.onCancel = onCancel
    const lines = script.lines ?? []
    const linesError = script.linesError
    this.lines = (async function* emit(): AsyncGenerator<string> {
      for (const line of lines) yield line
      if (linesError !== undefined) throw new Error(linesError)
    })()
    this.exit = new Promise<HostExit>((resolve) => {
      setTimeout(() => {
        resolve(
          this.cancelled
            ? { code: null, signal: 'SIGTERM', timedOut: false, cancelled: true }
            : script.exit ?? { code: 0, signal: null, timedOut: false, cancelled: false },
        )
      }, 0)
    })
  }

  /**
   * The child's captured standard error.
   * @returns the scripted text, or rejects when the script models an unreadable stream.
   */
  async stderr(): Promise<string> {
    if (this.stderrError !== undefined) throw new Error(this.stderrError)
    return this.stderrText
  }

  /**
   * Terminate the child, so its exit reports a cancellation.
   * @param reason - Why the caller cancelled.
   */
  cancel(reason?: string): void {
    this.cancelled = true
    this.onCancel(reason)
  }
}
