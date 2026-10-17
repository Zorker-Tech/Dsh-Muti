/**
 * The Pi adapter and its Cordis plugin: one {@link AgentAdapter} over
 * `@earendil-works/pi-coding-agent`.
 *
 * Transport: `pi --mode rpc` (JSONL commands and events) by default, with the one-shot
 * `pi --mode json` stream available as an alternate. Pi's own session files remain the
 * source for discovery and transcript reading.
 *
 * The model catalog comes from Pi's own files (`models.json` providers and their models,
 * `settings.json`'s default model and enabled scope); Pi's built-in catalog is deliberately
 * never read, so the catalog describes what this machine is configured to run.
 *
 * The store layout, capabilities and detection are described by `describe()`, which caches
 * its result because the mesh catalog is queried on every GUI load and detection spawns the
 * `--version` probe.
 *
 * ```yaml
 * - id: agent-pi
 *   name: '@deepseek-ai/dsh-agent-pi'
 *   config:
 *     # Optional: an explicit Pi executable, tried before PATH.
 *     binaryPath: /usr/local/bin/pi
 *     # Optional: Pi's agent directory, tried before $PI_CODING_AGENT_DIR and ~/.pi/agent.
 *     homeDir: ~/.pi/agent
 *     # Optional: the flat session directory, tried before $PI_CODING_AGENT_SESSION_DIR
 *     # and the sessionDir of Pi's own settings.json.
 *     sessionDir: ~/.pi/sessions
 *     env:
 *       PI_CODING_AGENT_DIR: ~/.pi/agent
 * ```
 * @module @deepseek-ai/dsh-agent-pi
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
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
  AgentRunMode,
  AgentSession,
  AgentSessionListOptions,
  AgentTranscript,
  AgentTranscriptRequest,
  AgentTransport,
} from '@deepseek-ai/dsh-agent-mesh'
import { brandString } from '@deepseek-ai/dsh-brand'
import { NativeProviderLlmAdapter, nativeProviderAuth, nativeProviderImages } from '@deepseek-ai/dsh-llm-pi-ai'
import { piLogin, piLogout, readPiAuthState } from './auth.ts'
import { resolvePiConfig, type PiAdapterConfig, type ResolvedPiConfig } from './config.ts'
import { DEFAULT_VERSION_PROBE_TIMEOUT_MS, detectionFrom, probePiVersion, resolvePiBinary } from './detect.ts'
import {
  isRecord,
  listPiSessions,
  readArray,
  readRecord,
  readString,
  resolvePiStore,
  type PiStoreLayout,
} from './sessions.ts'
import { readPiTranscript } from './transcript.ts'
import { readPiLlmRoutes } from './llm-models.ts'
import { readPiCapabilities, resolvePiMcpServer } from './capabilities.ts'
import { mintRunId, startPiRun } from './run.ts'
import { startPiRpcRun } from './rpc-run.ts'

export { DEFAULT_INTERRUPT_GRACE_MS, DEFAULT_RUN_MODE, resolvePiConfig } from './config.ts'
export type { PiAdapterConfig, ResolvedPiConfig } from './config.ts'

/** Canonical agent id. */
export const PI_ID = 'pi'

/** Human name. */
export const PI_DISPLAY_NAME = 'Pi'

/** One sentence on what this agent is and where its data lives. */
export const PI_SUMMARY =
  'Pi (@earendil-works/pi-coding-agent): a coding agent whose sessions are append-only JSONL trees.'

/** Environment variable names this adapter resolves for a run; never values. */
export const PI_RUN_ENVIRONMENT_KEYS: readonly string[] = ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']

/** The capability declaration, literal because consumers branch on it. */
export const PI_CAPABILITIES: AgentCapabilities = {
  runModes: ['duplex-protocol'],
  streaming: true,
  resume: true,
  interrupt: true,
  listSessions: true,
  readTranscript: true,
  nativeTodos: false,
  nativePlan: false,
  listModels: true,
  sandboxProfiles: [],
  approvalModes: ['default', 'approve'],
  credentials: { status: true, login: ['interactive'], logout: false },
}

/** Transports Pi offers, and whether this adapter implements them. */
export const PI_TRANSPORTS: readonly AgentTransport[] = [
  { mode: 'headless-exec', mechanism: 'pi --mode json', available: true },
  {
    mode: 'duplex-protocol',
    mechanism: 'pi --mode rpc (JSONL commands on stdin, responses and events on stdout)',
    available: true,
  },
]

