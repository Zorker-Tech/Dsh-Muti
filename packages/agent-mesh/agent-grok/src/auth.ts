/**
 * Credential status and delegated login/logout for Grok Build.
 *
 * Status is read from `$GROK_AUTH_PATH` (default `$GROK_HOME/auth.json`), which is a map
 * keyed by scope string: `xai::api_key` for API-key auth, the legacy
 * `https://accounts.x.ai/sign-in`, or an OIDC issuer URL. Mutation is never performed
 * here: the native `grok login` / `grok logout` commands are spawned and the observed
 * post-state is re-read. No function in this module returns, logs or persists a secret.
 *
 * grok has no `--api-key` login flag, so an `api-key` flow is refused with the
 * interaction a caller can render instead of being faked. This adapter performs no
 * `grok models` probe, so it never reports `cli-probe` as a credential source.
 * @module @deepseek-ai/dsh-agent-grok/auth
 */

import type {
  AgentAuthOperationResult,
  AgentAuthState,
  AgentHost,
  AgentLoginFlow,
  AgentLoginRequest,
  HostProcess,
} from '@deepseek-ai/dsh-agent-mesh'
import { DEFAULT_STORE_FILE_BYTES } from './config.ts'

/** Scope key for plain API-key auth. */
const API_KEY_SCOPE = 'xai::api_key'

/** Legacy scope key used by pre-OIDC devbox auth files. */
const LEGACY_SCOPE = 'https://accounts.x.ai/sign-in'

/** Credential variables grok honours, in the precedence its own banner reports. */
export const GROK_CREDENTIAL_ENV_KEYS = [
  'XAI_API_KEY',
  'GROK_CODE_XAI_API_KEY',
  'GROK_AUTH',
  'GROK_DEPLOYMENT_KEY',
] as const

/** Store and policy variables every grok child is given. */
export const GROK_RUNTIME_ENV_KEYS = ['GROK_HOME', 'GROK_AUTH_PATH', 'GROK_SANDBOX'] as const

/** Every variable name this adapter may pass to a grok process. */
export const GROK_MANAGED_ENV_KEYS: readonly string[] = [...GROK_RUNTIME_ENV_KEYS, ...GROK_CREDENTIAL_ENV_KEYS]

/** Bytes of CLI output kept in an auth operation result. */
const AUTH_OUTPUT_CHARS = 8 * 1024

/** One `auth.json` entry, with the secret reduced to its presence. */
export interface GrokAuthEntry {
  /** Scope key the entry is filed under. */
  readonly scope: string
  /** `auth_mode` verbatim: `web_login`, `oidc`, `external` or `api_key`. */
  readonly authMode: string
  /** Whether a bearer was present; the value itself is never retained. */
  readonly hasKey: boolean
  /** Whether a refresh token was present. */
  readonly hasRefreshToken: boolean
  /** Whether `expires_at` is in the past. */
  readonly expired: boolean
  /** Whether the entry carries an expiry at all. */
  readonly hasExpiry: boolean
  /** Account the entry names, when it does. */
  readonly email?: string
  /** Team the entry names, when it does. */
  readonly teamName?: string
  /** Expiry carried by the entry, when it has one. */
  readonly expiresAt?: string
  /** Whether this entry represents an account login rather than a bare key. */
  readonly accountLogin: boolean
}

/**
 * Parse the scope map read-only.
 * @param value - Parsed JSON of the credential file.
 * @param nowMs - Current time in epoch milliseconds, against which expiry is judged.
 * @returns one entry per scope; unrecognized values are skipped, never guessed at.
 */
