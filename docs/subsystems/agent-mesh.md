# Agent mesh

English | [中文](agent-mesh.zh.md)

The multi-agent family makes the coding agents a person already runs — Codex, Grok Build, Pi, OMP — visible to the Harness without re-implementing them. [`packages/agent-mesh/README.md`](../../packages/agent-mesh/README.md) owns the package topology and the per-package contracts.

## The seam

`ctx.agentMesh` is the registry every adapter registers on, plus the durable binding that records which agent one Harness session belongs to and Harness-owned pin/archive marks for agent-native sessions. The binding and marks use separate versioned storage domains. The service owns no agent format: it never reads an agent's files and never spawns one. An adapter that fails to describe its agent becomes a diagnostic for that agent and leaves the others untouched, so a machine with one broken integration still reports the rest.

The binding lives in the mesh's own storage domain (`agent_mesh`), and pin/archive marks live in `agent_mesh_session_marks`; both are versioned independently of the Session format. A Harness that does not know either domain reads only its own data, and their absence changes nothing for it.

## The provider contract

An adapter implements `AgentAdapter`: describe, read credential state, list the agent's own sessions, optionally return native TUI argv for one session, read a transcript window, read the agent's own todos and plan, list models, resolve native MCP configuration, dispatch a run, and perform login and logout. The launch method describes argv only; the controller does not start that command. `resolveMcpServer()` reads one effective declaration without starting it or returning secret values to inventories. Its logic is a function of `AgentHost` — files, processes, environment, clock — which `createContextHost` builds from `ctx.fs` and `ctx.subprocess`. Batch runs close stdin after their initial input; native RPC runs can keep stdin writable for protocol commands and close it during teardown. That split makes parsing, classification, and transport behavior testable against an in-memory host, and it is why a refusal by the filesystem policy (a sandboxed provider that does not allow the home directory) reaches the reader as an absent store rather than as an exception mid-scan.

`AgentMcpServerInfo` is the inventory summary: it reports the executable name or endpoint origin, never process arguments, endpoint paths, query values, or environment values. `resolveMcpServer()` returns `undefined` when the name is absent and otherwise returns an `AgentMcpServerConfig` for stdio or Streamable HTTP activation. The resolved arguments, environment, and headers pass to the MCP client and never return through model-facing tools.

Reads are projections onto one vocabulary, and each result carries the `notes` an adapter could not express as fields. A record whose native type the adapter does not model is projected as `unknown` with its native type preserved rather than dropped, so a protocol revision shows up as a visible gap.

## Native model routes

Each agent package also registers a separate provider with `ctx.llm`. It reads the agent's configured provider, endpoint, model, and supported credential data and exposes those models through the Harness LLM service. This is independent of `AgentAdapter.listModels`: an adapter can report that its agent catalog operation is unavailable while still providing direct routes from its configuration files. Model requests use the Harness LLM adapter and the configured endpoint; they do not dispatch a run through the agent CLI. Native credentials remain in their source store, and a route refuses authentication or request settings it cannot reproduce.

## Runs

`ctx.agentMesh` also tracks dispatched runs: the request, the projected events from the agent's own output stream (bounded retention), the terminal result with its classified failure, and cancellation. The registry never spawns anything itself — the adapter owns the transport — and it never rejects: a run that fails is a record with a terminal status. Runs are not worktree-isolated; the caller supplies the working directory.

Model calls to `mesh_run` require DSH user approval before an adapter starts the run. The tool can select one exact file-backed command by `commandName`, read its declared template through `ctx.fs`, remove frontmatter, and prepend the body to the task. It then waits for a terminal result and returns the run identity, final answer or classified error, and notes. Its `approval` option selects the external CLI's native mode and does not grant DSH approval. A missing owning agent or approval answerer fails the call closed.

An adapter can route supported native approval requests through the same DSH approval service while the run is active. Codex's default app-server mode forwards command and file-change requests and grants only one-shot `accept`; Grok's ACP mode forwards permission requests and accepts only one-shot allow or reject decisions. Pi RPC and OMP `rpc-ui` forward `confirm` requests and `select` requests only when the choices include explicit one-shot allow and deny options. Unsupported dialogs and decisions fail closed.

## Collaboration

