/**
 * Pi credential inspection and the credential operations this adapter will not fake.
 *
 * Status is read-only and file-first: `<agent-dir>/auth.json` is
 * `Record<providerId, {type:'api_key', key?, env?} | {type:'oauth', access, refresh,
 * expires, …}>`, and a provider key can also come from the environment this adapter
 * inspects. Nothing here writes, locks or rewrites the store, and no credential value ever
 * leaves this module: only provider names, kinds and expiries are projected. A key is read
 * only to test whether it is a `!command` reference, which is never executed here.
 *
 * Pi has no non-interactive credential command. `/login` and `/logout` exist only inside
 * its TUI, and this adapter never drives a TUI, so both operations return an explicit
 * unsupported-with-guidance result rather than faking a flow and never spawn anything.
 * @module @deepseek-ai/dsh-agent-pi/auth
 */

import type {
  AgentAuthOperationResult,
  AgentAuthState,
  AgentHost,
  AgentLoginRequest,
} from '@deepseek-ai/dsh-agent-mesh'
import { isRecord, readNumber, readString, type PiStoreLayout } from './sessions.ts'

/**
 * Credential-shaped environment variables Pi resolves a provider key from, as declared in
 * `@earendil-works/pi-ai`'s provider registry. Names only; values are never read into a
 * projection.
 *
 * Ambient sources Pi also supports (AWS IAM profiles, Google Application Default
 * Credentials) are deliberately absent: Pi's own `findEnvKeys` excludes them because they
 * cannot be classified by presence alone.
 */
export const PI_PROVIDER_ENV_VARS: readonly string[] = [
  // Anthropic: the auth token is a bearer credential, the other two are API keys.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANT_LING_API_KEY',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'NVIDIA_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'XAI_API_KEY',
  'TYPESAFE_API_KEY',
  'RADIUS_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ZAI_API_KEY',
  'ZAI_CODING_CN_API_KEY',
  'MISTRAL_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'MOONSHOT_API_KEY',
  'HF_TOKEN',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'BASETEN_API_KEY',
  'OPENCODE_API_KEY',
  'KIMI_API_KEY',
  'META_API_KEY',
  'CLOUDFLARE_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'QWEN_TOKEN_PLAN_API_KEY',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  // Amazon Bedrock's own credential sources.
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
]

/** Guidance shown when a credential operation has no non-interactive path. */
export const PI_LOGIN_INSTRUCTIONS =
  'Pi has no non-interactive login; run `pi` and use /login, or set a provider API key.'

/** Guidance shown for the equally TUI-only logout. */
export const PI_LOGOUT_INSTRUCTIONS =
  'Pi has no non-interactive logout; run `pi` and use /logout, or remove the provider entry from its auth.json.'

/** Byte cap on the credential file read. */
const AUTH_FILE_MAX_BYTES = 8 * 1024 * 1024

/** How a stored credential can be used, with no secret material. */
export type PiCredentialKind = 'oauth' | 'api_key' | 'command'

/** One provider's stored credential, classified without reading any secret value. */
export interface PiStoredCredential {
  /** Provider id, verbatim. */
  readonly provider: string
  /** How Pi would resolve it. */
  readonly kind: PiCredentialKind
  /** Whether it can authenticate a request right now. */
  readonly usable: boolean
  /** Expiry in milliseconds, for an OAuth credential. */
  readonly expiresMs?: number
}

/** The result of reading and classifying `auth.json`. */
interface CredentialObservation {
  /** Recognizable credentials, in file order. */
  readonly credentials: readonly PiStoredCredential[]
  /** Entries that were present but not recognizable as a credential. */
  readonly malformed: number
  /** Whether the file existed and parsed as a JSON object. */
  readonly parsed: boolean
  /** Parse or read failure, for a `misconfigured` detail; never secret material. */
  readonly error?: string
}

/** Everything an auth read needs. */
export interface PiAuthRead {
  /** Host providing the environment and the read. */
  readonly host: AgentHost
  /** Resolved store layout. */
  readonly layout: PiStoreLayout
  /** Environment to inspect; defaults to the host environment. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Observation time in milliseconds; injected so tests can pin it. */
  readonly now?: number
}

/**
 * Observe Pi's authentication state.
 *
 * A usable stored credential wins over the environment because that is what Pi itself
 * resolves first for a provider `auth.json` covers. An expired OAuth credential is
 * reported as `expired` rather than `unknown`, because Pi refreshes it on the next request.
 * An absent or empty file is only `unauthenticated` after the environment has been checked,
 * and a file that exists but cannot be interpreted is `misconfigured`, never a fabricated
 * "logged out".
 *
 * @param read - Host, layout and the environment to inspect.
 * @returns the observed state; never a secret.
 */
