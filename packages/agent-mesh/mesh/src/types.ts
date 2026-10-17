/**
 * Canonical multi-agent vocabulary: what an external coding agent is, what it
 * can do, what its own session store contains, and how a harness session binds
 * to it.
 *
 * The vocabulary is deliberately lossy in one direction only: every adapter
 * projects its native records onto these types and records, in the result's
 * `notes`, anything the projection could not carry. A consumer never has to
 * know an agent's native format, and an adapter never silently drops a field.
 * @module @deepseek-ai/dsh-agent-mesh/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertResource } from '@deepseek-ai/dsh-typert-protocol'

/** Registry identity of one external agent (`codex`, `grok`, `pi`, `omp`). */
export type AgentId = Branded<'AgentId'>

/** Stable key of one of an agent's own sessions, formed as `<agentId>:<nativeId>`. */
export type AgentSessionKey = Branded<'AgentSessionKey'>

/** One durable Harness-session binding change. */
export interface AgentMeshBindingChange {
  /** Harness Session whose binding changed. */
  readonly sessionId: SessionId
  /** Newly bound external agent; absent when the Session was unbound. */
  readonly agentId?: AgentId
}

/** Exact address of a session in the store owned by one external agent. */
export interface AgentSessionReference {
  /** Agent that owns the native session store. */
  readonly agentId: AgentId
  /** The identifier assigned by that agent. */
  readonly nativeId: string
}

/** User-owned visibility state for one external session. */
export type AgentSessionDisposition = 'pinned' | 'archived'

/** Persisted user choice for one exact external session. */
export interface AgentSessionMark extends AgentSessionReference {
  /** Stable mesh identity, distinct from every Harness Session id. */
  readonly key: AgentSessionKey
  /** Current user-owned state. */
  readonly disposition: AgentSessionDisposition
  /** ISO-8601 time of the latest state change. */
  readonly updatedAt: string
}

/** Identity of one dispatched run. */
export type AgentRunId = Branded<'AgentRunId'>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertResourceMap {
    /** One external agent and the session data owned by its CLI. */
    agent: TypertResource<AgentId>
  }
}

/** Transport an adapter can use to drive its agent. */
export type AgentRunMode = 'headless-exec' | 'duplex-protocol'

/** One transport an agent offers, and whether this adapter implements it. */
export interface AgentTransport {
  /** Transport family. */
  readonly mode: AgentRunMode
  /** The native commands or protocol this transport uses, for diagnostics. */
  readonly mechanism: string
  /** Whether the adapter implements this transport today. */
  readonly available: boolean
}

/** Login flow an adapter can perform, or explain how to perform by hand. */
export type AgentLoginFlow = 'oauth-loopback' | 'device-code' | 'api-key' | 'interactive'

/** What one agent's binary and adapter actually support. */
export interface AgentCapabilities {
  /** Transports the adapter implements. */
  readonly runModes: readonly AgentRunMode[]
  /** Whether a run streams incremental events. */
  readonly streaming: boolean
  /** Whether a run can continue an existing native session. */
  readonly resume: boolean
  /** Whether a running turn can be interrupted without killing the process. */
  readonly interrupt: boolean
  /** Whether the agent's own session store can be listed. */
  readonly listSessions: boolean
  /** Whether a native session's transcript can be read. */
  readonly readTranscript: boolean
  /** Whether the agent records its own todo list. */
  readonly nativeTodos: boolean
  /** Whether the agent records its own plan. */
  readonly nativePlan: boolean
  /** Whether the adapter can list the agent's configured models. */
  readonly listModels: boolean
  /** Sandbox profiles the agent accepts; empty when it has none. */
  readonly sandboxProfiles: readonly string[]
  /** Approval modes the agent accepts; empty when it has none. */
  readonly approvalModes: readonly string[]
  /** Credential surfaces the adapter implements. */
  readonly credentials: {
    /** Whether credential state can be read. */
    readonly status: boolean
    /** Login flows the adapter can perform (others are explained, not attempted). */
    readonly login: readonly AgentLoginFlow[]
    /** Whether the adapter can log the agent out. */
    readonly logout: boolean
  }
}

