/**
 * Git access for worktree isolation, over the mesh host port.
 *
 * Every command is explicit (no shell), runs through {@link AgentHost.spawn}, and
 * is classified on failure: a non-zero exit is returned as an unsuccessful
 * {@link GitCommandResult} rather than thrown, so the caller decides whether the
 * failure is an environment problem (`git is not installed`), a repository problem
 * (`not inside a work tree`), or a stale-record problem.
 *
 * The parser for `git status --porcelain=v1` lives here, with the status-to-kind
 * mapping, so worktree sampling reads one implementation.
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/git
 */

import type { AgentHost, HostExit } from '@deepseek-ai/dsh-agent-mesh'
import type { FileChangeStatus } from './domain.ts'

/** Result of one git command; a non-zero exit is a value, not an exception. */
export interface GitCommandResult {
  /** Whether the command exited 0 without being timed out or cancelled. */
  readonly ok: boolean
  /** Trimmed standard output. */
  readonly stdout: string
  /** Trimmed standard error. */
  readonly stderr: string
  /** Process exit code, or null when a signal or a host deadline ended it. */
  readonly code: number | null
}

/** One entry of `git status --porcelain=v1` output. */
export interface GitStatusEntry {
  /** Two-character status code, verbatim (`M `, `??`, `A `, `R `, `UU`, ...). */
  readonly code: string
  /** Repository-relative path. */
  readonly path: string
  /** Original path of a rename or copy. */
  readonly from?: string
  /** What the code means for conflict detection. */
  readonly status: FileChangeStatus
}

/** One changed line range from the old side of a unified diff. */
export interface GitHunk {
  /** First line in the base revision; an insertion uses its base line anchor. */
  readonly start: number
  /** Number of base lines changed; zero represents an insertion. */
  readonly lines: number
}

/** One `git worktree list --porcelain` entry. */
export interface GitWorktreeEntry {
  /** Absolute path of the worktree. */
  readonly path: string
  /** Checked-out commit, when the entry names one. */
  readonly head?: string
  /** Checked-out branch, when the worktree is not detached. */
  readonly branch?: string
}

/** Options for {@link GitRunner}. */
export interface GitRunnerOptions {
  /** Git executable; resolved through the child's `PATH` when it is a bare name. */
  readonly command: string
  /** Wall-clock budget for one git command, in milliseconds. */
  readonly timeoutMs: number
}

/**
 * Run git commands for one host.
 *
 * The runner holds no state beyond its options, so two repositories never share a
 * cached answer.
 */
export class GitRunner {
  /**
   * @param host - Host that spawns the git process.
   * @param options - Executable name and per-command budget.
   */
  constructor(
    private readonly host: AgentHost,
    private readonly options: GitRunnerOptions,
  ) {}

  /**
   * Whether git can be run at all on this host.
   * @returns true when `git --version` exits successfully.
   */
  async available(): Promise<boolean> {
    const result = await this.exec(this.host.home, ['--version'])
    return result.ok
  }

  /**
   * Run one git command in a directory.
   * @param cwd - Directory to run in.
   * @param args - Arguments passed verbatim, after the executable.
   * @returns the command result; failures are returned, never thrown.
   */
  async exec(cwd: string, args: readonly string[]): Promise<GitCommandResult> {
    const child = this.host.spawn({
      command: this.options.command,
      args: [...args],
      cwd,
      // A prompt would block until the host deadline; optional locks would fight a
      // concurrent user-side git in the same repository.
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs: this.options.timeoutMs,
    })
    const lines: string[] = []
    try {
      for await (const line of child.lines) lines.push(line)
    } catch (error: unknown) {
      // The exit record still classifies the command; only its stdout is lost.
      this.host.log('warn', `git ${args[0] ?? ''} output stream ended abnormally: ${describe(error)}`)
    }
    const stderr = await child.stderr()
    const exit = await child.exit
    return {
      ok: exitedCleanly(exit),
      // Only trailing whitespace is dropped: `git status --porcelain` encodes state
      // in its leading columns, so trimming the head would shift the first path.
      stdout: lines.join('\n').replace(/\s+$/, ''),
      stderr: stderr.trim(),
      code: exit.code,
    }
  }

