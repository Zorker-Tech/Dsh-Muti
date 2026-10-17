---
description: "The Agent mesh pages show external agents, native-session task dispatch through DSH approval, and shared collaboration plans, todos, worktrees, and advisory conflict reports. Open this reference to understand the browser controls and their Remote-backed state."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-mesh

English | [中文](README.zh.md)

## Summary

The Agents page lists external agents, their native sessions and transcripts, local tasks, credentials, dispatched runs, Session bindings, and copyable native resume commands. A task form can queue work for a selected native session in the open Harness Session; the model dispatches it with `mesh_run` through normal DSH approval. Its Collaboration tab shows shared plans, tasks, todo boards, worktree progress, and advisory conflict reports; users can mark a worktree as merged. The `/` menu offers skills and file-backed commands from the agent bound to the current Session. Agent runs still require DSH approval.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load the plugin through the web-app manifest. The Agents entry opens a global page: it belongs to the profile, not to a Session, so it stays available while any conversation is open. Refresh re-reads everything the page is showing, and a connection reset does the same.

When a Harness Session is bound to an agent, the `/` menu lists that agent's native skills and file-backed commands for the Session's working directory. Selecting a skill inserts a delegation prompt. Selecting a command inserts an editable prompt naming its exact agent id and `mesh_run.commandName`; the user submits it through the normal composer, and the model's run still goes through DSH approval.

The first column lists every registered agent with its installed flag, the version its binary reported, the resolved executable, the reason detection failed when it did, and the warnings the adapter stated. Selecting an agent lists that agent's own sessions, newest first, each with its recorded title, working directory, model, last update, reported status, message count, and the adapter's notes. These rows keep the agent and native session ids from the source store; they do not create Harness Sessions. The Workspace browser also lists them beside Harness rows, where selecting one opens the corresponding session here.

Selecting a session reads its transcript and its native tasks together. The transcript renders every message in the order the agent recorded it: the role, the tool name for a call or a result, the failure and truncation marks, the recorded timestamp, and the message text or the tool's input and output. A record the adapter could only project onto a generic kind shows its native record type instead of an invented category. The task area shows the agent's own todos with their statuses and blocking keys, then its plan with the steps in the agent's order; an agent that records no native task model says so rather than showing an empty list.

The session detail can ask the adapter for native TUI argv and renders a shell-quoted command with a copy control. It does not launch the executable; the command runs only when the person pastes it into a terminal on the DSH Host. An adapter without this capability reports that it is unavailable.

The session detail also accepts a task for the selected native session. Submitting it queues a logged user message in the open Harness Session with the exact agent id, working directory, native session id, and task. The model calls `mesh_run` under the usual DSH approval flow; the page does not start the external agent directly. This requires an open Harness Session and a recorded working directory for the native session.

The Session binding area names the agent bound to the open Session. Choosing an agent binds that Session to it and Unbind removes the binding; both read the bindings back and report a failure in place, and a Session with no binding and a page without an open Session each state their own condition.

The Accounts area lists every agent's credential status, the surface the state was observed on, the credential kind, and any detail or expiry the adapter reported. Its Log in menu lists only that adapter's declared flows. Log out appears only when the adapter can remove the observed credential source; environment credentials cannot be removed by CLI logout. An API-key flow opens a password field; submitting it sends the key with that one login request, and the field clears before the request finishes. Codex receives the key on stdin, and the Client does not store or log it. A login the adapter cannot perform itself returns instructions for the user, which the page shows.

The Runs area lists the runs the mesh tracked with the run id, the agent, the run's own status, the reported answer or the classified failure with its code and remediation, and the adapter's notes. An idle list refreshes every 5 seconds; while any run is active, the page refreshes records every 1.5 seconds. A running run offers Cancel. Each row can show up to 20 recent events; previews omit reasoning text and tool input and output. A cancellation failure is reported beside the list without hiding the last known run rows.

Select Collaboration to review shared plans, dispatched tasks, shared todos, worktree progress, and advisory conflicts for each collaboration. The page reads these records through the native `meshCollaboration` Remote namespace and refreshes every 3 seconds while any task is running, or every 15 seconds otherwise. It can mark a worktree as merged; that action records status and does not merge a Git branch. Conflict findings do not block dispatch.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser entry registers the `agents` main panel, the matching `sidebar.panellist` row, and a `/` source in `ctx.inputTriggers`. The source resolves the current Session's binding and working directory before reading the agent's native skill and command inventory, then offers only file-backed commands because `mesh_run.commandName` cannot dispatch code-defined commands without prompt files. Picking one inserts ordinary draft text; the client neither reads the external prompt file nor starts a run. The page declares no child slots, publishes no conversation node, and owns no tool view: the same Host mesh service behind the model's `mesh_*` tools answers its Remote reads, so a capability appears on both surfaces or on neither.

