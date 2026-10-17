---
description: "The Pi coding-agent adapter for the agent mesh: `pi` detection, read-only sessions and credentials, configured LLM routes, and native RPC runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-pi

English | [中文](README.zh.md)

## Summary

Mount this package to expose the Pi coding agent already installed on this machine. It lists Pi's own JSONL session trees under `~/.pi/agent`, reads the live branch of a session as a bounded transcript, reads Pi's configured model and provider routes for `ctx.llm`, inspects provider credential state, and dispatches `pi --mode rpc` by default. Nothing is written into Pi's store, and only detection and run dispatch start a process. Pi has no non-interactive login or logout, so those operations return guidance, and it records no native todo list or plan.

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

Mount the adapter after the mesh and LLM services; it injects `agentMesh`, `llm`, `fs`, and `subprocess`.

```yaml
- id: agent-mesh
  name: '@deepseek-ai/dsh-agent-mesh'
- id: agent-pi
  name: '@deepseek-ai/dsh-agent-pi'
  config:
    homeDir: ~/.pi/agent
    sessionDir: ~/.pi/sessions
```

### When to choose it

Choose this adapter on a machine that runs Pi and whose sessions should stay in Pi's own store. It is the only package that can list, read, or dispatch Pi sessions, and it stays inert until a caller reads or dispatches; a machine without the binary still mounts it and reports `installed: false` with a reason. It also registers Pi's configured routes with `ctx.llm`, using the endpoint, protocol, and credential information declared in Pi's files. It reports no native task state because Pi records no todo list or plan, so a caller that needs those must choose an agent that records them. A composition that needs a different external agent mounts that agent's adapter too, and one profile may mount several.

### Minimal configuration

The row above works with no `config` at all: detection searches `PATH` and the well-known install directories, the agent directory falls back to `$PI_CODING_AGENT_DIR` and then `~/.pi/agent`, and the session directory falls back to `$PI_CODING_AGENT_SESSION_DIR` and then Pi's own `settings.json`. Every accepted field is listed here.

| Field | Default | Meaning |
|---|---|---|
| `binaryPath` | unset | Explicit `pi` executable, tried before `PATH` and the well-known install directories. |
| `homeDir` | unset | Explicit Pi agent directory, tried before `$PI_CODING_AGENT_DIR` and `~/.pi/agent`. |
| `sessionDir` | unset | Flat session directory, tried before `$PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` of Pi's `settings.json`. |
| `env` | `{}` | Extra environment entries for every child process this adapter starts. |
| `runMode` | `duplex-protocol` | `duplex-protocol` uses `pi --mode rpc`; `headless-exec` uses `pi --mode json`. |
| `interruptGraceMs` | `10000` | Time to wait after an RPC abort before terminating Pi's process. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The adapter is a pure function of the mesh's `AgentHost`: `detect.ts` resolves the binary and probes `--version`, `sessions.ts` resolves the store layout, parses the session header and append-only entries, walks the `parentId` tree to the live branch, and scans both the flat override directory and the default per-project root, `transcript.ts` projects branch entries into mesh messages, `auth.ts` classifies `auth.json` and reports the credential operations it will not fake, `index.ts` reads the agent catalog, and `llm-models.ts` projects configured models from `models.json`, `settings.json`, and `auth.json` without writing Pi data. `run.ts` owns shared event projection and `pi --mode json`; `rpc-run.ts` owns RPC session binding, prompts, abort, and process teardown. The plugin's `apply` builds the host from the Cordis context and registers the mesh adapter and LLM provider as effects; `describe()` caches its descriptor because the mesh catalog is queried on every GUI load.

| File | What it owns |
|---|---|
| `src/index.ts` | The `pi` adapter, the `PI_CAPABILITIES`/`PI_TRANSPORTS` declarations, and the two provider registrations. |
| `src/detect.ts` | Binary resolution and `--version` probing. |
| `src/sessions.ts` | Store-layout resolution, the header/entry record model, the live-branch walk, bounded discovery, and the lossy cwd directory encoding. |
| `src/transcript.ts` | Live-branch projection into mesh messages with the 16 KiB field cap. |
| `src/auth.ts` | `auth.json` classification, the provider environment-variable list, and the login/logout guidance. |
| `src/llm-models.ts` | Read-only projection of Pi's provider routes, model overrides, and API-key sources into `ctx.llm`. |
| `src/run.ts` | Shared event projection, `pi --mode json` argv, the spawnless resume refusal, cancellation, and exit classification. |
| `src/rpc-run.ts` | `pi --mode rpc` session binding, DSH approval for supported confirmations, prompt and abort commands, and process teardown. |
| `src/config.ts` | The `PiAdapterConfig`/`ResolvedPiConfig` split and every default. |

