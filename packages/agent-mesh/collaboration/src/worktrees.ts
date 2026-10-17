/**
 * Worktree isolation: creation, live progress sampling, conflict reporting, and
 * removal of the git worktrees mesh tasks run in.
 *
 * The mesh owns the worktree lifecycle for every delegated task so every agent
 * behaves identically: one directory layout, one branch naming rule, and one place
 * that decides isolation. A worktree is only ever removed by id through
 * {@link WorktreeManager.remove}, which refuses uncommitted or unmerged work unless
 * the caller passes `force`.
 *
 * Conflict detection compares changed paths, base commits, and readable line ranges
 * of the live worktrees of one repository. Configured feature path prefixes report
 * related changes in different files. These are heuristics: two agents can still
 * conflict semantically outside the declared prefixes, and unavailable diffs limit
 * line-range findings. The report names those gaps rather than implying certainty.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/worktrees
 */

import { join } from 'node:path'
import type { AgentHost } from '@deepseek-ai/dsh-agent-mesh'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CollaborationError } from './errors.ts'
import type { GitHunk, GitRunner, GitStatusEntry } from './git.ts'
import type { WorktreeId, WorktreeRecord } from './domain.ts'
import type { ConflictFinding, ConflictPolicy, ConflictReport, CreateWorktreeRequest, RemoveWorktreeOptions, WorktreeProgress, WorktreeView } from './types.ts'

/** Deployment choices for worktree isolation. */
export interface WorktreeManagerOptions {
  /** Mesh-owned directory inside the repository holding created worktrees. */
  readonly worktreeDir: string
  /** Prefix for the branch created for a worktree. */
  readonly branchPrefix: string
  /** Commit-ish a worktree branches from when the request names none. */
  readonly baseRef?: string
  /** Whether same-hunk overlaps are warnings or blocking findings. */
  readonly conflictPolicy: ConflictPolicy
  /** Repository-relative path prefixes used to identify shared feature areas. */
  readonly featureBoundaries: readonly string[]
}

/** One worktree considered by a conflict scan. */
interface LiveWorktree {
  /** The record. */
  readonly record: WorktreeRecord
  /** The sample the scan used. */
  readonly progress: WorktreeProgress
  /** Ranges changed from the worktree's base, absent when `git diff` failed. */
  readonly hunks: ReadonlyMap<string, readonly GitHunk[]> | undefined
}

/**
 * Creates, samples, reports on, and removes the mesh's git worktrees.
 *
 * One manager serves every repository: records carry their own `repoRoot`, and every
 * path an operation runs against comes from a record, so two repositories never
 * share a working directory.
 */
export class WorktreeManager {
  /**
   * @param host - Host that spawns git and reports the clock.
   * @param git - Git command runner.
   * @param table - The worktrees table of the collaboration domain.
   * @param options - Directory layout and branch naming.
   */
  constructor(
    private readonly host: AgentHost,
    private readonly git: GitRunner,
    private readonly table: KvTable<WorktreeId, WorktreeRecord>,
    private readonly options: WorktreeManagerOptions,
  ) {}

  /**
   * Every recorded worktree, in record order, without a live sample.
   * @returns one record per tracked worktree.
   */
  records(): readonly WorktreeRecord[] {
    return [...this.table.entries()].map(([, record]) => record)
  }

  /**
   * Read one recorded worktree.
   * @param id - Worktree id.
   * @returns the record, or undefined when no record has that id.
   */
  get(id: string): WorktreeRecord | undefined {
    return this.table.get(brandString<WorktreeId>(id))
  }

  /**
   * Read one recorded worktree, refusing an unknown id.
   * @param id - Worktree id.
   * @returns the record.
   */
  require(id: string): WorktreeRecord {
    const record = this.get(id)
    if (record === undefined) {
      throw new CollaborationError('worktree/not-found', `no worktree with id "${id}"`, {
        remediation: 'List worktrees to find a valid id.',
      })
    }
    return record
  }

  /**
   * List worktrees, sampling the live ones.
   * @param repoRoot - Restrict to one repository, spelled as the caller knows it.
   * @returns one view per record, newest first, with progress on live worktrees; an
   *   explicit path outside a git repository returns an empty list.
   */
  async list(repoRoot?: string): Promise<readonly WorktreeView[]> {
    const canonical = repoRoot === undefined ? undefined : await this.git.repoRoot(repoRoot)
    if (repoRoot !== undefined && canonical === undefined) return []
    const records = this.records()
      .filter(record => canonical === undefined || record.repoRoot === canonical)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const views: WorktreeView[] = []
    for (const record of records) {
      views.push(await this.view(record))
    }
    return views
  }

