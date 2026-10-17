# Agent Note: Native multi-agent integration in the fork

Status: proposed

English | [中文](2026-10-16-native-agent-mesh-in-dsh.zh.md)

## Problem

DeepSeek Harness drives one agent (its own), while the coding work a person actually does is spread across other CLI agents — Codex, Grok Build, Pi, OMP — each with its own session store, credential file, headless protocol, and todo/plan model.

The MutiAgent plugin already models all four on one canonical schema and drives them from outside the harness as a `dsh` bundle. That plugin has reached its ceiling, and the reasons are structural rather than incidental:

- It ships its own client bundle over its own authenticated HTTP+SSE channel, so its UI is a parallel application inside the Web GUI rather than part of it. The harness's own session list, model selector, capability menu, and settings do not follow the agent a session is bound to, because no harness seam knows an external agent exists.
- It re-indexes what the agents already store (its own session index, its own tracking action, its own preference file), so the same fact has two owners and can disagree.
- It exposes its operations through three surfaces of its own making (native tools, an MCP server, the HTTP gateway) because an out-of-tree bundle cannot extend the harness's surfaces directly.

The owner has decided to fork the harness and implement these capabilities natively: one source of truth per fact, the harness's own seams carrying the feature, and no compatibility layer keeping the plugin's architecture alive inside the tree.

## Proposal

Implement the multi-agent capability family as first-party packages under `packages/agent-mesh/`, wired only to documented harness extension points.

### Constraints

These are the rules the implementation is held to; they are the reason the shape below is what it is.

1. **Native seams only.** Every capability attaches to a documented extension point — a Service Definition with its providers, `ctx.tools`, client slots, session projections, `ctx.authorization` flows, `ctx.llm` adapters, `ctx.skills` providers. No parallel transport (an HTTP gateway, an MCP server, a bundled client application) and no second registry for a fact a harness service already owns.
2. **One home per fact.** An agent's sessions, transcripts, credentials, todos, and plans live where that agent's own CLI keeps them. The mesh reads those stores and never writes them. The Harness owns its session-to-agent binding and mesh-owned orchestration records; its separate session-mark domain stores only pin/archive choices for browsing external sessions.
3. **Durable state is additive and ignorable.** No `SESSION_FORMAT_VERSION` bump, no new required-on-read session event, no change to the session-query SQLite schema. Mesh-owned durable state lives in mesh-owned storage domains whose absence an upstream Harness never notices; removing the mesh does not alter native stores, Harness sessions, workspaces, or retained marks.
4. **Fail loud, degrade visibly.** A missing binary, an unreadable store, an unrecognized native record, and a capability a binary does not have are reported as diagnostics, notes, or refusals. Unknown native records are preserved as `unknown` with their native type rather than dropped, so a protocol revision shows up as a visible gap.
5. **Never claim a capability that was not observed.** An adapter declares what its binary supports, and a consumer that needs a capability the provider does not have refuses instead of guessing — the same rule the agent-preset route already follows.
6. **Ported domain logic stays faithful and attributed.** The plugin's format knowledge (session-store layouts, event taxonomies, CLI protocols) is ported path by path rather than redesigned. Where a port deviates, or where the plugin's own behavior was never verified against a real store, the adapter's notes say so.

### Capability to seam

| Capability (today in the plugin) | Native home |
|---|---|
| Canonical schema across agents | `packages/agent-mesh/mesh` types + projections; each adapter's loss notes |
| Agent detection, versions, transports | `ctx.agentMesh` registry, `AgentAdapter.detect()` |
| Agent-partitioned session browsing, native TUI resume, transcripts, native todos/plans | `ctx.agentMesh` session reads, adapter-generated native TUI argv, `session.list` agent-native rows, Workspace grouping/search and mesh-owned pin/archive marks, plus the Agent Mesh panel |
| Agent capabilities (tools, skills, MCP, commands, context files) | Native skill directories are available through `dsh-skill-filesystem`; `mesh_capabilities` inventories declarations; `mesh_capability_read` reads one declared skill instruction, command template, or context file on demand through `ctx.fs`; file-backed commands register Agent-scoped `ctx.commands` aliases that queue the exact `mesh_run.commandName` and require DSH approval; bound Sessions receive native context files as durable runtime context; `mesh_mcp_connect` activates supported stdio or Streamable HTTP servers after first-use DSH approval; adapters that report native tool names contribute up to `maxProxyTools` Agent-scoped task-delegation proxies. The proxies accept free-text tasks and dispatch through the external CLI; native JSON schemas and implementations are not imported |
| Model routing of the agents' own models | `ctx.llm` configurable providers contributed by the adapters |
| Credential status, login, logout | Agent-owned credential reads and operations exposed through the mesh controller and panel |
| Delegated runs, worktree isolation, progress, conflicts | `ctx.agentMesh` runs plus `ctx.meshCollaboration` worktrees, task dispatch, plan, todo board, and conflict reports |
| Shared plan and todo board | Mesh collaboration records + the harness's todo/plan surfaces |
| Mesh and collaboration tools | 11 `mesh_*` tools and 13 collaboration tools registered through `ctx.tools` |
| Web UI (Agents panel and external session rows) | `ui-agent-mesh` panel and native rows/actions in `ui-workspace` |

