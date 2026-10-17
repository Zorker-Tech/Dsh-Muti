/**
 * The Grok Build plugin: one agent-mesh adapter over the harness's filesystem and
 * subprocess seams.
 *
 * The adapter reads Grok Build's own store and reports Grok's own credential state in
 * place; nothing here writes an agent's files. Detection, session listing, transcripts,
 * native tasks and runs are pure functions of the {@link AgentHost} port, so the plugin
 * itself only resolves configuration, builds the host and registers the adapter as an
 * effect.
 * @module @deepseek-ai/dsh-agent-grok
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createContextHost } from '@deepseek-ai/dsh-agent-mesh'
import { NativeProviderLlmAdapter, nativeProviderAuth, nativeProviderImages } from '@deepseek-ai/dsh-llm-pi-ai'
import type {
  AgentAdapter,
  AgentAuthOperationResult,
  AgentAuthState,
  AgentCapabilityInventory,
  AgentCapabilityReadRequest,
  AgentCapabilities,
  AgentDescriptor,
  AgentDetection,
  AgentHost,
  AgentLoginRequest,
  AgentMcpServerConfig,
  AgentMcpServerResolveRequest,
  AgentModel,
  AgentNativeTasks,
  AgentNativeTasksRequest,
  AgentRun,
  AgentRunMode,
  AgentRunRequest,
  AgentSession,
  AgentSessionListOptions,
  AgentTranscript,
  AgentTranscriptRequest,
  AgentTransport,
} from '@deepseek-ai/dsh-agent-mesh'
import type { GrokAdapterConfig, ResolvedGrokConfig } from './config.ts'
import { resolveGrokConfig } from './config.ts'
import { GROK_APPROVAL_MODES, GROK_SANDBOX_PROFILES, detectionFrom, probeVersion, resolveBinary } from './detect.ts'
import { GROK_MANAGED_ENV_KEYS, loginGrok, logoutGrok, readGrokAuthState, type GrokAuthContext } from './auth.ts'
import type { GrokPaths } from './sessions.ts'
import { GROK_AGENT_ID, findGrokSessionDir, listGrokSessions, resolveGrokPaths } from './sessions.ts'
import { readGrokNativeTasks } from './tasks.ts'
import { readGrokTranscript } from './transcript.ts'
import { mintRunId, runEnvironment, startGrokRun } from './run.ts'
import { startGrokAcpRun } from './acp-run.ts'
import { readGrokLlmRoutes } from './llm-models.ts'
import { readGrokCapabilities, resolveGrokMcpServer } from './capabilities.ts'

export { readGrokLlmRoutes } from './llm-models.ts'
export { DEFAULT_INTERRUPT_GRACE_MS, DEFAULT_RUN_MODE, resolveGrokConfig } from './config.ts'
export type { GrokAdapterConfig, ResolvedGrokConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'agent-grok'

/** The mesh registry plus the two seams the host port reads and spawns through. */
export const inject = ['agentMesh', 'llm', 'fs', 'subprocess']

/** Human name of the product behind this adapter. */
export const GROK_DISPLAY_NAME = 'Grok Build'

/** Plugin configuration: the adapter's own inputs, all optional. */
export const Config: Schema<GrokAdapterConfig> = Schema.object({
  binaryPath: Schema.string().description('Explicit Grok executable path; tried before PATH and the well-known directories.'),
  homeDir: Schema.string().description('Explicit Grok home; tried before $GROK_HOME and ~/.grok.'),
  env: Schema.dict(Schema.string()).description('Extra environment entries for every child process this adapter starts.'),
  model: Schema.string().description('Default model for runs that name none.'),
  sandbox: Schema.string().description('Default sandbox profile for runs that name none.'),
  approval: Schema.string().description('Default approval mode for runs that name none.'),
  maxTurns: Schema.natural().description('Default --max-turns for every dispatch.'),
  reasoningEffort: Schema.string().description('Default --reasoning-effort for every dispatch.'),
  noPlan: Schema.boolean().description('Pass --no-plan on every dispatch.'),
  noSubagents: Schema.boolean().description('Pass --no-subagents on every dispatch.'),
  disableWebSearch: Schema.boolean().description('Pass --disable-web-search on every dispatch.'),
  timeoutMs: Schema.natural().description('Default wall-clock budget for a run in milliseconds; 0 leaves runs unbounded.'),
  transcriptTailBytes: Schema.natural().description('Bytes read from the tail of updates.jsonl when projecting a transcript.'),
  loginTimeoutMs: Schema.natural().description('Wall-clock budget for a delegated login.'),
  logoutTimeoutMs: Schema.natural().description('Wall-clock budget for a delegated logout.'),
  versionProbeTimeoutMs: Schema.natural().description('Wall-clock budget for the --version detection probe.'),
  runMode: Schema.union([Schema.const('duplex-protocol'), Schema.const('headless-exec')]).description('Native run transport; ACP is the default.'),
  interruptGraceMs: Schema.natural().description('Time to wait for an ACP cancel before terminating its process.'),
})

