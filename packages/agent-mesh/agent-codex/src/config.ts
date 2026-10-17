/**
 * Deployment-varying inputs of the Codex adapter, and the explicit resolve step that
 * turns them into a fully defaulted spec.
 *
 * Every value here is changeable by the deployment through the Cordis plugin's config
 * (see `index.ts`); nothing in `src/` reads a tunable from anywhere else. Defaults live
 * in {@link resolveCodexConfig} alone, so the adapter spec the readers receive is always
 * complete.
 * @module @deepseek-ai/dsh-agent-codex/config
 */

import type { AgentRunMode } from '@deepseek-ai/dsh-agent-mesh'

/** Caller-supplied adapter configuration; every field is optional. */
export interface CodexAdapterConfig {
  /** Explicit Codex executable path; tried before `PATH` and the well-known directories. */
  readonly binaryPath?: string
  /** Explicit Codex home; tried before `$CODEX_HOME` and `~/.codex`. */
  readonly homeDir?: string
  /** Extra environment entries for every child process this adapter starts. */
  readonly env?: Readonly<Record<string, string>>
  /** Default model for runs that name none, in Codex's own naming. */
  readonly model?: string
  /** Native run transport; app-server is the default, with exec JSON available as an alternate. */
  readonly runMode?: AgentRunMode
  /** Default sandbox profile for runs that name none; must be one of the declared profiles. */
  readonly sandbox?: string
  /** Default approval mode for runs that name none; must be one of the declared modes. */
  readonly approval?: string
  /** Default wall-clock budget for a run in milliseconds; `0` leaves runs unbounded. */
  readonly timeoutMs?: number
  /** Time to wait for Codex to finish a turn after a native interrupt request. */
  readonly interruptGraceMs?: number
  /** Bytes read from the tail of a rollout when projecting a transcript. */
  readonly transcriptTailBytes?: number
  /** Bytes read from the tail of a rollout when extracting native task state. */
  readonly taskTailBytes?: number
  /** Wall-clock budget for a delegated login, which waits for a human in the loop. */
  readonly loginTimeoutMs?: number
  /** Wall-clock budget for a delegated logout. */
  readonly logoutTimeoutMs?: number
  /** Wall-clock budget for the `--version` detection probe. */
  readonly versionProbeTimeoutMs?: number
}

/** Fully resolved adapter configuration; every deployment choice is explicit. */
export interface ResolvedCodexConfig {
  /** Explicit Codex executable path, or `undefined` to search `PATH`. */
  readonly binaryPath: string | undefined
  /** Explicit Codex home, or `undefined` to use `$CODEX_HOME` and then `~/.codex`. */
  readonly homeDir: string | undefined
  /** Extra environment entries for child processes. */
  readonly env: Readonly<Record<string, string>>
  /** Default model for runs that name none. */
  readonly model: string | undefined
  /** Selected native run transport. */
  readonly runMode: AgentRunMode
  /** Default sandbox profile for runs that name none. */
  readonly sandbox: string | undefined
  /** Default approval mode for runs that name none. */
  readonly approval: string | undefined
  /** Default run budget in milliseconds; `0` means unbounded. */
  readonly timeoutMs: number
  /** Time to wait for Codex to finish after a native interrupt request. */
  readonly interruptGraceMs: number
  /** Rollout tail window for a transcript read. */
  readonly transcriptTailBytes: number
  /** Rollout tail window for a native task read. */
  readonly taskTailBytes: number
  /** Wall-clock budget for a delegated login. */
  readonly loginTimeoutMs: number
  /** Wall-clock budget for a delegated logout. */
  readonly logoutTimeoutMs: number
  /** Wall-clock budget for the `--version` probe. */
  readonly versionProbeTimeoutMs: number
}

/** Default rollout tail window for a transcript read. */
export const DEFAULT_TRANSCRIPT_TAIL_BYTES = 1024 * 1024

/** Default rollout tail window for a native task read. */
export const DEFAULT_TASK_TAIL_BYTES = 1024 * 1024

/** Default login budget: ten minutes, because a human completes a browser flow. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** Default logout budget. */
export const DEFAULT_LOGOUT_TIMEOUT_MS = 60 * 1000

/** Default `--version` probe budget. */
export const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 10 * 1000

/** Default grace after `turn/interrupt` before the managed process is terminated. */
export const DEFAULT_INTERRUPT_GRACE_MS = 10 * 1000

/** Default native transport. */
export const DEFAULT_RUN_MODE: AgentRunMode = 'duplex-protocol'

/**
 * Resolve caller configuration into the complete adapter spec.
 * @param config - Caller-supplied configuration.
 * @returns the resolved configuration with every default applied.
 */
export function resolveCodexConfig(config: CodexAdapterConfig = {}): ResolvedCodexConfig {
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
    env: config.env ?? {},
    model: emptyToUndefined(config.model),
    runMode,
    sandbox: emptyToUndefined(config.sandbox),
    approval: emptyToUndefined(config.approval),
    timeoutMs: positiveOrZero(config.timeoutMs) ?? 0,
    interruptGraceMs: positive(config.interruptGraceMs) ?? DEFAULT_INTERRUPT_GRACE_MS,
    transcriptTailBytes: positive(config.transcriptTailBytes) ?? DEFAULT_TRANSCRIPT_TAIL_BYTES,
    taskTailBytes: positive(config.taskTailBytes) ?? DEFAULT_TASK_TAIL_BYTES,
    loginTimeoutMs: positive(config.loginTimeoutMs) ?? DEFAULT_LOGIN_TIMEOUT_MS,
    logoutTimeoutMs: positive(config.logoutTimeoutMs) ?? DEFAULT_LOGOUT_TIMEOUT_MS,
    versionProbeTimeoutMs: positive(config.versionProbeTimeoutMs) ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS,
  }
}

/** A non-empty string, or `undefined`. */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/** A positive integer, or `undefined`. */
function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined
}

/** A non-negative integer, or `undefined`. */
function positiveOrZero(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined
}
