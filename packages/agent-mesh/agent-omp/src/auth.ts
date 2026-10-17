/**
 * OMP credential inspection and the delegated credential operations.
 *
 * OMP keeps credentials in the SQLite database `<agent-dir>/agent.db`, table
 * `auth_credentials(provider, credential_type, data, disabled_cause, identity_key,
 * created_at, updated_at)`. This adapter has no SQLite driver and does not scan the file's
 * bytes, so the store contributes exactly one fact: whether the file exists. A provider
 * key can also come from the host environment, which is a fact this adapter can check, so
 * the environment is consulted first and the existence of `agent.db` is reported as
 * `unknown` rather than guessed at (see the package README).
 *
 * `omp login [provider]` is a real subcommand (the terminal counterpart of `/login`): an
 * interactive OAuth flow over stdin with no provider, secret or non-interactive flag.
 * Login therefore delegates to it, bounded, and reports the CLI's own outcome plus the
 * guidance a human needs; an `api-key` flow has no CLI counterpart at all. There is no
 * `omp logout` subcommand — logout exists as the TUI `/logout`, the RPC `logout` command,
 * and `omp auth-broker logout` for a broker-backed vault — so the adapter declares
 * `logout: false` and returns guidance instead of running a command that does not exist.
 * `omp token <provider>` and `omp auth export` print secret material and are deliberately
 * never called.
 * @module @deepseek-ai/dsh-agent-omp/auth
 */

import type {
  AgentAuthOperationResult,
  AgentAuthState,
  AgentHost,
  AgentLoginFlow,
  AgentLoginRequest,
} from '@deepseek-ai/dsh-agent-mesh'
import type { OmpStoreLayout } from './sessions.ts'

/**
 * Credential-shaped environment variables OMP resolves a provider key from, taken from
 * the bundled catalog's per-provider `env` declarations. Names only; values are never
 * read into a projection.
 *
 * The bundled catalog declares more providers than this list, and a `models.yml` provider
 * may name its own variable in `apiKey`, which is always the authoritative per-machine
 * answer; this list is the common subset used to answer "is any provider key set at all"
 * and to recognize the ambient variable of a well-known provider id.
 *
 * Ambient sources OMP also supports (AWS IAM profiles and bearer tokens, Google
 * Application Default Credentials, the Foundry switch) are deliberately absent: they
 * cannot be classified by the presence of one variable.
 */
export const OMP_PROVIDER_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_CODEX_OAUTH_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'NVIDIA_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPINFRA_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'XAI_API_KEY',
  'XAI_OAUTH_TOKEN',
  'TYPESAFE_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'VERCEL_AI_GATEWAY_API_KEY',
  'ZAI_API_KEY',
  'ZHIPU_API_KEY',
  'MISTRAL_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'MINIMAX_CODE_API_KEY',
  'MINIMAX_CODE_CN_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'KIMI_CODE_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_HUB_TOKEN',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'BASETEN_API_KEY',
  'OPENCODE_API_KEY',
  'MODEL_API_KEY',
  'META_API_KEY',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_AI_GATEWAY_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'QWEN_OAUTH_TOKEN',
  'QWEN_PORTAL_API_KEY',
  'ALIBABA_CODING_PLAN_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'OLLAMA_API_KEY',
  'OLLAMA_CLOUD_API_KEY',
  'LM_STUDIO_API_KEY',
  'VLLM_API_KEY',
  'LITELLM_API_KEY',
  'NANO_GPT_API_KEY',
  'NOVITA_API_KEY',
  'SILICONFLOW_API_KEY',
  'SAMBANOVA_API_KEY',
  'STEPFUN_API_KEY',
  'QIANFAN_API_KEY',
  'SNOWFLAKE_PAT',
  'CURSOR_API_KEY',
  'CURSOR_ACCESS_TOKEN',
  'GITLAB_TOKEN',
  'CHARM_HYPER_API_KEY',
  'CLINE_API_KEY',
  'CORAL_API_KEY',
  'FIREPASS_API_KEY',
  'HELMCODE_API_KEY',
  'KILO_API_KEY',
  'SAKANA_API_KEY',
  'SYNTHETIC_API_KEY',
  'UMANS_AI_CODING_PLAN_API_KEY',
  'VENICE_API_KEY',
  'WAFER_SERVERLESS_API_KEY',
  'YOLO_AUTO_API_KEY',
  'ZENMUX_API_KEY',
  // Amazon Bedrock's own credential sources.
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
]