`ctx.meshCollaboration` owns work that spans agents: one collaboration record with a single authoritative plan and a single todo board, a task per unit of work with an assignee and dependencies, and a git worktree per isolated task under the repository's own `.dsh-agent-mesh/worktrees`. A dispatch creates or reuses that worktree, hands the agent the instruction plus the plan and todo context, and records the run on the task. Worktrees are sampled for changed files and commit position; conflict reports compare same-file overlaps, base-line ranges, configured feature path prefixes, and base commits. They are advisory and do not stop dispatch. A stale todo write (an `expectedRevision` that no longer matches) is refused rather than clobbering the board. Todo observation folds an agent's own native tasks into the board without overwriting authored items.

Model calls to `mesh_task_dispatch` and `mesh_worktree_remove` require DSH approval before starting an agent or deleting a worktree. Forced removal can discard uncommitted changes.

## Surfaces

The model reaches the mesh through `mesh_agents`, `mesh_capabilities`, `mesh_capability_read`, `mesh_sessions`, `mesh_transcript`, `mesh_tasks`, `mesh_run`, `mesh_runs`, `mesh_run_cancel`, `mesh_mcp_connect`, and `mesh_mcp_disconnect`. Adapters that report native tool names also contribute up to `maxProxyTools` Agent-scoped `mesh_agent_tool_*` proxies; each accepts a free-text `task`, rechecks the live binding and inventory, then delegates through the external CLI after DSH approval. `mesh_capabilities` reports declared tools, skills, MCP servers, commands, context files, and their paths without invoking them. `mesh_capability_read` reads one exact skill instruction, command template, or context file declared by the current inventory through `ctx.fs`, with a 1 MiB cap. `mesh_mcp_connect` starts one stdio or Streamable HTTP server after first-use DSH approval and exposes its tools only to the calling Agent; disconnect and Agent disposal remove those tools. Inventory shows executable names and endpoint origins, while approval text hides arguments and credentials. The separate `ctx.llm` providers expose the configured models for direct Harness model requests. The Web Client reaches mesh data through the `remote.agentMesh` namespace (agents, sessions, native TUI argv, transcript, tasks, credentials, login and logout, bindings, and runs) rendered by the Agent Mesh panel. `launchCommand` returns a `MeshLaunchCommand` containing argv and the DSH Host shell dialect, or `null` when the adapter has no native launcher. The panel quotes it for that shell and offers it for copying; the Web Host never starts the native CLI. `session.list` also includes visible agent-native session rows in the Harness session index; Workspace browsing groups them by exact registered path, searches their metadata, and applies mesh-owned pin/archive marks. Selecting one opens its source-owned session in the Agent Mesh panel. Both read through the same service, so a capability appears on both surfaces or on neither.

The human command package registers six global inspection commands and file-backed aliases for the current Agent binding. An alias queues a model follow-up with the exact native `commandName` and working directory; the resulting `mesh_run` still requires DSH approval.

A DSH Session with an external-agent binding refreshes the required `agent-mesh:native-context` system-prompt contribution before each model step. The agent loop records it in the durable `runtime-context` user-role snapshot and replaces the prior snapshot when context changes or is removed, so session replay retains the model input. Adapter notes remain in the contribution when discovery is incomplete. Reads use `ctx.fs`, each file is limited to 1 MiB, and `contextMaxBytes` bounds the rendered native contribution with a 2 MiB default; a read failure or over-budget contribution rejects step admission.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentmesh--agentmesh"></a>

### `ctx.agentMesh` — `AgentMesh`

The mesh registry. Adapters register as effects, so unmounting an adapter removes it and its agents' rows disappear with it.