One `mesh` source created in the apply closure holds every fact the page renders — the agent roster, one agent's sessions, one session's transcript and native tasks, credential rows, bindings, and runs — together with the selection, and exposes the read and mutation actions the component issues. The renderer binds that snapshot to the page's `useMesh` selector hook, so the component subscribes to nothing itself. The source installs its connection-reset listener only while it has a subscriber, reads the lists when the first one arrives, and clears its state and in-flight answers when the last leaves, so a remount reads the facts again rather than showing a previous generation's.

Each read carries an epoch keyed by what it addresses (the roster, one agent's sessions, one session's transcript or tasks, credentials, bindings, runs). Only the newest request for one key may publish, so a slow answer for a session the user has already left cannot replace the current one. A failed call keeps the rows already shown and reports the Remote failure's message, which is the only text the page repeats verbatim from the wire.

Selection lives in the source, not in component state, so the connection-reset readback re-reads exactly what is on screen: the selected agent's session list and every requested session's transcript and tasks.

The collaboration page reads its own Remote-backed source, keyed by collaboration and repository. It keeps the plan and task list with each collaboration, reads the selected todo board and repository worktrees, and computes conflict reports only when requested or after a prior report exists. Periodic reads share the connection-reset subscription lifecycle: the source starts them while the page has a subscriber, clears the timer when the last subscriber leaves, prevents in-flight results from publishing, and stops the refresh chain after its current Remote calls complete. Per-key epochs prevent stale responses from replacing newer records. Marking a worktree as merged updates its state through the collaboration Remote.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the mesh source, the `/` skill source, the sidebar row, and the panel |
| [`src/client/mesh-store.ts`](src/client/mesh-store.ts) | The shared Remote-backed snapshot and its actions |
| [`src/client/MeshPanel.tsx`](src/client/MeshPanel.tsx) | The page: agents, sessions, transcript, tasks, dispatch, binding, runs, accounts |
| [`src/client/mesh-format.ts`](src/client/mesh-format.ts) | Status-to-dictionary mapping and agent naming |
| [`src/client/collaboration-store.ts`](src/client/collaboration-store.ts) | The collaboration snapshots and refresh actions |
| [`src/client/CollaborationPanel.tsx`](src/client/CollaborationPanel.tsx) | Shared plans, tasks, todo boards, worktrees, and conflicts |
| [`src/client/CollaborationPanel.module.css`](src/client/CollaborationPanel.module.css) | Responsive collaboration-page layout |
| [`src/client/locales.ts`](src/client/locales.ts) | The `agentMesh` namespace copy (zh source of truth) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-agent-mesh-controller`](../../agent-mesh/controller/README.md) — the `agentMesh` Remote namespace, its wire vocabulary, and the adapter resolution behind each method.
- [`dsh-agent-mesh`](../../agent-mesh/mesh/README.md) — the adapter contract, the durable Session-to-agent binding, and the run registry the page reads.
- [`dsh-agent-mesh-collaboration`](../../agent-mesh/collaboration/README.md) — shared plans, todo boards, task dispatch, and worktree state.
- [Agent mesh subsystem](../../../docs/subsystems/agent-mesh.md) — the tools and the Remote surface over one service.
- [Slots](../../../docs/subsystems/slots.md) — the `main` keyed panel and the `sidebar.panellist` row this package registers into.

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser panel renders the mesh service already exposed through model tools and registers no prompt, tool schema, or Session event.

#### KV Cache effect

The panel adds no model context; submitted tasks enter through Session messages and do not alter the reusable system prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define current package constraints, not a task backlog.

- **Dispatch uses the open Harness Session** — the task form requires that Session and a native working directory, then queues a logged message for the model to call `mesh_run` under DSH approval. The page does not start an external agent directly, create collaborations, edit plans or todo boards, or merge Git branches. The Agents tab can cancel a tracked run, and the Collaboration tab can record a worktree as merged.
- **Run updates use polling** — the panel refreshes the idle run list every 5 seconds and active runs every 1.5 seconds while the panel source has a subscriber. It shows at most 20 events from the registry's retained detail, and pauses polling when the panel is unmounted.
- **Binding rides the open Session** — the binding area reads the Session retained by the main view. While no session is open, or while another main panel is shown without one, it reports that state rather than offering a binding.
- **Credential flows follow adapter declarations** — the page lists only the login flows an adapter declares and offers logout only when the adapter can remove the observed credential source. Environment credentials cannot be removed by CLI logout. API-key flows use a password field for one request; interactive flows that need a human return instructions instead.
- **Adapters decide what a transcript carries** — a record an adapter drops or projects onto a generic kind arrives here as that projection or not at all; the page repeats the adapter's notes rather than reading an agent's store itself. Workspace browsing uses the same source-owned session identity to open the selected record here.
- **The menu does not load native instructions** — selecting a skill names its agent and skill, while selecting a file-backed command names its exact `mesh_run.commandName`; neither selection reads the external instruction file or starts a run. The model can read declared files through `mesh_capability_read`, and a dispatched command reads its template through `ctx.fs` after the normal DSH approval.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