/** Guidance shown when a credential operation has no non-interactive path. */
export const OMP_LOGIN_INSTRUCTIONS =
  'OMP logs in through the OAuth providers its CLI knows: run `omp login [provider]` in a terminal ' +
  '(or `/login` inside omp), or declare a provider API key in models.yml and export the variable it names.'

/** Guidance shown for logout, which has no CLI subcommand. */
export const OMP_LOGOUT_INSTRUCTIONS =
  'OMP has no `omp logout` subcommand; run `/logout` inside omp, or for a broker-backed vault ' +
  '`omp auth-broker logout <provider>`. The stored credential rows live in <agent-dir>/agent.db.'

/** Wall-clock budget for the delegated `omp login`, matching the interactive flow's bound. */
export const OMP_LOGIN_TIMEOUT_MS = 30_000

/** Bytes of CLI output kept in an auth operation result. */
const OUTPUT_TAIL_CHARS = 2_000

/** Everything an auth status read needs. */
export interface OmpAuthRead {
  /** Host providing the environment, the home directory and the filesystem. */
  readonly host: AgentHost
  /** Resolved store layout. */
  readonly layout: OmpStoreLayout
  /** Environment to inspect; defaults to the host environment. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * Observe OMP's authentication state without reading a secret.
 *
 * The environment is consulted before the store because it is the only source this
 * adapter can interpret: a provider key variable is a fact, while `agent.db` is a SQLite
 * database whose rows this adapter cannot read, so the store itself yields `unknown`
 * (it exists) or `unauthenticated` (it does not).
 *
 * @param read - Host, layout and the environment to inspect.
 * @returns the observed state; never a secret.
 */
export async function readOmpAuthState(read: OmpAuthRead): Promise<AgentAuthState> {
  const env = read.env ?? read.host.env
  const environmentKey = OMP_PROVIDER_ENV_VARS.find((name) => {
    const value = env[name]
    return value !== undefined && value !== ''
  })
  if (environmentKey !== undefined) {
    return {
      status: 'authenticated',
      source: 'env',
      method: `api-key(${environmentKey})`,
      detail:
        'the key comes from the host environment, which this adapter cannot log out; a run receives ' +
        'it only when the harness forwards the variable to the child process',
    }
  }
  const store = await read.host.stat(read.layout.credentialPath)
  if (store !== undefined) {
    return {
      status: 'unknown',
      source: 'file',
      detail: 'the credential store is a SQLite database, which this adapter does not read',
    }
  }
  return { status: 'unauthenticated', source: 'none' }
}

/** Everything a delegated login needs. */
export interface OmpLoginOptions {
  /** Host used to start the CLI process. */
  readonly host: AgentHost
  /** Resolved `omp` executable, or the bare name for `PATH` resolution. */
  readonly binary: string
  /** Resolved store layout; the agent directory is the login's working directory. */
  readonly layout: OmpStoreLayout
  /** Requested flow; only `interactive` has a CLI counterpart. */
  readonly params: AgentLoginRequest
  /** Fresh status probe, run after the CLI exits. */
  readonly status: () => Promise<AgentAuthState>
  /** Working directory for the CLI process. */
  readonly cwd: string
  /** Environment entries layered over the host's scrubbed parent environment. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Wall-clock budget for the flow. */
  readonly timeoutMs: number
}

/**
 * Begin a login flow by delegating to `omp login`.
 *
 * The delegated process is `omp login` with no provider: OMP's own picker resolves one,
 * and the mesh login request carries no provider to pass. The flow is interactive over
 * stdin, so a managed run cannot answer it — the terminal outcome is reported verbatim,
 * and the guidance names the command a human should run instead. A flow other than
 * `interactive` is refused with guidance because OMP's CLI has no other login.
 *
 * @param options - Binary, layout, requested flow and the environment to run in.
 * @returns the CLI outcome (or the refusal) plus the freshly observed state.
 */
export async function ompLogin(options: OmpLoginOptions): Promise<AgentAuthOperationResult> {
  const flow: AgentLoginFlow = options.params.flow
  const state = await options.status()
  if (flow !== 'interactive') {
    return {
      ok: false,
      action: 'login',
      state,
      instructions: `OMP has no \`${flow}\` login; ${OMP_LOGIN_INSTRUCTIONS}`,
    }
  }
  options.host.log('info', 'delegating omp login')
  const { text, exit } = await runCli(options.host, {
    command: options.binary,
    args: ['login'],
    cwd: options.cwd,
    env: options.env,
    stdin: '',
    timeoutMs: options.timeoutMs,
  })
  // OMP's login prompts are written to the terminal, so its captured output is stderr.
  const output = text.trim()
  const ok = exit.code === 0
  return {
    ok,
    action: 'login',
    state: await options.status(),
    instructions: ok
      ? OMP_LOGIN_INSTRUCTIONS
      : `\`omp login\` needs a terminal to complete its OAuth flow (it reads prompts from stdin). ${OMP_LOGIN_INSTRUCTIONS}`,
    ...(output === '' ? {} : { output: tailChars(output, OUTPUT_TAIL_CHARS) }),
  }
}

/** Everything a reported logout needs. */
export interface OmpLogoutOptions {
  /** Resolved store layout, for the path the guidance names. */
  readonly layout: OmpStoreLayout
  /** Fresh status probe, so the result carries the observed state. */
  readonly status: () => Promise<AgentAuthState>
}

/**
 * Report that OMP has no logout subcommand.
 *
 * The CLI registers `login`, `auth export/import` and `auth-broker`, but no `logout`;
 * revocation is the TUI `/logout`, the RPC `logout` command, or `omp auth-broker logout`
 * for a broker-backed vault. This adapter never drives a TUI, so it reports the supported
 * paths instead of running a command that does not exist.
 *
 * @param options - Resolved layout and a fresh status probe.
 * @returns an unsuccessful result carrying the guidance and the observed state.
 */
export async function ompLogout(options: OmpLogoutOptions): Promise<AgentAuthOperationResult> {
  return {
    ok: false,
    action: 'logout',
    state: await options.status(),
    instructions: `${OMP_LOGOUT_INSTRUCTIONS} (${options.layout.credentialPath})`,
  }
}

/** Run one CLI process to completion, collecting its output. */
async function runCli(
  host: AgentHost,
  spec: {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly stdin: string
    readonly timeoutMs: number
  },
): Promise<{ readonly text: string; readonly exit: Awaited<ReturnType<AgentHost['spawn']>['exit']> }> {
  const process = host.spawn({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    stdin: spec.stdin,
    timeoutMs: spec.timeoutMs,
  })
  const lines: string[] = []
  try {
    for await (const line of process.lines) lines.push(line)
  } catch (cause) {
    host.log('warn', `omp cli output ended abnormally: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  let stderrText = ''
  try {
    stderrText = await process.stderr()
  } catch (cause) {
    host.log('warn', `omp cli stderr could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const exit = await process.exit
  return { text: `${lines.join('\n')}\n${stderrText}`, exit }
}

/** The last `count` characters of a string. */
function tailChars(text: string, count: number): string {
  return text.length <= count ? text : text.slice(text.length - count)
}
