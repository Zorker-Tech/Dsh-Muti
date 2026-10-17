/**
 * The native OpenAI Codex integration for the agent mesh.
 *
 * One implementation of the mesh's {@link AgentAdapter} for Codex: `describe()` detects the
 * binary and `$CODEX_HOME` and caches the descriptor; `listSessions`, `readTranscript` and
 * `readNativeTasks` read Codex's own rollout store in place; `readAuthState`, `login` and
 * `logout` inspect `auth.json` read-only and delegate every mutation to the CLI; and
 * `startRun` drives `codex exec --json` as a managed process whose stream is projected onto
 * the mesh run union. Reading never spawns Codex; only detection (a `--version` probe) and
 * run dispatch start a process.
 *
 * The adapter is a pure function of {@link CodexHost}; `apply` is the only place that
 * reaches the Cordis context, and it builds the host with the mesh's own
 * `createContextHost`.
 * @module @deepseek-ai/dsh-agent-codex
 */

import { createContextHost } from '@deepseek-ai/dsh-agent-mesh'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { NativeProviderLlmAdapter, nativeProviderAuth, nativeProviderImages } from '@deepseek-ai/dsh-llm-pi-ai'
import type {
  AgentAdapter,
  AgentAuthOperationResult,
  AgentAuthState,
  AgentCapabilityInventory,
  AgentCapabilityReadRequest,
  AgentMcpServerConfig,
  AgentMcpServerResolveRequest,
  AgentCapabilities,
  AgentDescriptor,
  AgentId,
  AgentLoginRequest,
  AgentModel,
  AgentNativeTasks,
  AgentNativeTasksRequest,
  AgentRun,
  AgentRunRequest,
  AgentSession,
  AgentSessionListOptions,
  AgentTransport,
  AgentTranscript,
  AgentTranscriptRequest,
} from '@deepseek-ai/dsh-agent-mesh'
import { RUN_INHERIT_ENV_KEYS, codexLogin, codexLogout, readCodexAuthState } from './auth.ts'
import { resolveCodexConfig, type CodexAdapterConfig, type ResolvedCodexConfig } from './config.ts'
import { CODEX_APPROVAL_MODES, CODEX_SANDBOX_PROFILES, detectionFrom, expandUserPath, probeVersion, resolveBinary } from './detect.ts'
import type { CodexHost } from './types.ts'
import { readCodexModels } from './models.ts'
import { readCodexLlmRoutes } from './llm-models.ts'
import { readCodexCapabilities, resolveCodexMcpServer } from './capabilities.ts'
import { mintRunId, runEnvironment, startCodexRun } from './run.ts'
import { startCodexAppServerRun } from './app-server-run.ts'
import { listCodexSessions, resolveCodexHome } from './sessions.ts'
import type { CodexHome } from './sessions.ts'
import { readCodexNativeTasks } from './tasks.ts'
import { readCodexTranscript } from './transcript.ts'

export { CODEX_APPROVAL_MODES, CODEX_SANDBOX_PROFILES, expandUserPath, probeVersion, resolveBinary } from './detect.ts'
export { RUN_INHERIT_ENV_KEYS, classifyAuthFile, decodeIdTokenClaims, readCodexAuthState, redactText } from './auth.ts'
export { DEFAULT_INTERRUPT_GRACE_MS, DEFAULT_RUN_MODE, resolveCodexConfig } from './config.ts'
export type { CodexAdapterConfig, ResolvedCodexConfig } from './config.ts'
export type { CodexHost } from './types.ts'
export { scanConfig } from './models.ts'
export { readCodexLlmRoutes } from './llm-models.ts'
export { buildExecArgs, classifyExecOutcome, mintRunId, startCodexRun, usageFromNative } from './run.ts'
export { isRolloutFileName, parseRolloutHead, renderSessionSource, resolveCodexHome, sessionKey, threadIdFromFileName } from './sessions.ts'
export { codexTodoId, hashText } from './tasks.ts'
export { projectRolloutLine } from './transcript.ts'

/** Canonical agent id in the mesh registry. */
export const CODEX_ID = 'codex'

/** Human-facing name. */
export const CODEX_DISPLAY_NAME = 'Codex'

/** Both native Codex run transports are available; duplex app-server is the default. */
export const CODEX_TRANSPORTS: readonly AgentTransport[] = [
  { mode: 'headless-exec', mechanism: 'codex exec --json', available: true },
  { mode: 'duplex-protocol', mechanism: 'codex app-server --stdio', available: true },
]

/**
 * Create the Codex adapter over a host.
 *
 * @param host - Host providing files, processes, environment and time.
 * @param config - Caller configuration; every field is optional and defaulted explicitly.
 * @returns the adapter; the mesh registry, not the caller, owns its lifetime.
 */
export function codexAdapter(host: CodexHost, config: CodexAdapterConfig = {}): AgentAdapter {
  return new CodexAdapter(host, resolveCodexConfig(config))
}