```ts cordis-catalog
/**
 * Dispatch one run on a registered agent.
 * @param agentId - Agent to run.
 * @param request - Prompt, working directory, and transport options.
 * @returns the run's identity and its terminal result. The run continues.
 */
startRun(agentId: AgentId | string, request: AgentRunRequest): MeshRunHandle

/**
 * Read one tracked run.
 * @param runId - Run identity.
 * @returns the snapshot, or undefined when the run is unknown or evicted.
 */
run(runId: string): MeshRunSnapshot | undefined

/**
 * Read one agent's declared tools, skills, servers, commands, and context files.
 * @param agentId - Agent whose native configuration is read.
 * @param request - Project directory and cancellation signal.
 * @returns the agent's capability inventory and any declared gaps.
 */
async readCapabilities( agentId: AgentId | string, request: AgentCapabilityReadRequest = {}, ): Promise<AgentCapabilityInventory>

/**
 * Resolve one native MCP server declaration without connecting to it.
 * @param agentId - Agent whose native MCP configuration is read.
 * @param request - Server name, project working directory, and cancellation.
 * @returns the effective server config, or `undefined` when that name is absent.
 */
async resolveMcpServer( agentId: AgentId | string, request: AgentMcpServerResolveRequest, ): Promise<AgentMcpServerConfig | undefined>

/**
 * Cancel one run.
 * @param runId - Run identity.
 * @param reason - Recorded reason.
 * @returns whether a live run was cancelled.
 */
cancelRun(runId: string, reason?: string): boolean

/**
 * Wait for one run to settle.
 * @param runId - Run identity.
 * @returns the terminal snapshot, or undefined when the run is unknown.
 */
async waitForRun(runId: string): Promise<MeshRunSnapshot | undefined>

/**
 * Read every registered agent's own session store.
 * A single adapter failure is retained beside readable stores so callers
 * can show incomplete coverage without losing usable rows.
 * @param options - Session filters, result bound, and cancellation.
 * @returns readable sessions in activity order and per-adapter failures.
 */
async listSessions(options: AgentSessionListOptions = {}): Promise<AgentSessionCatalog>

/**
 * Read the persisted pin/archive choices for external sessions.
 * @returns marks newest first.
 */
sessionMarks(): readonly AgentSessionMark[]

/**
 * Read one external session's persisted pin/archive choice.
 * @param reference - Exact agent-owned session identity.
 * @returns the current mark, or undefined when neither pinned nor archived.
 */
sessionMark(reference: AgentSessionReference): AgentSessionMark | undefined

/**
 * Pin an existing external session.
 * @param reference - Exact agent-owned session identity.
 * @returns resolution after the Harness-owned mark is durable.
 */
async pinSession(reference: AgentSessionReference): Promise<void>

/**
 * Archive an existing external session.
 * @param reference - Exact agent-owned session identity.
 * @returns resolution after the Harness-owned mark is durable.
 */
async archiveSession(reference: AgentSessionReference): Promise<void>

/**
 * Remove a session's pin or archive mark.
 * @param reference - Exact agent-owned session identity.
 * @param expected - Current disposition to remove when the caller is reversing one specific action.
 * @returns whether a persisted mark was removed.
 */
async clearSessionDisposition( reference: AgentSessionReference, expected?: AgentSessionDisposition, ): Promise<boolean>

/**
 * Register one agent adapter.
 * @param adapter - The provider to register.
 * @returns the disposer that unregisters it.
 */
register(adapter: AgentAdapter): () => void

/**
 * Resolve one adapter.
 * @param id - Agent identity.
 * @returns the registered adapter.
 */
adapter(id: AgentId | string): AgentAdapter

/**
 * Describe every registered agent.
 * @returns one descriptor per adapter, in registration order.
 */
async describe(): Promise<readonly AgentDescriptor[]>

/**
 * Report every registered agent, turning an adapter failure into a warning
 * for that agent instead of failing the whole report.
 * @returns the diagnostics report.
 */
async diagnostics(): Promise<AgentMeshDiagnostics>

/**
 * Bind one harness session to one agent.
 * @param sessionId - Harness session identity.
 * @param agentId - Agent the session belongs to.
 */
async bind(sessionId: SessionId, agentId: AgentId): Promise<void>

/**
 * Read one session's binding.
 * @param sessionId - Harness session identity.
 * @returns the bound agent, or undefined when the session is unbound.
 */
bound(sessionId: SessionId): AgentId | undefined

/**
 * Remove one session's binding.
 * @param sessionId - Harness session identity.
 * @returns whether a binding was removed.
 */
async unbind(sessionId: SessionId): Promise<boolean>

/**
 * Every binding, for callers that project the binding onto session lists.
 * @returns one row per bound session.
 */
bindings(): readonly { readonly sessionId: SessionId; readonly agentId: AgentId; readonly boundAt: string }[]
```

Types: [SessionId](core.md)

Source: [`packages/agent-mesh/mesh/src/index.ts`](../../packages/agent-mesh/mesh/src/index.ts)

<a id="ctxagentmeshcontroller--agentmeshcontroller"></a>

### `ctx.agentMeshController` — `AgentMeshController`

The mesh's Remote service, mounted in the API assembly as `remote.agentMesh`.