/** How an agent's binary was located. */
export type AgentDetectionSource = 'config' | 'path' | 'well-known' | 'none'

/** Result of looking for an agent's binary. */
export interface AgentDetection {
  /** Whether an executable was found. */
  readonly installed: boolean
  /** Absolute path of the resolved executable. */
  readonly binaryPath?: string
  /** Which search step found it. */
  readonly source: AgentDetectionSource
  /** First line of the binary's own version output, when it answered. */
  readonly version?: string
  /** Why detection failed, when it did. */
  readonly reason?: string
}

/** One agent as the mesh sees it: identity, capabilities, and where its data lives. */
export interface AgentDescriptor {
  /** Registry identity. */
  readonly id: AgentId
  /** Human-facing name. */
  readonly displayName: string
  /** One sentence on what this agent is and where its data lives. */
  readonly summary: string
  /** Observed capabilities. */
  readonly capabilities: AgentCapabilities
  /** Latest detection result. */
  readonly detection: AgentDetection
  /** Transports the agent offers. */
  readonly transports: readonly AgentTransport[]
  /** Directory the agent keeps its sessions in, when known. */
  readonly sessionRoot?: string
  /** File the agent keeps its credentials in, when known. */
  readonly credentialPath?: string
  /** Environment variables the adapter reads or sets for its child processes. */
  readonly environmentKeys: readonly string[]
}

/** Where an observed credential state came from. */
export type AgentAuthSource = 'env' | 'file' | 'keyring' | 'cli-probe' | 'none'

/** Coarse credential state of one agent. */
export type AgentAuthStatus = 'authenticated' | 'unauthenticated' | 'expired' | 'misconfigured' | 'unknown'

/** One agent's credential state. */
export interface AgentAuthState {
  /** Coarse state; `unknown` means the store exists but could not be interpreted. */
  readonly status: AgentAuthStatus
  /** Where the state was observed. */
  readonly source: AgentAuthSource
  /** The credential kind, when the adapter can name it. */
  readonly method?: string
  /** Human-readable detail, including anything the user must do by hand. */
  readonly detail?: string
  /** Expiry of the observed credential, when it carries one. */
  readonly expiresAt?: string
}

/** One model an agent can run, as its own configuration declares it. */
export interface AgentModel {
  /** Model identity within the agent (may be `provider/model`). */
  readonly id: string
  /** Human-facing name, when the agent has one. */
  readonly displayName?: string
  /** Provider the agent routes this model through, when it names one. */
  readonly provider?: string
}

/** Lifecycle state of one native session as far as its store reveals. */
export type AgentSessionStatus = 'idle' | 'running' | 'unreadable'

/** One session in an agent's own store. */
export interface AgentSession {
  /** Mesh-wide stable key, `<agentId>:<nativeId>`. */
  readonly key: AgentSessionKey
  /** Owning agent. */
  readonly agentId: AgentId
  /** The agent's own identifier for this session. */
  readonly nativeId: string
  /** Absolute path of the store file backing this session, when it is one file. */
  readonly nativePath?: string
  /** Title, as the agent recorded it. */
  readonly title?: string
  /** Whether the title came from the agent rather than from a projection. */
  readonly titleIsNative?: boolean
  /** Working directory the session ran in. */
  readonly cwd?: string
  /** Git branch the session recorded, when it did. */
  readonly branch?: string
  /** Repository root the session recorded, when it did. */
  readonly repoRoot?: string
  /** Model the session used, when the store names one. */
  readonly model?: string
  /** ISO-8601 creation time. */
  readonly createdAt: string
  /** ISO-8601 time of the last recorded activity. */
  readonly updatedAt: string
  /** Lifecycle state the store reveals. */
  readonly status: AgentSessionStatus
  /** Number of messages, when the store counted them without truncation. */
  readonly messageCount?: number
  /** Native id of the parent session, for a forked session. */
  readonly parentNativeId?: string
  /** The agent's own classification of the session, when it has one. */
  readonly source?: string
  /** Everything the projection could not carry, stated for the reader. */
  readonly notes: readonly string[]
}