/** The mesh adapter implementation; instances are stateless apart from the resolved caches. */
class CodexAdapter implements AgentAdapter {
  readonly id: AgentId = brandString<AgentId>(CODEX_ID)

  private readonly host: CodexHost

  private readonly config: ResolvedCodexConfig

  private descriptor: Promise<AgentDescriptor> | undefined

  private homeLayout: Promise<CodexHome> | undefined

  private runSequence = 0

  /**
   * @param host - Host providing files, processes, environment and time.
   * @param config - Fully resolved configuration.
   */
  constructor(host: CodexHost, config: ResolvedCodexConfig) {
    this.host = host
    this.config = config
  }

  /** Declared capabilities; never depends on detection. */
  capabilities(): AgentCapabilities {
    return {
      runModes: [this.config.runMode],
      streaming: true,
      resume: true,
      interrupt: this.config.runMode === 'duplex-protocol',
      listSessions: true,
      readTranscript: true,
      nativeTodos: true,
      nativePlan: true,
      listModels: true,
      sandboxProfiles: CODEX_SANDBOX_PROFILES,
      approvalModes: CODEX_APPROVAL_MODES,
      credentials: { status: true, login: ['oauth-loopback', 'device-code', 'api-key'], logout: true },
    }
  }

  /** Describe this agent on this machine, with detection resolved once and cached. */
  async describe(): Promise<AgentDescriptor> {
    const pending = this.descriptor ?? this.buildDescriptor()
    this.descriptor = pending
    try {
      return await pending
    } catch (cause) {
      // A detection failure must not be cached as a permanent verdict: the user may
      // install the binary and ask again without restarting.
      this.descriptor = undefined
      throw cause
    }
  }

  /** Observe authentication state without writing anything. */
  async readAuthState(): Promise<AgentAuthState> {
    return readCodexAuthState({ host: this.host, home: await this.resolveHome() })
  }

  /** Enumerate Codex sessions, active first and archived as well. */
  async listSessions(options: AgentSessionListOptions): Promise<readonly AgentSession[]> {
    return listCodexSessions({
      host: this.host,
      agentId: this.id,
      home: await this.resolveHome(),
      options,
    })
  }

  /** Return the Codex TUI argv for a person to paste into a terminal. */
  async nativeLaunchCommand(nativeId: string): Promise<readonly string[]> {
    const descriptor = await this.describe()
    return [descriptor.detection.binaryPath ?? 'codex', 'resume', nativeId]
  }

  /** Read a bounded window from the tail of a session's rollout. */
  async readTranscript(request: AgentTranscriptRequest): Promise<AgentTranscript> {
    return readCodexTranscript({
      host: this.host,
      home: await this.resolveHome(),
      agentId: this.id,
      nativeId: request.session.nativeId,
      defaultTailBytes: this.config.transcriptTailBytes,
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    })
  }

  /** Read Codex's own checklist and plan state, when the session recorded either. */
  async readNativeTasks(request: AgentNativeTasksRequest): Promise<AgentNativeTasks> {
    return readCodexNativeTasks({
      host: this.host,
      home: await this.resolveHome(),
      agentId: this.id,
      nativeId: request.session.nativeId,
      tailBytes: this.config.taskTailBytes,
    })
  }

  /**
   * Read the model ids Codex's own configuration names.
   *
   * The mesh model row carries no provenance, so only the user configuration layer is
   * read; see `models.ts` for why the reference adapter's layer merge is not reproduced.
   */
  async listModels(): Promise<readonly AgentModel[]> {
    return readCodexModels(this.host, await this.resolveHome())
  }

  /** Read Codex's declared capabilities from its config and instruction directories. */
  async readCapabilities(request: AgentCapabilityReadRequest): Promise<AgentCapabilityInventory> {
    return await readCodexCapabilities(this.host, this.id, await this.resolveHome(), request)
  }

  /** Resolve a native server without starting it; DSH owns approval and activation. */
  async resolveMcpServer(request: AgentMcpServerResolveRequest): Promise<AgentMcpServerConfig | undefined> {
    return await resolveCodexMcpServer(this.host, await this.resolveHome(), request)
  }

  /** Start a credential flow through `codex login`. */
  async login(request: AgentLoginRequest): Promise<AgentAuthOperationResult> {
    const descriptor = await this.describe()
    const home = await this.resolveHome()
    const binary = descriptor.detection.binaryPath
    if (binary === undefined) {
      return {
        ok: false,
        action: 'login',
        state: await this.readAuthState(),
        instructions: "install Codex, or set its binary path in this adapter's configuration, then run `codex login` by hand.",
      }
    }
    return codexLogin({
      host: this.host,
      binary,
      home,
      params: { flow: request.flow, ...(request.secret === undefined ? {} : { secret: request.secret }) },
      status: async () => await this.readAuthState(),
      cwd: await this.cliCwd(home),
      env: runEnvironment(this.host, this.config.env, undefined, home.path),
      timeoutMs: this.config.loginTimeoutMs,
    })
  }

