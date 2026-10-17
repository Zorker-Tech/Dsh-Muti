/**
 * Dispatch and observation of external-agent runs.
 *
 * The registry owns one in-process record per run: the request that produced
 * it, the events the agent projected so far (bounded), and the terminal
 * result. It never spawns anything itself — an adapter's `startRun` owns the
 * transport — and it never rejects: a run that fails becomes a record with a
 * terminal `failed` status and a classified error.
 * @module @deepseek-ai/dsh-agent-mesh/runs
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  AgentAdapter,
  AgentId,
  AgentRunEvent,
  AgentRunId,
  AgentRunRequest,
  AgentRunResult,
  AgentRunStatus,
  MeshRunHandle,
  MeshRunSnapshot,
} from './types.ts'

export type { MeshRunHandle, MeshRunSnapshot } from './types.ts'

/** Events retained per run, newest last. */
const DEFAULT_RETAINED_EVENTS = 200
/** Terminal records retained after completion, newest first. */
const DEFAULT_RETAINED_RUNS = 50

/** Bounded retention options for {@link AgentRunRegistry}. */
export interface AgentRunRegistryOptions {
  /** Events retained per run; defaults to 200. */
  readonly retainedEvents?: number
  /** Terminal runs retained; defaults to 50. */
  readonly retainedRuns?: number
}

/** One run's mutable record. */
interface RunState {
  readonly runId: AgentRunId
  readonly agentId: AgentId
  readonly cwd: string
  readonly prompt: string
  status: AgentRunStatus
  startedAt: string
  finishedAt?: string
  result?: AgentRunResult
  events: AgentRunEvent[]
  eventCount: number
  readonly cancel: (reason?: string) => void
  settled: Promise<void>
}

/**
 * Tracks dispatched runs, their projected events, and their terminal results.
 * One registry lives on the mesh service and is disposed with it, cancelling
 * every run still in flight.
 */
export class AgentRunRegistry {
  private readonly runs = new Map<AgentRunId, RunState>()
  private readonly retainedEvents: number
  private readonly retainedRuns: number

  /**
   * @param ctx - Context used for diagnostics on a misbehaving adapter.
   * @param options - Retention bounds.
   */
  constructor(private readonly ctx: Context, options: AgentRunRegistryOptions = {}) {
    this.retainedEvents = options.retainedEvents ?? DEFAULT_RETAINED_EVENTS
    this.retainedRuns = options.retainedRuns ?? DEFAULT_RETAINED_RUNS
  }

  /**
   * Dispatch one run and start observing its events.
   * @param adapter - Adapter that owns the transport.
   * @param request - What to run.
   * @returns the run's identity and its terminal result.
   */
  start(adapter: AgentAdapter, request: AgentRunRequest): MeshRunHandle {
    const run = adapter.startRun(request)
    const state: RunState = {
      runId: run.id,
      agentId: adapter.id,
      cwd: request.cwd,
      prompt: request.prompt,
      status: 'running',
      startedAt: new Date().toISOString(),
      events: [],
      eventCount: 0,
      cancel: (reason) => { run.cancel(reason) },
      settled: Promise.resolve(),
    }
    this.runs.set(run.id, state)
    state.settled = this.observe(state, run)
    return { runId: run.id, result: run.result }
  }

  /**
   * Every tracked run, newest first.
   * @returns one snapshot per tracked run, most recently dispatched first.
   */
  list(): readonly MeshRunSnapshot[] {
    return [...this.runs.values()].reverse().map(state => this.snapshot(state))
  }

  /**
   * Read one run.
   * @param runId - Run identity.
   * @returns the snapshot, or undefined when the run is unknown or evicted.
   */
  get(runId: string): MeshRunSnapshot | undefined {
    const state = this.runs.get(brandString<AgentRunId>(runId))
    return state === undefined ? undefined : this.snapshot(state)
  }

  /**
   * Cancel one run.
   * @param runId - Run identity.
   * @param reason - Recorded reason.
   * @returns whether a live run was cancelled.
   */
  cancel(runId: string, reason?: string): boolean {
    const state = this.runs.get(brandString<AgentRunId>(runId))
    if (state === undefined || state.status !== 'running') return false
    state.cancel(reason)
    return true
  }

  /** Cancel every run still in flight; the service calls this on unload. */
  dispose(): void {
    for (const state of this.runs.values()) {
      if (state.status === 'running') state.cancel('the agent mesh unloaded')
    }
  }

  /**
   * Wait for one run to settle, for callers that dispatched and want the record.
   * @param runId - Run identity.
   * @returns the terminal snapshot, or undefined when the run is unknown.
   */
  async wait(runId: string): Promise<MeshRunSnapshot | undefined> {
    const state = this.runs.get(brandString<AgentRunId>(runId))
    if (state === undefined) return undefined
    await state.settled
    return this.snapshot(state)
  }

  /** Fold the adapter's event stream into the record, then store the terminal result. */
  private async observe(state: RunState, run: ReturnType<AgentAdapter['startRun']>): Promise<void> {
    try {
      for await (const event of run) {
        state.events.push(event)
        state.eventCount += 1
        if (state.events.length > this.retainedEvents) state.events.splice(0, state.events.length - this.retainedEvents)
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(
        'agent-mesh: run %s ended its event stream abnormally: %s',
        state.runId,
        error instanceof Error ? error.message : String(error),
      )
    }
    try {
      const result = await run.result
      state.result = result
      state.status = result.status
      state.finishedAt = result.finishedAt
    } catch (error: unknown) {
      // An adapter's `result` is documented never to reject; a rejection here
      // is an adapter defect, so record it rather than losing the run.
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn('agent-mesh: run %s did not settle: %s', state.runId, message)
      state.status = 'failed'
      state.finishedAt = new Date().toISOString()
      state.result = {
        runId: state.runId,
        agentId: state.agentId,
        status: 'failed',
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        durationMs: 0,
        cwd: state.cwd,
        error: { code: 'run/protocol-error', message },
        notes: ['the adapter failed after dispatch without producing a terminal result'],
      }
    }
    this.evict()
  }

  /** Drop the oldest terminal runs once retention is exceeded. */
  private evict(): void {
    const terminal = [...this.runs.values()].filter(state => state.status !== 'running')
    const excess = terminal.length - this.retainedRuns
    for (const oldest of terminal.slice(0, Math.max(0, excess))) this.runs.delete(oldest.runId)
  }

  /** Project one stored state onto the observable snapshot. */
  private snapshot(state: RunState): MeshRunSnapshot {
    const result = state.result
    return {
      runId: state.runId,
      agentId: state.agentId,
      cwd: state.cwd,
      prompt: state.prompt,
      status: state.status,
      startedAt: state.startedAt,
      ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
      ...(result?.finalText === undefined ? {} : { finalText: result.finalText }),
      ...(result?.error === undefined ? {} : { error: result.error }),
      ...(result?.nativeSessionKey === undefined ? {} : { nativeSessionKey: result.nativeSessionKey }),
      notes: result === undefined ? [] : [...result.notes],
      events: [...state.events],
      eventCount: state.eventCount,
    }
  }
}