  /**
   * Create a worktree, or reuse one already reserved for the same agent.
   *
   * @param request - Agent, repository, base ref, and labels.
   * @returns the new or reused worktree with its first sample.
   */
  async create(request: CreateWorktreeRequest): Promise<WorktreeView> {
    if (!await this.git.available()) {
      throw new CollaborationError('worktree/git-unavailable', 'git is not available on this host', {
        remediation: 'Install git, or dispatch the task with isolation "shared-cwd".',
      })
    }
    const repoRoot = await this.git.repoRoot(request.repoRoot)
    if (repoRoot === undefined) {
      throw new CollaborationError('worktree/not-a-repository', `"${request.repoRoot}" is not inside a git work tree`, {
        remediation: 'Initialize a repository, or dispatch the task with isolation "shared-cwd".',
      })
    }

    if (request.reuse === true) {
      const reusable = await this.reusableFor(request.agentId, repoRoot)
      if (reusable !== undefined) {
        const reused: WorktreeRecord = {
          ...reusable,
          updatedAt: this.timestamp(),
          ...(request.collaborationId === undefined ? {} : { collaborationId: request.collaborationId }),
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        }
        await this.table.put(reused.id, reused)
        return await this.view(reused)
      }
    }

    const id = brandString<WorktreeId>(`wt-${randomToken()}`)
    const slug = slugify(request.label ?? request.agentId)
    const branch = await this.uniqueBranch(repoRoot, `${this.options.branchPrefix}${slug}`)
    const path = join(repoRoot, this.options.worktreeDir, 'worktrees', String(id))
    const baseRef = request.baseRef ?? this.options.baseRef
    await this.addWorktree(repoRoot, path, branch, baseRef)
    const baseCommit = await this.git.head(path)
    if (baseCommit === undefined) {
      // The worktree exists and is now unmanaged; report it rather than recording a
      // record whose base every later comparison would be measured against.
      throw new CollaborationError('worktree/create-failed', `created ${path} but could not resolve its HEAD commit`, {
        remediation: `Inspect ${path} and remove it by hand, then retry.`,
      })
    }

    const now = this.timestamp()
    const record: WorktreeRecord = {
      id,
      path,
      repoRoot,
      branch,
      baseCommit,
      baseRef: baseRef ?? 'HEAD',
      agentId: request.agentId,
      createdAt: now,
      updatedAt: now,
      state: 'idle',
      reusable: true,
      ...(request.collaborationId === undefined ? {} : { collaborationId: request.collaborationId }),
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    }
    await this.table.put(id, record)
    return await this.view(record)
  }

  /**
   * Remove one worktree.
   *
   * @param id - Worktree id.
   * @param options - `force` discards uncommitted and unmerged work; without it a
   *   dirty worktree or a branch ahead of its base is refused.
   * @returns the record, marked `removed`.
   */
  async remove(id: string, options: RemoveWorktreeOptions = {}): Promise<WorktreeRecord> {
    const record = this.require(id)
    const force = options.force === true
    if (!force) {
      const status = await this.git.status(record.path)
      if (status.length > 0) {
        throw new CollaborationError('worktree/dirty', `${record.path} has ${String(status.length)} uncommitted change(s)`, {
          remediation: 'Commit or stash the work, or pass force to discard it.',
        })
      }
      const ahead = await this.git.aheadBehind(record.path, record.baseCommit)
      const aheadCount = ahead?.ahead ?? 0
      if (aheadCount > 0) {
        throw new CollaborationError(
          'worktree/unmerged',
          `${record.branch} has ${String(aheadCount)} commit(s) that are not in ${record.baseRef}`,
          { remediation: 'Merge the branch, or pass force to discard the work.' },
        )
      }
    }
    const removed = await this.git.removeWorktree(record.repoRoot, record.path, force)
    if (!removed.ok) {
      // A worktree whose directory was deleted by hand has only an administrative
      // entry left; prune is the documented repair, and one retry decides the outcome.
      await this.git.pruneWorktrees(record.repoRoot)
      const retried = await this.git.removeWorktree(record.repoRoot, record.path, force)
      if (!retried.ok) {
        throw new CollaborationError('worktree/remove-failed', `git could not remove ${record.path}`, {
          cause: retried.stderr,
          remediation: 'Remove the directory by hand and run `git worktree prune`.',
        })
      }
    }
    const updated: WorktreeRecord = { ...record, state: 'removed', reusable: false, updatedAt: this.timestamp() }
    await this.table.put(updated.id, updated)
    return updated
  }

