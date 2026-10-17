/**
 * The mesh's wire vocabulary: what a Client receives over `remote.agentMesh`
 * and what it sends back. Every type here is plain JSON, and every field an
 * adapter could not fill is optional rather than absent-by-omission.
 * @module @deepseek-ai/dsh-agent-mesh-controller/types
 */

import type { AgentAuthState, AgentCapabilityInventory, AgentLoginFlow, AgentMessage, AgentNativeTasks, AgentRunEvent, AgentRunStatus } from '@deepseek-ai/dsh-agent-mesh/types'

/** One agent as the Client renders it in the agents list. */
export interface MeshAgentRow {
  /** Registry identity. */
  readonly agentId: string
  /** Human-facing name. */
  readonly displayName: string
  /** Whether the agent's binary was found. */
  readonly installed: boolean
  /** Version the binary reported, when it answered. */
  readonly version?: string
  /** Absolute path of the resolved binary. */
  readonly binaryPath?: string
  /** Why detection failed, when it did. */
  readonly detectionReason?: string
  /** Directory the agent keeps its sessions in, when known. */
  readonly sessionRoot?: string
  /** File the agent keeps its credentials in, when known. */
  readonly credentialPath?: string
  /** Everything diagnostics could not observe for this agent. */
  readonly warnings: readonly string[]
}

/** One session row in an agent's own store, as the Client renders it. */
export interface MeshSessionRow {
  /** Mesh-wide stable key, `<agentId>:<nativeId>`. */
  readonly key: string
  /** Owning agent. */
  readonly agentId: string
  /** The agent's own session identifier. */
  readonly nativeId: string
  /** Title as the agent recorded it. */
  readonly title: string
  /** Working directory the session ran in, when recorded. */
  readonly cwd?: string
  /** Model the session used, when recorded. */
  readonly model?: string
  /** ISO-8601 creation time. */
  readonly createdAt: string
  /** ISO-8601 time of the last recorded activity. */
  readonly updatedAt: string
  /** Lifecycle state the store reveals. */
  readonly status: string
  /** Whether the Harness has pinned this exact external session. */
  readonly pinned: boolean
  /** Whether the Harness has archived this exact external session. */
  readonly archived: boolean
  /** Message count, when the store counted it without truncation. */
  readonly messageCount?: number
  /** Everything the projection could not carry. */
  readonly notes: readonly string[]
}

/** One agent's credential state, as the Client renders it. */
export interface MeshCredentialRow {
  /** Agent the state belongs to. */
  readonly agentId: string
  /** Human-facing agent name. */
  readonly displayName: string
  /** Coarse state and where it was observed. */
  readonly state: AgentAuthState
  /** Login flows declared by this adapter, including flows that return manual guidance. */
  readonly loginFlows: readonly AgentLoginFlow[]
  /** Whether this adapter can log out the observed credential source. */
  readonly canLogout: boolean
}

/** Request for one agent's session list. */
export interface MeshSessionListRequest {
  /** Agent whose store is read. */
  readonly agentId: string
  /** Restrict to sessions whose recorded working directory resolves here. */
  readonly cwd?: string
  /** Maximum number of sessions to return, newest first. */
  readonly limit?: number
}

/** Request for one session's transcript or native tasks. */
export interface MeshSessionRequest {
  /** Agent whose store is read. */
  readonly agentId: string
  /** Native session id. */
  readonly sessionId: string
}

/** Shell syntax used to format one native-session command for the DSH Host. */
export type MeshLaunchShell = 'posix' | 'powershell'

/** Executable argv for opening one agent-owned session in its native TUI. */
export interface MeshLaunchCommand {
  /** Executable and arguments, kept separate until the Client quotes them for its shell. */
  readonly argv: readonly string[]
  /** Shell dialect of the DSH Host process. */
  readonly shell: MeshLaunchShell
}

/** Request for an agent's declared capabilities. */
export interface MeshCapabilityRequest {
  /** Agent whose native configuration is read. */
  readonly agentId: string
  /** Directory whose project-level configuration applies. */
  readonly cwd?: string
}

/** One agent's capability inventory for the Client. */
export type MeshCapabilityResponse = AgentCapabilityInventory

/** Request to change the Harness-owned visibility state of one external session. */
export type MeshSessionDispositionRequest = MeshSessionRequest

/** Request for one window of a session's transcript. */
export interface MeshTranscriptRequest extends MeshSessionRequest {
  /** Maximum number of trailing messages to return. */
  readonly maxMessages?: number
}

/** One session's transcript, as the Client renders it. */
export interface MeshTranscriptResponse {
  /** Session the window belongs to. */
  readonly key: string
  /** Messages in the window, oldest first. */
  readonly messages: readonly AgentMessage[]
  /** Total messages in the session, when the adapter could count them. */
  readonly totalMessages?: number
  /** Whether the window omits earlier messages or truncated content. */
  readonly hasMore: boolean
  /** Everything the projection could not carry. */
  readonly notes: readonly string[]
}

/** One session's native todo and plan state. */
export type MeshTasksResponse = AgentNativeTasks

/** Request to log one agent in. */
export interface MeshLoginRequest {
  /** Agent to log in. */
  readonly agentId: string
  /** Flow to use; must be one the adapter declared. */
  readonly flow: AgentLoginFlow
  /** Secret handed to the agent on stdin; never recorded. */
  readonly secret?: string
}

/** One session-to-agent binding, as the Client renders it. */
export interface MeshBindingRow {
  /** Harness session id. */
  readonly sessionId: string
  /** Bound agent id. */
  readonly agentId: string
  /** ISO-8601 binding time. */
  readonly boundAt: string
}

/** Request to dispatch one run to an external agent. */
export interface MeshRunStartRequest {
  /** Agent to run. */
  readonly agentId: string
  /** Prompt to hand the agent. */
  readonly prompt: string
  /** Absolute working directory the agent runs in. */
  readonly cwd: string
  /** Model in the agent's own naming. */
  readonly model?: string
  /** Approval mode in the agent's own vocabulary. */
  readonly approval?: string
  /** Native session to continue. */
  readonly resumeNativeId?: string
  /** Wall-clock budget in milliseconds. */
  readonly timeoutMs?: number
}

/** One dispatched run, as the Client renders it. */
export interface MeshRunRow {
  /** Run identity. */
  readonly runId: string
  /** Agent the run was dispatched to. */
  readonly agentId: string
  /** Working directory the agent runs in. */
  readonly cwd: string
  /** The prompt the run was dispatched with. */
  readonly prompt: string
  /** Current status. */
  readonly status: AgentRunStatus
  /** ISO-8601 dispatch time. */
  readonly startedAt: string
  /** ISO-8601 terminal time, when the run ended. */
  readonly finishedAt?: string
  /** The answer the run selected, when it produced one. */
  readonly finalText?: string
  /** Classified failure, when the run did not succeed. */
  readonly error?: { readonly code: string; readonly message: string; readonly remediation?: string; readonly output?: string }
  /** Everything the projection could not carry. */
  readonly notes: readonly string[]
  /** Most recent events, newest last. */
  readonly events: readonly AgentRunEvent[]
  /** Total events observed, including ones no longer retained. */
  readonly eventCount: number
}
