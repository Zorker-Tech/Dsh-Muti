/**
 * An in-memory {@link AgentHost} for this package's unit tests: an exact-path filesystem, a
 * scripted process queue, and a pinned clock.
 * @module @deepseek-ai/dsh-agent-pi/tests/host
 */

import { basename, dirname } from 'node:path'
import type {
  AgentHost,
  HostDirEntry,
  HostExit,
  HostProcess,
  HostSpawnSpec,
  HostStat,
} from '@deepseek-ai/dsh-agent-mesh'

/** One spawn call the adapter made. */
export interface SpawnedProcess {
  /** The spec the adapter passed. */
  readonly spec: HostSpawnSpec
}

/** The fake host: an `AgentHost` plus the test-facing controls. */
export interface FakeHost extends AgentHost {
  /** Every spawn call, in order. */
  readonly spawns: readonly SpawnedProcess[]
  /** Every recorded diagnostic line. */
  readonly logs: readonly string[]
  /**
   * Queue the process the next spawn call returns.
   * @param process - Factory for the process handle.
   */
  queue(process: () => HostProcess): void
  /**
   * Make the next spawn call throw, which is how a real host reports an unstartable child.
   * @param message - Error message.
   */
  failNextSpawn(message: string): void
  /**
   * Add or replace a file.
   * @param path - Absolute path.
   * @param content - File contents.
   */
  write(path: string, content: string): void
  /**
   * Read a file's contents.
   * @param path - Absolute path.
   * @returns the contents, or `undefined` when the path is absent.
   */
  read(path: string): string | undefined
}

/** Options for {@link createFakeHost}. */
export interface FakeHostOptions {
  /** Absolute file paths and their contents. */
  readonly files?: Readonly<Record<string, string>>
  /** Absolute directory paths that exist. */
  readonly dirs?: readonly string[]
  /** Environment the adapter inspects. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Home directory; defaults to `/home/tester`. */
  readonly home?: string
  /** Modification time of every path, in epoch milliseconds. */
  readonly mtimeMs?: number
  /** Clock start, in epoch milliseconds. */
  readonly startMs?: number
  /** Milliseconds each `now()` call advances; `0` keeps the clock pinned. */
  readonly clockStepMs?: number
}

/**
 * Build the fake host.
 * @param options - Files, directories, environment and clock.
 * @returns the host.
 */