  /**
   * Mark a worktree integrated, so it stops appearing as outstanding work.
   * @param id - Worktree id.
   * @param merged - `false` marks it outstanding again.
   * @returns the updated record.
   */
  async markIntegrated(id: string, merged = true): Promise<WorktreeRecord> {
    const record = this.require(id)
    const updated: WorktreeRecord = {
      ...record,
      state: merged ? 'merged' : 'idle',
      reusable: !merged,
      updatedAt: this.timestamp(),
    }
    await this.table.put(updated.id, updated)
    return updated
  }

  /**
   * Attach a live run to a worktree, or detach it when the run ends.
   * @param id - Worktree id.
   * @param runId - Run now executing here, or undefined when none is.
   */
  async bindRun(id: string, runId: string | undefined): Promise<void> {
    const record = this.get(id)
    if (record === undefined) return
    const updated: WorktreeRecord = {
      id: record.id,
      path: record.path,
      repoRoot: record.repoRoot,
      branch: record.branch,
      baseCommit: record.baseCommit,
      baseRef: record.baseRef,
      agentId: record.agentId,
      createdAt: record.createdAt,
      updatedAt: this.timestamp(),
      state: runId === undefined ? 'idle' : 'active',
      reusable: record.reusable,
      ...(record.collaborationId === undefined ? {} : { collaborationId: record.collaborationId }),
      ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
      ...(runId === undefined ? {} : { runId }),
    }
    await this.table.put(updated.id, updated)
  }

