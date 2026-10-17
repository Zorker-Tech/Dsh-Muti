/**
 * The harness-side {@link AgentHost}: file contents through `ctx.fs` (so the
 * profile's filesystem policy decides what may be read) and processes through
 * `ctx.subprocess` (so children get the seam's scrubbed environment and
 * managed process range).
 *
 * Two deliberate exceptions, both because an agent's store lives outside the
 * harness workspace by definition:
 *
 * - Modification times come from a direct metadata probe. `ctx.fs` exposes an
 *   opaque freshness token and no timestamp, and session listing must order by
 *   modification time and fall back to it when a store records none.
 * - A directory listing reports each child's modification time for the same
 *   reason, while the child's type comes from the filesystem service.
 *
 * A refusal by the filesystem policy (for example a sandboxed provider that
 * does not allow the home directory) surfaces as an absent or empty read, and
 * adapters report that as an unreadable store rather than an empty one.
 * @module @deepseek-ai/dsh-agent-mesh/context-host
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports that load these services' Context augmentations; the host
// reaches `ctx.fs` and `ctx.subprocess` without naming their classes.
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { AgentHost, HostDirEntry, HostExit, HostProcess, HostSpawnSpec, HostStat } from './types.ts'

/** Byte cap for a spawned child's collected stderr. */
const STDERR_CAP_BYTES = 512 * 1024
/** Default largest accepted stdout line. */
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024
/** Grace between the termination tiers of a managed process range. */
const TERMINATION_GRACE_MS = 3000

/** Options for {@link createContextHost}. */
export interface ContextHostOptions {
  /** Environment to expose to adapters; defaults to the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Home directory default stores resolve under; defaults to the OS home. */
  readonly home?: string
  /** Clock, injected so a test can pin it. */
  readonly now?: () => number
}

/**
 * Split a byte stream into `\n`-delimited lines, bounding memory by dropping a
 * line longer than the cap.
 * @param stream - The child's stdout.
 * @param maxLineBytes - Largest accepted line, in bytes.
 * @param onDrop - Called once per dropped line with the number of dropped bytes.
 * @returns an async iterator over the accepted lines.
 */
async function* readLines(
  stream: Readable,
  maxLineBytes: number,
  onDrop: (droppedBytes: number) => void,
): AsyncIterable<string> {
  let buffer = ''
  let dropping = 0
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (dropping > 0) {
        onDrop(dropping + line.length + 1)
        dropping = 0
      } else if (line.length > maxLineBytes) {
        onDrop(line.length + 1)
      } else {
        yield line.endsWith('\r') ? line.slice(0, -1) : line
      }
      index = buffer.indexOf('\n')
    }
    if (dropping === 0 && buffer.length > maxLineBytes) {
      dropping = buffer.length
      buffer = ''
    }
  }
  if (dropping > 0) {
    onDrop(dropping + buffer.length)
    return
  }
  if (buffer !== '') yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
}

/**
 * Probe one path's modification time by direct metadata read.
 * @param path - Absolute path.
 * @returns the time in epoch milliseconds, or 0 when the path cannot be probed.
 */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Build the harness-backed host for one adapter instance.
 * @param ctx - Context carrying the `fs` and `subprocess` services.
 * @param options - Environment, home, and clock overrides.
 * @returns the host adapters read and spawn through.
 */
