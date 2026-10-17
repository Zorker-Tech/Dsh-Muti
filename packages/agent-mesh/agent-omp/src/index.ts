/**
 * The native oh-my-pi (`omp`) integration for the agent mesh.
 *
 * One implementation of the mesh's `AgentAdapter` for OMP: `describe()` detects the
 * binary and resolves the store layout and caches the descriptor; `listSessions`,
 * `readTranscript` and `readNativeTasks` read OMP's own session files in place;
 * `readAuthState`, `login` and `logout` inspect the credential surface read-only and
 * delegate every mutation to `omp login`; and `startRun` drives `omp --mode rpc-ui` as a
 * managed duplex process whose stream is projected onto the mesh run union. Reading never
 * spawns OMP; only detection (a `--version` probe), credential operations and run
 * dispatch start a process. The adapter never writes an agent's files.
 *
 * The adapter is a pure function of the mesh's `AgentHost` port; `apply` is the only
 * place that reaches the Cordis context, and it builds the host with the mesh's own
 * `createContextHost`.
 * @module @deepseek-ai/dsh-agent-omp
 */

import { createContextHost } from '@deepseek-ai/dsh-agent-mesh'
import type {
  AgentAdapter,
  AgentAuthOperationResult,
  AgentAuthState,
  AgentCapabilityInventory,
  AgentCapabilityReadRequest,
  AgentCapabilities,
  AgentDescriptor,
  AgentHost,
  AgentId,
  AgentLoginRequest,
  AgentMcpServerConfig,
  AgentMcpServerResolveRequest,
  AgentModel,
  AgentNativeTasks,
  AgentNativeTasksRequest,
  AgentRun,
  AgentRunRequest,
  AgentSession,
  AgentSessionListOptions,
  AgentTranscript,
  AgentTranscriptRequest,
  AgentTransport,
} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { NativeProviderLlmAdapter, nativeProviderAuth, nativeProviderImages } from '@deepseek-ai/dsh-llm-pi-ai'
import { OMP_LOGIN_TIMEOUT_MS, ompLogin, ompLogout, readOmpAuthState } from './auth.ts'
import { resolveOmpConfig, type OmpAdapterConfig, type ResolvedOmpConfig } from './config.ts'
import {
  OMP_APPROVAL_MODES,
  OMP_BINARY_NAME,
  OMP_VERSION_PROBE_TIMEOUT_MS,
  detectionFrom,
  expandUserPath,
  probeVersion,
  resolveBinary,
} from './detect.ts'
import { mintRunId, runEnvironment } from './run.ts'
import { startOmpRpcRun } from './rpc-run.ts'
import { listOmpSessions, resolveOmpStore, type OmpStoreLayout } from './sessions.ts'
import { readOmpNativeTasks } from './tasks.ts'
import { readOmpTranscript } from './transcript.ts'
import { readOmpLlmRoutes } from './llm-models.ts'
import { readOmpCapabilities, resolveOmpMcpServer } from './capabilities.ts'

export { readOmpLlmRoutes } from './llm-models.ts'

export { OMP_LOGIN_INSTRUCTIONS, OMP_LOGIN_TIMEOUT_MS, OMP_LOGOUT_INSTRUCTIONS, OMP_PROVIDER_ENV_VARS, ompLogin, ompLogout, readOmpAuthState } from './auth.ts'
export { resolveOmpConfig } from './config.ts'
export type { OmpAdapterConfig, ResolvedOmpConfig } from './config.ts'
export { OMP_APPROVAL_MODES, OMP_BINARY_NAME, OMP_VERSION_PROBE_TIMEOUT_MS, detectionFrom, expandUserPath, probeVersion, resolveBinary, splitOmpModel } from './detect.ts'
export { buildOmpRpcRunArgs as buildRunArgs, startOmpRpcRun as startOmpRun } from './rpc-run.ts'
export { capEventText, classifyOmpExit, mintRunId, runEnvironment, OmpRunProjection } from './run.ts'
export type { OmpRpcRunArgs as OmpRunArgs } from './rpc-run.ts'
export type { OmpRunContext, OmpRunState } from './run.ts'
export { OMP_DEFAULT_TRANSCRIPT_BYTES, OMP_PLAN_MODES, OMP_SESSION_VERSION, OMP_SMALL_FILE_BYTES, OMP_TITLE_SLOT_BYTES, activeProfile, decodeCwdDirName, encodeCwdDirName, findOmpSessionFile, foldOmpEntries, listOmpSessions, ompBranch, readOmpEntry, readOmpSessionHeader, readOmpSessionLeadAt, readOmpSessionView, readOmpTitleSlot, resolveOmpStore, sessionKey } from './sessions.ts'
export type { OmpBranch, OmpNativeEntry, OmpSessionFold, OmpSessionHeader, OmpSessionView, OmpStoreLayout, OmpTitleSlot } from './sessions.ts'
export { hashText, ompTodoId, readOmpNativeTasks } from './tasks.ts'
export type { OmpNativeTaskRead } from './tasks.ts'
export { MAX_MESSAGE_TEXT_BYTES, ompProjectionCounters, projectOmpEntry, readOmpTranscript } from './transcript.ts'
export type { OmpMessageDraft, OmpProjectionCounters, OmpTranscriptRead } from './transcript.ts'

