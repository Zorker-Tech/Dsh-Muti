/**
 * Deployment-varying inputs of the Pi adapter, and the explicit resolve step that turns
 * them into a fully defaulted spec.
 *
 * Every value here is changeable by the deployment through the Cordis plugin's config (see
 * `index.ts`); nothing in `src/` reads a tunable from anywhere else. Defaults live in
 * {@link resolvePiConfig} alone, so the adapter spec the readers receive is always complete.
 * @module @deepseek-ai/dsh-agent-pi/config
 */

import type { AgentRunMode } from '@deepseek-ai/dsh-agent-mesh'

/** Caller-supplied adapter configuration; every field is optional. */
export interface PiAdapterConfig {
  /** Explicit Pi executable path; tried before `PATH` and the well-known directories. */
  readonly binaryPath?: string
  /** Pi's agent directory; tried before `$PI_CODING_AGENT_DIR` and `~/.pi/agent`. */
  readonly homeDir?: string
  /**
   * Flat session directory override; tried before `$PI_CODING_AGENT_SESSION_DIR` and the
   * `sessionDir` of Pi's own `settings.json`.
   */
  readonly sessionDir?: string
  /** Extra environment entries for every child process this adapter starts. */
  readonly env?: Readonly<Record<string, string>>
  /** Native transport; RPC is the default, with one-shot JSON available as an alternate. */
  readonly runMode?: AgentRunMode
  /** Time to wait for Pi to settle after an RPC abort before terminating its process. */
  readonly interruptGraceMs?: number
}

/** Fully resolved adapter configuration; every deployment choice is explicit. */
export interface ResolvedPiConfig {
  /** Explicit Pi executable path, or `undefined` to search `PATH`. */
  readonly binaryPath: string | undefined
  /** Explicit agent directory, or `undefined` to resolve it from the environment. */
  readonly homeDir: string | undefined
  /** Explicit session directory override, or `undefined` to resolve it from the environment. */
  readonly sessionDir: string | undefined
  /** Extra environment entries for child processes. */
  readonly env: Readonly<Record<string, string>>
  /** Selected native run transport. */
  readonly runMode: AgentRunMode
  /** Time to wait for Pi to settle after an RPC abort. */
  readonly interruptGraceMs: number
}

/** Default grace after a native RPC abort. */
export const DEFAULT_INTERRUPT_GRACE_MS = 10_000

/** Default Pi run transport. */
export const DEFAULT_RUN_MODE: AgentRunMode = 'duplex-protocol'

/**
 * Resolve caller configuration into the complete adapter spec.
 * @param config - Caller-supplied configuration.
 * @returns the resolved configuration with every default applied.
 */
export function resolvePiConfig(config: PiAdapterConfig = {}): ResolvedPiConfig {
  const configuredRunMode: unknown = config.runMode
  if (configuredRunMode !== undefined
    && configuredRunMode !== 'duplex-protocol'
    && configuredRunMode !== 'headless-exec') {
    throw new TypeError('runMode must be "duplex-protocol" or "headless-exec"')
  }
  const runMode = configuredRunMode ?? DEFAULT_RUN_MODE
  return {
    binaryPath: emptyToUndefined(config.binaryPath),
    homeDir: emptyToUndefined(config.homeDir),
    sessionDir: emptyToUndefined(config.sessionDir),
    env: config.env ?? {},
    runMode,
    interruptGraceMs: positive(config.interruptGraceMs) ?? DEFAULT_INTERRUPT_GRACE_MS,
  }
}

/** A non-empty string, or `undefined`. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/** A positive integer, or `undefined`. */
function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined
}