  /** Revoke credentials through `codex logout`. */
  async logout(): Promise<AgentAuthOperationResult> {
    const descriptor = await this.describe()
    const home = await this.resolveHome()
    const binary = descriptor.detection.binaryPath
    if (binary === undefined) {
      return {
        ok: false,
        action: 'logout',
        state: await this.readAuthState(),
        instructions: "install Codex, or set its binary path in this adapter's configuration, then run `codex logout` by hand.",
      }
    }
    return codexLogout({
      host: this.host,
      binary,
      home,
      status: async () => await this.readAuthState(),
      cwd: await this.cliCwd(home),
      env: runEnvironment(this.host, this.config.env, undefined, home.path),
      timeoutMs: this.config.logoutTimeoutMs,
    })
  }

  /**
   * Dispatch `codex exec --json` for one run.
   * @param request - What the caller asked to run.
   * @returns the live run handle; a failure to resolve the binary, validate a policy value,
   *   start the process or read its stream settles `result` as a classified failure rather
   *   than rejecting it.
   */
  startRun(request: AgentRunRequest): AgentRun {
    this.runSequence += 1
    const runContext = {
      host: this.host,
      config: this.config,
      agentId: this.id,
      runId: mintRunId(this.host, this.runSequence),
      resolve: async () => {
        const descriptor = await this.describe()
        return { binary: descriptor.detection.binaryPath, home: await this.resolveHome() }
      },
    }
    return this.config.runMode === 'headless-exec'
      ? startCodexRun(runContext, request)
      : startCodexAppServerRun(runContext, request)
  }

  /** Resolve the descriptor, and therefore detection, once. */
  private async buildDescriptor(): Promise<AgentDescriptor> {
    const candidates =
      this.config.binaryPath === undefined ? {} : { candidates: [expandUserPath(this.host, this.config.binaryPath)] }
    const resolution = await resolveBinary(this.host, candidates)
    const home = await this.resolveHome()
    const version =
      resolution.path === undefined
        ? undefined
        : await probeVersion(this.host, resolution.path, {
          cwd: this.host.home,
          timeoutMs: this.config.versionProbeTimeoutMs,
        })
    return {
      id: this.id,
      displayName: CODEX_DISPLAY_NAME,
      summary:
        'OpenAI Codex CLI: append-only rollout sessions under $CODEX_HOME, native app-server turns or the JSON exec stream, and ChatGPT or API-key credentials.',
      capabilities: this.capabilities(),
      detection: detectionFrom(resolution, version === undefined ? {} : { version }),
      transports: CODEX_TRANSPORTS,
      sessionRoot: home.sessionsRoot,
      credentialPath: home.credentialFile,
      environmentKeys: RUN_INHERIT_ENV_KEYS,
    }
  }

  /** Resolve the home layout once. */
  private async resolveHome(): Promise<CodexHome> {
    this.homeLayout ??= this.buildHome()
    return this.homeLayout
  }

  /** Resolve the home layout, warning when a configured `CODEX_HOME` was unusable. */
  private async buildHome(): Promise<CodexHome> {
    const home = await resolveCodexHome(this.host, this.config.homeDir)
    if (home.fallbackReason !== undefined) this.host.log('warn', home.fallbackReason)
    return home
  }

  /** A working directory that exists, for spawning the CLI. */
  private async cliCwd(home: CodexHome): Promise<string> {
    return (await this.host.stat(home.path))?.isDirectory === true ? home.path : this.host.home
  }
}

/** Cordis plugin name. */
export const name = 'agent-codex'

/** The mesh registry, LLM service, filesystem and subprocess services must be present. */
export const inject = ['agentMesh', 'llm', 'fs', 'subprocess']

/**
 * Mount the Codex adapter on the mesh registry.
 *
 * The host is the mesh's own `createContextHost`, so file reads go through the profile's
 * filesystem policy and children through the subprocess seam's scrubbed environment and
 * managed process range. Registration is an effect: unmounting this plugin removes the
 * adapter.
 *
 * Note: the loader resolves a plugin as `module.default ?? module`, so this module
 * exports no default at all — the named `name`/`inject`/`apply` exports are what a
 * profile row loads, and {@link codexAdapter} is the programmatic factory.
 *
 * @param ctx - Owning context.
 * @param config - Adapter configuration.
 */
export function apply(ctx: Context, config: CodexAdapterConfig = {}): void {
  const host = createContextHost(ctx)
  const adapter = codexAdapter(host, config)
  ctx.effect(() => ctx.agentMesh.register(adapter), 'agent-codex.register')
  const llmAdapter = new NativeProviderLlmAdapter({
    provider: 'agent-codex',
    displayName: 'Codex',
    routes: async () => readCodexLlmRoutes(host, await resolveCodexHome(host, config.homeDir)),
    auth: nativeProviderAuth(ctx, host.env),
    ...nativeProviderImages(ctx),
  })
  ctx.effect(() => ctx.llm.registerAdapter(['agent-codex'], llmAdapter), 'agent-codex.llm-register')
}