/** Filters and bounds for listing an agent's sessions. */
export interface AgentSessionListOptions {
  /** Restrict to sessions whose recorded working directory resolves to this path. */
  readonly cwd?: string
  /** Maximum number of sessions to return, newest first. */
  readonly limit?: number
  /** Abort the scan. */
  readonly signal?: AbortSignal
}

/** One adapter whose session store could not be read during a catalog pass. */
export interface AgentSessionListFailure {
  /** Adapter whose store failed. */
  readonly agentId: AgentId
  /** Reader-facing failure detail. */
  readonly message: string
}

/** One cross-agent session catalog read, retaining per-agent failures. */
export interface AgentSessionCatalog {
  /** Sessions from readable stores, newest first. */
  readonly items: readonly AgentSession[]
  /** Store failures in adapter registration order. */
  readonly failures: readonly AgentSessionListFailure[]
}

/** Role of one projected transcript message. */
export type AgentMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'unknown'

/** What one projected transcript message carries. */
export type AgentMessageKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'plan'
  | 'summary'
  | 'error'
  | 'unknown'

/** One projected message from an agent's transcript. */
export interface AgentMessage {
  /** Position within the returned window, ascending from 0. */
  readonly index: number
  /** Who produced the message. */
  readonly role: AgentMessageRole
  /** What the message carries. */
  readonly kind: AgentMessageKind
  /** Text content, when the message has any. */
  readonly text?: string
  /** Tool name, for tool calls and results. */
  readonly toolName?: string
  /** Tool input, for tool calls. */
  readonly toolInput?: string
  /** Tool output, for tool results. */
  readonly toolOutput?: string
  /** Whether a tool call or result records failure. */
  readonly failed?: boolean
  /** ISO-8601 time the agent recorded, when it did. */
  readonly timestamp?: string
  /** Native record type, for records projected onto a generic kind. */
  readonly nativeType?: string
  /** Whether text was cut to fit the adapter's per-field cap. */
  readonly truncated?: boolean
  /** File paths the record mentions, when they are the point of the record. */
  readonly paths?: readonly string[]
}

/** Request for one window of an agent's transcript. */
export interface AgentTranscriptRequest {
  /** Session to read, as returned by a session listing. */
  readonly session: AgentSession
  /** Maximum number of trailing messages to return. */
  readonly maxMessages?: number
  /** Maximum bytes of store to read before projecting. */
  readonly maxBytes?: number
}

/** One window of an agent's transcript. */
export interface AgentTranscript {
  /** Session the window belongs to. */
  readonly key: AgentSessionKey
  /** Messages in the window, oldest first. */
  readonly messages: readonly AgentMessage[]
  /** Total messages in the session, when the adapter could count them exactly. */
  readonly totalMessages?: number
  /** Whether the window omits earlier messages or truncated content. */
  readonly hasMore: boolean
  /** Everything the projection could not carry, stated for the reader. */
  readonly notes: readonly string[]
}

/** Status of one projected todo item. */
export type AgentTodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled'

/** One todo item in an agent's own task model. */
export interface AgentTodo {
  /** Stable id derived from the agent, session, and native key. */
  readonly id: string
  /** Item text. */
  readonly content: string
  /** Item status. */
  readonly status: AgentTodoStatus
  /** Owning agent id. */
  readonly owner: string
  /** Ids of items blocking this one; empty when the agent records none. */
  readonly blockedBy: readonly string[]
  /** ISO-8601 time the agent last recorded this item. */
  readonly updatedAt: string
  /** The agent's own key for the item, when it has one. */
  readonly nativeKey?: string
  /** Session the item was observed in. */
  readonly observedIn?: string
}