/**
 * Read the configured model and provider catalog from Pi's own configuration files.
 *
 * This is what Pi's own `models.json` declares — the `providers` object, each provider's
 * `models`, the `modelOverrides` that patch a model's metadata — plus `settings.json`'s
 * `defaultProvider`, `defaultModel` and `enabledModels`. Pi's built-in catalog, and the
 * overlay Pi fetches from pi.dev, are deliberately not read: they describe Pi rather than
 * this machine, and the mesh model row carries no provenance to say which is which.
 *
 * `AgentModel` has no notes channel and no `source` or `isDefault` field, so three facts the
 * reference reader reports are declared here instead: a `modelOverrides` entry that names a
 * model this reader cannot enumerate is still listed (with only the metadata the override
 * declares); the saved default model is added even when `models.json` does not declare it;
 * and `enabledModels` is applied as a scope, except when that scope would remove every
 * configured model — the usual reason is that it names models from Pi's built-in catalog,
 * and reporting "this machine can run nothing" would be wrong.
 *
 * Read-only and secret-free: no file is written, and a `models.json` `apiKey` is never read
 * into the catalog.
 *
 * @param host - Host providing the reads.
 * @param layout - Resolved store layout.
 * @returns the configured models, in file order, with the saved default and scope applied.
 */
export async function readPiModels(host: AgentHost, layout: PiStoreLayout): Promise<readonly AgentModel[]> {
  const models: AgentModel[] = []
  const modelsFile = parseJsonObject(await host.readHead(layout.modelsPath, MODEL_FILE_MAX_BYTES))
  if (modelsFile !== undefined) {
    if (readRecord(modelsFile, 'modelOverrides') !== undefined) {
      // Pi's schema accepts `modelOverrides` only inside a provider, where it patches that
      // provider's models, so a top-level one is inert and deliberately not applied.
      host.log('warn', `${layout.modelsPath} declares a top-level modelOverrides, which pi's schema does not accept`)
    }
    for (const [providerId, rawProvider] of Object.entries(readRecord(modelsFile, 'providers') ?? {})) {
      if (!isRecord(rawProvider)) continue
      const overrides = readRecord(rawProvider, 'modelOverrides') ?? {}
      const declared = new Set<string>()
      for (const definition of readArray(rawProvider, 'models') ?? []) {
        if (!isRecord(definition)) continue
        const id = nonEmpty(readString(definition, 'id'))
        if (id === undefined) continue
        const rawPatch = overrides[id]
        const patch = isRecord(rawPatch) ? rawPatch : undefined
        models.push(projectModel(id, providerId, definition, patch))
        declared.add(id)
      }
      for (const [modelId, rawOverride] of Object.entries(overrides)) {
        if (declared.has(modelId)) continue
        if (!isRecord(rawOverride)) continue
        // An override can name a model this reader cannot enumerate, because Pi's built-in
        // catalog is deliberately not read; it is listed with the override's own metadata.
        models.push(projectModel(modelId, providerId, undefined, rawOverride))
      }
    }
  }

  const settings = parseJsonObject(await host.readHead(layout.settingsPath, MODEL_FILE_MAX_BYTES))
  const defaultModel = nonEmpty(readString(settings, 'defaultModel'))
  const defaultProvider = nonEmpty(readString(settings, 'defaultProvider'))
  if (defaultModel !== undefined) {
    const known = models.some(model => model.id === defaultModel && (defaultProvider === undefined || model.provider === defaultProvider))
    if (!known) {
      models.push({ id: defaultModel, ...(defaultProvider === undefined ? {} : { provider: defaultProvider }) })
    }
  }

  const enabled = (readArray(settings, 'enabledModels') ?? []).filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
  )
  if (enabled.length === 0) return models
  const scoped = models.filter(model => enabled.some(pattern => matchesModelPattern(pattern, model)))
  return scoped.length === 0 ? models : scoped
}

/** Byte cap on a models.json or settings.json read. */
const MODEL_FILE_MAX_BYTES = 1024 * 1024