/**
 * Register the Grok Build adapter on the mesh.
 * @param ctx - Context providing the mesh registry, the filesystem and subprocess seams.
 * @param config - Plugin configuration, as validated by {@link Config}.
 */
export function apply(ctx: Context, config: GrokAdapterConfig): void {
  const host = createContextHost(ctx, { env: { ...process.env, ...(config.env ?? {}) }, home: homedir() })
  const adapter = grokAdapter(host, resolveGrokConfig(config))
  ctx.effect(() => ctx.agentMesh.register(adapter), 'agent-grok.register')
  const paths = resolveGrokPaths(host, config.homeDir)
  const llmAdapter = new NativeProviderLlmAdapter({
    provider: 'agent-grok',
    displayName: GROK_DISPLAY_NAME,
    routes: async () => await readGrokLlmRoutes(host, paths),
    auth: nativeProviderAuth(ctx, host.env),
    ...nativeProviderImages(ctx),
    onRouteError: (route, error) => {
      ctx.logger.warn(`agent-grok: model route "${route.id}" is unavailable`)
      ctx.logger.warn(error)
    },
  })
  ctx.effect(() => ctx.llm.registerAdapter(['agent-grok'], llmAdapter), 'agent-grok.llm-register')
}


/** Both native Grok run transports are available. */
export const GROK_TRANSPORTS: readonly AgentTransport[] = [
  { mode: 'headless-exec', mechanism: 'grok -p --output-format streaming-json', available: true },
  { mode: 'duplex-protocol', mechanism: 'grok agent stdio (ACP JSON-RPC)', available: true },
]

/** Describe the selected transport's run capabilities. */
function grokCapabilities(runMode: AgentRunMode): AgentCapabilities {
  return {
    runModes: [runMode],
    streaming: true,
    resume: true,
    interrupt: runMode === 'duplex-protocol',
    listSessions: true,
    readTranscript: true,
    nativeTodos: true,
    nativePlan: true,
    // Grok's model list needs a `grok models` CLI probe, which this adapter does not perform.
    listModels: false,
    sandboxProfiles: GROK_SANDBOX_PROFILES,
    approvalModes: GROK_APPROVAL_MODES,
    credentials: {
      status: true,
      login: ['oauth-loopback', 'device-code', 'interactive'],
      logout: true,
    },
  }
}

/** Detection resolved once and cached for the adapter's lifetime. */
interface GrokDetection {
  /** Absolute path of the executable, when one was found. */
  readonly binary: string | undefined
  /** The mesh detection record. */
  readonly detection: AgentDetection
}

/**
 * Build one Grok Build adapter over a host and a resolved configuration.
 * @param host - The host port every read and spawn goes through.
 * @param config - Fully resolved adapter configuration.
 * @returns a ready adapter; detection happens lazily on the first call that needs it.
 */