/** An agent's own plan for the session, when it records one. */
export interface AgentPlan {
  /** Whether the agent is currently working to a plan. */
  readonly active: boolean
  /** Plan steps or phases, in the agent's own terms. */
  readonly items: readonly string[]
}

/** An agent's own todo and plan state for one session. */
export interface AgentNativeTasks {
  /** Whether the agent has a native task model at all. */
  readonly available: boolean
  /** Todo items, in the agent's own order. */
  readonly todos: readonly AgentTodo[]
  /** The agent's plan, when it records one. */
  readonly plan?: AgentPlan
  /** Everything the projection could not carry, stated for the reader. */
  readonly notes: readonly string[]
}

/** Request for one session's native tasks. */
export interface AgentNativeTasksRequest {
  /** Session to read. */
  readonly session: AgentSession
}

/** Where one native capability declaration came from. */
export type AgentCapabilitySource = 'builtin' | 'config' | 'project' | 'user' | 'extension' | 'mcp' | 'plugin' | 'bundled'

/** One tool declared by an agent. */
export interface AgentToolInfo {
  /** Name as the external agent presents it. */
  readonly name: string
  /** Description in the native declaration, when present. */
  readonly description?: string
  /** Source of the declaration. */
  readonly source: AgentCapabilitySource
  /** Permission tier in the agent's own vocabulary. */
  readonly approval?: string
  /** Whether the agent loads this tool on demand. */
  readonly discoverable?: boolean
  /** Absolute declaring file, when the tool is user-configured. */
  readonly path?: string
}

/** One skill declared by an agent. */
export interface AgentSkillInfo {
  /** Native name, including a namespace when the agent adds one. */
  readonly name: string
  /** Description from the native declaration, when present. */
  readonly description?: string
  /** Source of the declaration. */
  readonly source: AgentCapabilitySource
  /** Absolute instruction file, when present. */
  readonly path?: string
  /** Whether the user can invoke it as a slash command. */
  readonly userInvocable?: boolean
}

/** One MCP server declared in an agent's configuration. */
export interface AgentMcpServerInfo {
  /** Name in the agent's configuration. */
  readonly name: string
  /** Configured transport. */
  readonly transport: 'stdio' | 'http' | 'sse' | 'unknown'
  /** Display name for a stdio executable, without its configured path. */
  readonly command?: string
  /** Origin for an HTTP or SSE endpoint; path, query, and credentials are omitted. */
  readonly url?: string
  /** Whether the native configuration enables this server. */
  readonly enabled: boolean
  /** Source of the declaration. */
  readonly source: AgentCapabilitySource
}

/** One native MCP server resolved for DSH's approved, Agent-scoped connection. */
export type AgentMcpServerConfig =
  | {
    /** Native server name from the source configuration. */
    readonly name: string
    /** File layer that supplied the effective declaration. */
    readonly source: Extract<AgentCapabilitySource, 'user' | 'project' | 'config'>
    /** Starts one local MCP process with direct argv. */
    readonly transport: 'stdio'
    /** Executable, without shell interpolation. */
    readonly command: string
    /** Arguments passed directly to the executable. */
    readonly args: readonly string[]
    /** Explicit and selected inherited environment values for the child; values stay in memory. */
    readonly env: Readonly<Record<string, string>>
    /** Working directory for the child process. */
    readonly cwd: string
    /** Per-call timeout from the native configuration, converted to milliseconds. */
    readonly toolCallTimeoutMs?: number
  }
  | {
    /** Native server name from the source configuration. */
    readonly name: string
    /** File layer that supplied the effective declaration. */
    readonly source: Extract<AgentCapabilitySource, 'user' | 'project' | 'config'>
    /** Connect to an MCP Streamable HTTP endpoint. */
    readonly transport: 'streamable-http'
    /** Absolute HTTP(S) endpoint. */
    readonly url: string
    /** Resolved request headers; values stay in memory and are never returned by model-facing tools. */
    readonly headers: Readonly<Record<string, string>>
    /** Per-call timeout from the native configuration, converted to milliseconds. */
    readonly toolCallTimeoutMs?: number
  }