  /**
   * Compare the live worktrees of one repository and report predicted conflicts.
   * @param repoRoot - Repository to analyse, spelled as the caller knows it.
   * @returns same-file, same-hunk, feature-area, and base-commit findings, plus any
   *   limits of this analysis.
   */
  async conflicts(repoRoot: string): Promise<ConflictReport> {
    if (!await this.git.available()) {
      throw new CollaborationError('worktree/git-unavailable', 'git is not available on this host', {
        remediation: 'Install git, or dispatch tasks with isolation "shared-cwd".',
      })
    }
    const canonical = await this.git.repoRoot(repoRoot)
    if (canonical === undefined) {
      throw new CollaborationError('worktree/not-a-repository', `"${repoRoot}" is not inside a git work tree`)
    }
    const notes: string[] = [
      'same-file and line-range findings are heuristic; different files can still conflict semantically',
    ]
    const records = this.records().filter(record => record.repoRoot === canonical)
    const live: LiveWorktree[] = []
    const skipped: string[] = []
    for (const record of records) {
      if (record.state !== 'idle' && record.state !== 'active') {
        skipped.push(record.id)
        continue
      }
      const progress = await this.sample(record)
      if (progress.notes.length > 0) notes.push(`${record.id}: ${progress.notes.join('; ')}`)
      const hunks = await this.git.hunks(record.path, record.baseCommit)
      if (hunks === undefined) {
        notes.push(`${record.id}: git could not read the diff; line-range conflicts are unavailable`)
      } else {
        const unavailable = progress.files
          .filter(file => file.status !== 'untracked' && (hunks.get(file.path)?.length ?? 0) === 0)
          .map(file => file.path)
        if (unavailable.length > 0) notes.push(`${record.id}: line ranges are unavailable for ${unavailable.join(', ')}`)
      }
      live.push({ record, progress, hunks })
    }
    if (skipped.length > 0) {
      notes.push(`integrated or removed worktrees are not compared: ${skipped.join(', ')}`)
    }

    const findings: ConflictFinding[] = []
    for (const [left, a] of live.entries()) {
      for (const b of live.slice(left + 1)) {
        const shared = intersectPaths(a.progress, b.progress)
        const sameBase = a.record.baseCommit === b.record.baseCommit
        if (shared.length > 0) {
          findings.push({
            kind: 'same-file',
            severity: 'warning',
            left: a.record.id,
            right: b.record.id,
            paths: shared,
            detail: `${String(shared.length)} file(s) are changed by both ${a.record.agentId} and ${b.record.agentId}`,
          })
          const overlapping = sameBase ? shared.filter((path) => {
            const leftHunks = a.hunks?.get(path)
            const rightHunks = b.hunks?.get(path)
            return leftHunks !== undefined && rightHunks !== undefined && hunkRangesOverlap(leftHunks, rightHunks)
          }) : []
          if (overlapping.length > 0) {
            findings.push({
              kind: 'same-hunk',
              severity: this.options.conflictPolicy === 'block' ? 'blocking' : 'warning',
              left: a.record.id,
              right: b.record.id,
              paths: overlapping,
              detail: `edits overlap in the same line ranges of ${String(overlapping.length)} file(s)`,
            })
          }
        }
        const sharedAreas = sharedFeatureAreas(a.progress, b.progress, this.options.featureBoundaries)
        if (sharedAreas.length > 0) {
          findings.push({
            kind: 'feature-boundary',
            severity: 'info',
            left: a.record.id,
            right: b.record.id,
            paths: sharedAreas,
            detail: `both agents changed files in ${String(sharedAreas.length)} feature area(s)`,
          })
        }
        if (!sameBase) {
          notes.push(`${a.record.id} and ${b.record.id}: same-hunk comparison was skipped because their base commits differ`)
          findings.push({
            kind: 'base-drift',
            severity: 'info',
            left: a.record.id,
            right: b.record.id,
            paths: [],
            detail: `worktrees were created from different commits (${a.record.baseCommit.slice(0, 8)} and ${b.record.baseCommit.slice(0, 8)})`,
          })
        }
      }
    }

    findings.sort((left, right) => conflictSeverityRank(right.severity) - conflictSeverityRank(left.severity))
    if (this.options.conflictPolicy === 'block') {
      notes.push('conflictPolicy is "block": same-hunk findings are marked blocking; this advisory report does not stop separate dispatches')
    }

    const report: ConflictReport = {
      repoRoot: canonical,
      at: this.timestamp(),
      worktrees: live.map(entry => entry.record.id),
      findings,
      notes,
      ...(findings.length === 0 ? {} : { suggestedOrder: suggestOrder(live) }),
    }
    return report
  }

  /** Build one view, sampling a live worktree. */
  private async view(record: WorktreeRecord): Promise<WorktreeView> {
    if (record.state !== 'idle' && record.state !== 'active') return { ...record }
    return { ...record, progress: await this.sample(record) }
  }

  /**
   * Take one progress sample of a worktree path.
   *
   * A sample never throws: a worktree whose git state cannot be read is reported
   * with the sample's `notes` naming the gap, because a conflict scan over several
   * worktrees must still report what it could see.
   */
  private async sample(record: WorktreeRecord): Promise<WorktreeProgress> {
    const notes: string[] = []
    const head = await this.git.head(record.path)
    const branch = await this.git.currentBranch(record.path) ?? record.branch
    const status: readonly GitStatusEntry[] = await this.git.status(record.path)
    const aheadBehind = await this.git.aheadBehind(record.path, record.baseCommit)
    if (head === undefined && status.length === 0) {
      notes.push('the worktree could not be read as a git work tree')
    }
    if (head === undefined && status.length > 0) {
      notes.push('HEAD could not be resolved; the recorded base commit is reported instead')
    }
    if (aheadBehind === undefined) {
      notes.push('the commit count ahead of the base commit could not be computed')
    }
    const files = status
      .map(entry => ({ path: entry.path, status: entry.status }))
      .sort((left, right) => left.path.localeCompare(right.path))
    return {
      at: this.timestamp(),
      head: head ?? record.baseCommit,
      branch,
      ahead: aheadBehind?.ahead ?? 0,
      files,
      dirty: status.length > 0,
      notes,
    }
  }

  /**
   * An idle, clean worktree already reserved for an agent in a repository.
   *
   * Reuse is safe only when the tree is clean and no run holds it: reusing one with
   * uncommitted work would merge two tasks' changes by accident.
   */
  private async reusableFor(agentId: string, repoRoot: string): Promise<WorktreeRecord | undefined> {
    for (const record of this.records()) {
      if (record.agentId !== agentId || record.repoRoot !== repoRoot) continue
      if (!record.reusable || record.state !== 'idle' || record.runId !== undefined) continue
      const status = await this.git.status(record.path)
      if (status.length === 0) return record
    }
    return undefined
  }

