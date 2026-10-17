---
description: "The oh-my-pi (`omp`) adapter for the agent mesh: `omp` and `PI_CODING_AGENT_DIR` detection, read-only sessions and todos, configured LLM routes, and duplex RPC runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-omp

English | [中文](README.zh.md)

## Summary

Mount this package to expose oh-my-pi (`omp`) on this machine. It lists OMP's title-slotted JSONL sessions, reads bounded live-branch transcripts plus native todos and plans, reports credential presence, and projects configured model routes into `ctx.llm`. Runs send prompts to `omp --mode rpc-ui`, which creates or resumes native sessions and exposes supported confirmation prompts to DSH; cancellation uses RPC `abort`. Session reads never write OMP data, and stored SQLite credentials are reported `unknown` because the adapter does not read that database. Only detection, credential flows, and run dispatch start a process.

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
- id: agent-omp
  name: '@deepseek-ai/dsh-agent-omp'
  config:
    homeDir: ~/.omp/agent
    sessionDir: ~/.omp/sessions
```

### When to choose it

Choose this adapter on a machine that runs the `omp` CLI and whose sessions should stay in OMP's own store. It is the only package that can list, read, or dispatch OMP sessions, and it stays inert until a caller reads or dispatches; a machine without the binary still mounts it and reports `installed: false` with a reason. It reports native todos and plan mode, so it is the adapter to prefer when those matter. It also registers configured OMP model routes with `ctx.llm`; this is separate from `AgentAdapter.listModels`, which remains unavailable because the adapter does not run OMP's model-catalog probe. A composition that needs a different external agent mounts that agent's adapter too, and one profile may mount several.

### Minimal configuration

The row above works with no `config` at all: detection searches `PATH` and the well-known install directories, and the agent directory follows OMP's own precedence of `$OMP_PROFILE`/`$PI_PROFILE`, `$PI_CODING_AGENT_DIR`, and `$PI_CONFIG_DIR`. Every accepted field is listed here.

| Field | Default | Meaning |
|---|---|---|
| `binaryPath` | unset | Explicit `omp` executable, tried before `PATH` and the well-known install directories. |
| `homeDir` | unset | Explicit OMP agent directory, the highest-priority source of the store root. |
| `sessionDir` | unset | Flat session directory, tried before `$PI_CODING_AGENT_SESSION_DIR`; OMP has no settings key for it. |
| `env` | `{}` | Extra environment entries for every child process this adapter starts. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The adapter is a pure function of the mesh's `AgentHost`: `detect.ts` resolves the binary and probes `--version`, `sessions.ts` resolves the store layout, parses the fixed-width title slot, session header, and append-only entries, walks the `parentId` tree to the live leaf (which a trailing `model_usage` marker can move), folds session state and usage, and scans both the flat override directory and the default per-project root, `transcript.ts` projects branch entries into mesh messages, `tasks.ts` reads todo snapshots and plan-mode transitions, `auth.ts` reports credential presence and delegates `omp login`, `llm-models.ts` reads configured YAML model routes and role selectors without opening the credential database, `run.ts` projects OMP session events and resolves resume targets, and `rpc-run.ts` owns RPC commands, native abort, and terminal results. The plugin's `apply` builds the host from the Cordis context, then registers the mesh adapter and separate LLM provider as effects.

| File | What it owns |
|---|---|
| `src/index.ts` | The `omp` adapter, the `OMP_TRANSPORTS` declaration, capability set, and registration on `ctx.agentMesh`. |
| `src/detect.ts` | Binary resolution, `--version` probing, the approval vocabulary, and the `provider/id` model split. |
| `src/sessions.ts` | Store-layout and profile resolution, the title slot/header/entry model, folding, the live-branch walk, and bounded discovery. |
| `src/transcript.ts` | Live-branch projection into mesh messages with the 16 KiB field cap. |
| `src/tasks.ts` | `user_todo_edit` snapshots and `todo` tool results, plus plan-mode state and its plan file path. |
| `src/auth.ts` | The provider environment-variable list, credential-store presence, and the login/logout guidance. |
| `src/llm-models.ts` | Read-only projection of configured providers, models, role selectors, and API-key references into `ctx.llm`. |
| `src/run.ts` | OMP session-event projection, resume resolution, child environment, and exit classification. |
| `src/rpc-run.ts` | RPC UI argv, session binding, DSH approval for supported confirmations, prompt completion, and turn interruption through OMP's `abort` command. |
| `src/config.ts` | The `OmpAdapterConfig`/`ResolvedOmpConfig` split and every default. |

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

This package adds no prompt text or tool. The mesh tools remain separate and reach the `AgentAdapter` through [`@deepseek-ai/dsh-agent-mesh-tools`](../tools/README.md). The package also registers `agent-omp` with `ctx.llm`, making configured OMP models selectable; selecting one sends requests to its configured endpoint through the Harness LLM service. Session rows, transcript messages, todo and plan state, and run results rendered by the mesh tools still come from the `AgentAdapter`, including each `notes` string that declares a projection gap.

#### Token effect

None by itself. A `mesh_*` tool call's token cost belongs to the tools package's result content; this adapter adds no text of its own to a request. A dispatched run's result also reaches the model only through `mesh_run`/`mesh_runs`.

#### KV Cache effect

None. This package contributes no model request content; the mesh tools package owns what enters a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A real-composition test runs the local `/model` command through the adapter in an isolated OMP 18.11.0 store, then verifies the session path, v3 header, title slot, startup entries, run result, and session binding. It makes no model request and does not read or write the installed user store.
- OMP keeps credentials in the SQLite database `<agent-dir>/agent.db`; this adapter has no SQLite driver and never reads it. A present `agent.db` is reported `unknown`, a provider environment variable is `authenticated`, and neither is `unauthenticated`, so the adapter cannot tell whether a stored credential is usable.
- `omp logout` does not exist as a subcommand: logout always returns guidance (`/logout` in the TUI, the RPC `logout` command, or `omp auth-broker logout`) and never runs anything; login delegates a bounded `omp login` for the `interactive` flow only, whose prompts need a terminal, so the reported outcome is usually a failure with guidance.
- `resolveMcpServer` reads the resolved agent directory's `mcp.json` and the nearest project `.omp/mcp.json` for `mesh_mcp_connect`. DSH starts a supported stdio or Streamable HTTP server only after first-use approval; SSE and managed OAuth entries fail closed.
- `cancel()` sends OMP's RPC `abort` command and preserves its session file. `rpc-ui` forwards `confirm` requests and `select` requests only when they contain explicit one-shot allow and deny choices; DSH declines unsupported dialogs and selections.
- A failed native UI approval response write ends the run as `run/protocol-error`; if cancellation succeeds after a failed UI-cancellation response write, the run remains cancelled and records the write failure in its notes.
- `capabilities().listModels` is `false`: the adapter does not run `omp models --json`. Separately, `ctx.llm` reads `models.yml` and `config.yml` for configured providers, models, model overrides, and exact `modelRoles` selections; it does not read OMP's SQLite credential store or use OMP OAuth. `auth: none` disables ambient keys, while `apiKey` resolves an environment name first and otherwise uses the configured literal. Shell-command credentials, `authHeader: false`, and OMP-specific request behavior the Harness cannot reproduce are refused.
- Transcript and task reads use a byte window over the live branch (default 512 KiB; a session file no larger than the window is read whole, a larger one contributes its title slot, header, and a tail window), the plan file the `mode_change` entries locate is reported verbatim and never opened, and `/clear` reset boundaries are recorded but not applied to the projection.
- Session-file support was ported against format v3; a header carrying an older `version` is only annotated in `notes`, and a by-id lookup that does not match the file-name convention probes at most 300 headers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/` pins the profile and agent-directory precedence, credential-state reporting, the mounted descriptor, argv building and the child environment, the NDJSON projection, the live-branch leaf override, the title slot, the scan caps, todo and plan extraction, and `ctx.llm` route projection. When OMP is installed, the real-store e2e test also creates one isolated session with the CLI and reads its path, v3 header, and startup entries through this adapter; it does not send a model prompt or touch the user's OMP store.

</details>