/** Native MCP server selection for an approved connection request. */
export interface AgentMcpServerResolveRequest {
  /** Server name from the native configuration. */
  readonly serverName: string
  /** Absolute project and default child working directory. */
  readonly cwd: string
  /** Cancellation while reading native configuration. */
  readonly signal?: AbortSignal
}

/** One slash command declared by an agent. */
export interface AgentCommandInfo {
  /** Name without its leading slash. */
  readonly name: string
  /** Description in the native declaration, when present. */
  readonly description?: string
  /** Source of the declaration. */
  readonly source: AgentCapabilitySource
  /** Absolute prompt-template path when the command is declared in a file. */
  readonly path?: string
}

/** One native configuration file observed while reading capabilities. */
export interface AgentCapabilitySourceFile {
  /** Absolute file or directory path. */
  readonly path: string
  /** Whether it was present and readable. */
  readonly present: boolean
  /** What this source contributes, or why it could not be read. */
  readonly note?: string
}

/** A limitation or unrecognized field in one capability projection. */
export interface AgentCapabilityNote {
  /** Inventory section affected. */
  readonly field: string
  /** What was unavailable or omitted. */
  readonly reason: string
}

/** Request for an agent's own configuration and capability declarations. */
export interface AgentCapabilityReadRequest {
  /** Directory whose project configuration and instruction files apply. */
  readonly cwd?: string
  /** Cancel the read between filesystem operations. */
  readonly signal?: AbortSignal
}

/** Read-only inventory of capabilities declared by one external agent. */
export interface AgentCapabilityInventory {
  /** Agent this inventory describes. */
  readonly agentId: AgentId
  /** Tools the native agent declares. */
  readonly tools: readonly AgentToolInfo[]
  /** Skills the native agent declares. */
  readonly skills: readonly AgentSkillInfo[]
  /** MCP servers the native agent declares. */
  readonly mcpServers: readonly AgentMcpServerInfo[]
  /** Slash commands the native agent declares. */
  readonly commands: readonly AgentCommandInfo[]
  /** Instruction files loaded by the native agent, in discovery order. */
  readonly contextFiles: readonly string[]
  /** Files and directories observed during this read. */
  readonly sources: readonly AgentCapabilitySourceFile[]
  /** Projection gaps that callers must not interpret as an empty declaration. */
  readonly notes: readonly AgentCapabilityNote[]
  /** ISO-8601 time this inventory was read. */
  readonly observedAt: string
}

/** One operation an adapter performed against an agent's credential store. */
export interface AgentAuthOperationResult {
  /** Whether the operation completed. */
  readonly ok: boolean
  /** The operation performed. */
  readonly action: 'login' | 'logout'
  /** Credential state observed after the operation. */
  readonly state: AgentAuthState
  /** What the user must do when the adapter could not complete the operation itself. */
  readonly instructions?: string
  /** Redacted command output, when the adapter ran a process. */
  readonly output?: string
}

/** Request to log an agent in. */
export interface AgentLoginRequest {
  /** Flow to use; must be one the adapter declared. */
  readonly flow: AgentLoginFlow
  /** Secret to hand to the agent on stdin; never recorded. */
  readonly secret?: string
}

/** Token accounting an agent reported for a run or a session. */
export interface AgentUsage {
  /** Prompt tokens. */
  readonly inputTokens?: number
  /** Completion tokens. */
  readonly outputTokens?: number
  /** Tokens served from the provider's cache. */
  readonly cachedInputTokens?: number
  /** Reasoning tokens, when the agent separates them. */
  readonly reasoningTokens?: number
  /** Total tokens as the agent counted them. */
  readonly totalTokens?: number
  /** Cost in US dollars, when the agent reports one. */
  readonly costUsd?: number
}

/** Terminal state of one dispatched run. */
export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout'

