/**
 * Structured failures for mesh collaboration. Codes are the closed vocabulary a
 * consumer branches on; messages are for humans and carry no contract.
 *
 * Every code is either a missing referent (a `not-found` code), a refusal of a
 * state-dependent request (`mesh/invalid-transition`, `schema/todo-conflict`,
 * `worktree/dirty`, `worktree/unmerged`), or an environment failure after which
 * no state was changed (`worktree/git-unavailable`, `worktree/not-a-repository`,
 * `worktree/create-failed`, `worktree/remove-failed`).
 * @module @deepseek-ai/dsh-agent-mesh-collaboration/errors
 */

/** Closed set of collaboration failure codes. */
export type CollaborationErrorCode =
  | 'mesh/collaboration-not-found'
  | 'mesh/task-not-found'
  | 'mesh/session-not-found'
  | 'mesh/invalid-transition'
  | 'mesh/duplicate-todo'
  | 'mesh/unsupported-operation'
  | 'schema/todo-conflict'
  | 'worktree/not-found'
  | 'worktree/not-a-repository'
  | 'worktree/git-unavailable'
  | 'worktree/create-failed'
  | 'worktree/remove-failed'
  | 'worktree/dirty'
  | 'worktree/unmerged'

/** A collaboration failure with a code a consumer can branch on. */
export class CollaborationError extends Error {
  /** Machine-readable failure code. */
  readonly code: CollaborationErrorCode
  /** What the caller can do about it, when there is something. */
  readonly remediation?: string

  /**
   * @param code - Failure code from the closed set.
   * @param message - Human-readable description.
   * @param options - Optional cause and remediation.
   */
  constructor(code: CollaborationErrorCode, message: string, options: { cause?: unknown; remediation?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CollaborationError'
    this.code = code
    if (options.remediation !== undefined) this.remediation = options.remediation
  }
}