```ts cordis-catalog
/**
 * Every registered agent with its detection state.
 * @param signal - Carrier cancellation.
 * @returns one row per registered adapter, in registration order.
 */
@Remote('agents') async remoteExportAgents(signal: AbortSignal): Promise<readonly MeshAgentRow[]>

/**
 * One agent's own sessions, newest first.
 * @param request - Agent and filters.
 * @param signal - Carrier cancellation.
 * @returns the session rows.
 */
@Remote('sessions') async remoteExportSessions(request: MeshSessionListRequest, signal: AbortSignal): Promise<readonly MeshSessionRow[]>

/**
 * Native TUI argv for one exact agent-owned session; this endpoint never starts it.
 * @param request - Agent and native session identity.
 * @param signal - Carrier cancellation.
 * @returns argv plus the Host shell dialect, or null when this adapter has no native TUI launcher.
 */
@Remote('launchCommand') async remoteExportLaunchCommand(request: MeshSessionRequest, signal: AbortSignal): Promise<MeshLaunchCommand | null>

/**
 * Pin one session in its source-owned store in Harness browsing surfaces.
 * @param request - Agent and native session identity.
 * @param signal - Carrier cancellation.
 */
@Remote('pinSession') async remotePinSession(request: MeshSessionDispositionRequest, signal: AbortSignal): Promise<void>

/**
 * Remove one external session from the Harness pin list.
 * @param request - Agent and native session identity.
 * @param signal - Carrier cancellation.
 */
@Remote('unpinSession') async remoteUnpinSession(request: MeshSessionDispositionRequest, signal: AbortSignal): Promise<void>

/**
 * Archive one external session from the Harness browsing surfaces without stopping its agent.
 * @param request - Agent and native session identity.
 * @param signal - Carrier cancellation.
 */
@Remote('archiveSession') async remoteArchiveSession(request: MeshSessionDispositionRequest, signal: AbortSignal): Promise<void>

/**
 * Restore one external session to the Harness browsing surfaces.
 * @param request - Agent and native session identity.
 * @param signal - Carrier cancellation.
 */
@Remote('unarchiveSession') async remoteUnarchiveSession(request: MeshSessionDispositionRequest, signal: AbortSignal): Promise<void>

/**
 * One window of a session's transcript.
 * @param request - Agent, session, and window bound.
 * @param signal - Carrier cancellation.
 * @returns the transcript window.
 */
@Remote('transcript') async remoteExportTranscript(request: MeshTranscriptRequest, signal: AbortSignal): Promise<MeshTranscriptResponse>

/**
 * One session's native todo and plan state.
 * @param request - Agent and session.
 * @param signal - Carrier cancellation.
 * @returns the agent's own task state.
 */
@Remote('tasks') async remoteExportTasks(request: MeshSessionRequest, signal: AbortSignal): Promise<AgentNativeTasks>

/**
 * Read the declarations in one agent's own configuration and skill roots.
 * @param request - Agent and optional project directory.
 * @param signal - Carrier cancellation.
 * @returns the inventory, or null when remote access excludes this agent.
 */
@Remote('capabilities') async remoteExportCapabilities( request: MeshCapabilityRequest, signal: AbortSignal, ): Promise<MeshCapabilityResponse | null>

/**
 * Credential state for every agent, or one agent.
 * @param agentId - Optional agent filter.
 * @param signal - Carrier cancellation.
 * @returns one row per requested agent.
 */
@Remote('credentials') async remoteExportCredentials(agentId: string | null, signal: AbortSignal): Promise<readonly MeshCredentialRow[]>

/**
 * Log one agent in.
 * @param request - Agent, flow, and optional secret.
 * @param signal - Carrier cancellation.
 * @returns the operation result.
 */
@Remote('login') async remoteExportLogin(request: MeshLoginRequest, signal: AbortSignal): Promise<AgentAuthOperationResult>

/**
 * Log one agent out.
 * @param agentId - Agent to log out.
 * @param signal - Carrier cancellation.
 * @returns the operation result.
 */
@Remote('logout') async remoteExportLogout(agentId: string, signal: AbortSignal): Promise<AgentAuthOperationResult>

/**
 * Bind one Harness session to one agent.
 * @param sessionId - Harness session id.
 * @param agentId - Agent to bind.
 * @param signal - Carrier cancellation.
 */
@Remote('bind') async remoteExportBind(sessionId: string, agentId: string, signal: AbortSignal): Promise<void>

/**
 * Remove one Harness session's binding.
 * @param sessionId - Harness session id.
 * @param signal - Carrier cancellation.
 * @returns whether a binding was removed.
 */
@Remote('unbind') async remoteExportUnbind(sessionId: string, signal: AbortSignal): Promise<boolean>

/**
 * Every binding, so a session list can show which agent each session belongs to.
 * @param signal - Carrier cancellation.
 * @returns one row per binding.
 */
@Remote('bindings') remoteExportBindings(signal: AbortSignal): Promise<readonly MeshBindingRow[]>

/**
 * Dispatch one run to an external agent.
 * @param request - Agent, prompt, working directory, and transport options.
 * @param signal - Carrier cancellation.
 * @returns the new run's id and agent.
 */
@Remote('runStart') remoteExportRunStart( request: MeshRunStartRequest, signal: AbortSignal, ): Promise<{ readonly runId: string; readonly agentId: string }>

/**
 * Every tracked run, newest first.
 * @param signal - Carrier cancellation.
 * @returns the run rows.
 */
@Remote('runs') remoteExportRuns(signal: AbortSignal): Promise<readonly MeshRunRow[]>

/**
 * Cancel one run.
 * @param runId - Run to cancel.
 * @param signal - Carrier cancellation.
 * @returns whether a live run was cancelled.
 */
@Remote('runCancel') remoteExportRunCancel(runId: string, signal: AbortSignal): Promise<boolean>
```