/** One native action or confirmation that the running agent asks its owner to approve. */
export interface AgentRunApprovalRequest {
  /** Native action category, or an interactive confirmation without a typed action category. */
  readonly kind: 'command' | 'file-change' | 'interaction'
  /** Short action label for the approval prompt. */
  readonly title: string
  /** Native request detail shown to the person deciding. */
  readonly detail: string
  /** Aborted when the native run ends or is cancelled. */
  readonly signal: AbortSignal
}

/** One decision for a native run approval request. */
export type AgentRunApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Request one DSH decision for a native action or confirmation during a run. */
export type AgentRunApprovalRequester = (
  request: AgentRunApprovalRequest,
) => Promise<AgentRunApprovalOutcome>

/** What a caller asks an adapter to run. */
export interface AgentRunRequest {
  /** Prompt to dispatch. */
  readonly prompt: string
  /** Working directory the agent runs in. */
  readonly cwd: string
  /** Model override, in the agent's own naming. */
  readonly model?: string
  /** Sandbox profile, when the agent has one. */
  readonly sandbox?: string
  /** Approval mode, when the agent has one. */
  readonly approval?: string
  /** Native session to continue. */
  readonly resumeNativeId?: string
  /** Wall-clock budget for the run. */
  readonly timeoutMs?: number
  /** Extra environment for the child, layered over the adapter's own. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Ask the owning DSH user to decide each native command, file change, or confirmation.
   * Adapters decline requests when this callback is absent; an allowed result
   * authorizes that one native request only.
   */
  readonly requestApproval?: AgentRunApprovalRequester
}

/** One projected event from a running agent. */
export type AgentRunEvent =
  | { readonly kind: 'run.started'; readonly runId: AgentRunId; readonly agentId: AgentId; readonly at: string }
  | { readonly kind: 'session.bound'; readonly runId: AgentRunId; readonly at: string; readonly nativeSessionId: string }
  | { readonly kind: 'message.delta'; readonly runId: AgentRunId; readonly at: string; readonly text: string }
  | { readonly kind: 'message.completed'; readonly runId: AgentRunId; readonly at: string; readonly text: string }
  | { readonly kind: 'reasoning.delta'; readonly runId: AgentRunId; readonly at: string; readonly text: string }
  | { readonly kind: 'tool.started'; readonly runId: AgentRunId; readonly at: string; readonly callId?: string; readonly toolName: string; readonly input?: string }
  | { readonly kind: 'tool.completed'; readonly runId: AgentRunId; readonly at: string; readonly callId?: string; readonly toolName: string; readonly output?: string; readonly failed?: boolean }
  | { readonly kind: 'todos.updated'; readonly runId: AgentRunId; readonly at: string; readonly todos: readonly { readonly content: string; readonly status: AgentTodoStatus }[] }
  | { readonly kind: 'files.changed'; readonly runId: AgentRunId; readonly at: string; readonly paths: readonly string[] }
  | { readonly kind: 'usage.updated'; readonly runId: AgentRunId; readonly at: string; readonly usage: AgentUsage }
  | { readonly kind: 'warning'; readonly runId: AgentRunId; readonly at: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly runId: AgentRunId; readonly at: string; readonly nativeType?: string; readonly native?: string }
  | { readonly kind: 'run.finished'; readonly runId: AgentRunId; readonly at: string; readonly result: AgentRunResult }

/** Terminal record of one run. */
export interface AgentRunResult {
  /** Run identity. */
  readonly runId: AgentRunId
  /** Owning agent. */
  readonly agentId: AgentId
  /** Terminal status. */
  readonly status: AgentRunStatus
  /** ISO-8601 dispatch time. */
  readonly startedAt: string
  /** ISO-8601 terminal time. */
  readonly finishedAt: string
  /** Wall-clock duration. */
  readonly durationMs: number
  /** Working directory the agent ran in. */
  readonly cwd: string
  /** Process exit code, when the process exited. */
  readonly exitCode?: number
  /** Terminating signal, when one terminated the process. */
  readonly signal?: string
  /** The answer the run selected, when it produced one. */
  readonly finalText?: string
  /** Usage the run reported. */
  readonly usage?: AgentUsage
  /** Native session the run bound to, when it bound one. */
  readonly nativeSessionKey?: AgentSessionKey
  /** Classified failure, when the run did not succeed. */
  readonly error?: { readonly code: string; readonly message: string; readonly remediation?: string; readonly output?: string }
  /** Everything the projection could not carry, stated for the reader. */
  readonly notes: readonly string[]
}

