/**
 * Deployment-varying inputs of the Grok Build adapter, and the explicit resolve step
 * that turns them into a fully defaulted spec.
 *
 * Every value here is changeable by the deployment through the Cordis plugin's config
 * (see `index.ts`); nothing in `src/` reads a tunable from anywhere else. Defaults live
 * in {@link resolveGrokConfig} alone, so the spec the readers receive is always complete.
 * @module @deepseek-ai/dsh-agent-grok/config
 */

import type { AgentRunMode } from '@deepseek-ai/dsh-agent-mesh'

/** Caller-supplied adapter configuration; every field is optional. */
export interface GrokAdapterConfig {
  /** Explicit Grok executable path; tried before `PATH` and the well-known directories. */
  readonly binaryPath?: string
  /** Explicit Grok home; tried before `$GROK_HOME` and `~/.grok`. */
  readonly homeDir?: string
  /** Extra environment entries for every child process this adapter starts. */
  readonly env?: Readonly<Record<string, string>>
  /** Native transport; ACP is the default, with one-shot streaming JSON available as an alternate. */
  readonly runMode?: AgentRunMode
  /** Time to wait for an ACP cancel before terminating its process. */
  readonly interruptGraceMs?: number
  /** Default model for runs that name none, in Grok's own naming. */
  readonly model?: string
  /** Default sandbox profile for runs that name none; one of the declared profiles. */
  readonly sandbox?: string
  /** Default approval mode for runs that name none; one of the declared modes. */
  readonly approval?: string
  /** Default `--max-turns` for every dispatch; omitted leaves Grok's own limit in force. */
  readonly maxTurns?: number
  /** Default `--reasoning-effort` for every dispatch. */
  readonly reasoningEffort?: string
  /** Pass `--no-plan` on every dispatch. */
  readonly noPlan?: boolean
  /** Pass `--no-subagents` on every dispatch. */
  readonly noSubagents?: boolean
  /** Pass `--disable-web-search` on every dispatch. */
  readonly disableWebSearch?: boolean
  /** Default wall-clock budget for a run in milliseconds; `0` leaves runs unbounded. */
  readonly timeoutMs?: number
  /** Bytes read from the tail of `updates.jsonl` when projecting a transcript. */
  readonly transcriptTailBytes?: number
  /** Wall-clock budget for a delegated login, which waits for a human in the loop. */
  readonly loginTimeoutMs?: number
  /** Wall-clock budget for a delegated logout. */
  readonly logoutTimeoutMs?: number
  /** Wall-clock budget for the `--version` detection probe. */
  readonly versionProbeTimeoutMs?: number
}

/** Fully resolved adapter configuration; every deployment choice is explicit. */
export interface ResolvedGrokConfig {
  /** Explicit Grok executable path, or `undefined` to search `PATH`. */
  readonly binaryPath: string | undefined
  /** Explicit Grok home, or `undefined` to use `$GROK_HOME` and then `~/.grok`. */
  readonly homeDir: string | undefined
  /** Extra environment entries for child processes. */
  readonly env: Readonly<Record<string, string>>
  /** Selected native run transport. */
  readonly runMode: AgentRunMode
  /** Time to wait for an ACP cancel before terminating its process. */
  readonly interruptGraceMs: number
  /** Default model for runs that name none. */
  readonly model: string | undefined
  /** Default sandbox profile for runs that name none. */
  readonly sandbox: string | undefined
  /** Default approval mode for runs that name none. */
  readonly approval: string | undefined
  /** Default `--max-turns` value. */
  readonly maxTurns: number | undefined
  /** Default `--reasoning-effort` value. */
  readonly reasoningEffort: string | undefined
  /** Whether `--no-plan` is passed on every dispatch. */
  readonly noPlan: boolean
  /** Whether `--no-subagents` is passed on every dispatch. */
  readonly noSubagents: boolean
  /** Whether `--disable-web-search` is passed on every dispatch. */
  readonly disableWebSearch: boolean
  /** Default run budget in milliseconds; `0` means unbounded. */
  readonly timeoutMs: number
  /** Tail window of `updates.jsonl` for a transcript read. */
  readonly transcriptTailBytes: number
  /** Wall-clock budget for a delegated login. */
  readonly loginTimeoutMs: number
  /** Wall-clock budget for a delegated logout. */
  readonly logoutTimeoutMs: number
  /** Wall-clock budget for the `--version` probe. */
  readonly versionProbeTimeoutMs: number
}

/** Default transcript window: the newest 1 MiB of records. */
export const DEFAULT_TRANSCRIPT_BYTES = 1024 * 1024

/** Default login budget: five minutes, because a human completes a browser flow. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** Default logout budget. */
export const DEFAULT_LOGOUT_TIMEOUT_MS = 30 * 1000

/** Default `--version` probe budget. */
export const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 10 * 1000

/** Default grace after an ACP session cancellation. */
export const DEFAULT_INTERRUPT_GRACE_MS = 10_000

/** Default Grok run transport. */
export const DEFAULT_RUN_MODE: AgentRunMode = 'duplex-protocol'

/** Bytes read from the head of a store file; a longer file is reported as unreadable. */
export const DEFAULT_STORE_FILE_BYTES = 1024 * 1024

/**
 * Resolve caller configuration into the complete adapter spec.
 * @param config - Caller-supplied configuration.
 * @returns the resolved configuration with every default applied.
 */
export function resolveGrokConfig(config: GrokAdapterConfig = {}): ResolvedGrokConfig {
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
    runMode,
    interruptGraceMs: positive(config.interruptGraceMs) ?? DEFAULT_INTERRUPT_GRACE_MS,
    model: emptyToUndefined(config.model),
    sandbox: emptyToUndefined(config.sandbox),
    approval: emptyToUndefined(config.approval),
    maxTurns: positive(config.maxTurns),
    reasoningEffort: emptyToUndefined(config.reasoningEffort),
    noPlan: config.noPlan === true,
    noSubagents: config.noSubagents === true,
    disableWebSearch: config.disableWebSearch === true,
    timeoutMs: positiveOrZero(config.timeoutMs) ?? 0,
    transcriptTailBytes: positive(config.transcriptTailBytes) ?? DEFAULT_TRANSCRIPT_BYTES,
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