/** Canonical agent id in the mesh registry. */
export const OMP_ID = 'omp'

/** Human-facing name. */
export const OMP_DISPLAY_NAME = 'OMP'

/**
 * Environment variable names this adapter resolves for a run; never values.
 *
 * `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `OMP_PROFILE`
 * and the legacy `PI_PROFILE` are read to resolve the store, and the first three plus
 * `OMP_PROFILE` are set on a child process.
 */
export const OMP_RUN_ENVIRONMENT_KEYS: readonly string[] = [
  'PI_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'OMP_PROFILE',
  'PI_PROFILE',
]

/** Transport inventory for the RPC process the adapter uses to run OMP turns. */
export const OMP_TRANSPORTS: readonly AgentTransport[] = [
  { mode: 'headless-exec', mechanism: 'omp --mode json', available: false },
  {
    mode: 'duplex-protocol',
    mechanism: 'omp --mode rpc-ui (JSON commands on stdin, events and approval requests on stdout)',
    available: true,
  },
]

/** One sentence on what this agent is and where its data lives. */
const OMP_SUMMARY =
  'OMP (oh-my-pi, @oh-my-pi/pi-coding-agent): a pi fork whose sessions are append-only JSONL trees ' +
  'headed by a fixed-width title slot.'

/**
 * Create the OMP adapter over a host.
 *
 * @param host - Host providing files, processes, environment and time.
 * @param config - Caller configuration; every field is optional and defaulted explicitly.
 * @returns the adapter; the mesh registry, not the caller, owns its lifetime.
 */
export function ompAdapter(host: AgentHost, config: OmpAdapterConfig = {}): AgentAdapter {
  return new OmpAdapter(host, resolveOmpConfig(config))
}

/** The mesh adapter implementation; instances are stateless apart from the resolved caches. */
class OmpAdapter implements AgentAdapter {
  readonly id: AgentId = brandString<AgentId>(OMP_ID)

  private readonly host: AgentHost

  private readonly config: ResolvedOmpConfig

  private descriptor: Promise<AgentDescriptor & { readonly sessionRoot: string }> | undefined

  private layout: OmpStoreLayout | undefined

  private runSequence = 0

  /**
   * @param host - Host providing files, processes, environment and time.
   * @param config - Fully resolved configuration.
   */
  constructor(host: AgentHost, config: ResolvedOmpConfig) {
    this.host = host
    this.config = config
  }

  /**
   * Declared capabilities; never depends on detection.
   *
   * `listModels` is `false`: the reference adapter's catalog read needs a CLI probe this
   * adapter does not run (see the README).
   * @returns the capability declaration.
   */
  capabilities(): AgentCapabilities {
    return {
      runModes: ['duplex-protocol'],
      streaming: true,
      resume: true,
      // RPC `abort` stops this prompt while preserving OMP's native session file.
      interrupt: true,
      listSessions: true,
      readTranscript: true,
      nativeTodos: true,
      nativePlan: true,
      listModels: false,
      sandboxProfiles: [],
      approvalModes: OMP_APPROVAL_MODES,
      credentials: { status: true, login: ['interactive'], logout: false },
    }
  }

