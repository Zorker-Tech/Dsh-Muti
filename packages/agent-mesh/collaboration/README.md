---
description: "Worktree-isolated multi-agent collaboration: one authoritative plan, one guarded todo board, per-agent git worktrees with progress samples and same-file, same-hunk, feature-area, and base-commit conflict reports."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mesh-collaboration

English | [中文](README.zh.md)

## Summary

Use this package when several agents need to work on one repository in isolated git worktrees. Create collaborations with one shared plan and revision-guarded todo board, dispatch dependent tasks with that context, and review live progress and predicted conflicts across files and base commits. Configure `featureBoundaries` to report related changes under path prefixes; `conflictPolicy: 'block'` marks same-hunk findings as blocking but does not stop dispatch. Conflict findings remain advisory.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount it after the mesh seam and at least one adapter; the base bundle carries all three. A collaboration is created through `mesh_collaboration_start` or the `remote.meshCollaboration` namespace, and every later operation addresses it by id. Worktree creation needs a real git repository and a `git` binary on the host: when git is unavailable the operation fails with `worktree/git-unavailable` instead of silently running in the shared directory. `conflictPolicy: 'block'` marks same-hunk findings as blocking for review; it does not stop a separate dispatch. `featureBoundaries` accepts repository-relative path prefixes and defaults to an empty list.

## Understand the implementation

| File | Role |
|---|---|
| `src/index.ts` | The `ctx.meshCollaboration` service: collaborations, plans, boards, tasks, worktrees, and dispatch |
| `src/domain.ts` | The durable domain (`agent_mesh_collab`) holding every record |
| `src/boards.ts` | Plan and todo-board rules, including the revision guard and native-task observation |
| `src/worktrees.ts` | Worktree lifecycle, progress sampling, and predicted conflict reports |
| `src/git.ts` | Git commands through the host port, with classified failures |
| `src/tools.ts` | The thirteen model-facing tools |
| `src/controller.ts` | The `remote.meshCollaboration` surface |

Every record is mesh-owned and additive: no session-format, session-event, or session-query schema changes, so removing the package leaves a Harness that reads only its own data.

## Further Exploration

- [Seam README](../mesh/README.md) — the registry, the run registry, and the host port this package builds on.
- [Agent mesh subsystem](../../../docs/subsystems/agent-mesh.md) — where collaboration sits in the family.

## Model Experience

### Starting and reading collaborations

#### What the model sees

`mesh_collaboration_start` takes a title, an objective, a repository root, and optional seed tasks (each naming an assignee, an instruction, optional `dependsOn` siblings, and an isolation mode), and returns the created collaboration. `mesh_collaborations` lists every collaboration with its plan, board counts, tasks, and worktrees, or reads one by id; phase rows include exit criteria. The schemas are what `packages/agent-mesh/collaboration/src/tools.ts` registers; the returned records are the service's own record types.

#### Token effect

Fixed schema cost on every request where the tools are visible. A listing grows with the number of collaborations, tasks, and worktrees it reports; reading one collaboration by id keeps that bounded.

#### KV Cache effect

Prefix-stable while the tool set and visibility are unchanged; results are appended after the reusable prefix.

### The plan and the todo board

#### What the model sees

`mesh_plan_set` replaces the objective, the complete phase list, the active phase, the decisions log, and the mode (`inject` puts the plan into dispatched prompts, `observe` does not); `mesh_plan_advance` activates a phase and marks earlier ones done, refusing while an earlier phase is still open. `mesh_todos_set` replaces the board and may carry `expectedRevision`; a stale revision is refused with the current revision rather than clobbering another writer's work, and a dependency cycle or an unknown phase id is refused with a labeled error. `mesh_todos_get` reads the board, and `mesh_todos_observe` folds one agent's own native tasks (read through the mesh) into it without overwriting authored items.

#### Token effect

`mesh_todos_set` grows with the whole board the model submits, and that list stays in the call history until compaction. Reads return the board as it stands.

#### KV Cache effect

Append-only; a board write is a tool call like any other and does not rewrite earlier messages.

### Worktrees, conflicts, and dispatch

#### What the model sees

`mesh_worktrees` lists worktrees with their base commit and ref, changed files, commit position, and clean state; a filter outside a Git repository returns an empty list. `mesh_worktree_create` creates one from a base ref, and `mesh_worktree_conflicts` reports same-file overlaps, overlapping base line ranges, changes in the same configured feature area, and different base commits across the live worktrees of one repository. Same-hunk severity is `warning` by default and `blocking` under `conflictPolicy: 'block'`; the report remains advisory and does not prevent separate dispatches. `mesh_worktree_remove` refuses a dirty worktree unless `force` is set. `mesh_task_dispatch` runs a task: it creates or reuses the task's worktree, sends the instruction plus the plan and board context, and records the run id and status on the task; a task whose dependency is unfinished, or that is already running or succeeded, is refused with the reason. `mesh_task_dispatch` and `mesh_worktree_remove` require DSH user approval before they start an agent or remove a worktree; forced removal can discard uncommitted work.

#### Token effect

A conflict report grows with the number of changed files under comparison. Dispatch returns a task record, not the agent's transcript, so a long-running agent does not grow this result.

#### KV Cache effect

No direct effect beyond the ordinary tool-call append.

## Known Limitations and Deferred Work

- Conflict reports are heuristics: untracked, binary, or unreadable diffs do not provide line ranges, and changes in different files can still conflict semantically outside configured feature prefixes.
- Worktrees live under `<repoRoot>/.dsh-agent-mesh/worktrees` and are not garbage-collected; a removed collaboration leaves its worktree directory until `mesh_worktree_remove` runs.
- Dispatch records the run and its id but does not follow it: reading the agent's answer means `mesh_runs` with the recorded run id.
- Runtime approval forwarding is available through the transports that expose supported requests: Codex app-server forwards command and file-change requests, Grok ACP forwards permission requests, and Pi RPC plus OMP rpc-ui forward confirmations and selections with explicit one-shot allow and deny choices. Unsupported requests fail closed; OMP's real CLI round trip remains unverified because the binary is not installed on this machine.
- The plan is injected as context text built from the plan and board records; there is no per-agent context filter beyond `mesh_plan_set`'s `mode`.
- Coverage: the package's tests exercise the service, boards, worktree rules, and error paths with fakes. A real `git worktree` round trip is exercised only where a git binary and repository exist, not in the unit suite.

### Dev Note

The durable domain is `agent_mesh_collab` (version 1). The service is mounted with its Remote controller by one row, so a composition that mounts the package gets both the in-process API and the client namespace.