export function grokAdapter(host: AgentHost, config: ResolvedGrokConfig): AgentAdapter {
  const paths: GrokPaths = resolveGrokPaths(host, config.homeDir)
  let detection: Promise<GrokDetection> | undefined
  let sequence = 0

  async function runDetection(): Promise<GrokDetection> {
    const resolution = await resolveBinary(host, config.binaryPath === undefined ? {} : { candidates: [config.binaryPath] })
    if (!resolution.found) {
      host.log('warn', `the grok binary was not found: ${resolution.reason}`)
      return { binary: undefined, detection: detectionFrom(resolution) }
    }
    const version = await probeVersion(host, resolution.path, { cwd: host.home, timeoutMs: config.versionProbeTimeoutMs })
    return { binary: resolution.path, detection: detectionFrom(resolution, version === undefined ? {} : { version }) }
  }

  async function detect(): Promise<GrokDetection> {
    detection ??= runDetection()
    return await detection
  }

  async function binaryPath(): Promise<string | undefined> {
    return (await detect()).binary
  }

  function authContext(): GrokAuthContext {
    return {
      host,
      credentialPath: paths.credentialPath,
      home: paths.home,
      // The same store and the same ambient credentials a dispatch receives, so a login
      // writes where this adapter reads.
      env: runEnvironment(host, paths, config, undefined),
      resolveBinary: binaryPath,
      loginTimeoutMs: config.loginTimeoutMs,
      logoutTimeoutMs: config.logoutTimeoutMs,
    }
  }

  return {
    id: GROK_AGENT_ID,

    async describe(): Promise<AgentDescriptor> {
      const resolved = await detect()
      return {
        id: GROK_AGENT_ID,
        displayName: GROK_DISPLAY_NAME,
        summary: 'Grok Build by xAI: headless `grok -p` dispatches, sessions under $GROK_HOME/sessions, plan and todo state on disk.',
        capabilities: grokCapabilities(config.runMode),
        detection: resolved.detection,
        transports: GROK_TRANSPORTS,
        sessionRoot: paths.sessionRoot,
        credentialPath: paths.credentialPath,
        environmentKeys: GROK_MANAGED_ENV_KEYS,
      }
    },

    async readAuthState(): Promise<AgentAuthState> {
      return await readGrokAuthState(authContext())
    },

    async listSessions(options: AgentSessionListOptions): Promise<readonly AgentSession[]> {
      return await listGrokSessions({ host, paths, options })
    },

    async nativeLaunchCommand(nativeId: string): Promise<readonly string[]> {
      const binary = await binaryPath() ?? GROK_AGENT_ID
      return [binary, '--resume', nativeId]
    },

    async readTranscript(request: AgentTranscriptRequest): Promise<AgentTranscript> {
      const dir = await findGrokSessionDir(host, paths, request.session.nativeId)
      if (dir === undefined) {
        return {
          key: request.session.key,
          messages: [],
          hasMore: false,
          notes: ['the session directory could not be located in the grok store; the transcript window is empty'],
        }
      }
      return await readGrokTranscript({
        host,
        sessionDir: dir.dir,
        key: request.session.key,
        ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
        ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
        ...(request.session.messageCount === undefined ? {} : { totalMessages: request.session.messageCount }),
      })
    },

    async readNativeTasks(request: AgentNativeTasksRequest): Promise<AgentNativeTasks> {
      const dir = await findGrokSessionDir(host, paths, request.session.nativeId)
      if (dir === undefined) {
        return {
          available: false,
          todos: [],
          notes: ['the session directory could not be located in the grok store; no native task state was read'],
        }
      }
      return await readGrokNativeTasks({ host, sessionDir: dir.dir, observedIn: request.session.key })
    },

    listModels(): Promise<readonly AgentModel[]> {
      return Promise.resolve([])
    },

    async readCapabilities(request: AgentCapabilityReadRequest): Promise<AgentCapabilityInventory> {
      return await readGrokCapabilities(host, GROK_AGENT_ID, paths, request)
    },

    async resolveMcpServer(request: AgentMcpServerResolveRequest): Promise<AgentMcpServerConfig | undefined> {
      return await resolveGrokMcpServer(host, paths, request)
    },

    startRun(request: AgentRunRequest): AgentRun {
      sequence += 1
      const context = { host, config, agentId: GROK_AGENT_ID, runId: mintRunId(host, sequence), paths, resolveBinary: binaryPath }
      return config.runMode === 'headless-exec' ? startGrokRun(context, request) : startGrokAcpRun(context, request)
    },

    async login(request: AgentLoginRequest): Promise<AgentAuthOperationResult> {
      return await loginGrok(authContext(), request)
    },

    async logout(): Promise<AgentAuthOperationResult> {
      return await logoutGrok(authContext())
    },
  }
}
