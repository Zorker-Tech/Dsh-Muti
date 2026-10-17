---
description: "The OpenAI Codex adapter for the agent mesh: `codex` and `$CODEX_HOME` detection, read-only rollouts, credentials and configured models, and native app-server runs with resumable sessions, interruption, and approval forwarding."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codex

English | [中文](README.zh.md)

## Summary

Mount this package to expose an installed Codex CLI to the Harness. It lists Codex rollout sessions, reads bounded transcript tails with checklist and plan state, reports ChatGPT or API-key status, lists configured models, exposes supported Responses API routes through `ctx.llm`, and runs resumable turns through `codex app-server --stdio`. Native command and file-change approval requests can be routed through DSH, and cancellation interrupts the current turn before terminating a stuck process. A machine without Codex reports `installed: false`.

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
- id: agent-codex
  name: '@deepseek-ai/dsh-agent-codex'
  config:
    homeDir: ~/.codex
    model: gpt-5-codex
```

### When to choose it

Choose this adapter on a machine that runs the Codex CLI and whose sessions should stay in Codex's own store. It is the only package that can list, read, or dispatch Codex sessions, and it stays inert until a caller reads or dispatches; a machine without the binary still mounts it and reports `installed: false` with a reason. Its separate `ctx.llm` provider exposes models selected by the supported user-level Codex configuration. A composition that needs a different external agent mounts that agent's adapter instead, and one profile may mount several. Choose the Harness's own loop instead when the work should not run through Codex's CLI at all; this adapter never re-implements Codex and never reads a store other than `$CODEX_HOME`.

### Minimal configuration

The row above works with no `config` at all: detection searches `PATH` and the well-known install directories, and the home falls back to `$CODEX_HOME` and then `~/.codex`. Every accepted field is listed here.

| Field | Default | Meaning |
|---|---|---|
| `binaryPath` | unset | Explicit `codex` executable, tried before `PATH` and the well-known install directories. |
| `homeDir` | unset | Explicit Codex home, tried before `$CODEX_HOME` and `~/.codex`. |
| `env` | `{}` | Extra environment entries for every child process this adapter starts. |
| `model` | unset | Model for runs that name none, in Codex's own naming. |
| `runMode` | `duplex-protocol` | `duplex-protocol` uses `codex app-server --stdio`; `headless-exec` uses `codex exec --json` without native interruption or approval forwarding. |
| `sandbox` | unset | Sandbox profile for runs that name none; one of `read-only`, `workspace-write`, `danger-full-access`. |
| `approval` | unset | Approval mode for runs that name none; one of `on-request`, `never`. |
| `timeoutMs` | `0` | Default run budget in milliseconds; `0` leaves runs unbounded. |
| `interruptGraceMs` | `10000` | Time to wait after `turn/interrupt` before terminating a process that has not completed the turn. |
| `transcriptTailBytes` | `1048576` | Rollout tail window read when projecting a transcript. |
| `taskTailBytes` | `1048576` | Rollout tail window read when extracting native task state. |
| `loginTimeoutMs` | `600000` | Wall-clock budget for a delegated `codex login`. |
| `logoutTimeoutMs` | `60000` | Wall-clock budget for a delegated `codex logout`. |
| `versionProbeTimeoutMs` | `10000` | Wall-clock budget for the `--version` detection probe. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The adapter is a pure function of `CodexHost`, the mesh's host port: `detect.ts` resolves the binary and probes `--version`, `sessions.ts` resolves the home layout and enumerates rollouts head-first, `transcript.ts` projects rollout lines, `tasks.ts` folds the latest checklist or plan record, `auth.ts` classifies `auth.json` and delegates credential flows, `models.ts` scans `config.toml`, `run.ts` owns the `codex exec --json` transport, and `app-server-run.ts` owns the duplex app-server lifecycle, event projection, approval requests, interruption, and terminal classification. The plugin's `apply` only builds that host from the Cordis context and registers the adapter as an effect, so unmounting removes it. Detection and the home layout are resolved once and cached; a detection failure is not cached, because the user may install the binary and ask again.

| File | What it owns |
|---|---|
| `src/index.ts` | The `codex` adapter: cached detection, capability declaration, login/logout delegation, and registration on `ctx.agentMesh`. |
| `src/detect.ts` | Binary resolution, `--version` probing, and the sandbox and approval vocabularies. |
| `src/sessions.ts` | Home resolution, bounded rollout discovery, `session_meta` parsing, and `session_index.jsonl` titles. |
| `src/transcript.ts` | Rollout-line projection into mesh messages with the 16 KiB field cap. |
| `src/tasks.ts` | Latest `plan_update`, `update_plan`, `todo_list` and `plan` state with re-read-stable todo ids. |
| `src/auth.ts` | `auth.json` classification, environment precedence, delegated `codex login`/`logout`, and redaction. |
| `src/models.ts` | The user-layer `config.toml` scan for the configured model ids. |
| `src/llm-models.ts` | Read-only projection of Codex's Responses API model routes and environment-key references. |
| `src/run.ts` | `codex exec --json` argv, stream mapping, cancellation, and exit classification. |
| `src/app-server-run.ts` | `codex app-server --stdio` thread lifecycle, event projection, one-shot DSH approval, interruption, and terminal results. |
| `src/config.ts` | The `CodexAdapterConfig`/`ResolvedCodexConfig` split and every default. |
| `src/types.ts`, `src/json.ts`, `src/notes.ts` | The host-port alias plus the JSON and projection-note narrowing helpers. |

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

The mesh tools remain separate: this package adds no prompt text or tool, and those tools still reach the `AgentAdapter` through [`@deepseek-ai/dsh-agent-mesh-tools`](../tools/README.md). A `mesh_run` call waits for the native turn to finish and returns its final answer or classified error. The app-server transport forwards command and file-change approval requests through the calling DSH session and accepts only one-shot grants. The adapter also registers `agent-codex` with `ctx.llm`; when the user selects one of its configured models, requests go directly to the configured Responses API endpoint.

#### Token effect

None by itself. A `mesh_*` tool call's token cost belongs to the tools package's result content; this adapter adds no text of its own to a request. A dispatched run's result also reaches the model only through `mesh_run`/`mesh_runs`.

#### KV Cache effect

None. This package contributes no model request content; the mesh tools package owns what enters a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `headless-exec` cannot interrupt one turn or forward runtime approval requests; use the default `duplex-protocol` mode when those features are required.
- The app-server adapter forwards command and file-change approval requests to DSH and grants only a native one-shot `accept`; other offered permission decisions are declined. Requests for user input, additional turn permissions, and MCP elicitation fail closed with empty or declined answers.
- `resolveMcpServer` reads `$CODEX_HOME/config.toml` and project `.codex/config.toml` layers for `mesh_mcp_connect`. DSH starts a supported stdio or Streamable HTTP server only after first-use approval; SSE and OAuth entries fail closed.
- zstd-compressed rollouts (`rollout-*.jsonl.zst`) are not decompressed: listing reports them `unreadable`, `readNativeTasks` returns an empty state with a note, and `readTranscript` throws `mesh/unsupported-operation`. Open the session in Codex to materialise the plain rollout.
- Transcript and task reads are bounded tail windows (`transcriptTailBytes` and `taskTailBytes`, 1 MiB by default), so older content is outside the window and is declared in `notes`; Codex records no message count, so `totalMessages` is never reported.
- Session listing reads only the first 64 KiB of each rollout head, walks at most 4 directory levels and 5,000 rollout files per root, and takes a title only from `session_index.jsonl`; the first user message is not read during listing.
- The model catalog reads only the user configuration layer (`$CODEX_HOME/config.toml`): the legacy `[profiles.*]` selection, the working-directory layer, and trusted project `.codex/config.toml` layers are deliberately not merged, because the mesh model row carries no provenance and a partial layer precedence could not be reported.
- The `ctx.llm` route supports `model`, `review_model`, `model_provider`, `wire_api = "responses"`, `base_url`, `name`, and an `env_key`; it does not reuse Codex's `auth.json` OAuth session, query parameters, or other wire APIs. Use a named environment API key, normally `OPENAI_API_KEY`, for direct model requests.
- A keyring credential store or an unrecognized `auth_mode` is reported `unknown` rather than logged out, and `id_token` claims (account, plan, expiry) are decoded without signature verification and are display-only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/` pins binary resolution and home fallback, the auth classifications and delegated login/logout, the `config.toml` scan and LLM route projection, session listing (archived, compressed, cwd filter, abort), rollout-line projection with every declared gap, native task extraction and id stability, the exec argv and event projection, and app-server lifecycle, approvals, interruption, and failure classification. The zstd path is covered as an unreadable case rather than as decompression.

</details>