-----

<a id="further-exploration"></a>
## Further Exploration

- [The mesh seam](../mesh/README.md) — the registry and the run vocabulary this adapter projects onto.
- [Mesh tools](../tools/README.md) — the model-facing tools that read through this adapter.
- [Group README](../README.md) — how the seam, the adapters, the tools, and the controller fit together.
- [Agent mesh subsystem](../../../docs/subsystems/agent-mesh.md) — the canonical types and the adapter contract.
- [The native multi-agent integration decision](../../../.agents/notes/proposed/architecture/2026-10-16-native-agent-mesh-in-dsh.md) — what the family deliberately drops.

-----

<a id="model-experience"></a>
## Model Experience

### Adapter records

#### What the model sees

This package adds no prompt text or tool. The mesh tools still reach its `AgentAdapter` through [`@deepseek-ai/dsh-agent-mesh-tools`](../tools/README.md). It also registers `agent-pi` with `ctx.llm`, so Pi models declared in its configuration can be selected for Harness requests. The session rows, transcript messages, and run results rendered by the mesh tools still come from the `AgentAdapter`, including each `notes` string that declares a projection gap.

#### Token effect

None by itself. A `mesh_*` tool call's token cost belongs to the tools package's result content; this adapter adds no text of its own to a request. A dispatched run's result also reaches the model only through `mesh_run`/`mesh_runs`.

#### KV Cache effect

None. This package contributes no model request content; the mesh tools package owns what enters a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The default `duplex-protocol` run uses `pi --mode rpc`; `runMode: headless-exec` selects `pi --mode json`. RPC binds the current session with `get_state`, sends one prompt, projects Pi's events, and sends native `abort` for a live turn before terminating the process after `interruptGraceMs` if needed.
- If the host rejects its child-exit report, the adapter cancels Pi, logs that exit could not be confirmed, and returns `run/protocol-error`; confirm the process stopped before retrying.
- Pi RPC routes `confirm` requests and `select` requests with explicit one-shot allow and deny choices through DSH approval. Other dialogs and selections are declined with a warning. The run request's `approval: approve` option passes Pi's `--approve` flag.
- A failed native UI approval response write ends the run as `run/protocol-error`; if caller cancellation succeeds after a failed UI-cancellation response write, the run remains cancelled and records the write failure in its notes.
- Pi has no non-interactive login or logout: both operations return `ok: false` with guidance and never spawn anything, and `capabilities().credentials` declares `login: ['interactive']` and `logout: false`.
- `resolveMcpServer` reads the user `mcp.json` and project `.pi/mcp.json` layers for `mesh_mcp_connect`. DSH starts a supported stdio or Streamable HTTP server only after first-use approval; SSE and managed OAuth entries fail closed.
- Pi records no native todo list and no plan mode: `readNativeTasks` returns `available: false`, so the mesh task surface stays empty for Pi sessions.
- A resume whose recorded cwd differs from the requested one is refused before spawning (`run/context-unavailable`), because Pi would otherwise ask an interactive fork question that a managed child cannot answer; a resume passes the session file path rather than the bare id for the same reason.
- Transcript reads are bounded to the live branch: a session file no larger than the read window (default 512 KiB, clamped to 64 KiB–8 MiB) is read whole; a larger file contributes its header plus a tail window. A chain that starts outside the window leaves `totalMessages` unreported, and abandoned branches contribute nothing.
- The session directory name is a lossy cwd hint (`--<flattened>--`), the header's own `cwd` is authoritative, and a disagreement is declared as a note; the adapter scans both the flat `sessionDir` override and the default `sessions/` root, bounded to 200 directories, 400 files per directory, and 1,500 files per scan.
- The model catalog reads only `models.json` and `settings.json`: Pi's built-in catalog and its pi.dev overlay are deliberately not read, so an `enabledModels` scope that would remove every configured model is ignored rather than reporting zero runnable models.
- The `ctx.llm` routes also read only Pi's user files. They project declared providers/models and overrides plus `defaultProvider`/`defaultModel`; API keys come from `auth.json` `api_key` records or `models.json` values and environment references. Stored OAuth cannot be refreshed, and shell-command credentials or headers are refused; native credentials are never copied into the Harness credential store.
- Fake-process tests cover RPC session binding, streamed events, and native abort. No real Pi model run has been performed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The fake RPC process exercises session binding, event projection, and native abort without making model requests.

</details>
