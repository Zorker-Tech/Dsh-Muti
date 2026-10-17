/**
 * Deployment-varying inputs of the OMP adapter, and the explicit resolve step that
 * turns them into a fully defaulted spec.
 *
 * Every value here is changeable by the deployment through the Cordis plugin's config
 * (see `index.ts`); nothing in `src/` reads a tunable from anywhere else. Defaults live
 * in {@link resolveOmpConfig} alone, so the adapter spec the readers receive is always
 * complete.
 * @module @deepseek-ai/dsh-agent-omp/config
 */

/** Caller-supplied adapter configuration; every field is optional. */
export interface OmpAdapterConfig {
  /** Explicit `omp` executable path; tried before `PATH` and the well-known directories. */
  readonly binaryPath?: string
  /**
   * Explicit OMP agent directory, the highest-priority source of `<agent-dir>`.
   *
   * A named profile (`$OMP_PROFILE`, else `$PI_PROFILE`) derives its own agent directory
   * and ignores `$PI_CODING_AGENT_DIR`, so a run started with this override is also
   * started with an explicitly empty `OMP_PROFILE`, which OMP documents as selecting the
   * default profile.
   */
  readonly homeDir?: string
  /**
   * Session directory override, as `omp --session-dir` defines it: the one directory that
   * directly holds session files for every project.
   *
   * OMP's `config.yml` has no equivalent key (`--session-dir` defaults from
   * `$PI_CODING_AGENT_SESSION_DIR`), so this setting and that variable are the only
   * non-argv sources.
   */
  readonly sessionDir?: string
  /** Extra environment entries for every child process this adapter starts. */
  readonly env?: Readonly<Record<string, string>>
}

/** Fully resolved adapter configuration; every deployment choice is explicit. */
export interface ResolvedOmpConfig {
  /** Explicit `omp` executable path, or `undefined` to search `PATH`. */
  readonly binaryPath: string | undefined
  /** Explicit OMP agent directory, or `undefined` to resolve the profile/default layout. */
  readonly homeDir: string | undefined
  /** Session directory override, or `undefined` to read the per-project buckets. */
  readonly sessionDir: string | undefined
  /** Extra environment entries for child processes. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * Resolve caller configuration into the complete adapter spec.
 * @param config - Caller-supplied configuration.
 * @returns the resolved configuration with every default applied.
 */
export function resolveOmpConfig(config: OmpAdapterConfig = {}): ResolvedOmpConfig {
  return {
    binaryPath: emptyToUndefined(config.binaryPath),
    homeDir: emptyToUndefined(config.homeDir),
    sessionDir: emptyToUndefined(config.sessionDir),
    env: config.env ?? {},
  }
}

/** A trimmed non-empty string, or `undefined`. */
function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