Source: [`packages/agent-mesh/controller/src/index.ts`](../../packages/agent-mesh/controller/src/index.ts)

<a id="ctxmeshcollaboration--meshcollaboration"></a>

### `ctx.meshCollaboration` — `MeshCollaboration`

The collaboration service.

It owns the domain, the worktree manager, and the plan and board documents; a consumer reaches all of them through this one key, and no other package writes the collaboration tables.

```ts cordis-catalog
/**
 * Create one collaboration with its plan, its board, and its initial tasks.
 * @param request - Title, objective, repository, and optional task seeds.
 * @returns the created collaboration.
 */
async start(request: StartCollaborationRequest): Promise<CollaborationView>

/**
 * Every collaboration, most recently changed first.
 * @returns one view per collaboration, without live worktree samples.
 */
list(): readonly CollaborationView[]

/**
 * Read one collaboration.
 * @param collaborationId - Collaboration id.
 * @returns the collaboration with its plan, board, tasks and worktrees.
 */
get(collaborationId: string): CollaborationView

/**
 * Read one collaboration's plan.
 * @param collaborationId - Collaboration id.
 * @returns the plan.
 */
plan(collaborationId: string): PlanRecord

/**
 * Replace a collaboration's plan fields.
 * @param collaborationId - Collaboration id.
 * @param patch - Fields to replace; an absent field keeps its current value.
 * @returns the plan after the write.
 */
async setPlan(collaborationId: string, patch: PlanPatch): Promise<PlanRecord>

/**
 * Move the plan to a phase, marking every earlier phase done.
 * @param collaborationId - Collaboration id.
 * @param phaseId - Phase to activate.
 * @returns the plan after the write.
 */
async advancePhase(collaborationId: string, phaseId: string): Promise<PlanRecord>

/**
 * Read a collaboration's todo board.
 * @param collaborationId - Collaboration id.
 * @returns the board with its revision.
 */
getTodos(collaborationId: string): TodoBoardRecord

/**
 * Replace a collaboration's todo board.
 * @param collaborationId - Collaboration id.
 * @param todos - The complete new board.
 * @param options - Expected revision; a mismatch is refused rather than applied.
 * @returns the board after the write.
 */
async setTodos(collaborationId: string, todos: readonly TodoInput[], options: SetTodosOptions = {}): Promise<TodoBoardRecord>

/**
 * Fold one agent's own native task state into a collaboration's board.
 * @param collaborationId - Collaboration id.
 * @param agentId - Agent whose store is read.
 * @param sessionId - The agent's native session id; its newest session when omitted.
 * @returns the board, how many items changed, and what could not be observed.
 */
async observeTodos(collaborationId: string, agentId: string, sessionId?: string): Promise<ObserveOutcome>

/**
 * Render exactly the context a dispatched run for one agent would receive.
 * @param collaborationId - Collaboration id.
 * @param agentId - Agent the context would be rendered for.
 * @returns the context block and its hash, or undefined when the plan mode is observe-only.
 */
contextPreview(collaborationId: string, agentId: string): ContextPreview | undefined

/**
 * Every task of one collaboration, in creation order.
 * @param collaborationId - Collaboration id.
 * @returns the tasks.
 */
tasks(collaborationId: string): readonly CollaborationTaskRecord[]

/**
 * Read one task.
 * @param collaborationId - Collaboration the task belongs to.
 * @param taskId - Task id.
 * @returns the task.
 */
task(collaborationId: string, taskId: string): CollaborationTaskRecord

/**
 * Dispatch one task: isolate it, inject the shared context, and record the run.
 *
 * A task is refused when it already runs or succeeded, and when any task it depends
 * on has not succeeded.
 * @param collaborationId - Collaboration owning the task.
 * @param taskId - Task to dispatch.
 * @param options - Base ref for a newly created worktree and a run budget.
 * @returns the task after dispatch, the run id, the working directory, and the injected context.
 */
async dispatchTask(collaborationId: string, taskId: string, options: DispatchOptions = {}): Promise<TaskDispatchResult>

/**
 * List worktrees with a live progress sample.
 * @param repoRoot - Restrict to one repository; every recorded worktree when omitted.
 * @returns one view per worktree, newest first; an explicit path outside a git
 *   repository returns an empty list.
 */
async worktrees(repoRoot?: string): Promise<readonly WorktreeView[]>

/**
 * Create or reuse one worktree.
 * @param request - Agent, repository, base ref, and labels.
 * @returns the worktree with its first sample.
 */
async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeView>

/**
 * Compare the live worktrees of one repository.
 * @param repoRoot - Repository to analyse.
 * @returns predicted same-file, same-hunk, feature-area, and base-commit findings.
 */
async worktreeConflicts(repoRoot: string): Promise<ConflictReport>

/**
 * Remove one worktree.
 * @param worktreeId - Worktree to remove.
 * @param options - `force` discards uncommitted and unmerged work.
 * @returns the record, marked `removed`.
 */
async removeWorktree(worktreeId: string, options: RemoveWorktreeOptions = {}): Promise<WorktreeRecord>

/**
 * Mark one worktree integrated, or outstanding again.
 * @param worktreeId - Worktree to mark.
 * @param merged - `false` marks it outstanding again.
 * @returns the updated record.
 */
async markWorktreeIntegrated(worktreeId: string, merged: boolean = true): Promise<WorktreeRecord>
```

