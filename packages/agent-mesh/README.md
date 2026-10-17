---
description: "The agent-mesh package group: the external coding-agent registry, its session-to-agent binding, the per-agent adapters that read those agents' own stores, and the model-facing tools over them."
kind: "package-group"
---

# agent-mesh/ — external coding-agent integration family

English | [中文](README.zh.md)

## Summary

The agent-mesh family connects the Harness to Codex, Grok Build, Pi, and OMP while each keeps its own store and CLI. Users can inspect sessions, transcripts, plans, credentials, and runs; bind Harness sessions to agents; use configured models; and activate native MCP servers after DSH approval. Bound sessions receive adapter-declared context files as durable model input. Adapters read native data and report fields they cannot project; model-facing tools expose those capabilities, while the mesh owns bindings and run tracking. The Web panel, human commands, and worktree collaboration packages support these workflows.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`mesh/`](mesh/README.md) | Defines the multi-agent seam: the canonical vocabulary, the adapter provider contract and host port, the adapter registry, the durable session-to-agent binding, diagnostics, and the run registry | `ctx.agentMesh` |
| [`tools/`](tools/README.md) | Exposes installed agents, declared capability inventories, automatic context snapshots for bound Sessions, on-demand reads of declared skill/prompt/context files, file-backed command dispatch, approved per-Agent MCP activation, native sessions and tasks, and terminal run results to the model | registers on `ctx.tools` |
| [`commands/`](commands/README.md) | Registers six global inspection commands and scoped aliases for file-backed commands declared by each bound agent | `ctx.commands` |
| [`controller/`](controller/README.md) | The Remote surface the Web Client reads: agents, sessions and native TUI argv, transcript, tasks, credentials and sign-in, bindings, and runs | `remote.agentMesh` |
| [`agent-codex/`](agent-codex/README.md) | Codex: detection, rollout store, transcripts, native plans, credentials, Responses routes, and resumable `codex app-server --stdio` runs (`headless-exec` is also available) | registers on `ctx.agentMesh` and `ctx.llm` |
| [`agent-grok/`](agent-grok/README.md) | Grok Build: detection, session store, ACP updates, plans, credentials, configured model routes, ACP duplex runs, and streaming-json runs | registers on `ctx.agentMesh` and `ctx.llm` |
| [`agent-pi/`](agent-pi/README.md) | Pi: detection, JSONL session tree, transcripts, credentials, configured model routes, RPC duplex runs, and `--mode json` runs | registers on `ctx.agentMesh` and `ctx.llm` |
| [`agent-omp/`](agent-omp/README.md) | OMP: detection, session store, transcripts, native todos and plans, configured model routes, and `--mode rpc-ui` runs | registers on `ctx.agentMesh` and `ctx.llm` |
| [`collaboration/`](collaboration/README.md) | Worktree-isolated multi-agent work: one collaboration, one authoritative plan, one todo board, per-agent worktrees with progress samples and same-file conflict reports, and task dispatch | `ctx.meshCollaboration` |

## Related documentation

- [Agent mesh subsystem](../../docs/subsystems/agent-mesh.md) — the seam, the provider contract, runs, collaboration, and the surfaces.
- [The native multi-agent integration decision](../../.agents/notes/proposed/architecture/2026-10-16-native-agent-mesh-in-dsh.md) — why the family exists, what it deliberately drops, and the constraints it is held to.

<a id="dev-note"></a>
## Dev Note

The per-agent adapters are separate packages so a composition can select one agent at a time, and so each one's notes about what it could not verify stay with the code that makes the claim. The Web panel lives in `packages/client/ui-agent-mesh`, where client packages belong, and it reads the family through the Remote surface rather than through any package here.
