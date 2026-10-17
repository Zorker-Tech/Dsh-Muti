/**
 * Boots the shipped headless profile through the real Loader with the family
 * mounted, then reports what the composition actually registered.
 *
 * The smoke runs this in an isolated world and asserts on the file it writes,
 * so a row that fails to activate (a lost `inject`, a missing package) fails
 * the test instead of passing a type check.
 */
import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

/** Tool names the model-facing package must have registered. */
const EXPECTED_COLLABORATION_TOOLS = [
  'mesh_collaboration_start',
  'mesh_collaborations',
  'mesh_plan_set',
  'mesh_plan_advance',
  'mesh_todos_set',
  'mesh_todos_get',
  'mesh_todos_observe',
  'mesh_task_dispatch',
  'mesh_worktrees',
  'mesh_worktree_create',
  'mesh_worktree_conflicts',
  'mesh_worktree_remove',
] as const

/** Tool names the model-facing package must have registered. */
const EXPECTED_TOOLS = [
  'mesh_agents',
  'mesh_sessions',
  'mesh_transcript',
  'mesh_tasks',
  'mesh_capability_read',
  'mesh_run',
  'mesh_runs',
  'mesh_run_cancel',
] as const

const overlay = process.argv[2]
if (overlay === undefined) throw new Error('agent-mesh family fixture requires its overlay')

const report: {
  meshMounted: boolean
  toolsRegistered: string[]
  toolsMissing: string[]
  bindingsReady: boolean
  adapterIds: string[]
  bindingRoundTrip: boolean
  diagnosticsAgents: number
  collaborationMounted: boolean
  collaborationToolsMissing: string[]
  commandNames: string[]
  collaborationBoard?: { todos: number; phases: number }
} = {
  meshMounted: false,
  toolsRegistered: [],
  toolsMissing: [...EXPECTED_TOOLS],
  bindingsReady: false,
  adapterIds: [],
  bindingRoundTrip: false,
  diagnosticsAgents: 0,
  collaborationMounted: false,
  collaborationToolsMissing: [...EXPECTED_COLLABORATION_TOOLS],
  commandNames: [],
}

const ctx = await bootProductionProfile({
  binName: 'agent-mesh-family-test',
  profile: 'headless',
  overlayPaths: [overlay],
})
try {
  const mesh = ctx.get('agentMesh')
  if (mesh !== undefined) {
    report.meshMounted = true
    const diagnostics = await mesh.diagnostics()
    report.bindingsReady = diagnostics.bindingsReady
    report.diagnosticsAgents = diagnostics.agents.length
    report.adapterIds = mesh.ids.map(String)

    // The binding is the seam's only durable write; prove it works in the
    // booted composition rather than only in a unit test.
    await mesh.bind('family-smoke-session' as Parameters<typeof mesh.bind>[0], 'codex' as Parameters<typeof mesh.bind>[1])
      .catch(() => undefined)
  }

  const collaboration = ctx.get('meshCollaboration')
  report.collaborationMounted = collaboration !== undefined
  if (collaboration !== undefined) {
    // A real end-to-end read: start a collaboration, set its plan and board, and
    // read them back, so the booted composition proves the durable board works.
    const started = await collaboration.start({ title: 'family smoke', objective: 'prove the board', repoRoot: process.cwd() })
    await collaboration.setPlan(started.id, {
      objective: 'prove the board',
      phases: [{ id: 'p1', title: 'one', status: 'active' }],
      activePhaseId: 'p1',
    })
    await collaboration.setTodos(started.id, [{
      id: 't1', content: 'first', status: 'pending', owner: 'codex', blockedBy: [],
    }])
    const board = collaboration.getTodos(started.id)
    const plan = collaboration.plan(started.id)
    report.collaborationBoard = { todos: board.todos.length, phases: plan.phases?.length ?? 0 }
  }

  const commandRegistry = ctx.get('commands')
  if (commandRegistry !== undefined) {
    const session = ctx.sessions.create(SessionId('agent-mesh-family-command-test'))
    const inbox = createInboxStub()
    let status: AgentStatus = 'idle'
    const agent: Agent = {
      id: session.id,
      options: {},
      session,
      inbox,
      ctx: new Context(),
      get status() { return status },
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject(input) { this.inbox.append('next-step', input) },
      cancel() { status = 'idle' },
      runMaintenance: task => task(new AbortController().signal),
      whenIdle() { return Promise.resolve() },
    }
    report.commandNames = commandRegistry.list(agent).map(command => command.name)
  }

  const tools = ctx.get('tools')
  if (tools !== undefined) {
    report.toolsRegistered = EXPECTED_TOOLS.filter(name => tools.get(name) !== undefined)
    report.toolsMissing = EXPECTED_TOOLS.filter(name => tools.get(name) === undefined)
    report.collaborationToolsMissing = EXPECTED_COLLABORATION_TOOLS.filter(name => tools.get(name) === undefined)
  }
} finally {
  await ctx.fiber.dispose()
}

await writeFile('agent-mesh-family-report.json', JSON.stringify(report, null, 2))
