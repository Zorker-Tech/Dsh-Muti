/**
 * An in-memory {@link AgentHost} that answers git commands from a script.
 *
 * The host owns one repository root and one clock. Every spawn is recorded, and the
 * answers are derived from the working directory, so a test can make one worktree
 * dirty while another stays clean without knowing how the service builds its
 * commands.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/tests/support/fake-host
 */

import type { AgentHost, HostDirEntry, HostExit, HostProcess, HostSpawnSpec, HostStat } from '@deepseek-ai/dsh-agent-mesh'

/** The scripted answer of one git command. */
export interface FakeAnswer {
  /** Lines the command writes to standard output. */
  readonly lines?: readonly string[]
  /** Text the command writes to standard error. */
  readonly stderr?: string
  /** Exit code; 0 when omitted. */
  readonly code?: number
  /** Whether the host's own deadline ended the command. */
  readonly timedOut?: boolean
  /** Whether the caller cancelled the command. */
  readonly cancelled?: boolean
  /** Message the standard-output stream rejects with instead of yielding lines. */
  readonly linesError?: string
}

/** A scripted child process that replays one answer. */
class FakeProcess implements HostProcess {
  private readonly answer: FakeAnswer

  /** The spawn request this process answers. */
  readonly spec: HostSpawnSpec

  /**
   * @param spec - The spawn request.
   * @param answer - What the command writes and how it exits.
   */
  constructor(spec: HostSpawnSpec, answer: FakeAnswer) {
    this.spec = spec
    this.answer = answer
  }

  /** Standard output, line by line. */
  get lines(): AsyncIterable<string> {
    const lines = this.answer.lines ?? []
    const failure = this.answer.linesError
    return (async function* replay(): AsyncGenerator<string> {
      if (failure !== undefined) throw new Error(failure)
      for (const line of lines) yield line
    })()
  }

  /**
   * Everything the command wrote to standard error.
   * @returns the scripted text.
   */
  async stderr(): Promise<string> {
    return this.answer.stderr ?? ''
  }

  /** How the process ended. */
  get exit(): Promise<HostExit> {
    return Promise.resolve({
      code: this.answer.code ?? 0,
      signal: null,
      timedOut: this.answer.timedOut ?? false,
      cancelled: this.answer.cancelled ?? false,
    })
  }

  /**
   * Terminate the process; a scripted process has already exited.
   * @param _reason - Recorded reason, unused.
   */
  cancel(_reason?: string): void {
    // Nothing is running.
  }
}

/** One spawn the host answered. */
export interface RecordedSpawn {
  /** The working directory the command ran in. */
  readonly cwd: string
  /** Arguments after the executable. */
  readonly args: readonly string[]
  /** Executable the host was asked to run. */
  readonly command: string
  /** Environment entries the caller layered over the host environment. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Wall-clock budget the caller asked for, when it named one. */
  readonly timeoutMs: number | undefined
}

/** A scripted git host for the collaboration suite. */
export class FakeHost implements AgentHost {
  /** Environment a child would inherit. */
  readonly env: Readonly<Record<string, string | undefined>> = {}

  /** The person's home directory. */
  readonly home = '/home/tester'

  /** Repository root every path is resolved against. */
  root = '/repo'

  /** Branch `rev-parse --abbrev-ref HEAD` answers with. */
  branch = 'agent-mesh/work'

  /** Whether git answers at all. */
  gitAvailable = true

  /** Porcelain status lines per working directory. */
  readonly status = new Map<string, readonly string[]>()

  /** Unified diff lines per working directory. */
  readonly diffs = new Map<string, readonly string[]>()

  /** Commits ahead of the base per working directory. */
  readonly ahead = new Map<string, number>()

  /** Worktree paths `git worktree remove` refuses. */
  readonly refusedRemovals = new Set<string>()

  /** Every command the host was asked to run, in order. */
  readonly spawns: RecordedSpawn[] = []

  /** Every `git worktree add` the host accepted. */
  readonly created: { path: string; branch: string }[] = []

  /** Every diagnostic line the host was asked to record, in order. */
  readonly logs: { readonly level: 'info' | 'warn'; readonly message: string }[] = []

  /**
   * Answers consulted before the built-in git script; returning undefined falls
   * through, so a test overrides only the commands it cares about.
   */
  respond?: (spec: HostSpawnSpec) => FakeAnswer | undefined

  private clock = Date.parse('2026-10-16T00:00:00.000Z')