/** Parse a JSON text as an object, tolerating absence and corruption. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** A non-empty configured string. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}

/** Project one model, patched by its `modelOverrides` entry when it has one. */
function projectModel(
  id: string,
  providerId: string,
  definition: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): AgentModel {
  const displayName = nonEmpty(readString(patch, 'name')) ?? nonEmpty(readString(definition, 'name'))
  return { id, ...(displayName === undefined ? {} : { displayName }), provider: providerId }
}

/** Pi thinking levels, in Pi's own `getSupportedThinkingLevels` order. */
const PI_THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Whether one `enabledModels` pattern matches a model.
 *
 * Pi resolves these patterns with exact ids and case-insensitive globs against
 * `provider/id` and the bare id, after stripping an optional `:<thinking>` suffix. Pi's
 * fuzzy partial-name matching is not reproduced; a pattern that needs it simply does not
 * match.
 *
 * @param pattern - One configured pattern.
 * @param model - Model reference to test.
 * @returns whether the pattern matches.
 */
export function matchesModelPattern(pattern: string, model: AgentModel): boolean {
  const base = stripThinkingSuffix(pattern.trim())
  if (base === '') return false
  const references = model.provider === undefined ? [model.id] : [`${model.provider}/${model.id}`, model.id]
  if (!/[*?[]/.test(base)) return references.some(reference => reference.toLowerCase() === base.toLowerCase())
  const expression = globExpression(base)
  return references.some(reference => expression.test(reference))
}

/** Remove a trailing `:<thinking>` suffix, keeping any other colon (a model id such as `qwen2.5-coder:7b` keeps its tag). */
function stripThinkingSuffix(pattern: string): string {
  const colon = pattern.lastIndexOf(':')
  if (colon <= 0) return pattern
  const suffix = pattern.slice(colon + 1)
  if (!PI_THINKING_LEVELS.includes(suffix)) return pattern
  return pattern.slice(0, colon)
}

/** Compile Pi's `minimatch`-style pattern subset (`*`, `?`, `[…]`) for case-insensitive matching. */
function globExpression(pattern: string): RegExp {
  let expression = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index)
    if (character === '*') {
      expression += '.*'
      continue
    }
    if (character === '?') {
      expression += '.'
      continue
    }
    if (character === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end !== -1) {
        expression += `[${pattern.slice(index + 1, end)}]`
        index = end
        continue
      }
    }
    expression += character.replace(/[.*+?^${}()|[\]\\]/, '\\$&')
  }
  return new RegExp(`^${expression}$`, 'i')
}

/**
 * The Pi adapter over one {@link AgentHost}.
 *
 * Every read and every spawn goes through the host, so the whole adapter is a pure function
 * of that port and can be exercised in unit tests with an in-memory implementation.
 */
export class PiAdapter implements AgentAdapter {
  /** Registry identity. */
  readonly id: AgentId = brandString<AgentId>(PI_ID)

  private described: AgentDescriptor & { readonly sessionRoot: string } | undefined
  private runSequence = 0

  /**
   * @param host - Host every read and spawn goes through.
   * @param config - Resolved adapter configuration.
   */
  constructor(
    private readonly host: AgentHost,
    private readonly config: ResolvedPiConfig,
  ) {}

  /**
   * Describe this agent, including detection on this machine.
   *
   * The result is cached: the mesh catalog is queried on every GUI load and the `--version`
   * probe spawns a process.
   *
   * @returns the descriptor.
   */
  async describe(): Promise<AgentDescriptor & { readonly sessionRoot: string }> {
    if (this.described !== undefined) return this.described
    const layout = await this.layout()
    const resolution = await resolvePiBinary(
      this.host,
      this.config.binaryPath === undefined ? {} : { candidates: [this.config.binaryPath] },
    )
    const version =
      resolution.found && resolution.path !== undefined
        ? await probePiVersion(this.host, resolution.path, {
          cwd: layout.agentDir,
          timeoutMs: DEFAULT_VERSION_PROBE_TIMEOUT_MS,
        })
        : undefined
    const descriptor: AgentDescriptor & { readonly sessionRoot: string } = {
      id: this.id,
      displayName: PI_DISPLAY_NAME,
      summary: PI_SUMMARY,
      detection: detectionFrom(resolution, version === undefined ? {} : { version }),
      capabilities: { ...PI_CAPABILITIES, runModes: [this.config.runMode], interrupt: this.config.runMode === 'duplex-protocol' },
      transports: PI_TRANSPORTS,
      sessionRoot: layout.sessionDirOverride ?? layout.defaultSessionsRoot,
      credentialPath: layout.credentialPath,
      environmentKeys: PI_RUN_ENVIRONMENT_KEYS,
    }
    this.described = descriptor
    return descriptor
  }