  /**
   * The canonical repository root containing a directory.
   *
   * Git resolves the worktree path through symlinks, so two spellings of one
   * repository (`/tmp/x` and `/private/tmp/x`) answer with the same root. Every
   * record stores that answer, which is what makes a later lookup by a differently
   * spelled path find its worktrees.
   * @param path - Any directory inside, or at the root of, the repository.
   * @returns the canonical root, or undefined when the path is not in a work tree.
   */
  async repoRoot(path: string): Promise<string | undefined> {
    const result = await this.exec(path, ['rev-parse', '--show-toplevel'])
    return result.ok && result.stdout !== '' ? result.stdout : undefined
  }

  /**
   * The commit a worktree's HEAD resolves to.
   * @param path - Directory to inspect.
   * @returns the commit sha, or undefined when HEAD cannot be resolved.
   */
  async head(path: string): Promise<string | undefined> {
    const result = await this.exec(path, ['rev-parse', 'HEAD'])
    return result.ok && result.stdout !== '' ? result.stdout : undefined
  }

  /**
   * The branch checked out at a path.
   * @param path - Directory to inspect.
   * @returns the branch name, or undefined on a detached HEAD.
   */
  async currentBranch(path: string): Promise<string | undefined> {
    const result = await this.exec(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!result.ok || result.stdout === '' || result.stdout === 'HEAD') return undefined
    return result.stdout
  }

  /**
   * Whether a local branch already exists.
   * @param repoRoot - Repository to inspect.
   * @param branch - Branch name without the `refs/heads/` prefix.
   * @returns true when the branch exists.
   */
  async hasBranch(repoRoot: string, branch: string): Promise<boolean> {
    const result = await this.exec(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return result.ok && result.stdout !== ''
  }

  /**
   * Create a worktree on a new branch.
   * @param repoRoot - Repository to branch from.
   * @param worktreePath - Absolute destination path.
   * @param branch - New branch to create and check out.
   * @param baseRef - Commit-ish to branch from; omitted for the repository's HEAD.
   * @returns the command result; the caller classifies a failure.
   */
  async addWorktree(repoRoot: string, worktreePath: string, branch: string, baseRef?: string): Promise<GitCommandResult> {
    const args = ['worktree', 'add', '-b', branch, worktreePath]
    if (baseRef !== undefined) args.push(baseRef)
    return await this.exec(repoRoot, args)
  }

  /**
   * Remove a worktree.
   * @param repoRoot - Repository owning the worktree.
   * @param worktreePath - Worktree to remove.
   * @param force - Discard uncommitted and unmerged work.
   * @returns the command result; the caller classifies a failure.
   */
  async removeWorktree(repoRoot: string, worktreePath: string, force: boolean): Promise<GitCommandResult> {
    const args = ['worktree', 'remove']
    if (force) args.push('--force')
    args.push(worktreePath)
    return await this.exec(repoRoot, args)
  }

  /**
   * Drop administrative entries whose worktree directory is gone.
   * @param repoRoot - Repository to prune.
   * @returns the command result.
   */
  async pruneWorktrees(repoRoot: string): Promise<GitCommandResult> {
    return await this.exec(repoRoot, ['worktree', 'prune'])
  }

  /**
   * Whether a path is inside a git work tree.
   * @param path - Directory to inspect.
   * @returns true when git reports a work tree.
   */
  async isRepository(path: string): Promise<boolean> {
    const result = await this.exec(path, ['rev-parse', '--is-inside-work-tree'])
    return result.ok && result.stdout === 'true'
  }

  /**
   * The working-tree status of a directory, as structured entries.
   * @param path - Directory to inspect.
   * @returns one entry per changed path; an empty list when git fails or the tree is clean.
   */
  async status(path: string): Promise<readonly GitStatusEntry[]> {
    const result = await this.exec(path, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (!result.ok) return []
    return parseStatus(result.stdout)
  }

  /**
   * Changed line ranges between a worktree and its recorded base commit.
   *
   * Ranges use the base side of each hunk so two worktrees created from the same
   * commit can be compared even when their changed lines have different offsets
   * after insertion. Untracked and binary paths have no line ranges. A failed diff
   * returns `undefined`, distinct from a successful diff with no text hunks.
   * @param path - Worktree directory.
   * @param base - Commit the worktree was created from.
   * @returns ranges keyed by repository-relative path, or undefined when git fails.
   */
  async hunks(path: string, base: string): Promise<ReadonlyMap<string, readonly GitHunk[]> | undefined> {
    const result = await this.exec(path, ['diff', '--no-color', '--unified=0', base, '--'])
    if (!result.ok) return undefined
    const hunks = new Map<string, GitHunk[]>()
    let oldPath: string | undefined
    let current: string | undefined
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('--- a/')) {
        oldPath = line.slice('--- a/'.length)
        continue
      }
      if (line.startsWith('--- /dev/null')) {
        oldPath = undefined
        continue
      }
      if (line.startsWith('+++ b/')) {
        current = line.slice('+++ b/'.length)
        if (!hunks.has(current)) hunks.set(current, [])
        continue
      }
      if (line.startsWith('+++ /dev/null')) {
        current = oldPath
        if (current !== undefined && !hunks.has(current)) hunks.set(current, [])
        continue
      }
      if (current === undefined) continue
      const match = header.exec(line)
      if (match === null) continue
      const start = Number(match[1])
      const lines = match[2] === undefined ? 1 : Number(match[2])
      hunks.get(current)?.push({ start, lines })
    }
    return new Map([...hunks].map(([path, ranges]) => [path, ranges]))
  }