Types: [CreateWorktreeRequest](worktrees.md)

Source: [`packages/agent-mesh/collaboration/src/index.ts`](../../packages/agent-mesh/collaboration/src/index.ts)

<a id="ctxmeshcollaborationcontroller--meshcollaborationcontroller"></a>

### `ctx.meshCollaborationController` — `MeshCollaborationController`

The collaboration Remote service, mounted in the API assembly as `remote.meshCollaboration`.

```ts cordis-catalog
/**
 * Every collaboration, most recently changed first, or one collaboration.
 * @param collaborationId - Collaboration to read; null lists every one.
 * @param signal - Carrier cancellation.
 * @returns one row per collaboration.
 */
@Remote('collaborations') remoteExportCollaborations( collaborationId: string | null, signal: AbortSignal, ): Promise<readonly MeshCollaborationRow[]>

/**
 * Create one collaboration.
 * @param request - Title, objective, repository, and optional task seeds.
 * @param signal - Carrier cancellation.
 * @returns the created collaboration.
 */
@Remote('collaborationStart') async remoteExportCollaborationStart(request: MeshCollaborationStartRequest, signal: AbortSignal): Promise<MeshCollaborationRow>

/**
 * Replace a collaboration's plan fields.
 * @param request - Collaboration, objective, and the fields to replace.
 * @param signal - Carrier cancellation.
 * @returns the plan after the write.
 */
@Remote('planSet') async remoteExportPlanSet(request: MeshPlanSetRequest, signal: AbortSignal): Promise<readonly MeshPlanPhaseRow[]>

/**
 * Move a plan to a phase, marking every earlier phase done.
 * @param request - Collaboration and phase.
 * @param signal - Carrier cancellation.
 * @returns the plan phases after the write.
 */
@Remote('planAdvance') async remoteExportPlanAdvance(request: MeshPlanAdvanceRequest, signal: AbortSignal): Promise<readonly MeshPlanPhaseRow[]>

/**
 * Render exactly the context a dispatched run for one agent would receive.
 * @param request - Collaboration and agent.
 * @param signal - Carrier cancellation.
 * @returns the block and its hash, or an unavailable result when the plan is observe-only.
 */
@Remote('planContextPreview') async remoteExportPlanContextPreview(request: MeshContextPreviewRequest, signal: AbortSignal): Promise<MeshContextPreviewRow>

/**
 * Read one collaboration's todo board.
 * @param request - Collaboration to read.
 * @param signal - Carrier cancellation.
 * @returns the board with its revision.
 */
@Remote('todosGet') async remoteExportTodosGet(request: MeshCollaborationRequest, signal: AbortSignal): Promise<MeshTodoBoardRow>

/**
 * Replace one collaboration's todo board.
 * @param request - Collaboration, the complete new board, and the expected revision.
 * @param signal - Carrier cancellation.
 * @returns the board after the write.
 */
@Remote('todosSet') async remoteExportTodosSet(request: MeshTodosSetRequest, signal: AbortSignal): Promise<MeshTodoBoardRow>

/**
 * Fold one agent's own native task state into a collaboration's board.
 * @param request - Collaboration, agent, and optional session.
 * @param signal - Carrier cancellation.
 * @returns the board after the fold and how many items changed.
 */
@Remote('todosObserve') async remoteExportTodosObserve(request: MeshTodosObserveRequest, signal: AbortSignal): Promise<MeshTodosObserveResponse>

/**
 * Dispatch one collaboration task.
 * @param request - Collaboration, task, and dispatch options.
 * @param signal - Carrier cancellation.
 * @returns the run id, working directory, and injected context hash.
 */
@Remote('taskDispatch') async remoteExportTaskDispatch(request: MeshTaskDispatchRequest, signal: AbortSignal): Promise<MeshTaskDispatchResponse>

/**
 * List worktrees with a live progress sample.
 * @param request - Optional repository filter.
 * @param signal - Carrier cancellation.
 * @returns one row per worktree, newest first.
 */
@Remote('worktrees') async remoteExportWorktrees(request: MeshWorktreeListRequest, signal: AbortSignal): Promise<readonly MeshWorktreeRow[]>

/**
 * Create or reuse one worktree.
 * @param request - Agent, repository, base ref, and labels.
 * @param signal - Carrier cancellation.
 * @returns the worktree with its first sample.
 */
@Remote('worktreeCreate') async remoteExportWorktreeCreate(request: MeshWorktreeCreateRequest, signal: AbortSignal): Promise<MeshWorktreeRow>

/**
 * Compare the live worktrees of one repository.
 * @param request - Repository to analyse.
 * @param signal - Carrier cancellation.
 * @returns predicted same-file, same-hunk, feature-area, and base-commit findings.
 */
@Remote('worktreeConflicts') async remoteExportWorktreeConflicts(request: MeshWorktreeConflictsRequest, signal: AbortSignal): Promise<MeshConflictReportRow>

/**
 * Remove one worktree.
 * @param request - Worktree and whether uncommitted work may be discarded.
 * @param signal - Carrier cancellation.
 * @returns the removed worktree and whether its work was discarded.
 */
@Remote('worktreeRemove') async remoteExportWorktreeRemove(request: MeshWorktreeRemoveRequest, signal: AbortSignal): Promise<MeshWorktreeRemoveResponse>

/**
 * Mark one worktree integrated, or outstanding again.
 * @param request - Worktree and the state to move it to.
 * @param signal - Carrier cancellation.
 * @returns the worktree after the write.
 */
@Remote('worktreeIntegrated') async remoteExportWorktreeIntegrated(request: MeshWorktreeIntegratedRequest, signal: AbortSignal): Promise<MeshWorktreeRow>
```

Source: [`packages/agent-mesh/collaboration/src/controller.ts`](../../packages/agent-mesh/collaboration/src/controller.ts)

<a id="agent-mesh-events"></a>

### `agent-mesh/*` events

<a id="agent-meshbinding-change--parallel"></a>

#### `agent-mesh/binding-change` — parallel

The durable external-agent binding changed after its storage write completed.

```ts cordis-catalog
/**
 * The durable external-agent binding changed after its storage write completed.
 * @param change - Harness Session and its new external-agent binding, if any.
 * @mode parallel
 */
'agent-mesh/binding-change'(change: AgentMeshBindingChange): Promise<void>
```

Source: [`packages/agent-mesh/mesh/src/index.ts`](../../packages/agent-mesh/mesh/src/index.ts)
<!-- END GENERATED cordis-surface -->
