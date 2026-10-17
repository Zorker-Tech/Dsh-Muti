/**
 * Reads the developer machine's real agent installations through the family,
 * inside a booted shipped profile, and writes what it observed.
 *
 * Every claim here is about real data: which agents were detected, how many of
 * their own sessions the adapters listed, whether a transcript projected into
 * messages, which credential state was observed, and what native task state
 * exists. The test skips when a machine has no such installation.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextHost } from '@deepseek-ai/dsh-agent-mesh'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { ompAdapter, readOmpSessionView } from '../../../agent-omp/src/index.ts'

/** What a direct version probe through the host port observed. */
interface ProbeObservation {
  readonly code: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly stdoutLines: number
  readonly stderrHead: string
}

/** One agent's observation. */
interface AgentObservation {
  readonly probe?: ProbeObservation
  readonly binaryPath?: string
  readonly sessionRoot?: string
  readonly agentId: string
  readonly installed: boolean
  readonly version: string
  readonly detectionReason: string
  readonly sessionCount: number
  readonly firstSessionKey: string
  readonly firstSessionTitle: string
  readonly firstSessionStatus: string
  readonly firstSessionNotes?: readonly string[]
  readonly transcriptMessages: number
  readonly transcriptKinds: readonly string[]
  readonly transcriptNotes: number
  readonly authStatus: string
  readonly authSource: string
  readonly nativeTodos: number
  readonly nativePlanItems: number
  readonly error?: string
  readonly cliStoreRoundTrip?: {
    readonly nativeId: string
    readonly cwd: string
    readonly headerVersion: number
    readonly entryTypes: readonly string[]
    readonly transcriptMessages: number
    readonly runStatus: string
    readonly runSessionKey: string
    readonly runEventKinds: readonly string[]
  }
}

/** A session made by the real OMP RPC process in an isolated temporary store. */
interface OmpCliStoreRoundTrip {
  readonly nativeId: string
  readonly cwd: string
  readonly headerVersion: number
  readonly entryTypes: readonly string[]
  readonly transcriptMessages: number
  readonly runStatus: string
  readonly runSessionKey: string
  readonly runEventKinds: readonly string[]
}

/**
 * Spawn the agent binary's `--version` through the host port and report what
 * came back, so a detection that succeeds while a probe fails is visible.
 * @param ctx - Booted composition context.
 * @param binaryPath - Resolved binary, when detection found one.
 * @returns the probe observation, or undefined when no binary was resolved.
 */
async function probeReport(
  ctx: Parameters<typeof createContextHost>[0],
  binaryPath: string | undefined,
): Promise<ProbeObservation | undefined> {
  if (binaryPath === undefined) return undefined
  const host = createContextHost(ctx, {})
  const process_ = host.spawn({ command: binaryPath, args: ['--version'], cwd: host.home, env: host.env, timeoutMs: 10_000 })
  let stdoutLines = 0
  for await (const line of process_.lines) {
    void line
    stdoutLines += 1
  }
  const exit = await process_.exit
  return { code: exit.code, signal: exit.signal, timedOut: exit.timedOut, stdoutLines, stderrHead: (await process_.stderr()).slice(0, 200) }
}

