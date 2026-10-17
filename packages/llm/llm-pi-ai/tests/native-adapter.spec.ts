import { Context } from '@deepseek-ai/cordis'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeProviderLlmAdapter, nativeProviderAuth, nativeProviderImages } from '../src/native-adapter.ts'
import type { NativeProviderLlmRoute } from '../src/native-adapter.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(closeMockServers)

function route(overrides: Partial<NativeProviderLlmRoute> = {}): NativeProviderLlmRoute {
  return {
    id: 'gateway',
    modelNamespace: 'vendor/region',
    displayName: 'Gateway',
    profile: { api: 'openai-completions', baseURL: 'https://gateway.example/v1' },
    models: [{ id: 'model/with-slash', name: 'Model' }],
    resolveApiKey: () => Promise.resolve('native-key'),
    ...overrides,
  }
}

describe('NativeProviderLlmAdapter', () => {
  it('projects routes into one provider and sends the selected native model', async () => {
    const server = await mockServer([{ events: textEvents }])
    const native = route({ profile: { api: 'openai-completions', baseURL: server.url } })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['agent-native'], new NativeProviderLlmAdapter({
      provider: 'agent-native',
      displayName: 'Native Agent',
      routes: async () => [native],
      auth: memoryAuth(),
    }))

    expect(ctx.llm.listProviders()).toContainEqual({ id: 'agent-native', name: 'Native Agent' })
    await expect(ctx.llm.listModels('agent-native')).resolves.toEqual([{
      provider: 'agent-native',
      id: 'vendor%2Fregion/model%2Fwith-slash',
      name: 'Gateway / Model',
      inputModalities: ['text'],
    }])
    await expect(ctx.llm.resolveModelInfo('agent-native', 'vendor%2Fregion/model%2Fwith-slash'))
      .resolves.toMatchObject({
        provider: 'agent-native',
        id: 'vendor%2Fregion/model%2Fwith-slash',
        name: 'Gateway / Model',
      })

    const assembled = await assemble(ctx, {
      provider: 'agent-native',
      model: 'vendor%2Fregion/model%2Fwith-slash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      })],
    })
    expect(assembled.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(assembled.finish).toEqual({ kind: 'stop' })
    expect(server.paths).toEqual(['/chat/completions'])
    expect(server.requests[0]).toMatchObject({ model: 'model/with-slash' })
    expect(server.headers[0]?.authorization).toBe('Bearer native-key')
  })

  it('uses route error reporting while preserving models from other routes', async () => {
    const failures: unknown[] = []
    const adapter = new NativeProviderLlmAdapter({
      provider: 'agent-native',
      displayName: 'Native Agent',
      routes: async () => [
        route({ id: 'bad', profile: { api: 'not-a-supported-api' } }),
        route({ id: 'good' }),
      ],
      onRouteError: (_route, error) => failures.push(error),
      auth: memoryAuth(),
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['agent-native'], adapter)

    await expect(ctx.llm.listModels('agent-native')).resolves.toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(Error)
  })

  it('propagates route errors when no diagnostic callback is configured', async () => {
    const adapter = new NativeProviderLlmAdapter({
      provider: 'agent-native',
      displayName: 'Native Agent',
      routes: async () => [route({ profile: { api: 'not-a-supported-api', baseURL: 'https://gateway.example/v1' } })],
      auth: memoryAuth(),
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['agent-native'], adapter)

    await expect(ctx.llm.listModels('agent-native')).rejects.toThrow('not-a-supported-api')
  })

  it('rejects foreign provider ids, unknown route/model ids, and malformed encoded ids', async () => {
    const adapter = new NativeProviderLlmAdapter({
      provider: 'agent-native',
      displayName: 'Native Agent',
      routes: async () => [route()],
      auth: memoryAuth(),
    })

    await expect(adapter.listModels('other')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    await expect(adapter.resolveModel('agent-native', '/model')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await expect(adapter.resolveModel('agent-native', 'provider/')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await expect(adapter.resolveModel('agent-native', 'vendor%2Fother/model'))
      .rejects.toThrow('is not configured')
    await expect(adapter.resolveModel('agent-native', 'vendor%2Fregion/missing'))
      .rejects.toThrow('has no configured model')
    await expect(adapter.resolveModel('agent-native', 'vendor%2Fregion/%'))
      .rejects.toThrow('not a valid encoded provider/model pair')
    await expect(adapter.resolveModel('agent-native', 'vendor%2Fregion/model%2Fwith-slash'))
      .resolves.toMatchObject({ provider: 'agent-native', name: 'Gateway / Model' })
  })

  it('prepares and streams a call with native identifiers and optional attachment hooks', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = new NativeProviderLlmAdapter({
      provider: 'agent-native',
      displayName: 'Native Agent',
      routes: async () => [route({ profile: { api: 'openai-completions', baseURL: server.url } })],
      auth: memoryAuth(),
      resolveAttachments: () => undefined,
      resolveImageAccess: () => undefined,
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['agent-native'], adapter)

    const prepared = await adapter.prepareCall('agent-native', 'vendor%2Fregion/model%2Fwith-slash')
    expect(prepared.model.name).toBe('Gateway / Model')
    const chunks = []
    for await (const chunk of prepared.stream({
      provider: 'agent-native',
      model: 'vendor%2Fregion/model%2Fwith-slash',
      messages: [],
    })) chunks.push(chunk)
    expect(chunks.length).toBeGreaterThan(0)
    expect(server.requests[0]).toMatchObject({ model: 'model/with-slash' })
  })

  it('defaults the model namespace to its provider id and streams through the adapter entry', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = new NativeProviderLlmAdapter({
      provider: 'agent-native',
      displayName: 'Native Agent',
      routes: async () => [{
        id: 'gateway',
        displayName: 'Gateway',
        profile: { api: 'openai-completions', baseURL: server.url },
        models: [{ id: 'model' }],
        resolveApiKey: () => Promise.resolve('native-key'),
      }],
      auth: memoryAuth(),
    })

    await expect(adapter.listModels('agent-native')).resolves.toMatchObject([
      { id: 'gateway/model', name: 'Gateway / model' },
    ])
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'agent-native',
      model: 'gateway/model',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      })],
    })) chunks.push(chunk)
    expect(chunks.length).toBeGreaterThan(0)
    expect(server.requests[0]).toMatchObject({ model: 'model' })
  })

  it('does not add ambient credentials to a native keyless route', async () => {
    const server = await mockServer([{ events: textEvents }])
    const auth = memoryAuth()
    auth.authContext.env = async () => 'ambient-secret'
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['agent-native'], new NativeProviderLlmAdapter({
      provider: 'agent-native',
      displayName: 'Native Agent',
      routes: async () => [route({
        id: 'openai',
        modelNamespace: 'openai',
        displayName: 'OpenAI',
        models: [{ id: 'gpt-5' }],
        profile: { api: 'openai-completions', baseURL: server.url },
        allowAmbientAuth: false,
        resolveApiKey: () => Promise.resolve(undefined),
      })],
      auth,
    }))

    await assemble(ctx, {
      provider: 'agent-native',
      model: 'openai/gpt-5',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      })],
    })
    expect(server.headers[0]?.authorization).toBeUndefined()
  })
})