### Package topology

```
packages/agent-mesh/
  mesh/        Service Definition `ctx.agentMesh`: canonical vocabulary, adapter
               contract and host port, registry, session-to-agent binding,
               diagnostics, run registry. Depends on no adapter.
  tools/       Consumer: the model-facing operations on `ctx.tools`.
  commands/    Consumer: global inspection commands and Agent-scoped
               file-backed native command aliases on `ctx.commands`.
  controller/  Consumer: the `remote.agentMesh` surface the Web Client reads.
  agent-codex/ agent-grok/ agent-pi/ agent-omp/
               Providers, one package per agent, each mountable on its own row.
packages/client/ui-agent-mesh/
               Consumer: the Agent Mesh panel.
```

One registry and adapter SPI serve four provider packages, one per agent. The package split keeps each binary's store and protocol implementation with that agent while the shared vocabulary and mesh lifecycle remain in `mesh/`.

### Deliberately dropped from the plugin

- **The HTTP+SSE gateway and the MCP server.** In-tree, the harness's own tools and remote services are the surface. The harness has no MCP-server seam; adding one is a separate decision and is not part of this work.
- **The plugin's session index and import/untrack tracking.** Sessions are read from the stores their agents own; a second index would give the same fact two owners.
- **The plugin's client bundle.** Replaced by first-party client packages registering into harness slots.
- **The plugin's preference file.** Replaced by a storage domain owned by the mesh.

## Implementation status

Implemented in the current worktree: the mesh registry and run service; the model-facing mesh tools; approved activation of native MCP servers; the Remote controller; four agent providers; the collaboration service and tools; the Agent Mesh panel; copyable native TUI resume commands; source-owned agent session rows in `session.list` and Workspace browsing; durable native context snapshots for bound Sessions; scoped DSH command handlers for file-backed native commands; and Agent-scoped native tool task-delegation proxies. A native command handler rechecks the current inventory and queues a model follow-up with the exact agent, command name, and working directory; `mesh_run` and native tool proxies remain behind DSH approval. Proxies accept a free-text task, recheck the binding and capability inventory before dispatch, and ask the external CLI to use the named native tool. Grok ACP and Pi RPC provide duplex runs, with streaming-json and JSON headless modes available as alternatives. The base bundle mounts the mesh, tools, commands, controller, collaboration service, and all four providers. The dedicated agent rows retain each provider's native identity and do not create Harness Sessions or read agent transcript bodies during list/search.

What the recorded verification covers: package and composition tests; a Loader smoke that checks storage initialization, tool registration, and all four providers; and real-store smokes that read installed Codex, Grok, and Pi stores through their adapters. OMP is not installed on this machine, so its user store and CLI RPC roundtrip remain unverified. Fake-protocol tests cover Grok ACP authentication, streamed text and DSH one-shot approval, plus Pi RPC session binding, event projection and native abort. Later source changes add DSH confirmation forwarding for Pi and OMP; those approval paths have not been run in this worktree. The last recorded focused Agent Mesh and `ui-agent-mesh` coverage run passed 68 test files and 942 tests; all 72 included source files reached 100% statement, function, branch, and line coverage. The collaboration polling code and its tests were added after that run and have not been run since, so those coverage figures describe the earlier source set rather than this worktree. Host and Client `build:check` passed; `test:docs` passed 21/21 gates and `doc-sync` passed 43/43. The keyless `agent-mesh-approval` snapshot passed refresh and replay, recording a rejected `mesh_run` request. Real model-driven runs for all four providers, the full repository coverage gate, and the Windows matrix remain unverified.

Two mapping rows above shipped differently, and this is why:

- **Credentials.** Adapters report credential state and perform login and logout, exposed through the panel and the Remote surface. They are NOT registered as `ctx.authorization` flows: that seam's contract is that the flow is the credential's writer and commits a record through `ctx.credentials` during its run, but an agent CLI owns its own credential store and the mesh stores none (constraint 2). Satisfying the seam would mean writing a marker record into the Harness store purely to pass the check, which is a second home for a fact the agent already owns.
- **Models.** Each agent package now registers a separate `agent-codex`, `agent-grok`, `agent-pi`, or `agent-omp` provider with `ctx.llm`, using `NativeProviderLlmAdapter` from `dsh-llm-pi-ai`. Readers project supported endpoint, protocol, model, header, and credential-reference data from the agent's own user configuration. This does not make `AgentAdapter.listModels` available, dispatch runs through an agent CLI, reuse CLI OAuth that the route reader cannot refresh, or copy native credentials into the Harness credential store. Unsupported auth and request behavior is refused per route.

