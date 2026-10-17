/**
 * Codex credential inspection and login/logout delegation.
 *
 * The adapter never becomes a credential store: status is derived by reading
 * `$CODEX_HOME/auth.json` and the relevant environment variables **without writing
 * anything**, and every mutation is delegated to `codex login` / `codex logout`. No value
 * from a token, key or header ever leaves this module — only its presence, kind and
 * metadata do, and the CLI's own output is passed through {@link redactText} seeded with
 * any secret this module was handed.
 * @module @deepseek-ai/dsh-agent-codex/auth
 */

import { join } from 'node:path'
import type { AgentAuthState, AgentAuthStatus, AgentLoginFlow, AgentAuthOperationResult } from '@deepseek-ai/dsh-agent-mesh'
import type { CodexHost, HostExit } from './types.ts'
import { asRecord, num, str } from './json.ts'
import { CODEX_CREDENTIAL_FILE, type CodexHome } from './sessions.ts'

/** Environment variables that can carry a Codex credential. */
export const CODEX_CREDENTIAL_ENV_KEYS: readonly string[] = ['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY']

/** Credential flows this adapter can drive through the native CLI. */
export const CODEX_LOGIN_FLOWS: readonly AgentLoginFlow[] = ['oauth-loopback', 'device-code', 'api-key']

/**
 * Environment variable names a run may receive from the ambient environment, sorted.
 *
 * `CODEX_HOME` and `CODEX_SQLITE_HOME` keep the child on the home this adapter inspected;
 * the credential variables are Codex's own, named so an environment-provided credential
 * reaches the agent exactly as {@link readCodexAuthState} reports it — the adapter never
 * copies a secret out of `auth.json` into a child's environment.
 */
export const RUN_INHERIT_ENV_KEYS: readonly string[] = [
  ...CODEX_CREDENTIAL_ENV_KEYS,
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
].sort()

/** Config file consulted only to learn which credential store Codex uses. */
const CODEX_CONFIG_FILE = 'config.toml'

/** Bytes read from `config.toml` while looking for the credential-store setting. */
const CONFIG_HEAD_BYTES = 256 * 1024

/** Byte cap on the credential file read. */
const AUTH_FILE_MAX_BYTES = 8 * 1024 * 1024

/** Bytes of CLI output kept in an auth operation result. */
const OUTPUT_TAIL_CHARS = 4 * 1024

