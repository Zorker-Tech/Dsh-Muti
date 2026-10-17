/**
 * A fake `ctx.agentMesh` for the collaboration suite: it records every dispatch,
 * settles a run only when the test says so, and answers session and native-task
 * reads from maps.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/tests/support/fake-mesh
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  AgentAdapter,
  AgentId,
  AgentNativeTasks,
  AgentRunId,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  AgentSession,
  MeshRunHandle,
  MeshRunSnapshot,
} from '@deepseek-ai/dsh-agent-mesh'
import type { CollaborationMeshPort } from '../../src/types.ts'

/** One dispatched run the fake tracks. */
interface FakeRun {
  readonly runId: AgentRunId
  readonly agentId: AgentId
  readonly request: AgentRunRequest
  status: AgentRunStatus
  note?: string
  readonly result: Promise<AgentRunResult>
  readonly done: Promise<void>
  settleResult: (result: AgentRunResult) => void
  settleDone: () => void
}

/** A scripted mesh registry. */
export class FakeMesh implements CollaborationMeshPort {
  /** Every dispatch, in order. */
  readonly starts: { agentId: string; request: AgentRunRequest }[] = []

  /** Sessions per agent id, as `listSessions` returns them. */
  readonly sessions = new Map<string, AgentSession[]>()

  /** Native task state keyed by `<agentId>:<nativeId>`. */
  readonly nativeTasks = new Map<string, AgentNativeTasks>()

  private readonly runs = new Map<string, FakeRun>()
  private readonly evicted = new Set<string>()
  private readonly broken = new Map<string, string>()
  private counter = 0

  /**
   * Dispatch one run and hold it open until {@link settle}.
   * @param agentId - Agent to run.
   * @param request - Prompt, working directory, and options.
   * @returns the run's identity and a result promise that resolves on settlement.
   */
  startRun(agentId: AgentId | string, request: AgentRunRequest): MeshRunHandle {
    this.counter += 1
    const runId = brandString<AgentRunId>(`run-${String(this.counter)}`)
    this.starts.push({ agentId: String(agentId), request })
    let settleResult: (result: AgentRunResult) => void = () => {
      throw new Error('the fake run was not wired')
    }
    let settleDone: () => void = () => {
      throw new Error('the fake run was not wired')
    }
    const result = new Promise<AgentRunResult>((resolve) => { settleResult = resolve })
    const done = new Promise<void>((resolve) => { settleDone = resolve })
    this.runs.set(runId, {
      runId,
      agentId: brandString<AgentId>(String(agentId)),
      request,
      status: 'running',
      result,
      done,
      settleResult,
      settleDone,
    })
    return { runId, result }
  }

  /**
   * Settle one run the way the mesh would when its adapter finishes.
   * @param runId - Run to settle.
   * @param status - Terminal status.
   * @param error - Classified failure, when the run failed.
   */
  settle(runId: string, status: AgentRunStatus, error?: { code: string; message: string }): void {
    const run = this.runs.get(runId)
    if (run === undefined) throw new Error(`the fake mesh has no run "${runId}"`)
    run.status = status
    if (error !== undefined) run.note = error.message
    run.settleResult({
      runId: run.runId,
      agentId: run.agentId,
      status,
      startedAt: '2026-10-16T00:00:00.000Z',
      finishedAt: '2026-10-16T00:00:01.000Z',
      durationMs: 1000,
      cwd: run.request.cwd,
      notes: [],
      ...(error === undefined ? {} : { error }),
    })
    run.settleDone()
  }

  /**
   * Answer `waitForRun` with undefined for one run, as an evicted registry entry does.
   * @param runId - Run whose settlement is dropped.
   */
  evict(runId: string): void {
    this.evicted.add(runId)
  }

  /**
   * Make `waitForRun` reject for one run, as a defective adapter would.
   * @param runId - Run whose wait fails.
   * @param message - Message the rejection carries.
   */
  breakRun(runId: string, message: string): void {
    this.broken.set(runId, message)
  }

  /**
   * Wait for one run to settle.
   * @param runId - Run identity.
   * @returns the terminal snapshot, or undefined for an unknown or evicted run.
   */
  async waitForRun(runId: string): Promise<MeshRunSnapshot | undefined> {
    const failure = this.broken.get(runId)
    if (failure !== undefined) {
      this.broken.delete(runId)
      throw new Error(failure)
    }
    const run = this.runs.get(runId)
    if (run === undefined) return undefined
    await run.done
    if (this.evicted.has(runId)) return undefined
    return {
      runId: run.runId,
      agentId: run.agentId,
      cwd: run.request.cwd,
      prompt: run.request.prompt,
      status: run.status,
      startedAt: '2026-10-16T00:00:00.000Z',
      finishedAt: '2026-10-16T00:00:01.000Z',
      notes: [],
      events: [],
      eventCount: 0,
      ...(run.note === undefined ? {} : { error: { code: 'run/agent-crashed', message: run.note } }),
    }
  }

  /**
   * Resolve one agent's reads.
   * @param id - Agent identity.
   * @returns the session and native-task reads for that agent.
   */
  adapter(id: AgentId | string): Pick<AgentAdapter, 'listSessions' | 'readNativeTasks'> {
    const key = String(id)
    return {
      listSessions: async () => this.sessions.get(key) ?? [],
      readNativeTasks: async request => this.nativeTasks.get(`${key}:${request.session.nativeId}`)
        ?? { available: false, todos: [], notes: [] },
    }
  }
}
