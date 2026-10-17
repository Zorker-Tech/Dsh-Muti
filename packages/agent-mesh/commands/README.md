---
description: "List external agents, native sessions, integration diagnostics, and recent runs through DSH's human command menu."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mesh-commands

English | [中文](README.zh.md)

## Summary

Six global commands let users inspect external agent registrations, native sessions, diagnostics, runs, and DSH-owned mesh state. A bound agent also contributes file-backed command aliases such as `/agent-codex-review <task>`. The alias queues a model task with the exact native command and working directory; `mesh_run` still requires DSH approval. `/agent-refresh` reads native stores again without building a duplicate session index.

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

Use the commands when a user needs a quick text view of the native Agent Mesh state from a command-capable UI.

### Command reference

| Input | Result |
|---|---|
| `/agents` | Lists registered agents, installation status, and coarse credential status without credential values |
| `/agent-sessions [cwd]` | Reads native session stores, optionally filters by working directory, and shows up to 20 returned sessions |
| `/agent-refresh` | Reads up to 100 sessions per agent from native stores; it does not create or refresh a second index |
| `/agents-diagnostics` | Shows agent detection, version, binary and store paths, and warnings |
| `/mesh-runs` | Shows the 20 latest tracked runs without rendering prompts or answers |
| `/mesh-state` | Counts registered agents, durable bindings, session marks, and tracked runs |

`/agent-sessions` passes its trimmed input as one working-directory path; quote characters are not parsed. A store failure appears beside readable sessions so one unavailable agent does not hide the others.

File-backed aliases follow `/agent-<agent>-<command> <task>`. They refresh when the binding or working directory changes and disappear when the Session is unbound or disposed. The alias queues a normal model follow-up; it does not start the external CLI directly.

### Mount the commands

The package accepts no configuration. Mount it after the command registry and Agent Mesh service in a custom composition; the DSH base bundle mounts it with those dependencies.

```yaml
- id: agent-mesh-commands
  name: '@deepseek-ai/dsh-agent-mesh-commands'
```

The mesh service needs its storage-domain provider. Agent adapters register separately, so the commands remain available when no external agent is installed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The command provider registers six global names and per-Agent aliases with the DSH command registry. It reads session stores on demand and derives aliases from file-backed commands in the bound agent's current capability inventory. Binding and working-directory changes replace the aliases; each alias rechecks the inventory before queuing a model follow-up. The DSH command service records invocation and completion events in the receiving session.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Registers commands, bounds session and run output, and renders mesh state |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Mesh package map](../README.md) — the native agents, panel, tools, and collaboration packages.
- [Agent Mesh service](../mesh/README.md) — session ownership, bindings, marks, diagnostics, and runs.
- [Commands service](../../interaction/commands/README.md) — command registration, dispatch, and result handling.
- [Agent Mesh panel](../../client/ui-agent-mesh/README.md) — interactive agent, credential, session, and run controls.

-----

<a id="model-experience"></a>
## Model Experience

### Human command output

#### What the model sees

The six global inspection commands return direct output and do not enter model requests. A file-backed alias queues a user-role follow-up that names the exact agent, `mesh_run.commandName`, working directory, and task. That follow-up is recorded in the Session and the model must pass the ordinary DSH approval before a provider starts a run.

#### Token effect

Discovering or running a global inspection command adds no model tokens. A file-backed alias adds its queued task to the next model request; the direct command result is not included.

#### KV Cache effect

Global command discovery and direct output do not alter the model request prefix or its cache. A file-backed alias changes the next request by adding its task.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when a user should use the panel or model-facing tools instead of the command menu.

- **Bounded text output** — session and run commands show at most 20 rows; `/agent-refresh` reads up to 100 sessions per agent and does not expose pagination.
- **Interactive command adapter required** — the package registers commands, but a headless composition without a command-capable client cannot receive or display them.
- **Native stores remain authoritative** — session counts and rows can differ between reads as agents update their own stores.
- **Native command names must fit the DSH command grammar** — aliases with unsupported names or names already registered in the Agent scope are skipped and logged.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