/** A URL the user must open, as Codex's flows print it. */
const URL_PATTERN = /https?:\/\/[^\s"'`<>)\]}]+/

/** A device code, in either the dashed or the plain form Codex prints. */
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/

/** Native `auth_mode` values, mapped onto the method label reported to the UI. */
const AUTH_METHODS: Readonly<Record<string, string>> = {
  apikey: 'api-key',
  chatgpt: 'chatgpt-oauth',
  chatgptauthtokens: 'chatgpt-auth-tokens',
  headers: 'headers',
  agentidentity: 'agent-identity',
  personalaccesstoken: 'personal-access-token',
  bedrockapikey: 'bedrock-api-key',
  bedrockaccesskeys: 'bedrock-access-keys',
}

/** Credential-shaped substrings replaced in anything this module reports. */
const REDACTION_RULES: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /\b(sk|sk-ant|sk-proj|xai|gsk|pk|ghp|gho|ghs|glpat)[-_][A-Za-z0-9_-]{12,}\b/g, replacement: '<redacted:key>' },
  { pattern: /\bBearer\s+[-.\w~+/]{16,}=*/gi, replacement: 'Bearer <redacted:token>' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '<redacted:jwt>' },
  { pattern: /("(?:api_?key|access_?token|refresh_?token|password|secret|authorization)"\s*:\s*")[^"]{6,}(")/gi, replacement: '$1<redacted>$2' },
]

/** A classified credential file, before it is stamped with observation context. */
export interface CodexAuthClassification {
  /** Classified state. */
  readonly status: AgentAuthStatus
  /** Credential mechanism observed. */
  readonly method?: string
  /** Account identifier or email, when the id_token exposed one. */
  readonly account?: string
  /** Subscription plan label, when the id_token exposed one. */
  readonly plan?: string
  /** ISO 8601 expiry, when the id_token's `exp` claim supplied one. */
  readonly expiresAt?: string
  /** Human-readable explanation of the classification. */
  readonly detail?: string
}

/** Normalize a native token for comparison. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Decode a JWT payload segment without verifying it.
 *
 * The id_token's claims are the only place Codex records the ChatGPT account and plan;
 * they are read for display and never treated as proof of anything, which is why the
 * signature is deliberately not checked.
 *
 * @param token - A JWT as stored in `auth.json`.
 * @returns the claims object, or `undefined` when the token cannot be decoded.
 */
export function decodeIdTokenClaims(token: string): Record<string, unknown> | undefined {
  const segment = token.split('.')[1]
  if (segment === undefined || segment === '') return undefined
  try {
    const decoded = Buffer.from(segment, 'base64url').toString('utf8')
    return asRecord(JSON.parse(decoded))
  } catch {
    return undefined
  }
}

/**
 * Classify a parsed `auth.json`.
 *
 * An unparsable or structurally unusable file yields `misconfigured` with the reason,
 * never a fabricated "logged out". Absence of material is `unauthenticated`; a credential
 * this adapter cannot interpret is `unknown`.
 *
 * @param value - The parsed file content.
 * @returns the classification, with account and plan when the id_token exposed them.
 */
export function classifyAuthFile(value: unknown): CodexAuthClassification {
  const record = asRecord(value)
  if (record === undefined) {
    return { status: 'misconfigured', detail: 'auth.json is not a JSON object' }
  }
  const mode = str(record, 'auth_mode')
  const method = mode === undefined ? undefined : AUTH_METHODS[normalize(mode)]
  const tokens = asRecord(record['tokens'])
  const idToken = str(tokens, 'id_token')
  const accessToken = str(tokens, 'access_token')
  const claims = idToken === undefined ? undefined : decodeIdTokenClaims(idToken)
  const account = claims === undefined ? undefined : str(claims, 'email') ?? str(claims, 'chatgpt_user_id')
  const plan = claims === undefined ? undefined : str(claims, 'chatgpt_plan_type')
  const expirySeconds = claims === undefined ? undefined : num(claims, 'exp')
  const expiresAt = expirySeconds === undefined ? undefined : new Date(expirySeconds * 1000).toISOString()
  const accountFields = {
    ...(account === undefined ? {} : { account }),
    ...(plan === undefined ? {} : { plan }),
  }
  const expiryFields = expiresAt === undefined ? {} : { expiresAt }

  if (idToken !== undefined || accessToken !== undefined) {
    const expires = expirySeconds === undefined ? undefined : new Date(expirySeconds * 1000).getTime()
    const expired = expires !== undefined && expires <= Date.now()
    const decodeFailed = idToken !== undefined && claims === undefined
    const detail = decodeFailed
      ? 'the stored id_token could not be decoded, so the account and plan are unknown'
      : expired
        ? 'the stored ChatGPT token is past its expiry; codex refreshes it on next use'
        : idToken !== undefined && expiresAt === undefined
          ? 'the id_token carries no exp claim, so no expiry can be reported'
          : undefined
    return {
      status: expired ? 'expired' : 'authenticated',
      method: method ?? 'chatgpt-oauth',
      ...accountFields,
      ...expiryFields,
      ...(detail === undefined ? {} : { detail }),
    }
  }
  if (str(record, 'OPENAI_API_KEY') !== undefined) {
    return { status: 'authenticated', method: method ?? 'api-key', detail: 'an API key is stored in auth.json' }
  }
  if (str(record, 'personal_access_token') !== undefined) {
    return { status: 'authenticated', method: method ?? 'personal-access-token' }
  }
  if (record['agent_identity'] !== undefined) {
    return { status: 'authenticated', method: method ?? 'agent-identity' }
  }
  if (record['bedrock_api_key'] !== undefined || record['bedrock_access_keys'] !== undefined) {
    return {
      status: 'authenticated',
      method: method ?? 'bedrock-api-key',
      detail: 'Amazon Bedrock credentials are stored in auth.json',
    }
  }
  if (mode === undefined) {
    return { status: 'unauthenticated', detail: 'auth.json carries no auth_mode and no credential material' }
  }
  if (method === undefined) {
    return { status: 'unknown', method: mode, detail: `auth.json uses an unrecognized auth_mode "${mode}"` }
  }
  if (method === 'headers') {
    return { status: 'unknown', method, detail: 'auth_mode is "headers": credentials come from request headers this adapter does not read' }
  }
  return { status: 'unauthenticated', method, detail: `auth_mode is "${mode}" but no credential material is present` }
}

/** Everything an auth status read needs. */
export interface CodexAuthRead {
  /** Host providing the environment, the home directory and the read. */
  readonly host: CodexHost
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Environment to inspect; defaults to the host environment. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * Observe Codex's authentication state.
 *
 * The environment wins as a source: a credential variable is what a run would actually
 * use, and an env-provided credential is reported as first-class and explicitly
 * un-manageable. Absence of the file is only reported as `unauthenticated` after checking
 * whether Codex is configured to keep credentials in the OS keyring, in which case the
 * honest answer is `unknown`.
 *
 * @param read - Host, home layout and the environment to inspect.
 * @returns the observed state; never a secret.
 */
export async function readCodexAuthState(read: CodexAuthRead): Promise<AgentAuthState> {
  const env = read.env ?? read.host.env
  const environmentKeys = CODEX_CREDENTIAL_ENV_KEYS.filter(key => (env[key] ?? '') !== '')
  if (environmentKeys.length > 0) {
    return {
      status: 'authenticated',
      source: 'env',
      method: environmentKeys.includes('CODEX_ACCESS_TOKEN') ? 'access-token' : 'api-key',
      detail: `a credential is supplied through ${environmentKeys.join(', ')}, which takes precedence over the stored one; an environment credential cannot be logged out`,
    }
  }
  const text = await read.host.readHead(read.home.credentialFile, AUTH_FILE_MAX_BYTES)
  if (text.trim() === '') {
    const store = await readCredentialStoreMode(read.host, read.home)
    if (store === 'keyring') {
      return {
        status: 'unknown',
        source: 'keyring',
        method: 'keyring',
        detail:
          'Codex is configured with cli_auth_credentials_store = "keyring", which this adapter cannot read; runs may still be authenticated',
      }
    }
    return {
      status: 'unauthenticated',
      source: 'none',
      detail:
        store === undefined
          ? `${CODEX_CREDENTIAL_FILE} is absent from ${read.home.path}`
          : `${CODEX_CREDENTIAL_FILE} is absent and the configured credential store is "${store}"`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    return {
      status: 'misconfigured',
      source: 'file',
      detail: `${CODEX_CREDENTIAL_FILE} could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
  const classified = classifyAuthFile(parsed)
  const detail = authDetail(classified)
  return {
    status: classified.status,
    source: 'file',
    ...(classified.method === undefined ? {} : { method: classified.method }),
    ...(classified.expiresAt === undefined ? {} : { expiresAt: classified.expiresAt }),
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * Fold the classification's detail together with the account and plan the mesh state has
 * no field for.
 * @param classified - Classification of the credential file.
 * @returns the human-readable detail.
 */
function authDetail(classified: CodexAuthClassification): string | undefined {
  const identity = [
    classified.account === undefined ? undefined : `account ${classified.account}`,
    classified.plan === undefined ? undefined : `plan ${classified.plan}`,
  ].filter(part => part !== undefined)
  const parts = [...(classified.detail === undefined ? [] : [classified.detail]), ...identity]
  return parts.length === 0 ? undefined : parts.join('; ')
}

/**
 * Read the configured credential store from `config.toml`.
 * @param host - Host providing the read.
 * @param home - Resolved home layout.
 * @returns the raw setting value (`file`, `keyring`, `auto`, `ephemeral`), or `undefined`.
 */
export async function readCredentialStoreMode(host: CodexHost, home: CodexHome): Promise<string | undefined> {
  const head = await host.readHead(join(home.path, CODEX_CONFIG_FILE), CONFIG_HEAD_BYTES)
  const match = /^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"/m.exec(head)
  return match?.[1]
}

/** Everything a delegated login needs. */
export interface CodexLoginOptions {
  /** Host used to start the CLI process. */
  readonly host: CodexHost
  /** Resolved Codex binary. */
  readonly binary: string
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Requested flow and, for `api-key`, the secret to feed on stdin. */
  readonly params: { readonly flow: AgentLoginFlow; readonly secret?: string }
  /** Fresh status probe, run after the CLI exits. */
  readonly status: () => Promise<AgentAuthState>
  /** Working directory for the CLI process. */
  readonly cwd: string
  /** Environment entries layered over the derived set; always carries `CODEX_HOME`. */
  readonly env: Readonly<Record<string, string>>
  /** Wall-clock budget for the flow. */
  readonly timeoutMs: number
}

/**
 * Delegate a login to `codex login` and report the state that resulted.
 *
 * The secret for an `api-key` flow is passed on **stdin** and never in argv, and every
 * byte of the CLI's output is passed through a redactor seeded with that secret. A
 * non-zero exit is reported as `ok: false` with the output attached rather than thrown,
 * and a flow this adapter does not implement is explained rather than rejected.
 *
 * @param options - Binary, home, requested flow, and the environment to run in.
 * @returns the intent plus the freshly observed state.
 */
export async function codexLogin(options: CodexLoginOptions): Promise<AgentAuthOperationResult> {
  const flow = options.params.flow
  if (!CODEX_LOGIN_FLOWS.includes(flow)) {
    return {
      ok: false,
      action: 'login',
      state: await options.status(),
      instructions: `codex cannot log in with the "${flow}" flow. Supported flows: ${CODEX_LOGIN_FLOWS.join(', ')}. Run \`codex login\` yourself for anything else.`,
    }
  }
  if (flow === 'api-key' && (options.params.secret === undefined || options.params.secret === '')) {
    return {
      ok: false,
      action: 'login',
      state: await options.status(),
      instructions: 'provide the API key in the request; this adapter passes it to `codex login --with-api-key` on stdin.',
    }
  }
  const args = loginArgs(flow)
  const stdin = flow === 'api-key' ? options.params.secret : undefined
  options.host.log('info', `delegating codex login (${flow})`)
  const { text, exit } = await runCli(options.host, {
    command: options.binary,
    args,
    cwd: options.cwd,
    env: options.env,
    ...(stdin === undefined ? {} : { stdin }),
    timeoutMs: options.timeoutMs,
  })
  const output = redactText(text, options.params.secret === undefined ? [] : [options.params.secret])
  const instructions = loginInstructions(flow, output)
  const after = await options.status()
  options.host.log('info', `codex login finished (${flow}, exit ${exit.code === null ? 'signal' : String(exit.code)})`)
  return {
    ok: exit.code === 0,
    action: 'login',
    state: after,
    instructions,
    ...(output.trim() === '' ? {} : { output: tailChars(output, OUTPUT_TAIL_CHARS) }),
  }
}

/** Everything a delegated logout needs. */
export interface CodexLogoutOptions {
  /** Host used to start the CLI process. */
  readonly host: CodexHost
  /** Resolved Codex binary. */
  readonly binary: string
  /** Resolved home layout. */
  readonly home: CodexHome
  /** Fresh status probe, run after the CLI exits. */
  readonly status: () => Promise<AgentAuthState>
  /** Working directory for the CLI process. */
  readonly cwd: string
  /** Environment entries layered over the derived set; always carries `CODEX_HOME`. */
  readonly env: Readonly<Record<string, string>>
  /** Wall-clock budget for the logout. */
  readonly timeoutMs: number
}

/**
 * Delegate a logout to `codex logout` and report the state that resulted.
 * @param options - Binary, home and the environment to run in.
 * @returns the intent plus the freshly observed state; a non-zero exit is reported, not
 *   thrown, so the caller can show what Codex said.
 */
export async function codexLogout(options: CodexLogoutOptions): Promise<AgentAuthOperationResult> {
  options.host.log('info', 'delegating codex logout')
  const { text, exit } = await runCli(options.host, {
    command: options.binary,
    args: ['logout'],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  })
  const output = redactText(text, [])
  const state = await options.status()
  return {
    ok: exit.code === 0,
    action: 'logout',
    state,
    ...(output.trim() === '' ? {} : { output: tailChars(output, OUTPUT_TAIL_CHARS) }),
  }
}

/** Run one CLI process to completion, collecting all of its output. */
async function runCli(
  host: CodexHost,
  spec: {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly stdin?: string
    readonly timeoutMs: number
  },
): Promise<{ readonly text: string; readonly exit: HostExit }> {
  const process = host.spawn({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
    timeoutMs: spec.timeoutMs,
  })
  const lines: string[] = []
  try {
    for await (const line of process.lines) lines.push(line)
  } catch (cause) {
    host.log('warn', `codex cli output ended abnormally: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  let stderrText = ''
  try {
    stderrText = await process.stderr()
  } catch (cause) {
    host.log('warn', `codex cli stderr could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const exit = await process.exit
  return { text: `${lines.join('\n')}\n${stderrText}`, exit }
}

/** Native argv for a credential flow. */
function loginArgs(flow: AgentLoginFlow): readonly string[] {
  switch (flow) {
    case 'device-code':
      return ['login', '--device-auth']
    case 'api-key':
      return ['login', '--with-api-key']
    default:
      return ['login']
  }
}

/**
 * Describe the human step a login flow needs, parsed out of the CLI's own output.
 *
 * The subprocess is held open until it exits and one result is returned, so the
 * instruction is reported after the flow completes rather than as it streams; a URL or a
 * device code Codex printed is still what the user needs.
 *
 * @param flow - The flow that ran.
 * @param output - Redacted CLI output.
 * @returns the instruction to surface.
 */
function loginInstructions(flow: AgentLoginFlow, output: string): string {
  if (flow === 'api-key') {
    return 'the API key was passed to `codex login --with-api-key` on stdin and is now stored by Codex.'
  }
  // Codex prints its local listener before the URL a human must open, so the last URL in
  // the output is the actionable one.
  const url = lastUrl(output)
  if (flow === 'device-code') {
    const code = deviceCode(output)
    if (url === undefined) return 'Codex is waiting for a device login; complete it in a browser, then re-check the status here.'
    return `open ${url}${code === undefined ? '' : ` and enter the code ${code}`} to finish the login.`
  }
  if (url === undefined) return 'Codex opened a browser window (or printed an authorization URL) to finish the login.'
  return `finish the login at ${url}; codex completes it through its loopback listener.`
}

/** The last URL in output, which is the one a human must act on. */
function lastUrl(output: string): string | undefined {
  const matches = [...output.matchAll(new RegExp(URL_PATTERN.source, 'g'))]
  return matches.at(-1)?.[0]
}

/** A device code printed by Codex, preferring a line that names it as one. */
function deviceCode(output: string): string | undefined {
  for (const line of output.split('\n')) {
    if (!/code/i.test(line)) continue
    const match = DEVICE_CODE_PATTERN.exec(line)
    if (match !== null) return match[0]
  }
  return DEVICE_CODE_PATTERN.exec(output)?.[0]
}

/**
 * Replace credential-shaped substrings in text this module is about to report.
 * @param text - Text that may carry a credential.
 * @param literals - Concrete secrets known to this call.
 * @returns the text with every match replaced.
 */
export function redactText(text: string, literals: readonly string[] = []): string {
  let out = text
  for (const literal of literals) {
    if (literal.trim().length >= 6) out = out.split(literal).join('<redacted:provided>')
  }
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, rule.replacement)
  }
  return out
}

/** The last `count` characters of a string. */
function tailChars(text: string, count: number): string {
  return text.length <= count ? text : `…${text.slice(text.length - count)}`
}
