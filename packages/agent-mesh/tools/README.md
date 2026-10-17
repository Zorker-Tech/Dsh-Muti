---
description: "Model-facing tools over the external coding-agent mesh: installed agents, capability inventories, each agent's own sessions and transcript, native todos and plans, and dispatched runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mesh-tools

English | [中文](README.zh.md)

## Summary

Mount this package to let the model inspect external coding agents, read declared skill, prompt, and context files through DSH's filesystem policy, activate a declared MCP server after DSH approval, read each agent's own session and task state, and dispatch work on the agent's CLI. A DSH Session bound to an external agent also receives its declared context files as durable model input, refreshed when their contents change. A tool whose agent has no adapter fails loud, and a session the store does not hold is reported as not found.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Mount it after the mesh seam and at least one adapter. It registers global tools, so every preset sees them; a preset that registers a tool with the same name shadows it.

`contextMaxBytes` defaults to 2 MiB and bounds the rendered native context contribution. Raise this `cordis.yml` field when the adapter-declared files need more space; an oversized or unreadable snapshot fails step admission with an actionable error.

```yaml
- name: '@deepseek-ai/dsh-agent-mesh-tools'
  config:
    maxProxyTools: 24
```

| Field | Default | Meaning |
|---|---|---|
| `contextMaxBytes` | `2097152` | Maximum UTF-8 bytes in the rendered native context contribution |
| `maxProxyTools` | `24` | Maximum distinct native tool names exposed to each bound Agent; `0` disables proxies and values above `64` are rejected |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-mesh-tools) lists every accepted field.

## Understand the implementation

Each tool is a `defineTool` registration. Inventory and session tools call `readCapabilities` and `adapter(...)`; `mesh_capability_read` reads one exact path listed as a skill instruction, context file, or file-backed command through `ctx.fs`; run tools call `startRun`, `runs`, and `cancelRun`; MCP tools resolve native configuration, then mount one MCP client in a scope owned by the calling Agent. `mesh_mcp_connect` asks DSH before the first activation for that Agent and server. `mesh_mcp_disconnect` removes that Agent's client, and Agent disposal removes all remaining clients. Disposal attempts every remaining scope and reports rejected cleanup to the host logger. `mesh_run` waits for its run's terminal result. A pre-step listener reads the bound adapter's declared context files through the same filesystem policy and refreshes a required `system-prompt` context contribution; the agent loop records it in the durable `runtime-context` snapshot and replaces that snapshot when its text changes. Adapter discovery notes remain visible in the contribution. Agent creation and mesh binding-change listeners read the current native tool inventory and register up to `maxProxyTools` task-delegation tools in that Agent's scope before the next model request. Each proxy checks the binding and declaration again, then delegates through `startRun` after DSH approval. `contextMaxBytes` bounds the rendered native contribution. Output schemas carry the fields the renderer prints, and every `notes` array an adapter produced is passed through so the model sees what a projection could not carry.

## Further Exploration

- [Seam README](../mesh/README.md) — the vocabulary these tools project.
- [Group README](../README.md).

## Model Experience

### The read tools

#### What the model sees

Eleven tools, each with its own schema: `mesh_agents`, `mesh_capabilities`, `mesh_capability_read`, `mesh_sessions`, `mesh_transcript`, `mesh_tasks`, `mesh_run`, `mesh_runs`, `mesh_run_cancel`, `mesh_mcp_connect`, and `mesh_mcp_disconnect`. `mesh_capabilities` reports declared tools, skills, MCP servers, commands, context files, and their source paths without invoking them. `mesh_capability_read` returns one listed skill instruction, context file, or file-backed command template as a logged tool result, up to 1 MiB; undeclared paths fail with guidance to refresh the inventory, and filesystem errors retain their DSH codes. Before each model step, a bound DSH Session refreshes a required `agent-mesh:native-context` contribution inside its durable `runtime-context` snapshot; changed files and removed instructions replace the earlier snapshot in the Session surface. The native contribution is bounded by `contextMaxBytes`, whose default is 2 MiB. Use `mesh_mcp_connect` to request DSH approval and activate one declared stdio or Streamable HTTP server for the calling Agent. Session read tools return projected records from one agent's own store, and every `notes` array an adapter produced is passed through verbatim so the model reads what the projection could not carry.