/** One run as a caller observes it without subscribing to anything. */
export interface MeshRunSnapshot {
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
  /** The most recent events, newest last, bounded by the registry's retention. */
  readonly events: readonly AgentRunEvent[]
  /** Total events observed, including ones no longer retained. */
  readonly eventCount: number
  /** The native session the run bound to, when it bound one. */
  readonly nativeSessionKey?: string
}

/** A run's identity and its cancellation, as `start` returns it. */
export interface MeshRunHandle {
  /** Run identity. */
  readonly runId: AgentRunId
  /** Resolves with the terminal result; never rejects. */
  readonly result: Promise<AgentRunResult>
}

/** A dispatched run: its event stream, its terminal record, and its cancellation. */
export interface AgentRun extends AsyncIterable<AgentRunEvent> {
  /** Run identity. */
  readonly id: AgentRunId
  /** Resolves with the terminal record; never rejects for a failed run. */
  readonly result: Promise<AgentRunResult>
  /** Cancel the run. The first call wins; later calls do nothing. */
  cancel(reason?: string): void
}

/**
 * The provider contract every external agent integration implements. A mesh
 * consumer resolves an adapter through {@link AgentMesh} and never spawns an
 * agent's binary itself.
 */
export interface AgentAdapter {
  /** Registry identity; must be unique within one mesh. */
  readonly id: AgentId
  /** Observe identity, capabilities, and detection. */
  describe(): Promise<AgentDescriptor>
  /** Read credential state. */
  readAuthState(): Promise<AgentAuthState>
  /** List sessions in the agent's own store. */
  listSessions(options: AgentSessionListOptions): Promise<readonly AgentSession[]>
  /**
   * Return argv for a human to open the agent's native TUI at one session.
   * The adapter describes the command and never starts it.
   * @param nativeId - The exact identifier assigned by the agent.
   * @returns The executable and its arguments, in order.
   */
  nativeLaunchCommand?(nativeId: string): Promise<readonly string[]>
  /** Read one window of a session's transcript. */
  readTranscript(request: AgentTranscriptRequest): Promise<AgentTranscript>
  /** Read the agent's own todo and plan state, when it has one. */
  readNativeTasks(request: AgentNativeTasksRequest): Promise<AgentNativeTasks>
  /** List the agent's configured models, when the agent exposes them. */
  listModels(): Promise<readonly AgentModel[]>
  /** Read the capabilities its own configuration, extensions, and skill directories declare. */
  readCapabilities(request: AgentCapabilityReadRequest): Promise<AgentCapabilityInventory>
  /**
   * Resolve one native MCP declaration without starting it or exposing its secrets in inventories.
   * @param request - Server name, absolute project directory, and cancellation signal.
   * @returns The effective declaration, or `undefined` when the server is absent.
   * @throws When the effective declaration is unreadable, disabled, malformed, or unsupported.
   */
  resolveMcpServer(request: AgentMcpServerResolveRequest): Promise<AgentMcpServerConfig | undefined>
  /** Dispatch one run and return its event stream. */
  startRun(request: AgentRunRequest): AgentRun
  /** Perform one login flow, or explain what the user must run instead. */
  login(request: AgentLoginRequest): Promise<AgentAuthOperationResult>
  /** Log the agent out, or explain what the user must run instead. */
  logout(): Promise<AgentAuthOperationResult>
}

// The adapter host port. Its declarations live here, in the module the coverage
// configuration excludes as declaration-only.

