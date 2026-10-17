# 智能体 mesh

[English](agent-mesh.md) | 中文

多智能体能力族让用户已经在使用的编码智能体——Codex、Grok Build、Pi、OMP——对 Harness 可见，而不重新实现它们。[`packages/agent-mesh/README.zh.md`](../../packages/agent-mesh/README.zh.md) 负责包拓扑与各包契约。

## 接缝

`ctx.agentMesh` 是每个 adapter 注册的注册表，也是记录 Harness 会话所属智能体的持久化绑定，并持有由 Harness 管理的外部会话置顶/归档标记。绑定和标记使用各自独立的版本化 storage domain。该服务不拥有任何智能体格式：它既不读取智能体的文件，也不启动智能体。某个 adapter 无法描述其智能体时，只会成为该智能体的诊断，不影响其它智能体；因此一台机器上某一个集成损坏，其余仍照常报告。

绑定存放在 mesh 自己的 storage domain（`agent_mesh`）中，置顶/归档标记存放在 `agent_mesh_session_marks` 中；两者的版本都独立于 Session 格式。不认识这些 domain 的 Harness 只会读到它自己的数据，这些 domain 不存在对它没有任何影响。

## Provider 契约

adapter 实现 `AgentAdapter`：描述、读取凭证状态、列举该智能体自己的会话、可选地返回某个会话的原生 TUI argv、读取一个 transcript 窗口、读取该智能体自己的 todo 与 plan、列举模型、解析原生 MCP 配置、派发 run，以及登录与登出。原生启动方法只描述 argv；controller 不会启动该命令。`resolveMcpServer()` 只读取一条生效声明，不会启动 server，也不会把密钥返回到能力清单。它的逻辑是 `AgentHost`（文件、进程、环境、时钟）的函数，而 `createContextHost` 用 `ctx.fs` 与 `ctx.subprocess` 构造该端口。批量运行会在初始输入后关闭 stdin；原生 RPC 运行可保持 stdin 可写以发送协议命令，并在拆卸时关闭。由此可针对内存宿主测试解析、分类与传输行为；文件系统策略的拒绝（例如不允许 home 目录的沙箱 provider）会以"存储缺失"的形式到达读取方，而不是在扫描中途抛出异常。

`AgentMcpServerInfo` 是清单摘要：它报告可执行文件名或 endpoint 源站，不报告进程参数、endpoint 路径、查询值或环境值。`resolveMcpServer()` 在 server 名称不存在时返回 `undefined`，否则返回用于 stdio 或 Streamable HTTP 启用的 `AgentMcpServerConfig`。解析后的参数、环境变量和 headers 会传给 MCP 客户端，不会通过面向模型的工具返回。

读取都是对同一套词汇的投影，每个结果都携带 adapter 无法用字段表达的 `notes`。adapter 没有建模的原生记录会以 `unknown` 投影并保留其原生类型，而不是被丢弃，因此协议修订会表现为可见的缺口。

## 原生模型路由

每个 agent 包还会向 `ctx.llm` 注册一个独立 provider。它读取智能体已配置的 provider、endpoint、model 与受支持的凭据数据，并通过 Harness LLM 服务暴露这些模型。这与 `AgentAdapter.listModels` 相互独立：即使某 adapter 报告智能体目录操作不可用，仍可从配置文件提供直接路由。模型请求使用 Harness LLM adapter 与已配置 endpoint，不会通过 agent CLI 派发 run。原生凭据保留在源存储中；路由无法复现的认证或请求设置会被拒绝。

## Runs

`ctx.agentMesh` 还跟踪派发的 run：请求、来自智能体自身输出流的投影事件（有界保留）、带分类失败的终态结果，以及取消。注册表本身不启动任何东西——传输由 adapter 拥有——也从不抛错：失败的 run 是一条带终态的记录。run 没有 worktree 隔离；工作目录由调用方提供。

模型调用 `mesh_run` 前，DSH 会要求用户批准，adapter 才能启动 run。该工具可通过 `commandName` 选择一个精确的文件型命令，经 `ctx.fs` 读取其声明模板、移除 frontmatter，并将正文放在任务之前；随后等待终态结果，并返回 run 身份、最终答案或分类错误以及 notes。它的 `approval` 参数只选择外部 CLI 的原生模式，不会授予 DSH 审批。缺少所属 agent 或审批回答通道时，调用会 fail closed。