  /**
   * Current time, fixed until {@link advance} moves it.
   * @returns epoch milliseconds.
   */
  now(): number {
    return this.clock
  }

  /**
   * Move the clock forward.
   * @param ms - Milliseconds to advance.
   */
  advance(ms: number): void {
    this.clock += ms
  }

  /**
   * Record one diagnostic line.
   * @param level - Severity.
   * @param message - Text that would be recorded.
   */
  log(level: 'info' | 'warn', message: string): void {
    this.logs.push({ level, message })
  }

  /**
   * Stat one path; nothing exists in this host.
   * @param _path - Absolute path.
   * @returns always undefined.
   */
  async stat(_path: string): Promise<HostStat | undefined> {
    return undefined
  }

  /**
   * List one directory; nothing exists in this host.
   * @param _path - Absolute path.
   * @returns always an empty list.
   */
  async listDir(_path: string): Promise<readonly HostDirEntry[]> {
    return []
  }

  /**
   * Read the first bytes of a file; nothing exists in this host.
   * @param _path - Absolute path.
   * @param _maxBytes - Maximum bytes to read.
   * @returns always an empty string.
   */
  async readHead(_path: string, _maxBytes: number): Promise<string> {
    return ''
  }

  /**
   * Read the last bytes of a file; nothing exists in this host.
   * @param _path - Absolute path.
   * @param _maxBytes - Maximum bytes to read.
   * @returns always an empty window.
   */
  async readTail(_path: string, _maxBytes: number): Promise<{ text: string; droppedPartialLine: boolean }> {
    return { text: '', droppedPartialLine: false }
  }

  /**
   * Run one command, answering from the script.
   * @param spec - The fully specified spawn request.
   * @returns the scripted child process.
   */
  spawn(spec: HostSpawnSpec): HostProcess {
    this.spawns.push({
      cwd: spec.cwd,
      args: [...spec.args],
      command: spec.command,
      env: { ...spec.env },
      timeoutMs: spec.timeoutMs,
    })
    return new FakeProcess(spec, this.answer(spec))
  }

  /** Answer one git invocation. */
  private answer(spec: HostSpawnSpec): FakeAnswer {
    const scripted = this.respond?.(spec)
    if (scripted !== undefined) return scripted
    const [command, ...rest] = spec.args
    if (command === '--version') {
      return this.gitAvailable ? { lines: ['git version 2.43.0'] } : { code: 127, stderr: 'git: command not found' }
    }
    if (!this.gitAvailable) return { code: 127, stderr: 'git: command not found' }
    if (!this.inRepo(spec.cwd)) return { code: 128, stderr: 'fatal: not a git repository' }
    if (command === 'rev-parse') {
      switch (rest[0]) {
        case '--show-toplevel':
          return { lines: [this.root] }
        case '--is-inside-work-tree':
          return { lines: ['true'] }
        case '--abbrev-ref':
          return { lines: [this.branch] }
        case 'HEAD':
          return { lines: [`${'a'.repeat(39)}1`] }
        case '--absolute-git-dir':
          return { lines: [`${this.root}/.git`] }
        case '--verify':
          // No branch exists yet, so a fresh branch name is always accepted.
          return { code: 1, stderr: 'fatal: Needed a single revision' }
        default:
          return { code: 1, stderr: `unsupported rev-parse: ${rest.join(' ')}` }
      }
    }
    if (command === 'worktree') {
      if (rest[0] === 'add') {
        const path = rest[2] ?? ''
        const branch = rest[1] ?? ''
        this.created.push({ path, branch })
        return {}
      }
      if (rest[0] === 'remove') {
        const path = rest[rest.length - 1] ?? ''
        return this.refusedRemovals.has(path) ? { code: 1, stderr: `fatal: '${path}' contains modified or untracked files` } : {}
      }
      if (rest[0] === 'prune') return {}
      return { code: 1, stderr: `unsupported worktree subcommand: ${rest.join(' ')}` }
    }
    if (command === 'status') return { lines: [...(this.status.get(spec.cwd) ?? [])] }
    if (command === 'diff') return { lines: [...(this.diffs.get(spec.cwd) ?? [])] }
    if (command === 'rev-list') return { lines: [`0\t${String(this.ahead.get(spec.cwd) ?? 0)}`] }
    return { code: 1, stderr: `unsupported command: ${spec.args.join(' ')}` }
  }

  /** Whether a path is inside the scripted repository. */
  private inRepo(path: string): boolean {
    return path === this.root || path.startsWith(`${this.root}/`)
  }
}