/** Run OMP's local model command through the adapter in an isolated store, without a model request. */
async function readOmpCliStoreRoundTrip(
  ctx: Parameters<typeof createContextHost>[0],
  binaryPath: string,
): Promise<OmpCliStoreRoundTrip> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-omp-store-roundtrip-'))
  const agentDir = join(root, 'agent')
  const env = {
    PATH: process.env['PATH'] ?? '',
    HOME: root,
    USERPROFILE: root,
    TMPDIR: tmpdir(),
    TEMP: tmpdir(),
    OMP_PROFILE: 'default',
    PI_CODING_AGENT_DIR: agentDir,
    OPENAI_API_KEY: 'dsh-store-smoke-unused',
    ...(process.env['SystemRoot'] === undefined ? {} : { SystemRoot: process.env['SystemRoot'] }),
  }
  const host = createContextHost(ctx, { env, home: root })
  try {
    const adapter = ompAdapter(host, { binaryPath, homeDir: agentDir })
    const run = adapter.startRun({ prompt: '/model', cwd: root, model: 'openai/gpt-5.2' })
    const runEvents: string[] = []
    for await (const event of run) runEvents.push(event.kind)
    const runResult = await run.result
    if (runResult.status !== 'succeeded' || runResult.nativeSessionKey === undefined) {
      throw new Error(`isolated OMP adapter RPC run failed (${runResult.status}): ${runResult.error?.message ?? 'no native session'}`)
    }
    const sessions = await adapter.listSessions({ limit: 5 })
    if (sessions.length !== 1) throw new Error(`OMP created ${String(sessions.length)} sessions in its isolated store`)
    const session = sessions[0]
    if (session === undefined || session.nativePath === undefined) {
      throw new Error('OMP did not expose the isolated session file it created')
    }
    const view = await readOmpSessionView(host, session.nativePath, 256 * 1024)
    if (view.header?.version !== 3) throw new Error('OMP did not write a readable v3 session header')
    const transcript = await adapter.readTranscript({ session })
    return {
      nativeId: session.nativeId,
      cwd: session.cwd ?? '',
      headerVersion: view.header.version,
      entryTypes: view.entries.map(entry => entry.type),
      transcriptMessages: transcript.messages.length,
      runStatus: runResult.status,
      runSessionKey: runResult.nativeSessionKey,
      runEventKinds: runEvents,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const overlay = process.argv[2]
if (overlay === undefined) throw new Error('real-stores fixture requires its overlay')

const observations: AgentObservation[] = []
const ctx = await bootProductionProfile({
  binName: 'agent-mesh-real-stores',
  profile: 'headless',
  overlayPaths: [overlay],
})
try {
  const mesh = ctx.get('agentMesh')
  if (mesh === undefined) throw new Error('the agent mesh did not mount')

  for (const agentId of mesh.ids) {
    const adapter = mesh.adapter(agentId)
    const base = {
      agentId: String(agentId),
      installed: false,
      version: '',
      detectionReason: '',
      sessionCount: 0,
      firstSessionKey: '',
      firstSessionTitle: '',
      firstSessionStatus: '',
      transcriptMessages: 0,
      transcriptKinds: [] as string[],
      transcriptNotes: 0,
      authStatus: '',
      authSource: '',
      nativeTodos: 0,
      nativePlanItems: 0,
    }
    try {
      const descriptor = await adapter.describe()
      const auth = await adapter.readAuthState()
      const sessions = await adapter.listSessions({ limit: 5 })
      const first = sessions[0]
      let messages = 0
      let kinds: string[] = []
      let notes = 0
      let nativeTodos = 0
      let nativePlanItems = 0
      if (first !== undefined) {
        const transcript = await adapter.readTranscript({ session: first, maxMessages: 10 })
        messages = transcript.messages.length
        kinds = [...new Set(transcript.messages.map(message => message.kind))]
        notes = transcript.notes.length
        const tasks = await adapter.readNativeTasks({ session: first })
        nativeTodos = tasks.todos.length
        nativePlanItems = tasks.plan?.items.length ?? 0
      }
      const probe = await probeReport(ctx, descriptor.detection.binaryPath)
      const cliStoreRoundTrip = agentId === 'omp' && descriptor.detection.binaryPath !== undefined
        ? await readOmpCliStoreRoundTrip(ctx, descriptor.detection.binaryPath)
        : undefined
      observations.push({
        ...base,
        ...(probe === undefined ? {} : { probe }),
        binaryPath: descriptor.detection.binaryPath ?? '',
        sessionRoot: descriptor.sessionRoot ?? '',
        installed: descriptor.detection.installed,
        version: descriptor.detection.version ?? '',
        detectionReason: descriptor.detection.reason ?? '',
        sessionCount: sessions.length,
        firstSessionKey: first?.key ?? '',
        firstSessionTitle: first?.title ?? '',
        firstSessionStatus: first?.status ?? '',
        firstSessionNotes: first === undefined ? [] : [...first.notes],
        transcriptMessages: messages,
        transcriptKinds: kinds,
        transcriptNotes: notes,
        authStatus: auth.status,
        authSource: auth.source,
        nativeTodos,
        nativePlanItems,
        ...(cliStoreRoundTrip === undefined ? {} : { cliStoreRoundTrip }),
      })
    } catch (error: unknown) {
      observations.push({ ...base, error: error instanceof Error ? error.message : String(error) })
    }
  }
} finally {
  await ctx.fiber.dispose()
}

await writeFile('agent-mesh-real-stores.json', JSON.stringify(observations, null, 2))
