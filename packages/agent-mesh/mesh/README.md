---
description: "The agent-mesh service definition: the canonical multi-agent vocabulary, the adapter provider contract, the adapter registry, and the durable binding from a Harness session to the external agent it belongs to."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mesh

English | [中文](README.zh.md)

## Summary

Mount this package with the adapter packages you use to discover, browse, and dispatch external coding agents from a Harness composition. `ctx.agentMesh` reads agent sessions, tracks Harness bindings and runs, stores pin/archive choices, and resolves native MCP configuration. Adapters own each agent's formats and can return native TUI argv; DSH never starts the CLI. Bindings and marks use mesh-owned storage, and external IDs never become Harness session IDs or alter Session logs.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Mount the seam with the storage stack it depends on, then mount one adapter per agent:

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storage')
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- id: agent-mesh
  name: '@deepseek-ai/dsh-agent-mesh'
```

The registry is empty until an adapter registers, and `bind()` refuses an agent with no adapter, so a composition that mounts the seam without an adapter reports "no agents" rather than silently accepting a binding it cannot honor.

## Understand the implementation

- `types.ts` is the canonical vocabulary: agent descriptors, credentials, sessions, transcripts, native tasks, models, run events and results, and the `AgentAdapter` provider contract. Catalog reads retain per-agent failures, and projections carry `notes` for source data the shared fields cannot represent. `AgentHost.spawn()` supports closed batch input and writable duplex stdin for native RPC transports.
- `index.ts` is the service: adapter registration, diagnostics, native MCP resolution, `listSessions()`, Harness-session bindings, source-owned session marks, and tracked runs. MCP resolution reads a declaration for later approval; it does not start the server.
- `domain.ts` declares `agent_mesh` for Harness-session bindings and `agent_mesh_session_marks` for agent-native session pin/archive choices. Both domains are versioned independently of the Session format; a mark stores only the agent id, native id, disposition, and update time.
- `runs.ts` retains bounded run events and terminal results, and cancels live runs when the service unmounts.

## Further Exploration

- [The native multi-agent integration decision](../../../.agents/notes/proposed/architecture/2026-10-16-native-agent-mesh-in-dsh.md) — the constraints this seam is held to and the alternatives it rejected.
- [Group README](../README.md) — how the seam, the adapters, and the tools fit together.

## Model Experience

None, as this seam registers no prompt, tool, or session event, and every model-facing surface over it belongs to a mounted adapter.

#### KV Cache effect

No direct effect; the registry and the binding never touch a model request.

## Known Limitations and Deferred Work

- Runs are tracked and bounded by the mesh service; dispatching callers can read their snapshots and cancel live runs. Worktree isolation and cross-agent conflict reports belong to the separate collaboration package, which composes the mesh.
- The binding is per Harness session only. There is no binding for a workspace or a preset.
- `diagnostics()` reports what adapters can describe; it does not probe for a missing binary on its own.
- A sandboxed filesystem provider may refuse paths outside the Workspace; adapters then report an unreadable store.

### Dev Note

The empty-registry, adapter-failure, mark-persistence, and binding behaviors are pinned by `tests/mesh.spec.ts`; `tests/runs.spec.ts` covers retained run events and cancellation.
