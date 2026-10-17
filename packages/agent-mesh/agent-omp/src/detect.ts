/**
 * OMP identity, binary resolution and version probing.
 *
 * Detection never runs the agent to decide it exists: a candidate is accepted when the
 * host reports a non-directory at its path, and `--version` is the only process this
 * module starts.
 * @module @deepseek-ai/dsh-agent-omp/detect
 */

import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { AgentDetection, AgentDetectionSource, AgentHost } from '@deepseek-ai/dsh-agent-mesh'

/** Bare command name OMP installs under. */
export const OMP_BINARY_NAME = 'omp'

/** Approval modes `--approval-mode` accepts, in OMP's own vocabulary. */
export const OMP_APPROVAL_MODES: readonly string[] = ['always-ask', 'write', 'yolo']

/** Default wall-clock budget for the `--version` probe. */
export const OMP_VERSION_PROBE_TIMEOUT_MS = 10 * 1000

/** Result of resolving a binary on this machine. */
export interface BinaryResolution {
  /** Whether a candidate was found. */
  readonly found: boolean
  /** Absolute path of the resolved executable. */
  readonly path?: string
  /** Which search step found it. */
  readonly source: AgentDetectionSource
  /** Why resolution failed, when it did. */
  readonly reason?: string
}

/**
 * Expand a leading `~` and resolve a relative path against the host process directory.
 * @param host - Host providing the home directory.
 * @param path - Path as written by the user or a configuration file.
 * @returns the absolute path.
 */
export function expandUserPath(host: AgentHost, path: string): string {
  if (path === '~') return host.home
  if (path.startsWith('~/')) return join(host.home, path.slice(2))
  return isAbsolute(path) ? path : resolve(path)
}

/**
 * Split a configured model string into OMP's `--provider` and `--model` values.
 *
 * `provider/id` is split at the first slash; anything else is passed verbatim, because a
 * bare pattern is legal (OMP also accepts role aliases such as `@slow`, a `:<thinking>`
 * suffix and fuzzy patterns), and guessing would silently select a different model.
 *
 * @param model - Model string from the run request.
 * @returns the provider, when the string has the `provider/id` shape, and the model value.
 */
export function splitOmpModel(model: string): { readonly provider?: string; readonly model: string } {
  const trimmed = model.trim()
  if (trimmed.startsWith('@')) return { model: trimmed }
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return { model: trimmed }
  const provider = trimmed.slice(0, slash)
  const id = trimmed.slice(slash + 1)
  if (id === '' || !/^[A-Za-z0-9._-]+$/.test(provider)) return { model: trimmed }
  return { provider, model: id }
}

/**
 * Locate the OMP executable without running it.
 *
 * A candidate is accepted when the host reports a non-directory at its path; the host
 * port carries no executable-bit fact, so the `--version` probe in {@link probeVersion}
 * is what proves the candidate can actually run.
 *
 * @param host - Host providing the filesystem, the environment and the home directory.
 * @param options - Explicit candidate paths to try before `PATH`.
 * @returns the resolution, with the reason a search failed.
 */
export async function resolveBinary(
  host: AgentHost,
  options: { readonly candidates?: readonly string[] } = {},
): Promise<BinaryResolution> {
  for (const candidate of options.candidates ?? []) {
    if (candidate === '') continue
    const absolute = isAbsolute(candidate) ? candidate : join(process.cwd(), candidate)
    if (await exists(host, absolute)) return { found: true, path: absolute, source: 'config' }
  }

  for (const dir of (host.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue
    // A PATH entry can be relative (pnpm prepends `node_modules/.bin`), and a
    // relative command only resolves against the child's own cwd, so the found
    // candidate is anchored here — the same absolutization the plugin's
    // realpath performed after its access check.
    const candidate = isAbsolute(dir) ? join(dir, OMP_BINARY_NAME) : join(process.cwd(), dir, OMP_BINARY_NAME)
    if (await exists(host, candidate)) return { found: true, path: candidate, source: 'path' }
  }

  // A GUI-launched host process often has a minimal PATH, so the install locations that
  // do not appear in it are tried explicitly.
  const home = host.home
  for (const candidate of [
    join(home, '.local', 'bin', OMP_BINARY_NAME),
    join(home, '.cargo', 'bin', OMP_BINARY_NAME),
    join(home, '.bun', 'bin', OMP_BINARY_NAME),
    join('/', 'usr', 'local', 'bin', OMP_BINARY_NAME),
    join('/', 'opt', 'homebrew', 'bin', OMP_BINARY_NAME),
  ]) {
    if (await exists(host, candidate)) return { found: true, path: candidate, source: 'well-known' }
  }

  return {
    found: false,
    source: 'none',
    reason: `\`${OMP_BINARY_NAME}\` was not found on PATH or in any known install location`,
  }
}

/** Whether a non-directory exists at this path. */
async function exists(host: AgentHost, path: string): Promise<boolean> {
  const stat = await host.stat(path)
  return stat !== undefined && !stat.isDirectory
}

/**
 * Read the first version line a binary prints.
 *
 * Standard output is preferred over standard error, and the first non-empty line is taken
 * verbatim because these strings are user-facing and each product formats them
 * differently.
 *
 * @param host - Host used to start the probe.
 * @param binaryPath - Absolute path of the binary.
 * @param options - Directory to probe from and the wall-clock budget.
 * @returns the version line, or `undefined` when the probe failed or printed nothing.
 */
export async function probeVersion(
  host: AgentHost,
  binaryPath: string,
  options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<string | undefined> {
  let process: ReturnType<AgentHost['spawn']>
  try {
    process = host.spawn({
      command: binaryPath,
      args: ['--version'],
      cwd: options.cwd,
      env: {},
      timeoutMs: options.timeoutMs,
    })
  } catch (cause) {
    host.log('warn', `${OMP_BINARY_NAME} --version could not be started: ${messageOf(cause)}`)
    return undefined
  }
  const stdoutLines: string[] = []
  try {
    for await (const line of process.lines) stdoutLines.push(line)
  } catch (cause) {
    host.log('warn', `${OMP_BINARY_NAME} --version output ended abnormally: ${messageOf(cause)}`)
  }
  let stderrText = ''
  try {
    stderrText = await process.stderr()
  } catch (cause) {
    host.log('warn', `${OMP_BINARY_NAME} --version stderr could not be read: ${messageOf(cause)}`)
  }
  await process.exit
  const stdoutText = stdoutLines.join('\n')
  return firstLine(stdoutText.trim() === '' ? stderrText : stdoutText)
}

/** The first non-empty trimmed line of a text. */
function firstLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return undefined
}

/**
 * Assemble a mesh detection record from a resolution and an optional version probe.
 * @param resolution - Result of {@link resolveBinary}.
 * @param extras - Version the probe observed, when it answered.
 * @returns the detection record.
 */
export function detectionFrom(resolution: BinaryResolution, extras: { readonly version?: string } = {}): AgentDetection {
  if (!resolution.found || resolution.path === undefined) {
    return {
      installed: false,
      source: 'none',
      ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
    }
  }
  return {
    installed: true,
    binaryPath: resolution.path,
    source: resolution.source,
    ...(extras.version === undefined ? {} : { version: extras.version }),
  }
}

/** A thrown value as a message string. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