export function createContextHost(ctx: Context, options: ContextHostOptions = {}): AgentHost {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const now = options.now ?? ((): number => Date.now())

  const resolve = async (path: string): Promise<Awaited<ReturnType<Context['fs']['resolve']>> | undefined> => {
    try {
      return await ctx.fs.resolve(path)
    } catch {
      return undefined
    }
  }

  // A head window is a byte range, not a whole-file read: `readBytes` refuses a
  // file larger than its cap, which would report every real session store as
  // empty. A missing or refused target reads as an empty string.
  const readHead = async (path: string, maxBytes: number): Promise<string> => {
    const target = await resolve(path)
    if (target === undefined) return ''
    try {
      const bytes = await ctx.fs.readByteRange(target, { offset: 0, length: maxBytes })
      return Buffer.from(bytes).toString('utf8')
    } catch {
      return ''
    }
  }

  return {
    env,
    home,
    now,

    async stat(path: string): Promise<HostStat | undefined> {
      const target = await resolve(path)
      if (target === undefined) return undefined
      try {
        const info = await ctx.fs.stat(target)
        // A missing target is absent, not empty: adapters use this probe for
        // existence, so reporting a fabricated stat would make every candidate
        // look installed.
        if (info === undefined) return undefined
        return {
          size: info.type === 'file' ? (info.size ?? 0) : 0,
          mtimeMs: mtimeOf(path),
          isDirectory: info.type === 'directory',
        }
      } catch {
        return undefined
      }
    },

    async listDir(path: string): Promise<readonly HostDirEntry[]> {
      const target = await resolve(path)
      if (target === undefined) return []
      try {
        const entries = await ctx.fs.listDir(target)
        return entries.map((entry): HostDirEntry => ({
          name: entry.name,
          isDirectory: entry.type === 'directory',
          mtimeMs: mtimeOf(join(path, entry.name)),
        }))
      } catch {
        return []
      }
    },

    readHead,

    async readTail(path: string, maxBytes: number): Promise<{ text: string; droppedPartialLine: boolean }> {
      const target = await resolve(path)
      if (target === undefined) return { text: '', droppedPartialLine: false }
      try {
        const info = await ctx.fs.stat(target)
        const size = info?.size ?? 0
        const offset = Math.max(0, size - maxBytes)
        const bytes = offset === 0
          ? await ctx.fs.readBytes(target, undefined, maxBytes)
          : await ctx.fs.readByteRange(target, { offset, length: maxBytes })
        const text = Buffer.from(bytes).toString('utf8')
        if (offset === 0) return { text, droppedPartialLine: false }
        const firstBreak = text.indexOf('\n')
        if (firstBreak < 0) return { text: '', droppedPartialLine: true }
        return { text: text.slice(firstBreak + 1), droppedPartialLine: true }
      } catch {
        return { text: '', droppedPartialLine: false }
      }
    },

    spawn(spec: HostSpawnSpec): HostProcess {
      if (spec.interactive === true && spec.stdin !== undefined) {
        throw new Error('agent-mesh: interactive stdin cannot also use batch stdin')
      }
      const controller = new AbortController()
      let timedOut = false
      let cancelled = false
      const timer = spec.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          timedOut = true
          controller.abort()
        }, spec.timeoutMs)
      timer?.unref()

      const handle = ctx.subprocess.spawn({
        argv: [spec.command, ...spec.args],
        cwd: spec.cwd,
        stdio: {
          stdin: spec.interactive === true ? 'pipe' : spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
          stdout: 'pipe',
          stderr: { maxBytes: STDERR_CAP_BYTES },
        },
        graceMs: TERMINATION_GRACE_MS,
        env: { ...spec.env },
        signal: controller.signal,
      })

      const maxLineBytes = spec.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
      const stdout = handle.stdout
      const lines: AsyncIterable<string> = stdout === undefined
        ? (async function* empty(): AsyncIterable<string> { /* a child without a stdout stream emits no events */ })()
        : readLines(stdout, maxLineBytes, (dropped) => {
          ctx.logger.warn('agent-mesh: an over-long stdout line dropped %d byte(s)', dropped)
        })

      const exit: Promise<HostExit> = handle.done.then(
        outcome => ({ code: outcome.exitCode, signal: outcome.signal, timedOut, cancelled }),
        () => ({ code: null, signal: null, timedOut, cancelled }),
      )

      return {
        lines,
        exit,
        stderr(): Promise<string> {
          return Promise.resolve(handle.collected.stderr?.readFrom(0).text ?? '')
        },
        cancel(reason?: string): void {
          if (cancelled || timedOut) return
          cancelled = true
          ctx.logger.info('agent-mesh: cancelling a run%s', reason === undefined ? '' : `: ${reason}`)
          handle.terminate()
        },
        writeStdin(data: string): void {
          if (spec.interactive !== true || handle.stdin === undefined) {
            throw new Error('agent-mesh: child stdin is not open for interactive writes')
          }
          if (handle.stdin.destroyed || !handle.stdin.writable) {
            throw new Error('agent-mesh: child stdin is already closed')
          }
          handle.stdin.write(data)
        },
        closeStdin(): void {
          if (spec.interactive !== true || handle.stdin === undefined) {
            throw new Error('agent-mesh: child stdin is not open for interactive writes')
          }
          if (!handle.stdin.destroyed && handle.stdin.writable) handle.stdin.end()
        },
      }
    },

    log(level: 'info' | 'warn', message: string): void {
      if (level === 'warn') ctx.logger.warn('agent-mesh: %s', message)
      else ctx.logger.info('agent-mesh: %s', message)
    },
  }
}