export function parseGrokAuthStore(value: unknown, nowMs: number): readonly GrokAuthEntry[] {
  const record = asRecord(value)
  if (record === undefined) return []
  const entries: GrokAuthEntry[] = []
  for (const [scope, raw] of Object.entries(record)) {
    const entry = asRecord(raw)
    if (entry === undefined) continue
    const authMode = typeof entry['auth_mode'] === 'string' ? entry['auth_mode'] : ''
    const expiresAt = isoValue(entry['expires_at'])
    const expired = expiresAt === undefined ? false : Date.parse(expiresAt) <= nowMs
    entries.push({
      scope,
      authMode,
      hasKey: typeof entry['key'] === 'string' && entry['key'] !== '',
      hasRefreshToken: typeof entry['refresh_token'] === 'string' && entry['refresh_token'] !== '',
      expired,
      hasExpiry: expiresAt !== undefined,
      ...(typeof entry['email'] === 'string' && entry['email'] !== '' ? { email: entry['email'] } : {}),
      ...(typeof entry['team_name'] === 'string' && entry['team_name'] !== '' ? { teamName: entry['team_name'] } : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      accountLogin: isAccountLogin(scope, authMode),
    })
  }
  return entries
}

/** The credential store as read: presence plus the entries, never secret material. */
export interface GrokAuthStoreRead {
  /** Whether the store file exists. */
  readonly present: boolean
  /** One entry per scope, with secret values reduced to a presence flag. */
  readonly entries: readonly GrokAuthEntry[]
  /** Why the store could not be read, when it exists but could not be. */
  readonly error?: string
}

/**
 * Read the scope-keyed credential store without writing, locking or rewriting it.
 *
 * An absent or empty file is the signed-out state a crashed writer leaves behind, not
 * corruption; a file that cannot be parsed is reported through
 * {@link GrokAuthStoreRead.error}. No entry value is retained: `key` and `refresh_token`
 * are reduced to booleans in-process.
 * @param host - Host providing the file metadata and contents.
 * @param credentialPath - Resolved credential file path.
 * @param maxBytes - Largest credential file this read accepts.
 * @returns the store's presence, its parsed entries, and the read error when there is one.
 */
export async function readGrokAuthStore(host: AgentHost, credentialPath: string, maxBytes: number): Promise<GrokAuthStoreRead> {
  const stat = await host.stat(credentialPath)
  if (stat === undefined || stat.isDirectory) return { present: false, entries: [] }
  if (stat.size > maxBytes) {
    return { present: true, entries: [], error: 'the credential store is larger than a single bounded read' }
  }
  const text = (await host.readHead(credentialPath, maxBytes)).trim()
  // An empty file is the signed-out state a crashed writer leaves behind, not corruption.
  if (text === '') return { present: true, entries: [] }
  try {
    const parsed: unknown = JSON.parse(text)
    return { present: true, entries: parseGrokAuthStore(parsed, host.now()) }
  } catch (cause) {
    return { present: true, entries: [], error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Choose the entry that best describes the live credential.
 *
 * Precedence: a usable account login, then an account login that can still refresh, then
 * an API-key entry (canonical scope first), then anything else.
 * @param entries - Parsed entries.
 * @returns the selected entry, or `undefined` when the store is empty.
 */
export function selectGrokAuthEntry(entries: readonly GrokAuthEntry[]): GrokAuthEntry | undefined {
  let best: GrokAuthEntry | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    const score = entryScore(entry)
    if (score < bestScore) {
      best = entry
      bestScore = score
    }
  }
  return best
}

/** Rank one entry for selection; lower wins, and an unusable entry never outranks a usable one. */
function entryScore(entry: GrokAuthEntry): number {
  if (entry.accountLogin) {
    if (!entry.expired) return 0
    if (entry.hasRefreshToken) return 1
    return 5
  }
  if (entry.scope === API_KEY_SCOPE) return 2
  if (entry.hasKey) return 3
  return 6
}

/**
 * Canonical credential method label for a native `auth_mode`.
 * @param authMode - The `auth_mode` string from the store.
 * @returns the canonical method label, or the raw token when it is not one this adapter knows.
 */
export function grokMethodLabel(authMode: string): string {
  switch (authMode) {
    case 'web_login':
      return 'web-login'
    case 'oidc':
      return 'oidc'
    case 'external':
      return 'external'
    case 'api_key':
      return 'api-key'
    default:
      return authMode === '' ? 'unknown' : authMode
  }
}

/** Everything the credential reads and flows need from the adapter. */
export interface GrokAuthContext {
  /** Host providing the file reads, the clock and process spawning. */
  readonly host: AgentHost
  /** Resolved credential file path. */
  readonly credentialPath: string
  /** Grok home, used as the working directory of `grok login` and `grok logout`. */
  readonly home: string
  /** Environment handed to a delegated `grok login`/`grok logout` child. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Resolves the executable, or `undefined` when no binary is installed. */
  readonly resolveBinary: () => Promise<string | undefined>
  /** Wall-clock budget for a delegated login. */
  readonly loginTimeoutMs: number
  /** Wall-clock budget for a delegated logout. */
  readonly logoutTimeoutMs: number
}

/**
 * Observe the credential state without writing anything.
 *
 * @param context - Host, credential path and the ambient environment.
 * @returns the classified state; `misconfigured` for an unreadable store and
 *   `unauthenticated` only when nothing at all supplies a credential.
 */
export async function readGrokAuthState(context: GrokAuthContext): Promise<AgentAuthState> {
  const environmentKeys = GROK_CREDENTIAL_ENV_KEYS.filter((name) => {
    const value = context.host.env[name]
    return value !== undefined && value !== ''
  })
  const store = await readGrokAuthStore(context.host, context.credentialPath, DEFAULT_STORE_FILE_BYTES)
  const entry = selectGrokAuthEntry(store.entries)

  // grok's own banner reports the environment key ahead of the file, so an env credential
  // is the state a run will actually use.
  const environmentKey = environmentKeys[0]
  if (environmentKey !== undefined) {
    const method = methodForEnvKey(environmentKey)
    return {
      status: 'authenticated',
      source: 'env',
      method,
      ...(entry?.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      detail: `${method} credential comes from the environment; this adapter cannot log it out or rotate it`,
    }
  }

  if (store.error !== undefined) {
    return {
      status: 'misconfigured',
      source: 'file',
      detail: `the credential store could not be read: ${store.error}`,
    }
  }

  if (entry !== undefined) {
    const method = grokMethodLabel(entry.authMode)
    if (!entry.hasKey) {
      return {
        status: 'misconfigured',
        source: 'file',
        method,
        detail: `the ${entry.scope} entry carries no credential material`,
      }
    }
    if (entry.expiresAt !== undefined && store.entries.every(candidate => candidate.expired && !candidate.hasRefreshToken)) {
      return {
        status: 'expired',
        source: 'file',
        method,
        expiresAt: entry.expiresAt,
        detail: 'every stored credential is past its expiry and none can be refreshed; run `grok login` again',
      }
    }
    const details = accountDetails(entry)
    if (!entry.hasExpiry) details.push('grok stores no expiry for this credential')
    if (entry.scope === LEGACY_SCOPE) {
      details.push('this is the legacy web-login scope, which grok re-validates per request')
    }
    return {
      status: 'authenticated',
      source: 'file',
      method,
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      ...(details.length === 0 ? {} : { detail: details.join('; ') }),
    }
  }

  return {
    status: 'unauthenticated',
    source: 'file',
    detail: 'no credential file, no credential environment variable, and no CLI confirmation is available',
  }
}

/**
 * Start a credential flow through the native CLI.
 *
 * @param context - Host, paths, child environment and budgets.
 * @param request - The declared flow to run; a flow grok cannot complete
 *   non-interactively is reported with the interaction a human must perform.
 * @returns the observed post-state and what the user must do by hand, never the requested intent.
 */
export async function loginGrok(context: GrokAuthContext, request: AgentLoginRequest): Promise<AgentAuthOperationResult> {
  if (request.flow === 'api-key') {
    context.host.log('warn', 'grok has no non-interactive api-key login; the flow must be completed by a human')
    return {
      ok: false,
      action: 'login',
      instructions: 'Grok Build has no `--api-key` login flag, so a pasted key cannot be delegated. Set XAI_API_KEY in the adapter environment, or run `grok login` in a terminal.',
      state: await readGrokAuthState(context),
    }
  }
  if (request.flow === 'interactive') {
    return {
      ok: false,
      action: 'login',
      instructions: 'Run `grok login` in a terminal; the loopback flow needs a browser and a TTY-less child cannot host it.',
      state: await readGrokAuthState(context),
    }
  }

  const binary = await context.resolveBinary()
  if (binary === undefined) {
    return {
      ok: false,
      action: 'login',
      instructions: 'Install Grok Build, or set this adapter\'s binary path, and then run `grok login` in a terminal.',
      state: await readGrokAuthState(context),
    }
  }
  const args = request.flow === 'device-code' ? ['login', '--device-auth'] : ['login', '--oauth']
  const outcome = await runCli(context, binary, args, context.loginTimeoutMs)
  const instructions = instructionsFor(request.flow, outcome.ok, outcome.captured)
  return {
    ok: outcome.ok,
    action: 'login',
    ...(instructions === undefined ? {} : { instructions }),
    state: await readGrokAuthState(context),
    ...(outcome.output === '' ? {} : { output: outcome.output }),
  }
}

/**
 * Revoke credentials through the native CLI.
 *
 * @param context - Host, paths, child environment and budgets.
 * @returns whether `grok logout` succeeded, plus the observed post-state.
 */
export async function logoutGrok(context: GrokAuthContext): Promise<AgentAuthOperationResult> {
  const binary = await context.resolveBinary()
  if (binary === undefined) {
    return {
      ok: false,
      action: 'logout',
      instructions: 'Install Grok Build, or set this adapter\'s binary path, and then run `grok logout` in a terminal.',
      state: await readGrokAuthState(context),
    }
  }
  const outcome = await runCli(context, binary, ['logout'], context.logoutTimeoutMs)
  return {
    ok: outcome.ok,
    action: 'logout',
    state: await readGrokAuthState(context),
    ...(outcome.output === '' ? {} : { output: outcome.output }),
  }
}

/** Run one native credential command and capture its redacted output. */
async function runCli(
  context: GrokAuthContext,
  binary: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly output: string; readonly captured: string }> {
  let child: HostProcess
  try {
    child = context.host.spawn({ command: binary, args: [...args], cwd: context.home, env: context.env, timeoutMs })
  } catch (cause) {
    context.host.log('warn', `grok ${args.join(' ')} could not be started: ${messageOf(cause)}`)
    return { ok: false, output: '', captured: '' }
  }
  const lines: string[] = []
  try {
    for await (const line of child.lines) lines.push(line)
  } catch (cause) {
    context.host.log('warn', `grok ${args.join(' ')} output ended abnormally: ${messageOf(cause)}`)
  }
  let stderrText = ''
  try {
    stderrText = await child.stderr()
  } catch (cause) {
    context.host.log('warn', `grok ${args.join(' ')} stderr could not be read: ${messageOf(cause)}`)
  }
  const exit = await child.exit
  const captured = `${lines.join('\n')}\n${stderrText}`.trim()
  return { ok: exit.code === 0, output: capTail(redactGrokOutput(captured), AUTH_OUTPUT_CHARS), captured }
}

/**
 * The human interaction a delegated flow still needs, when it needs one.
 *
 * The mesh records a single instruction string, so an observed URL or device code is
 * stated inside it rather than in a structured field.
 */
function instructionsFor(flow: AgentLoginFlow, ok: boolean, captured: string): string | undefined {
  const url = /https?:\/\/[^\s"'<>]+/.exec(captured)?.[0]
  const code = /(?:^|\s)([A-Z0-9]{4}(?:-[A-Z0-9]{4,})+)(?:\s|$)/.exec(captured)?.[1]
  if (flow === 'device-code') {
    const where = [url === undefined ? undefined : `URL: ${url}`, code === undefined ? undefined : `code: ${code}`]
      .filter((part): part is string => part !== undefined)
    return [
      'Open the URL in a browser and confirm the code shown there matches the code below.',
      ...where,
    ].join(' ')
  }
  if (ok) return undefined
  return url === undefined
    ? 'Complete the sign-in in the browser that was opened; the run finishes when grok receives the callback.'
    : `Complete the sign-in in the browser that was opened (${url}); the run finishes when grok receives the callback.`
}

/** Account facts the mesh's credential record has no fields for, stated in the detail. */
function accountDetails(entry: GrokAuthEntry): string[] {
  const details: string[] = []
  if (entry.email !== undefined) details.push(`signed in as ${entry.email}`)
  if (entry.teamName !== undefined) details.push(`team ${entry.teamName}`)
  return details
}

const ENV_CREDENTIAL_METHODS: Readonly<Record<(typeof GROK_CREDENTIAL_ENV_KEYS)[number], string>> = {
  XAI_API_KEY: 'api-key',
  GROK_CODE_XAI_API_KEY: 'api-key-legacy',
  GROK_AUTH: 'legacy-token',
  GROK_DEPLOYMENT_KEY: 'deployment-key',
}

/** Credential method implied by an environment variable name. */
function methodForEnvKey(name: (typeof GROK_CREDENTIAL_ENV_KEYS)[number]): string {
  return ENV_CREDENTIAL_METHODS[name]
}

/** Whether an entry represents an account login rather than a bare key. */
function isAccountLogin(scope: string, authMode: string): boolean {
  if (authMode === 'api_key') return false
  return authMode === 'web_login' || authMode === 'oidc' || authMode === 'external' || scope !== API_KEY_SCOPE
}

/**
 * Replace every credential-shaped substring before native output leaves this adapter.
 *
 * A `grok login` transcript can echo a key or a bearer header, so every path that keeps
 * CLI output runs it through this function first.
 * @param text - Captured CLI output.
 * @returns the same text with credential-shaped substrings replaced.
 */
export function redactGrokOutput(text: string): string {
  let out = text
  for (const rule of REDACTION_RULES) out = out.replace(rule.pattern, rule.replacement)
  return out
}

/** Keep the newest `count` characters of a text, which is where a failure states itself. */
function capTail(text: string, count: number): string {
  const trimmed = text.trim()
  return trimmed.length > count ? trimmed.slice(trimmed.length - count) : trimmed
}

/** Credential-shaped substrings a `grok login` transcript must never carry onward. */
const REDACTION_RULES: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // xAI and other provider key shapes, bearer headers, and generic JSON secret fields.
  { pattern: /\b(?:sk|sk-ant|sk-proj|xai|gsk|pk|ghp|gho|ghs|glpat)[-_][A-Za-z0-9_-]{12,}\b/g, replacement: '<redacted:key>' },
  { pattern: /\bBearer\s+[\w.~+/-]{16,}=*/gi, replacement: 'Bearer <redacted:token>' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '<redacted:jwt>' },
  {
    pattern: /("(?:api_?key|access_?token|refresh_?token|password|secret|authorization)"\s*:\s*")[^"]{6,}(")/gi,
    replacement: '$1<redacted>$2',
  },
]

/** Narrow a JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

/** An RFC3339 timestamp kept verbatim, when it parses. */
function isoValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return Number.isFinite(Date.parse(value)) ? value : undefined
}

/** A thrown value as a message string. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