  /**
   * Describe this agent on this machine, with detection resolved once and cached.
   * @returns the descriptor.
   */
  async describe(): Promise<AgentDescriptor & { readonly sessionRoot: string }> {
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

  /**
   * Observe authentication state without writing anything.
   * @returns the observed state; never a secret.
   */
  async readAuthState(): Promise<AgentAuthState> {
    return readOmpAuthState({ host: this.host, layout: this.storeLayout(), env: this.host.env })
  }

  /**
   * Enumerate OMP's sessions from its own store, newest first.
   * @param options - Cwd filter, limit and cancellation.
   * @returns the sessions, bounded by the ported scan caps.
   */
  async listSessions(options: AgentSessionListOptions): Promise<readonly AgentSession[]> {
    return listOmpSessions({ host: this.host, agentId: this.id, layout: this.storeLayout(), options })
  }

  /** Return the OMP TUI argv for a person to paste into a terminal. */
  async nativeLaunchCommand(nativeId: string): Promise<readonly string[]> {
    const descriptor = await this.describe()
    const argv = [descriptor.detection.binaryPath ?? this.binaryPath()]
    argv.push('--session-dir', descriptor.sessionRoot)
    argv.push('--resume', nativeId)
    return argv
  }

  /**
   * Read a bounded transcript window along a session's live branch.
   * @param request - The session to read and the caller's bounds.
   * @returns the window, oldest first, with every declared gap.
   */
  async readTranscript(request: AgentTranscriptRequest): Promise<AgentTranscript> {
    return readOmpTranscript({
      host: this.host,
      layout: this.storeLayout(),
      session: request.session,
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    })
  }

  /**
   * Read OMP's own todo list and plan-mode state for a session.
   * @param request - The session to read.
   * @returns the observed state, with the notes stating when this session records neither.
   */
  async readNativeTasks(request: AgentNativeTasksRequest): Promise<AgentNativeTasks> {
    return readOmpNativeTasks({
      host: this.host,
      layout: this.storeLayout(),
      agentId: this.id,
      session: request.session,
    })
  }

  /**
   * Report no models.
   *
   * The reference adapter builds this list from OMP's own `models.yml`/`config.yml` and a
   * bounded `omp models --json` probe; neither is implemented here, so the honest answer
   * is an empty list and `capabilities().listModels === false`.
   * @returns an empty list.
   */
  listModels(): Promise<readonly AgentModel[]> {
    return Promise.resolve([])
  }

  /**
   * Read OMP's native capability files and resource directories without loading them.
   * @param request - Optional project directory and cancellation signal.
   * @returns OMP's capability inventory and any projection gaps.
   */
  async readCapabilities(request: AgentCapabilityReadRequest): Promise<AgentCapabilityInventory> {
    return await readOmpCapabilities(this.host, this.id, this.storeLayout(), request)
  }

  /** Resolve a native server without starting it; DSH owns approval and activation. */
  async resolveMcpServer(request: AgentMcpServerResolveRequest): Promise<AgentMcpServerConfig | undefined> {
    return await resolveOmpMcpServer(this.host, this.storeLayout(), request)
  }

  /**
   * Start a credential flow through `omp login`.
   * @param request - Requested flow; only `interactive` has a CLI counterpart.
   * @returns the CLI outcome (or the refusal) plus the freshly observed state.
   */
  async login(request: AgentLoginRequest): Promise<AgentAuthOperationResult> {
    const layout = this.storeLayout()
    return ompLogin({
      host: this.host,
      binary: this.binaryPath(),
      layout,
      params: request,
      status: async () => await this.readAuthState(),
      cwd: await this.cliCwd(layout),
      env: runEnvironment({ config: this.config, layout }, undefined),
      timeoutMs: OMP_LOGIN_TIMEOUT_MS,
    })
  }

  /**
   * Report that OMP has no logout subcommand, with the paths that do revoke.
   * @returns an unsuccessful result carrying the guidance and the freshly observed state.
   */
  async logout(): Promise<AgentAuthOperationResult> {
    return ompLogout({
      layout: this.storeLayout(),
      status: async () => await this.readAuthState(),
    })
  }

  /**
   * Dispatch `omp --mode rpc-ui` for one run.
   * @param request - What the caller asked to run; the prompt travels as an RPC command.
   * @returns the live run handle; a failure to resolve a resume target, start the process
   *   or read its stream settles `result` as a classified failure rather than rejecting it.
   */
  startRun(request: AgentRunRequest): AgentRun {
    this.runSequence += 1
    return startOmpRpcRun(
      {
        host: this.host,
        config: this.config,
        layout: this.storeLayout(),
        agentId: this.id,
        runId: mintRunId(this.host, this.runSequence),
      },
      request,
    )
  }

  /** Resolve the descriptor, and therefore detection, once. */
  private async buildDescriptor(): Promise<AgentDescriptor & { readonly sessionRoot: string }> {
    const candidates =
      this.config.binaryPath === undefined ? {} : { candidates: [expandUserPath(this.host, this.config.binaryPath)] }
    const resolution = await resolveBinary(this.host, candidates)
    const version =
      resolution.path === undefined
        ? undefined
        : await probeVersion(this.host, resolution.path, {
          cwd: this.host.home,
          timeoutMs: OMP_VERSION_PROBE_TIMEOUT_MS,
        })
    const layout = this.storeLayout()
    return {
      id: this.id,
      displayName: OMP_DISPLAY_NAME,
      summary: OMP_SUMMARY,
      capabilities: this.capabilities(),
      detection: detectionFrom(resolution, version === undefined ? {} : { version }),
      transports: OMP_TRANSPORTS,
      sessionRoot: layout.sessionDirOverride ?? layout.defaultSessionsRoot,
      credentialPath: layout.credentialPath,
      environmentKeys: OMP_RUN_ENVIRONMENT_KEYS,
    }
  }

  /** The resolved store layout, computed once from the configuration and the host environment. */
  private storeLayout(): OmpStoreLayout {
    this.layout ??= resolveOmpStore({ host: this.host, config: this.config })
    return this.layout
  }

  /** The resolved binary: the configured override, else the bare name for `PATH`. */
  private binaryPath(): string {
    return this.config.binaryPath ?? OMP_BINARY_NAME
  }

  /** A working directory that exists, for spawning the CLI. */
  private async cliCwd(layout: OmpStoreLayout): Promise<string> {
    return (await this.host.stat(layout.agentDir))?.isDirectory === true ? layout.agentDir : this.host.home
  }
}

/** Cordis plugin name. */
export const name = 'agent-omp'

/** The mesh registry and the host services must be present. */
export const inject = ['agentMesh', 'llm', 'fs', 'subprocess']

/** Deployment-owned inputs of the OMP adapter. */
export interface Config {
  /** Explicit `omp` executable path; tried before `PATH` and the well-known directories. */
  binaryPath?: string
  /** Explicit OMP agent directory, the highest-priority source of the store root. */
  homeDir?: string
  /** Session directory override, as `omp --session-dir` defines it. */
  sessionDir?: string
  /** Environment entries layered over the harness process environment. */
  env?: Record<string, string>
}

export const Config: z<Config> = z.object({
  binaryPath: z.string(),
  homeDir: z.string(),
  sessionDir: z.string(),
  env: z.dict(z.string()).default({}),
})

/**
 * Mount the OMP adapter on the mesh registry.
 *
 * The host is the mesh's own `createContextHost`, so file reads go through the profile's
 * filesystem policy and children through the subprocess seam's scrubbed environment and
 * managed process range. Registration is an effect: unmounting this plugin removes the
 * adapter. The environment the adapter inspects is the harness process environment with
 * this plugin's `env` layered over it, and the person's home comes from `HOME` (falling
 * back to the harness's own home) so a staged environment resolves the same layout the
 * child will.
 *
 * @param ctx - Owning context.
 * @param config - Adapter configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const env: Record<string, string | undefined> = { ...process.env, ...(config.env ?? {}) }
  const home = env['HOME'] ?? env['USERPROFILE']
  const host = createContextHost(ctx, { env, ...(home === undefined ? {} : { home }) })
  const adapter = ompAdapter(host, config)
  ctx.effect(() => ctx.agentMesh.register(adapter), 'agent-omp.register')
  const layout = resolveOmpStore({ host, config: resolveOmpConfig(config) })
  const llmAdapter = new NativeProviderLlmAdapter({
    provider: 'agent-omp',
    displayName: OMP_DISPLAY_NAME,
    routes: async () => await readOmpLlmRoutes(host, layout),
    auth: nativeProviderAuth(ctx, host.env),
    ...nativeProviderImages(ctx),
    onRouteError: (route, error) => {
      ctx.logger.warn(`agent-omp: model route "${route.id}" is unavailable`)
      ctx.logger.warn(error)
    },
  })
  ctx.effect(() => ctx.llm.registerAdapter(['agent-omp'], llmAdapter), 'agent-omp.llm-register')
}