  /**
   * How many commits HEAD is ahead of and behind a base commit.
   * @param path - Directory to inspect.
   * @param base - Commit to compare against.
   * @returns the counts, or undefined when they cannot be computed.
   */
  async aheadBehind(path: string, base: string): Promise<{ ahead: number; behind: number } | undefined> {
    const result = await this.exec(path, ['rev-list', '--left-right', '--count', `${base}...HEAD`])
    if (!result.ok) return undefined
    const [behind, ahead] = result.stdout.split(/\s+/)
    if (behind === undefined || ahead === undefined) return undefined
    const behindCount = Number.parseInt(behind, 10)
    const aheadCount = Number.parseInt(ahead, 10)
    if (Number.isNaN(behindCount) || Number.isNaN(aheadCount)) return undefined
    return { ahead: aheadCount, behind: behindCount }
  }

  /**
   * Every worktree git knows about, including the main one.
   * @param repoRoot - Repository to list.
   * @returns the entries; an empty list when git fails.
   */
  async listWorktrees(repoRoot: string): Promise<readonly GitWorktreeEntry[]> {
    const result = await this.exec(repoRoot, ['worktree', 'list', '--porcelain'])
    if (!result.ok) return []
    const entries: GitWorktreeEntry[] = []
    let path: string | undefined
    let head: string | undefined
    let branch: string | undefined
    const flush = (): void => {
      if (path === undefined) return
      entries.push({
        path,
        ...(head === undefined ? {} : { head }),
        ...(branch === undefined ? {} : { branch }),
      })
      head = undefined
      branch = undefined
    }
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush()
        path = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).replace('refs/heads/', '')
      }
    }
    flush()
    return entries
  }

  /**
   * The absolute git directory of a repository, where local-only files live.
   *
   * `git rev-parse --git-dir` answers with a path relative to the *caller* when run
   * from the repository root, so `--absolute-git-dir` is the only safe answer here.
   * @param path - Any directory inside the repository.
   * @returns the absolute git directory, or undefined when it cannot be determined.
   */
  async gitDir(path: string): Promise<string | undefined> {
    const result = await this.exec(path, ['rev-parse', '--absolute-git-dir'])
    return result.ok && result.stdout !== '' ? result.stdout : undefined
  }
}

/**
 * Whether a host exit counts as a successful command.
 * @param exit - Exit facts from the host.
 * @returns true only for a clean exit 0.
 */
function exitedCleanly(exit: HostExit): boolean {
  return exit.code === 0 && !exit.timedOut && !exit.cancelled
}

/**
 * Parse `git status --porcelain=v1` output.
 * @param stdout - Command output, trimmed.
 * @returns one entry per changed path, in git's order.
 */
export function parseStatus(stdout: string): readonly GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  for (const line of stdout.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const rest = line.slice(3)
    const arrow = rest.indexOf(' -> ')
    const path = arrow === -1 ? rest : rest.slice(arrow + 4)
    const from = arrow === -1 ? undefined : rest.slice(0, arrow)
    entries.push({
      code,
      path,
      ...(from === undefined ? {} : { from }),
      status: statusKind(code),
    })
  }
  return entries
}

/**
 * Classify one porcelain status code.
 * @param code - The two-character code, verbatim.
 * @returns the change kind conflict detection reports.
 */
export function statusKind(code: string): FileChangeStatus {
  if (code.includes('?')) return 'untracked'
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted'
  if (code.includes('R')) return 'renamed'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  return 'modified'
}

/**
 * Render one thrown value for a diagnostic line.
 * @param error - The thrown value.
 * @returns its message when it is an Error, otherwise its string form.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
