/**
 * Structured failures for the agent mesh. Codes are the closed vocabulary a
 * consumer branches on; messages are for humans and carry no contract.
 * @module @deepseek-ai/dsh-agent-mesh/errors
 */

/** Closed set of mesh failure codes. */
export type AgentMeshErrorCode =
  | 'mesh/agent-not-registered'
  | 'mesh/duplicate-agent'
  | 'mesh/capability-not-declared'
  | 'mesh/session-not-found'
  | 'mesh/not-installed'
  | 'mesh/unsupported-operation'

/** A mesh failure with a code a consumer can branch on. */
export class AgentMeshError extends Error {
  /** Machine-readable failure code. */
  readonly code: AgentMeshErrorCode
  /** What the caller can do about it, when there is something. */
  readonly remediation?: string

  /**
   * @param code - Failure code from the closed set.
   * @param message - Human-readable description.
   * @param options - Optional cause and remediation.
   */
  constructor(code: AgentMeshErrorCode, message: string, options: { cause?: unknown; remediation?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AgentMeshError'
    this.code = code
    if (options.remediation !== undefined) this.remediation = options.remediation
  }
}