  /**
   * Read Pi's credential state. Never returns secret material.
   * @returns the observed state.
   */
  async readAuthState(): Promise<AgentAuthState> {
    return await readPiAuthState(await this.authRead())
  }

  /**
   * Enumerate Pi's sessions from its own store. Read-only.
   * @param options - Cwd filter, limit and cancellation.
   * @returns session summaries, newest first.
   */
  async listSessions(options: AgentSessionListOptions): Promise<readonly AgentSession[]> {
    return await listPiSessions({
      host: this.host,
      agentId: this.id,
      layout: await this.layout(),
      options,
    })
  }

  /** Return the Pi TUI argv for a person to paste into a terminal. */
  async nativeLaunchCommand(nativeId: string): Promise<readonly string[]> {
    const descriptor = await this.describe()
    const argv = [descriptor.detection.binaryPath ?? 'pi']
    argv.push('--session-dir', descriptor.sessionRoot)
    argv.push('--session', nativeId)
    return argv
  }

  /**
   * Read a bounded transcript window along a session's live branch. Read-only.
   * @param request - Session to read and the caller's bounds.
   * @returns the window and its declared gaps.
   */
  async readTranscript(request: AgentTranscriptRequest): Promise<AgentTranscript> {
    return await readPiTranscript({
      host: this.host,
      layout: await this.layout(),
      session: request.session,
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    })
  }

  /**
   * Pi has no native todo list and no plan mode, so there is nothing to read.
   * @param request - Session to read; unused, because Pi records no task state.
   * @returns the declared absence of a native task model.
   */
  readNativeTasks(request: AgentNativeTasksRequest): Promise<AgentNativeTasks> {
    void request
    return Promise.resolve({ available: false, todos: [], notes: [] })
  }

  /**
   * Read the configured model and provider catalog from Pi's own configuration files.
   * @returns the catalog of what Pi's configuration declares on this machine.
   */
  async listModels(): Promise<readonly AgentModel[]> {
    return await readPiModels(this.host, await this.layout())
  }

  /**
   * Read Pi's declared capabilities without starting its CLI or extensions.
   * @param request - Optional project directory and cancellation signal.
   * @returns Pi's native capability inventory and any projection gaps.
   */
  async readCapabilities(request: AgentCapabilityReadRequest): Promise<AgentCapabilityInventory> {
    return await readPiCapabilities(this.host, this.id, await this.layout(), request)
  }

  /** Resolve a native server without starting it; DSH owns approval and activation. */
  async resolveMcpServer(request: AgentMcpServerResolveRequest): Promise<AgentMcpServerConfig | undefined> {
    return await resolvePiMcpServer(this.host, await this.layout(), request)
  }

  /**
   * Dispatch a run through the configured Pi transport.
   * @param request - Run parameters; the prompt travels on stdin.
   * @returns the run handle, its event stream and its terminal result.
   */
  startRun(request: AgentRunRequest): AgentRun {
    const runId = mintRunId(this.host, (this.runSequence += 1))
    const context = {
      host: this.host,
      config: this.config,
      agentId: this.id,
      runId,
      resolve: async () => {
        const layout = await this.layout()
        const resolution = await resolvePiBinary(
          this.host,
          this.config.binaryPath === undefined ? {} : { candidates: [this.config.binaryPath] },
        )
        return { binary: resolution.path, layout }
      },
    }
    return this.config.runMode === 'headless-exec'
      ? startPiRun(context, request)
      : startPiRpcRun(context, request)
  }

  /**
   * Report that Pi has no non-interactive login instead of driving a TUI.
   * @param request - Requested flow; the optional secret is never used or recorded.
   * @returns an unsuccessful result carrying the guidance and the observed state.
   */
  async login(request: AgentLoginRequest): Promise<AgentAuthOperationResult> {
    return await piLogin(await this.authRead(), request)
  }

  /**
   * Report that Pi has no non-interactive logout.
   * @returns an unsuccessful result carrying the guidance and the observed state.
   */
  async logout(): Promise<AgentAuthOperationResult> {
    return await piLogout(await this.authRead())
  }

