import { join } from 'node:path'

export const name = 'snapshot-native-context'
export const inject = ['agentMesh', 'commands']

const agentId = 'snapshot-native-context'

const adapter = {
  id: agentId,
  async describe() {
    return {
      id: agentId,
      displayName: 'Snapshot native context',
      summary: 'Provides a fixed instruction file for the keyless Session snapshot.',
      capabilities: {
        runModes: ['headless-exec'], streaming: false, resume: false, interrupt: false,
        listSessions: false, readTranscript: false, nativeTodos: false, nativePlan: false,
        listModels: false, sandboxProfiles: [], approvalModes: [],
        credentials: { status: false, login: [], logout: false },
      },
      detection: { installed: false, source: 'none' },
      transports: [{ mode: 'headless-exec', mechanism: 'snapshot fixture', available: true }],
      environmentKeys: [],
    }
  },
  async readAuthState() {
    return { status: 'unauthenticated', source: 'none' }
  },
  async listSessions() {
    return []
  },
  async readTranscript() {
    throw new Error('snapshot adapter has no native sessions')
  },
  async readNativeTasks() {
    return { available: false, todos: [], notes: [] }
  },
  async listModels() {
    return []
  },
  async readCapabilities({ cwd }) {
    return {
      agentId,
      tools: [{ name: 'read_file', description: 'Read one file from the workspace.', source: 'builtin' }],
      skills: [], mcpServers: [],
      commands: [{ name: 'review', description: 'Review the working tree.', source: 'user', path: join(cwd, 'review.md') }],
      contextFiles: ['NATIVE_INSTRUCTIONS.md'], sources: [], notes: [],
      observedAt: '2026-10-17T00:00:00.000Z',
    }
  },
  async resolveMcpServer() {
    return undefined
  },
  startRun() {
    throw new Error('snapshot adapter does not start runs')
  },
  async login() {
    return { ok: false, action: 'login', state: { status: 'unauthenticated', source: 'none' } }
  },
  async logout() {
    return { ok: false, action: 'logout', state: { status: 'unauthenticated', source: 'none' } }
  },
}

export function apply(ctx) {
  ctx.effect(() => ctx.agentMesh.register(adapter), 'snapshot native context adapter')
  ctx.on('agent/created', async ({ agent }) => {
    await ctx.agentMesh.bind(agent.id, agentId)
  })
  let invoked = false
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || invoked) return decision
    invoked = true
    const alias = `agent-${agentId}-review`
    const execution = await ctx.commands.execute(
      agent,
      `/${alias} Inspect the staged changes and report one finding.`,
      [],
      new AbortController().signal,
    )
    if (execution?.result.kind !== 'success') throw new Error(`snapshot command /${alias} did not queue its task`)
    return decision
  }, { prepend: true })
}