  /** Ensure a branch name is free, suffixing a counter when it is taken. */
  private async uniqueBranch(repoRoot: string, base: string): Promise<string> {
    if (!await this.git.hasBranch(repoRoot, base)) return base
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base}-${String(index)}`
      if (!await this.git.hasBranch(repoRoot, candidate)) return candidate
    }
    return `${base}-${randomToken()}`
  }

  /** Create the worktree, classifying a git refusal. */
  private async addWorktree(repoRoot: string, path: string, branch: string, baseRef: string | undefined): Promise<void> {
    const result = await this.git.addWorktree(repoRoot, path, branch, baseRef)
    if (result.ok) return
    throw new CollaborationError('worktree/create-failed', `git worktree add failed for ${branch}`, {
      cause: result.stderr,
      remediation: `Check that ${path} does not exist and that the repository has at least one commit.`,
    })
  }

  /** Current time as an ISO-8601 string, from the host's clock. */
  private timestamp(): string {
    return new Date(this.host.now()).toISOString()
  }
}

/**
 * Changed paths both samples carry.
 * @param left - First sample.
 * @param right - Second sample.
 * @returns the shared paths, sorted.
 */
function intersectPaths(left: WorktreeProgress, right: WorktreeProgress): readonly string[] {
  const rightPaths = new Set(right.files.map(file => file.path))
  return left.files.map(file => file.path).filter(path => rightPaths.has(path)).sort()
}

/**
 * Propose an integration order: the smallest change sets first, so a human merging
 * by hand meets the easiest branches before the widest ones.
 * @param live - The sampled worktrees.
 * @returns worktree ids in proposed integration order.
 */
function suggestOrder(live: readonly LiveWorktree[]): readonly string[] {
  return [...live]
    .sort((left, right) => left.progress.files.length - right.progress.files.length
      || left.record.id.localeCompare(right.record.id))
    .map(entry => entry.record.id)
}

/** Compare two changed line-range sets. */
function hunkRangesOverlap(left: readonly GitHunk[], right: readonly GitHunk[]): boolean {
  for (const a of left) {
    const aEnd = a.start + Math.max(a.lines, 1) - 1
    for (const b of right) {
      const bEnd = b.start + Math.max(b.lines, 1) - 1
      if (a.start <= bEnd && b.start <= aEnd) return true
    }
  }
  return false
}

/** Find configured feature prefixes changed by both worktrees, excluding same-file findings. */
function sharedFeatureAreas(
  left: WorktreeProgress,
  right: WorktreeProgress,
  boundaries: readonly string[],
): readonly string[] {
  const rightPaths = new Set(right.files.map(file => file.path))
  const areas = new Set<string>()
  for (const file of left.files) {
    if (rightPaths.has(file.path)) continue
    const area = boundaryOf(file.path, boundaries)
    if (area === undefined) continue
    if (right.files.some(candidate => candidate.path !== file.path && boundaryOf(candidate.path, boundaries) === area)) {
      areas.add(area)
    }
  }
  return [...areas].sort()
}

/** Match a git path against a configured repository-relative feature prefix. */
function boundaryOf(path: string, boundaries: readonly string[]): string | undefined {
  return boundaries
    .map(boundary => boundary.replace(/^\/+|\/+$/g, ''))
    .filter(boundary => boundary !== '' && (path === boundary || path.startsWith(`${boundary}/`)))
    .sort((left, right) => right.length - left.length)[0]
}

/** Sort conflict findings by blocking, warning, then informational severity. */
function conflictSeverityRank(severity: ConflictFinding['severity']): number {
  if (severity === 'blocking') return 3
  if (severity === 'warning') return 2
  return 1
}

/**
 * Reduce a label to a path- and branch-safe slug.
 * @param value - Label to slugify.
 * @returns the slug, never empty.
 */
function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'work' : slug.slice(0, 40)
}

/**
 * Mint a short random token for one id.
 * @returns the token.
 */
function randomToken(): string {
  return Math.random().toString(36).slice(2, 10)
}
