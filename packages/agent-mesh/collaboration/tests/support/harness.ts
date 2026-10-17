/**
 * The collaboration suite's shared harness: the mounted service over a scripted
 * host, a scripted mesh, and real storage, plus the call helpers every spec uses.
 *
 * The host is armed immediately before mounting; each spec file runs its tests one
 * at a time, so the static hand-off cannot interleave.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/tests/support/harness
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { AgentHost } from '@deepseek-ai/dsh-agent-mesh'
import { CollaborationError } from '../../src/errors.ts'
import { MeshCollaboration } from '../../src/index.ts'
import type { Config } from '../../src/index.ts'
import { FakeHost } from './fake-host.ts'
import { FakeMesh } from './fake-mesh.ts'

const roots: string[] = []
const fibers: Fiber[] = []
let approvalAgentNumber = 0

/** The service under test with the scripted host injected. */
export class HostedCollaboration extends MeshCollaboration {
  /** The host the next mount uses. */
  static armed: FakeHost | undefined

  /** {@link MeshCollaboration.createHost} with the armed host. */
  protected override createHost(): AgentHost {
    const host = HostedCollaboration.armed
    if (host === undefined) throw new Error('a collaboration mount requires an armed fake host')
    HostedCollaboration.armed = undefined
    return host
  }
}

/** One mounted harness: the context, the scripted host and mesh, and the service. */
export interface Harness {
  /** The owning context. */
  readonly ctx: Context
  /** The scripted host. */
  readonly host: FakeHost
  /** The scripted mesh. */
  readonly mesh: FakeMesh
  /** The mounted service. */
  readonly service: MeshCollaboration
}

/** Mount the storage stack, the tool runtime, a scripted mesh, and the service. */
export async function mount(config: Config = {}, beforeCollaboration?: (ctx: Context) => void): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-agent-mesh-collaboration-'))
  roots.push(root)
  const ctx = new Context()
  const host = new FakeHost()
  const mesh = new FakeMesh()
  fibers.push(await ctx.plugin(Storage))
  fibers.push(await ctx.plugin(StorageJson, { root: join(root, '.storage') }))
  fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(Tools))
  fibers.push(await ctx.plugin(ApprovalService))
  ctx.on('approval/request', () => Promise.resolve<'allowed-once'>('allowed-once'))
  beforeCollaboration?.(ctx)
  // The registry is replaced by a scripted port: this suite asserts on collaboration
  // records, so it never needs an adapter that would spawn a real agent process.
  ctx.provide('agentMesh', mesh as never)
  HostedCollaboration.armed = host
  fibers.push(await ctx.plugin(HostedCollaboration, config))
  return { ctx, host, mesh, service: ctx.meshCollaboration }
}

/** Dispose every fiber the suite mounted and remove its storage roots. */
export async function unmountAll(): Promise<void> {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** Create an open session that can receive an auditable approval request. */
export function approvalAgent(): Agent {
  const session = Session.create(SessionId(`mesh-collaboration-approval-${++approvalAgentNumber}`))
  session.append('turn/start', { turn: 1 })
  return { id: session.id, session } as Agent
}

/** The value a test expects to be present, failing loudly when it is absent. */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} should be defined`)
  return value
}

/** The thrown failure of one request. */
export async function failure(run: () => Promise<unknown>): Promise<CollaborationError> {
  try {
    await run()
  } catch (error: unknown) {
    if (error instanceof CollaborationError) return error
    throw error
  }
  throw new Error('the request should have been refused')
}

/** Call one model-facing tool through the tool pipeline. */
export async function callTool(ctx: Context, name: string, args: unknown, agent?: Agent): Promise<unknown> {
  const result = await ctx.tools.execute({
    name,
    arguments: args,
    callId: ToolCallId(`call-${name}`),
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  })
  if (result.isError) {
    throw new Error(`tool ${name} failed: ${JSON.stringify(result.error)}`)
  }
  return typeof result.value === 'string' ? JSON.parse(result.value) : result.value
}

/** Call one model-facing tool and return the failure the pipeline reported. */
export async function callToolFailure(ctx: Context, name: string, args: unknown, agent?: Agent): Promise<string> {
  const result = await ctx.tools.execute({
    name,
    arguments: args,
    callId: ToolCallId(`call-${name}-failing`),
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  })
  if (!result.isError) throw new Error(`tool ${name} should have failed`)
  return JSON.stringify(result.error)
}

/** The text one successful tool call rendered for its caller. */
export async function callToolText(ctx: Context, name: string, args: unknown, agent?: Agent): Promise<string> {
  const result = await ctx.tools.execute({
    name,
    arguments: args,
    callId: ToolCallId(`call-${name}-text`),
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  })
  if (result.isError) throw new Error(`tool ${name} failed: ${JSON.stringify(result.error)}`)
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

/** Start one collaboration with a single worktree-isolated task. */
export async function startOne(
  harness: Harness,
  tasks: NonNullable<Parameters<MeshCollaboration['start']>[0]['tasks']> = [
    { title: 'write the parser', instruction: 'Write the parser.', assignee: 'codex' },
  ],
): Promise<{ collaborationId: string; taskId: string }> {
  const view = await harness.service.start({
    title: 'Ship the mesh',
    objective: 'Ship worktree-isolated collaboration',
    repoRoot: '/repo',
    tasks,
  })
  const task = required(view.tasks[0], 'the seeded task')
  return { collaborationId: view.id, taskId: task.id }
}