  /** Resolve the store layout from the configuration and the host environment. */
  private async layout(): Promise<PiStoreLayout> {
    return await resolvePiStore({
      host: this.host,
      ...(this.config.homeDir === undefined ? {} : { homeDir: this.config.homeDir }),
      ...(this.config.sessionDir === undefined ? {} : { sessionDir: this.config.sessionDir }),
    })
  }

  /** Everything an auth read needs: the host, the layout and the clock. */
  private async authRead(): Promise<{
    host: AgentHost
    layout: PiStoreLayout
    now: number
  }> {
    return { host: this.host, layout: await this.layout(), now: this.host.now() }
  }
}

/**
 * Create the Pi adapter over one host.
 * @param host - Host every read and spawn goes through.
 * @param config - Adapter configuration; resolved here, so the adapter always receives a
 *   complete spec.
 * @returns a ready adapter.
 */
export function createPiAdapter(host: AgentHost, config: PiAdapterConfig = {}): PiAdapter {
  return new PiAdapter(host, resolvePiConfig(config))
}

/** Cordis plugin name. */
export const name = 'agent-pi'

/** The mesh registry, the filesystem service and the subprocess service must all be present. */
export const inject = ['agentMesh', 'llm', 'fs', 'subprocess']

/** Plugin configuration; every field is optional. */
export interface Config {
  /** Explicit Pi executable path; tried before `PATH` and the well-known directories. */
  binaryPath?: string
  /** Pi's agent directory; tried before `$PI_CODING_AGENT_DIR` and `~/.pi/agent`. */
  homeDir?: string
  /**
   * Flat session directory override; tried before `$PI_CODING_AGENT_SESSION_DIR` and the
   * `sessionDir` of Pi's own `settings.json`.
   */
  sessionDir?: string
  /** Extra environment entries for every child process this adapter starts. */
  env?: Record<string, string>
  /** Native run transport; RPC is the default. */
  runMode?: AgentRunMode
  /** Time to wait for Pi to settle after an RPC abort before terminating its process. */
  interruptGraceMs?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  binaryPath: z.string(),
  homeDir: z.string(),
  sessionDir: z.string(),
  env: z.dict(z.string()),
  runMode: z.union([z.const('duplex-protocol'), z.const('headless-exec')]),
  interruptGraceMs: z.natural(),
})

/**
 * Mount the Pi adapter on the mesh registry.
 *
 * The environment the adapter inspects is the host process environment with the plugin's own
 * `env` entries layered over it, so a deployment can point Pi's store resolution at another
 * agent directory without exporting anything.
 *
 * @param ctx - Owning context, carrying the mesh registry and the host services.
 * @param config - Plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const host = createContextHost(ctx, { env: { ...process.env, ...(config.env ?? {}) }, home: homedir() })
  const adapter = createPiAdapter(host, {
    ...(config.binaryPath === undefined ? {} : { binaryPath: config.binaryPath }),
    ...(config.homeDir === undefined ? {} : { homeDir: config.homeDir }),
    ...(config.sessionDir === undefined ? {} : { sessionDir: config.sessionDir }),
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.runMode === undefined ? {} : { runMode: config.runMode }),
    ...(config.interruptGraceMs === undefined ? {} : { interruptGraceMs: config.interruptGraceMs }),
  })
  ctx.effect(() => ctx.agentMesh.register(adapter), 'agent-pi.register')
  const llmAdapter = new NativeProviderLlmAdapter({
    provider: 'agent-pi',
    displayName: 'Pi',
    routes: async () => readPiLlmRoutes(host, await resolvePiStore({
      host,
      ...(config.homeDir === undefined ? {} : { homeDir: config.homeDir }),
      ...(config.sessionDir === undefined ? {} : { sessionDir: config.sessionDir }),
    })),
    auth: nativeProviderAuth(ctx, host.env),
    ...nativeProviderImages(ctx),
    onRouteError: (route, error) => {
      ctx.logger.warn(`agent-pi: model route "${route.id}" is unavailable`)
      ctx.logger.warn(error)
    },
  })
  ctx.effect(() => ctx.llm.registerAdapter(['agent-pi'], llmAdapter), 'agent-pi.llm-register')
}