adapter 可在 run 期间通过同一个 DSH 审批服务转发受支持的原生审批请求。Codex 默认 app-server 模式会转发命令与文件变更请求，并且只授予单次 `accept`；Grok ACP 模式会转发权限请求，且只接受一次性允许或拒绝。Pi RPC 与 OMP `rpc-ui` 会转发 `confirm` 请求；只有选项中含有明确一次性允许和拒绝项的 `select` 请求才会转发。其它对话框与决策会 fail closed。

## 协作

`ctx.meshCollaboration` 拥有跨智能体的工作：一份 collaboration 记录，配一份权威 plan 与一块 todo 看板；每个工作单元是一项带负责人与依赖的任务；每个隔离任务在仓库自己的 `.dsh-agent-mesh/worktrees` 下拥有一个 git worktree。派发会创建或复用该 worktree，把指令连同 plan 与 todo 上下文交给智能体，并把 run 记录到任务上。worktree 会被采样改动文件与提交位置；冲突报告会比较同文件重叠、基提交行范围、配置的功能路径前缀及基提交，并作为提示，不会阻止派发。过期的 todo 写入（`expectedRevision` 不再匹配）会被拒绝，而不是覆盖看板。todo 观测会把智能体自己的原生任务折叠进看板，而不覆盖已编写的条目。

模型调用 `mesh_task_dispatch` 和 `mesh_worktree_remove` 前，DSH 同样会要求用户批准，之后才能启动智能体或删除 worktree。强制删除可能丢弃未提交的改动。

## 表面

模型通过 `mesh_agents`、`mesh_capabilities`、`mesh_capability_read`、`mesh_sessions`、`mesh_transcript`、`mesh_tasks`、`mesh_run`、`mesh_runs`、`mesh_run_cancel`、`mesh_mcp_connect` 和 `mesh_mcp_disconnect` 触达 mesh。会报告原生工具名的 adapter 还会为已绑定 Agent 提供最多 `maxProxyTools` 个 `mesh_agent_tool_*` 代理；每个代理只接收自由文本 `task`，会重新检查当前绑定与清单，并在 DSH 审批后通过外部 CLI 委托任务。`mesh_capabilities` 报告已声明的工具、skill、MCP server、命令、上下文文件及其路径，但不会调用它们。`mesh_capability_read` 通过 `ctx.fs` 读取当前清单中精确声明的一个 skill 指令、命令模板或上下文文件，大小上限为 1 MiB。`mesh_mcp_connect` 在首次使用经 DSH 审批后启动一个 stdio 或 Streamable HTTP server，并仅向调用方 Agent 暴露其工具；断开连接或 Agent 结束时会移除这些工具。清单只显示可执行文件名和 endpoint 源站；审批文本会隐藏参数和凭据。独立的 `ctx.llm` provider 暴露已配置模型，供 Harness 直接发起模型请求。Web Client 通过 `remote.agentMesh` 命名空间（智能体、会话、原生 TUI argv、transcript、任务、凭证、登录与登出、绑定、run）触达 mesh 数据，并由 Agent Mesh 面板渲染。`launchCommand` 返回包含 argv 和 DSH Host shell 方言的 `MeshLaunchCommand`；adapter 没有原生启动器时返回 `null`。面板按该 shell 转义命令并提供复制操作；Web Host 不会启动原生 CLI。`session.list` 也会在 Harness 会话索引中返回可见的外部智能体原生会话；Workspace 浏览会按精确的已注册路径分组、搜索其元数据，并应用 mesh 管理的置顶/归档标记。选择该行会在 Agent Mesh 面板中打开源端会话。两者读取同一个服务，因此某能力要么在两个表面都出现，要么都不出现。

人类命令包注册六条全局查询命令，并为当前 Agent 绑定提供的文件型命令注册别名。别名会排入一条包含精确原生 `commandName` 与工作目录的模型后续消息；后续 `mesh_run` 仍需 DSH 审批。

已绑定外部智能体的 DSH Session 会在每个模型步骤前刷新必需的 `agent-mesh:native-context` system-prompt 贡献。agent loop 会将其记录在持久化的 `runtime-context` user-role 快照中，并在上下文变更或移除时替换旧快照，因此 Session 回放会保留模型输入。上下文发现不完整时，贡献会包含 adapter notes。读取通过 `ctx.fs` 执行，每个文件上限为 1 MiB；`contextMaxBytes` 限制渲染后的原生贡献，默认值为 2 MiB。读取失败或贡献超出预算时，本步骤不会被接纳。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [SessionId](core.zh.md)

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

Types: [CreateWorktreeRequest](worktrees.zh.md)

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