export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const dirs = new Set<string>(options.dirs ?? [])
  for (const path of files.keys()) {
    let parent = dirname(path)
    while (parent !== '/' && parent !== '.' && parent !== '') {
      dirs.add(parent)
      parent = dirname(parent)
    }
  }
  const mtimeMs = options.mtimeMs ?? Date.parse('2026-10-16T00:00:00.000Z')
  const env = options.env ?? {}
  const logs: string[] = []
  const spawns: SpawnedProcess[] = []
  const queued: (() => HostProcess)[] = []
  let spawnFailure: string | undefined
  let clock = options.startMs ?? Date.parse('2026-10-16T00:00:00.000Z')
  const step = options.clockStepMs ?? 0

  const childrenOf = (path: string): readonly HostDirEntry[] => {
    const out: HostDirEntry[] = []
    for (const candidate of files.keys()) {
      if (dirname(candidate) === path) out.push({ name: basename(candidate), isDirectory: false, mtimeMs })
    }
    for (const candidate of dirs) {
      if (candidate !== path && dirname(candidate) === path) {
        out.push({ name: basename(candidate), isDirectory: true, mtimeMs })
      }
    }
    return out
  }

  return {
    env,
    home: options.home ?? '/home/tester',
    spawns,
    logs,

    async stat(path: string): Promise<HostStat | undefined> {
      const content = files.get(path)
      if (content !== undefined) {
        return { size: Buffer.byteLength(content, 'utf8'), mtimeMs, isDirectory: false }
      }
      if (dirs.has(path)) return { size: 0, mtimeMs, isDirectory: true }
      return undefined
    },

    async listDir(path: string): Promise<readonly HostDirEntry[]> {
      if (!dirs.has(path) && path !== '/') return []
      return childrenOf(path)
    },

    async readHead(path: string, maxBytes: number): Promise<string> {
      const content = files.get(path)
      if (content === undefined) return ''
      return Buffer.from(content, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8')
    },

    async readTail(path: string, maxBytes: number): Promise<{ text: string; droppedPartialLine: boolean }> {
      const content = files.get(path)
      if (content === undefined) return { text: '', droppedPartialLine: false }
      const bytes = Buffer.from(content, 'utf8')
      const cap = Math.max(1, maxBytes)
      const offset = Math.max(0, bytes.length - cap)
      const text = bytes.subarray(offset, offset + cap).toString('utf8')
      if (offset === 0) return { text, droppedPartialLine: false }
      const firstBreak = text.indexOf('\n')
      if (firstBreak < 0) return { text: '', droppedPartialLine: true }
      return { text: text.slice(firstBreak + 1), droppedPartialLine: true }
    },

    spawn(spec: HostSpawnSpec): HostProcess {
      if (spawnFailure !== undefined) {
        const message = spawnFailure
        spawnFailure = undefined
        throw new Error(message)
      }
      spawns.push({ spec })
      const next = queued.shift()
      if (next === undefined) throw new Error('the fake host has no queued process')
      return next()
    },

    now(): number {
      const value = clock
      clock += step
      return value
    },

    log(_level: 'info' | 'warn', message: string): void {
      logs.push(message)
    },

    queue(process: () => HostProcess): void {
      queued.push(process)
    },

    failNextSpawn(message: string): void {
      spawnFailure = message
    },

    write(path: string, content: string): void {
      files.set(path, content)
      let parent = dirname(path)
      while (parent !== '/' && parent !== '.' && parent !== '') {
        dirs.add(parent)
        parent = dirname(parent)
      }
    },

    read(path: string): string | undefined {
      return files.get(path)
    },
  }
}

/** Exit facts with every field defaulted. */
export function exitFacts(options: Partial<HostExit> = {}): HostExit {
  return {
    code: options.code ?? 0,
    signal: options.signal ?? null,
    timedOut: options.timedOut ?? false,
    cancelled: options.cancelled ?? false,
  }
}

/** Options for {@link processWith}. */
export interface ScriptedProcessOptions {
  /** Text the child wrote to stderr; defaults to empty. */
  readonly stderr?: string
  /** Exit code; defaults to 0. */
  readonly code?: number
  /** Terminating signal, when one ended the process. */
  readonly signal?: string
  /** Whether the host killed the child on its deadline. */
  readonly timedOut?: boolean
  /** Whether the caller cancelled the child. */
  readonly cancelled?: boolean
}

/**
 * Build a process handle that emits `lines` and exits.
 * @param lines - Standard-output lines, in order.
 * @param options - stderr text and exit facts.
 * @returns the process handle.
 */
export function processWith(lines: readonly string[], options: ScriptedProcessOptions = {}): HostProcess {
  return {
    lines: (async function* stream(): AsyncGenerator<string> {
      await Promise.resolve()
      for (const line of lines) yield line
    })(),
    async stderr(): Promise<string> {
      return options.stderr ?? ''
    },
    exit: Promise.resolve(exitFacts({
      code: options.code ?? 0,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timedOut === undefined ? {} : { timedOut: options.timedOut }),
      ...(options.cancelled === undefined ? {} : { cancelled: options.cancelled }),
    })),
    cancel(): void {
      // The scripted process has already produced everything it will produce.
    },
  }
}

/** A process that never finishes, so a cancellation test can observe the pending state. */
export function hangingProcess(): HostProcess {
  return {
    lines: (async function* stream(): AsyncGenerator<string> {
      await Promise.resolve()
    })(),
    async stderr(): Promise<string> {
      return ''
    },
    exit: new Promise<HostExit>(() => {
      // Deliberately never settles.
    }),
    cancel(): void {
      // The handle's exit promise is what a real host settles; this fake keeps it pending.
    },
  }
}