#### Token effect

Fixed schema cost on every request where the tools are visible. Session and message results are bounded by the caller's `limit` and `maxMessages`; a capability-file result is bounded by the 1 MiB file limit. A bound Session adds its current native context contribution to model input, up to `contextMaxBytes`.

#### KV Cache effect

Prefix-stable while the tool set and visibility are unchanged. Result text is appended after the request prefix. Native context is appended on first use or when its files or discovery notes change, so unchanged files do not add a message on every step.

### The run tools

#### What the model sees

`mesh_run` waits for the external run to finish and returns its run id, terminal status, final answer or classified error, and adapter notes. It can take an exact `commandName` from the current capability inventory; for a file-backed command it reads the template through `ctx.fs`, strips frontmatter, and prepends the body to the task. `mesh_runs` reports status, the selected answer, a classified error, and retained recent events; `mesh_run_cancel` reports whether a live run was cancelled. When an adapter reports native tool names, the bound Agent also sees up to `maxProxyTools` `mesh_agent_tool_*` schemas; each accepts only a free-text `task` and asks the external CLI to use the named tool, so this delegates through the agent rather than calling a native implementation directly. Proxy calls require DSH approval and recheck the binding and current inventory before dispatch. `mesh_run` and native tool proxies provide an approval callback for supported requests raised while they run: Codex's default app-server mode forwards command and file-change requests and grants only one-shot `accept`; Grok ACP forwards permission requests with one-shot allow or reject; Pi RPC and OMP `rpc-ui` forward `confirm` requests and `select` requests only when their choices include explicit one-shot allow and deny options. The `approval` option on `mesh_run` selects the external CLI's own mode; it does not grant DSH approval. An unsupported adapter mode and an unknown run fail with a message naming the agent or run.

#### Token effect

`mesh_run` is fixed-shape and small, but the tool call remains open until the external run reaches a terminal status. `mesh_runs` grows with the retained event window (bounded per run, default 200 events) and with the runs it lists, so a caller reads one run at a time when that matters.

#### KV Cache effect

Append-only; nothing here rewrites earlier messages, so newly visible results follow the reusable request prefix.

## Known Limitations and Deferred Work

- `mesh_transcript` and `mesh_tasks` locate a session by listing the agent's store, so a store that cannot be listed cannot be read by id.
- Dispatched runs are not worktree-isolated; the caller supplies the working directory.
- A run's events are visible only through the retained window `mesh_runs` reports; there is no streaming tool result.
- Native CLI tools are not imported with their native implementations or JSON argument schemas. If an adapter reports tool names, a bound Agent receives up to `maxProxyTools` `mesh_agent_tool_*` proxies that accept free-text tasks and delegate them through the external CLI after DSH approval; execution rechecks the binding and current inventory. Adapters that report no native tool names, including the current Codex inventory, contribute no proxies. Declared skill instructions and file-backed commands can be read on demand with `mesh_capability_read`; context files are injected automatically for bound DSH Sessions, and file-backed command bodies can also be prepended to a `mesh_run` task with `commandName`. Adapter notes identify context files or directories it could not discover. An unreadable declared file or a snapshot over `contextMaxBytes` stops step admission with an actionable error. `mesh_mcp_connect` can activate stdio and Streamable HTTP servers after DSH approval; SSE and managed OAuth configurations fail closed. Inventory reports only an executable name and endpoint origin, and approval text hides arguments and credentials.
- Runtime approval forwarding requires a duplex transport and a caller-provided approval callback. Headless runs and callers without that callback decline native approval requests.

### Dev Note

Registration, and the mesh registry the tools read through, are pinned by `tests/tools.spec.ts`.