/** Metadata of one path, as the host reports it. */
export interface HostStat {
  /** Byte size; 0 for a directory. */
  readonly size: number
  /** Last-modification time in epoch milliseconds. */
  readonly mtimeMs: number
  /** Whether the path is a directory. */
  readonly isDirectory: boolean
}

/** One child of a directory. */
export interface HostDirEntry {
  /** Basename of the child. */
  readonly name: string
  /** Whether the child is a directory. */
  readonly isDirectory: boolean
  /** Last-modification time in epoch milliseconds. */
  readonly mtimeMs: number
}

/** What an adapter asks the host to run. */
export interface HostSpawnSpec {
  /** Executable to run. */
  readonly command: string
  /** Arguments, excluding the executable. */
  readonly args: readonly string[]
  /** Working directory for the child. */
  readonly cwd: string
  /** Environment entries layered over the host's scrubbed parent environment. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Text to write to the child's stdin, which is then closed. */
  readonly stdin?: string
  /** Keep stdin open for a line-oriented duplex protocol. Mutually exclusive with `stdin`. */
  readonly interactive?: boolean
  /** Wall-clock budget; the host terminates the child when it expires. */
  readonly timeoutMs?: number
  /** Largest accepted stdout line, in bytes; a longer line is dropped and logged. */
  readonly maxLineBytes?: number
}

/** How a child process ended. */
export interface HostExit {
  /** Exit code, or null when a signal ended the process. */
  readonly code: number | null
  /** Terminating signal, or null on a normal exit. */
  readonly signal: string | null
  /** Whether the host's own deadline terminated the child. */
  readonly timedOut: boolean
  /** Whether the caller cancelled the run. */
  readonly cancelled: boolean
}

/** A running child process. */
export interface HostProcess {
  /** Stdout lines, split on `\n`, with a trailing `\r` removed. */
  readonly lines: AsyncIterable<string>
  /** Everything the child wrote to stderr, as text. */
  stderr(): Promise<string>
  /** Resolves with the child's exit facts; never rejects for a non-zero exit. */
  readonly exit: Promise<HostExit>
  /** Terminate the child. The first call wins; later calls do nothing. */
  cancel(reason?: string): void
  /** Write one frame to a child started with `interactive: true`. */
  writeStdin?(data: string): void
  /** Close stdin on a child started with `interactive: true`. */
  closeStdin?(): void
}

/** What an adapter needs from its host: files, processes, environment, time. */
export interface AgentHost {
  /** Environment the host will inherit-and-scrub for a child. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The person's home directory, used to resolve an agent's default store. */
  readonly home: string
  /**
   * Stat one path.
   * @param path - Absolute path.
   * @returns the metadata, or undefined when the path does not exist.
   */
  stat(path: string): Promise<HostStat | undefined>
  /**
   * List one directory.
   * @param path - Absolute path.
   * @returns the children, or an empty list when the directory is absent.
   */
  listDir(path: string): Promise<readonly HostDirEntry[]>
  /**
   * Read the first bytes of a file.
   * @param path - Absolute path.
   * @param maxBytes - Maximum bytes to read.
   * @returns the decoded text, or an empty string when the file is absent.
   */
  readHead(path: string, maxBytes: number): Promise<string>
  /**
   * Read the last bytes of a file.
   * @param path - Absolute path.
   * @param maxBytes - Maximum bytes to read.
   * @returns the decoded text, and whether a leading partial line was dropped.
   */
  readTail(path: string, maxBytes: number): Promise<{ text: string; droppedPartialLine: boolean }>
  /**
   * Spawn a child process.
   * @param spec - The fully specified spawn request.
   * @returns the running child.
   */
  spawn(spec: HostSpawnSpec): HostProcess
  /** Current time in epoch milliseconds; injected so tests can pin it. */
  now(): number
  /**
   * Record one diagnostic line.
   * @param level - Severity.
   * @param message - Text to record.
   */
  log(level: 'info' | 'warn', message: string): void
}