export async function readPiAuthState(read: PiAuthRead): Promise<AgentAuthState> {
  const env = read.env ?? read.host.env
  const now = read.now ?? read.host.now()
  const observation = await observeCredentials(read.host, read.layout.credentialPath, now)
  const environmentKeys = PI_PROVIDER_ENV_VARS.filter(name => (env[name] ?? '') !== '')

  const usable = observation.credentials.filter(credential => credential.usable)
  if (usable.length > 0) {
    const expiries = expiriesOf(usable)
    const commandOnly = usable.every(credential => credential.kind === 'command')
    return {
      status: 'authenticated',
      source: 'file',
      method: methodLabel(usable),
      ...(expiries === undefined ? {} : { expiresAt: expiries }),
      ...(commandOnly
        ? { detail: 'the stored key is a `!command` reference that pi resolves by running a shell command' }
        : {}),
    }
  }

  const expired = observation.credentials.filter(credential => credential.kind === 'oauth')
  if (expired.length > 0) {
    const expiries = expiriesOf(expired)
    return {
      status: 'expired',
      source: 'file',
      method: methodLabel(expired),
      ...(expiries === undefined ? {} : { expiresAt: expiries }),
      detail: 'a stored OAuth credential expired; pi refreshes it on the next request',
    }
  }

  const environmentKey = environmentKeys[0]
  if (environmentKey !== undefined) {
    return {
      status: 'authenticated',
      source: 'env',
      method: `api-key(${environmentKey})`,
      detail:
        'the key comes from the environment this adapter inspects, which it cannot log out; ' +
        'a run receives it only when it survives the harness subprocess environment scrub or ' +
        "the deployment forwards it through this adapter's `env` configuration",
    }
  }

  if (!observation.parsed) {
    if (observation.error === undefined) {
      return {
        status: 'unauthenticated',
        source: 'none',
        detail: 'auth.json is absent and no provider key is set in the environment',
      }
    }
    return {
      status: 'misconfigured',
      source: 'file',
      detail: `auth.json could not be read: ${observation.error}`,
    }
  }

  return {
    status: 'unauthenticated',
    source: 'file',
    detail:
      observation.malformed === 0
        ? 'auth.json holds no usable credential'
        : `auth.json holds no usable credential, and ${observation.malformed} entries were not recognizable`,
  }
}

/**
 * Report that Pi has no non-interactive login. The `interactive` flow is declared and
 * surfaced as guidance rather than driving a TUI.
 *
 * @param read - Host, layout and the environment to classify the state from.
 * @param request - Requested flow; the optional secret is never used, recorded or passed on.
 * @returns an unsuccessful result carrying the guidance and the freshly observed state.
 */
export async function piLogin(read: PiAuthRead, request: AgentLoginRequest): Promise<AgentAuthOperationResult> {
  const state = await readPiAuthState(read)
  const instructions =
    request.flow === 'interactive'
      ? PI_LOGIN_INSTRUCTIONS
      : `Pi has no \`${request.flow}\` login flow; ${PI_LOGIN_INSTRUCTIONS}`
  return { ok: false, action: 'login', state, instructions }
}

/**
 * Report that Pi has no non-interactive logout, naming the credential file the user can
 * edit by hand.
 *
 * @param read - Host, layout and the environment to classify the state from.
 * @returns an unsuccessful result carrying the guidance and the freshly observed state.
 */
export async function piLogout(read: PiAuthRead): Promise<AgentAuthOperationResult> {
  const state = await readPiAuthState(read)
  return {
    ok: false,
    action: 'logout',
    state,
    instructions: `${PI_LOGOUT_INSTRUCTIONS} (${read.layout.credentialPath})`,
  }
}

/** Classify every entry of an auth.json file. */
async function observeCredentials(host: AgentHost, credentialPath: string, now: number): Promise<CredentialObservation> {
  const stat = await host.stat(credentialPath)
  if (stat === undefined) return { credentials: [], malformed: 0, parsed: false }
  if (stat.isDirectory) {
    return { credentials: [], malformed: 0, parsed: false, error: 'auth.json is a directory, not a file' }
  }
  const text = await host.readHead(credentialPath, AUTH_FILE_MAX_BYTES)
  if (text.trim() === '') {
    // Absence is not an error: an agent with no stored credential is unauthenticated.
    if (stat.size > 0) return { credentials: [], malformed: 0, parsed: false, error: 'auth.json could not be read' }
    return { credentials: [], malformed: 0, parsed: false }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    return {
      credentials: [],
      malformed: 0,
      parsed: false,
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
  if (!isRecord(value)) {
    return { credentials: [], malformed: 0, parsed: false, error: 'auth.json does not hold a JSON object' }
  }

  const credentials: PiStoredCredential[] = []
  let malformed = 0
  for (const [provider, entry] of Object.entries(value)) {
    const credential = classifyCredential(provider, entry, now)
    if (credential === undefined) malformed += 1
    else credentials.push(credential)
  }
  return { credentials, malformed, parsed: true }
}

/** Classify one provider's stored credential, without reading it into a projection. */
function classifyCredential(provider: string, value: unknown, now: number): PiStoredCredential | undefined {
  if (!isRecord(value)) return undefined
  const type = readString(value, 'type')
  if (type === 'oauth') {
    const expires = readNumber(value, 'expires')
    const hasTokens = (readString(value, 'access') ?? '') !== '' || (readString(value, 'refresh') ?? '') !== ''
    if (!hasTokens && expires === undefined) return undefined
    return {
      provider,
      kind: 'oauth',
      usable: expires !== undefined && expires > now,
      ...(expires === undefined ? {} : { expiresMs: expires }),
    }
  }
  if (type === 'api_key') {
    const key = readString(value, 'key')
    // A `!command` key is resolved by pi at request time; the command text is never read
    // into a projection, and it is never executed by this adapter.
    if (key === undefined || key === '') return undefined
    return { provider, kind: key.startsWith('!') ? 'command' : 'api_key', usable: true }
  }
  return undefined
}

/** The latest expiry among a set of credentials, when any carries one. */
function expiriesOf(credentials: readonly PiStoredCredential[]): string | undefined {
  const expiries = credentials
    .map(credential => credential.expiresMs)
    .filter((value): value is number => value !== undefined)
  return expiries.length === 0 ? undefined : new Date(Math.max(...expiries)).toISOString()
}

/** Name the providers and kinds observed, e.g. `anthropic(oauth), openai(api_key)`. */
function methodLabel(credentials: readonly PiStoredCredential[]): string {
  const labels: string[] = []
  for (const credential of credentials) {
    const label = `${credential.provider}(${credential.kind})`
    labels.push(label)
  }
  return labels.join(', ')
}
