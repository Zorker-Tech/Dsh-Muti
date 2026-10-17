/**
 * Route one CLI-owned provider catalog through the Harness LLM service.
 *
 * The public provider id belongs to the agent adapter. Model ids retain both
 * the native provider and model id, while each request uses the endpoint,
 * protocol, headers, and credential resolver read from that agent's store.
 * @module dsh-llm-pi-ai/native-adapter
 */

import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import type { AuthContext, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import {
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { PiAiAdapter } from './adapter.ts'
import type { PiAiAuthInjection } from './adapter.ts'
import { resolveProfiles } from './config.ts'
import type { PiAiModelProfile, PiAiProviderProfile } from './config.ts'

/** One CLI-owned provider and the models it declares. */
export interface NativeProviderLlmRoute {
  /** Provider id in the CLI's configuration. */
  readonly id: string
  /** Stable provider namespace shown in public model ids; defaults to `id`. */
  readonly modelNamespace?: string
  /** Provider label used to distinguish models in DSH selectors. */
  readonly displayName: string
  /** Public pi-ai route fields copied from the CLI's configuration. */
  readonly profile: Omit<PiAiProviderProfile, 'apiKeyEnv' | 'models' | 'displayName'>
  /** Models declared by the CLI, in its preferred order. */
  readonly models: readonly PiAiModelProfile[]
  /** Whether pi-ai may resolve an ambient key when the CLI route is keyless. Defaults to true. */
  readonly allowAmbientAuth?: boolean
  /** Resolve this route's native credential for one request without persisting it. */
  readonly resolveApiKey: () => Promise<string | undefined>
}

/** Live catalog reader and Harness services for one agent-owned model provider. */
export interface NativeProviderLlmAdapterOptions {
  /** Fixed provider id registered with `ctx.llm`, such as `agent-pi`. */
  readonly provider: string
  /** Display name for the fixed Harness provider. */
  readonly displayName: string
  /** Read the current agent-owned model provider definitions. */
  readonly routes: () => Promise<readonly NativeProviderLlmRoute[]>
  /** Report one route that could not be projected; other routes remain usable. */
  readonly onRouteError?: (route: NativeProviderLlmRoute, error: unknown) => void
  /** Auth services used by pi-ai for ambient provider authentication. */
  readonly auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  readonly resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  readonly resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
}

/**
 * LLM provider that dynamically projects a CLI's configured models.
 * @param options - Native catalog reader and Harness services.
 */
export class NativeProviderLlmAdapter extends LlmAdapter {
  constructor(private readonly options: NativeProviderLlmAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.displayName }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertProvider(provider)
    const routes = await this.options.routes()
    const result: LlmModelInfo[] = []
    for (const route of routes) {
      try {
        const { adapter, nativeProvider } = this.routeAdapter(route)
        for (const model of await adapter.listModels(nativeProvider)) {
          result.push({
            ...model,
            provider,
            id: nativeModelId(route.modelNamespace ?? route.id, model.id),
            name: modelName(route.displayName, model.name),
          })
        }
      } catch (error) {
        if (this.options.onRouteError === undefined) throw error
        this.options.onRouteError(route, error)
      }
    }
    return result
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    this.assertProvider(provider)
    const selection = await this.select(model)
    const resolved = await selection.adapter.resolveModel(selection.nativeProvider, selection.nativeModel, signal)
    return {
      ...resolved,
      provider,
      id: model,
      name: modelName(selection.route.displayName, resolved.name),
    }
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    this.assertProvider(provider)
    const selection = await this.select(model)
    const prepared = await selection.adapter.prepareCall(selection.nativeProvider, selection.nativeModel, signal)
    return {
      model: {
        ...prepared.model,
        provider,
        id: model,
        name: modelName(selection.route.displayName, prepared.model.name),
      },
      stream: options => prepared.stream({
        ...options,
        provider: selection.nativeProvider,
        model: selection.nativeModel,
      }),
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal)
    yield* prepared.stream(options)
  }

  private async select(model: string): Promise<NativeModelSelection> {
    const identity = parseNativeModelId(model)
    const routes = await this.options.routes()
    const namespaceRoutes = routes.filter(candidate => (candidate.modelNamespace ?? candidate.id) === identity.provider)
    if (namespaceRoutes.length === 0) {
      throw new LlmError(`native provider route "${identity.provider}" is not configured`, 'UNKNOWN_MODEL')
    }
    const route = namespaceRoutes.find(candidate => candidate.models.some(entry => entry.id === identity.model))
    if (route === undefined) {
      throw new LlmError(`native provider "${identity.provider}" has no configured model "${identity.model}"`, 'UNKNOWN_MODEL')
    }
    const { adapter, nativeProvider } = this.routeAdapter(route)
    return { route, adapter, nativeProvider, nativeModel: identity.model }
  }

  private routeAdapter(route: NativeProviderLlmRoute): NativeRouteAdapter {
    const nativeProvider = route.id
    const profile = {
      ...route.profile,
      displayName: route.displayName,
      models: route.models.map(model => ({ ...model })),
    }
    const profiles = resolveProfiles({ [nativeProvider]: profile })
    const auth = route.allowAmbientAuth === false
      ? {
        credentials: this.options.auth.credentials,
        authContext: {
          ...this.options.auth.authContext,
          env: () => Promise.resolve(undefined),
        },
      }
      : this.options.auth
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: () => route.resolveApiKey(),
      auth,
      ...(this.options.resolveAttachments === undefined ? {} : { resolveAttachments: this.options.resolveAttachments }),
      ...(this.options.resolveImageAccess === undefined ? {} : { resolveImageAccess: this.options.resolveImageAccess }),
    })
    return { adapter, nativeProvider }
  }

  private assertProvider(provider: string): void {
    if (provider !== this.options.provider) {
      throw new LlmError(`native agent adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
  }
}

interface NativeRouteAdapter {
  readonly adapter: PiAiAdapter
  readonly nativeProvider: string
}

interface NativeModelSelection extends NativeRouteAdapter {
  readonly route: NativeProviderLlmRoute
  readonly nativeModel: string
}

interface NativeModelIdentity {
  readonly provider: string
  readonly model: string
}

/** Encode a native provider/model pair into the fixed Harness provider's model id. */
function nativeModelId(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`
}

/** Parse a model id produced by {@link nativeModelId}. */
function parseNativeModelId(value: string): NativeModelIdentity {
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) {
    throw new LlmError(`native model id "${value}" must name both provider and model`, 'UNKNOWN_MODEL')
  }
  try {
    const provider = decodeURIComponent(value.slice(0, separator))
    const model = decodeURIComponent(value.slice(separator + 1))
    return { provider, model }
  } catch (error) {
    throw new LlmError(`native model id "${value}" is not a valid encoded provider/model pair`, 'UNKNOWN_MODEL', { cause: error })
  }
}

/** Distinguish equal model names from different CLI-owned providers. */
function modelName(provider: string, model: string): string {
  return `${provider} / ${model}`
}

/**
 * Create read-only pi-ai auth injections for a CLI-owned route.
 *
 * Credential reads are empty because the CLI's own route resolver supplies its
 * credential. A refresh or login that tries to write through pi-ai fails rather
 * than copying a credential into the Harness credential domain.
 * @param ctx - Context used to resolve the host launch environment.
 * @param environment - Native agent environment values checked before the launch snapshot.
 * @returns pi-ai auth services that cannot persist native credentials.
 */
export function nativeProviderAuth(
  ctx: Context,
  environment: Readonly<Record<string, string | undefined>> = {},
): PiAiAuthInjection {
  const credentials: CredentialStore = {
    read: () => Promise.resolve(undefined),
    list: (): Promise<readonly CredentialInfo[]> => Promise.resolve([]),
    modify: (): Promise<Credential | undefined> => Promise.reject(
      new LlmError('native agent credentials are read-only through the Harness LLM route', 'UNSUPPORTED_AUTH'),
    ),
    delete: () => Promise.resolve(undefined),
  }
  const authContext: AuthContext = {
    env: name => Promise.resolve(environment[name] ?? launchEnvironmentOf(ctx).get(name)?.value),
    async fileExists(path) {
      const expanded = path.startsWith('~/') || path === '~'
        ? resolvePath(homedir(), path.slice(1).replace(/^\//, ''))
        : path
      try {
        await access(expanded)
        return true
      } catch (error) {
        // Missing, unreadable, and broken links all mean the ambient provider
        // credential source is unavailable.
        void error
        return false
      }
    },
  }
  return { credentials, authContext }
}

/**
 * Create image services for a CLI-owned route from the current Harness context.
 * @param ctx - Context containing the optional attachment and filesystem services.
 * @returns hooks that preserve request image bytes and map normalized images into the current tool world.
 */
export function nativeProviderImages(
  ctx: Context,
): Pick<NativeProviderLlmAdapterOptions, 'resolveAttachments' | 'resolveImageAccess'> {
  return {
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  }
}