Native tool proxying delegates work through an external agent; it does not import or directly invoke an external tool's implementation or native JSON schema. An adapter that reports native tool names contributes up to `maxProxyTools` Agent-scoped DSH tools with a free-text `task` argument. The external CLI receives the task plus an instruction to use the named native tool; each call requires DSH approval and rechecks the live binding and inventory before dispatch. Adapters that do not report tool names expose no proxies. File-backed native commands register as Agent-scoped DSH slash handlers in the form `/agent-<agent>-<command> <task>`. Each handler rechecks the current capability inventory and queues a recorded model follow-up with the exact agent id, native `commandName`, and working directory; the model dispatches only after DSH approval. The handler does not load the external template itself. `mesh_run.commandName` reads the declared template through the DSH filesystem policy, strips frontmatter, and prepends the body to the task. `mesh_capability_read` lets the model request one exact declared skill instruction, command template, or context file through the DSH filesystem policy, with a 1 MiB limit. Bound Sessions receive native context files in a durable runtime-context snapshot before each model step; changed or removed context replaces the prior snapshot. Native skill directories are also readable through `dsh-skill-filesystem`, and `mesh_capabilities` reports the other declarations. `mesh_mcp_connect` activates supported MCP servers after first-use DSH approval and fails closed for unsupported transport or managed authentication. Codex's default app-server mode forwards command and file-change approval requests raised during a run to DSH; Grok ACP forwards permission requests and accepts one-shot allow or reject; Pi RPC and OMP `rpc-ui` forward `confirm` and explicit one-shot allow/deny `select` requests. DSH approval gates before `mesh_run`, `mesh_task_dispatch`, and `mesh_worktree_remove` remain separate and authorize the initial tool action. The OMP CLI is not installed on this machine, so its native session store and RPC UI flow remain unverified against the real binary. The Harness session index and Workspace browser use a dedicated agent-native row model; they do not expose foreign logs through `SessionPersistence`.

## Alternatives considered
**Keep the plugin at its ceiling and let harness components read it through guard reads** (a `ctx.get('mutiAgent')`-style optional dependency in tree components). This keeps one codebase and no fork maintenance, but it cannot make the harness's own surfaces follow the bound agent: every such read is a branch in shipped code for a service that is usually absent, the client bundle stays a parallel UI, and the plugin keeps owning facts the harness also owns. It is the option that produced the ceiling.

**Vendor the plugin's packages into the fork as pinned copies behind a thin seam.** Chosen earlier and now rejected: it preserves the plugin's own runtime vocabulary (its own context, config, and wire envelope) inside the tree, so the harness still cannot extend its own surfaces natively, and it adds a two-repository sync obligation for code that is now first-party. Porting the domain logic into native packages keeps the format knowledge without keeping the architecture.

**Present external agent sessions through a `SessionPersistence` provider** so they appear as ordinary Harness sessions in every consumer. This is rejected because it would answer with foreign logs under Harness Session identity, header, export, and search semantics, making an unsupported fidelity claim for partially projected records. The dedicated agent-native rows expose the same browsing actions without adapting those records into Harness Sessions.

**Per-agent provider packages from the start.** Correct if the four adapters diverge; premature while they share one SPI. Splitting later is mechanical.

**Reuse `ctx.subagents` for mesh runs.** The delegation seam already runs Codex and ACP children out of process, but it is one-shot by design: it returns the child's selected answer and keeps intermediate traffic outside the parent conversation, and it has no notion of a user-initiated run, a worktree, or a live event stream. Mesh runs stay a mesh service; the delegation seam keeps its own meaning.

## Acceptance criteria

- The mesh packages compile under the repository's strict TypeScript settings and pass their focused tests and per-file coverage gate.
- Each adapter detects its binary, lists and reads that agent's real session store, reports credential state, and dispatches a native run whose stdout event stream is projected to canonical events with unknown native types preserved. OMP uses RPC, including native `abort` for turn interruption.
- The mesh's durable binding is a mesh-owned storage domain: no session-format, session-event, or session-query schema change, and an upstream harness reading the same home sees only its own data.
- The operations are reachable as native tools; `mesh_run`, `mesh_task_dispatch`, and `mesh_worktree_remove` require the Harness approval gate before dispatch or deletion.
- Bound Sessions receive native context files through durable runtime-context snapshots, and file-backed native commands queue recorded model tasks with the exact `commandName` through DSH-scoped command handlers.
- Verification for full delivery also requires the repository coverage gate, recorded-session snapshots, a real model-driven run for every provider, Windows coverage, native interruption for every adapter that declares it, and approval-forwarding tests for every supported runtime approval path.
- Externally perceptible breaking changes to existing surfaces carry an upgrade-guide entry when the landing is complete.

## Risks

- **Porting fidelity.** The plugin's parsers encode observed store formats; a faithful port still needs fixture tests per agent, and OMP's store behavior was never verified against a real store in the plugin either. The current real CLI roundtrip covers only the initial session records. Adapters must say which claims are verified.
- **Scope.** The plugin is ~57k lines across nine packages. Porting it whole is a multi-stage effort; this note's topology is the frame, and each capability lands with its own tests.
- **Duplication with the subagent seam.** Codex is already runnable as a subagent provider. The mesh must not grow a second, divergent Codex integration; where the two overlap, the mesh's adapter is the reader of Codex's own session store and the subagent provider remains the delegation path.
- **Coverage.** Focused coverage for all Agent Mesh packages and the panel is 100%; the full repository coverage gate and Windows matrix have not been rerun after the latest changes.