describe('nativeProviderAuth', () => {
  it('keeps pi-ai credential writes read-only and resolves launch environment lookups', async () => {
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: { LAUNCH_KEY: 'from-launch' } },
    ]))
    const auth = nativeProviderAuth(ctx, { DIRECT_KEY: 'from-agent' })

    await expect(auth.credentials.read('openai')).resolves.toBeUndefined()
    await expect(auth.credentials.list()).resolves.toEqual([])
    await expect(auth.credentials.delete('openai')).resolves.toBeUndefined()
    await expect(auth.credentials.modify('openai', async () => undefined)).rejects.toMatchObject({
      code: 'UNSUPPORTED_AUTH',
    })
    await expect(auth.authContext.env('DIRECT_KEY')).resolves.toBe('from-agent')
    await expect(auth.authContext.env('LAUNCH_KEY')).resolves.toBe('from-launch')
    await expect(auth.authContext.env('MISSING_KEY')).resolves.toBeUndefined()
  })

  it('checks direct and home-relative paths without throwing for missing files', async () => {
    const auth = nativeProviderAuth(new Context())
    await expect(auth.authContext.fileExists('/tmp')).resolves.toBe(true)
    await expect(auth.authContext.fileExists('/path/that/cannot/exist')).resolves.toBe(false)
    await expect(auth.authContext.fileExists('~/..')).resolves.toBe(true)
    await expect(auth.authContext.fileExists('~')).resolves.toBe(true)
  })
})

class ImagePathAttachmentStore extends AttachmentStore {
  override readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1,
    maxImagePixels: 1,
    maxImageDimension: 1,
    mediaTypes: ['image/png'],
  }

  constructor(ctx: Context, private readonly hostPath?: string) {
    super(ctx)
  }

  override validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.reject(new Error('not used'))
  }

  override saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('not used'))
  }

  override readImage(ref: ImageAttachmentRef, _signal?: AbortSignal): Promise<StoredImageAttachment> {
    return Promise.reject(new Error(`not used: ${ref.attachmentId}`))
  }

  override imageHostPath(_ref: ImageAttachmentRef): string | undefined {
    return this.hostPath
  }
}

describe('nativeProviderImages', () => {
  it('resolves attachments and maps normalized image paths into the current tool world', () => {
    const ctx = new Context()
    ctx.provide('fs', {
      processPathFromHostPath: (path: string) => path.replace('/host/', '/tool/'),
    } as never)
    new ImagePathAttachmentStore(ctx, '/host/normalized/image.png')
    const attachments = ctx.attachments
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId('sha256:0123456789abcdef'),
      mediaType: 'image/png',
      bytes: 12,
      width: 1,
      height: 1,
    }
    const images = nativeProviderImages(ctx)
    expect(images.resolveAttachments?.()?.imageHostPath(ref)).toBe('/host/normalized/image.png')
    const resolveImageAccess = images.resolveImageAccess
    if (resolveImageAccess === undefined) expect.unreachable('native image access must be configured')
    expect(resolveImageAccess(attachments, ref)).toEqual({ readonlyPath: '/tool/normalized/image.png' })

    const missingContext = new Context()
    new ImagePathAttachmentStore(missingContext)
    const missingPath = missingContext.attachments
    expect(resolveImageAccess(missingPath, ref)).toBeUndefined()
    expect(nativeProviderImages(new Context()).resolveAttachments?.()).toBeUndefined()
    expect(nativeProviderImages(new Context()).resolveImageAccess?.(attachments, ref)).toBeUndefined()
  })
})
