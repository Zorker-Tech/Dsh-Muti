---
description: "The Grok Build adapter for the agent mesh: `grok` and `$GROK_HOME` detection, read-only session stores and credentials, configured model routes, and native ACP runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-grok

English | [中文](README.zh.md)

## Summary

Mount this package to expose Grok Build's CLI and own sessions to the Harness. It projects bounded transcripts and native todo/plan state, reads scope-keyed credentials, exposes configured model routes through `ctx.llm`, and runs prompts through ACP by default or streaming JSON on request. Adapter reads never write Grok files; only detection, credential flows, and run dispatch start processes. Grok has no headless API-key login, so login requests return guidance.

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
- id: agent-grok
  name: '@deepseek-ai/dsh-agent-grok'
  config:
    homeDir: ~/.grok
    model: grok-code-fast-1
```

### When to choose it

Choose this adapter on a machine that runs the Grok Build CLI and whose sessions should stay in Grok's own store. It is the only package that can list, read, or dispatch Grok sessions, and it stays inert until a caller reads or dispatches; a machine without the binary still mounts it and reports `installed: false` with a reason. Its separate `ctx.llm` provider projects configured model endpoints without starting `grok models`. A composition that needs a different external agent can mount that agent's adapter too.

### Minimal configuration

The row above works with no `config` at all: detection searches `PATH` and the well-known install directories, the home falls back to `$GROK_HOME` and then `~/.grok`, and the credential file falls back to `$GROK_AUTH_PATH` and then `<home>/auth.json`. Every accepted field is listed here.

| Field | Default | Meaning |
|---|---|---|
| `binaryPath` | unset | Explicit `grok` executable, tried before `PATH` and the well-known install directories. |
| `homeDir` | unset | Explicit Grok home, tried before `$GROK_HOME` and `~/.grok`. |
| `env` | `{}` | Extra environment entries for every child process this adapter starts. |
| `runMode` | `duplex-protocol` | `duplex-protocol` uses Grok ACP; `headless-exec` uses `grok -p --output-format streaming-json`. |
| `interruptGraceMs` | `10000` | Time to wait after an ACP session cancel before terminating its process. |
| `model` | unset | Model for runs that name none, in Grok's own naming. |
| `sandbox` | unset | Sandbox profile for runs that name none; one of `off`, `workspace`, `devbox`, `read-only`, `strict`. |
| `approval` | unset | Approval mode for runs that name none; one of `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`. |
| `maxTurns` | unset | `--max-turns` value passed on every dispatch; unset leaves Grok's own limit in force. |
| `reasoningEffort` | unset | `--reasoning-effort` value passed on every dispatch. |
| `noPlan` | `false` | Pass `--no-plan` on every dispatch. |
| `noSubagents` | `false` | Pass `--no-subagents` on every dispatch. |
| `disableWebSearch` | `false` | Pass `--disable-web-search` on every dispatch. |
| `timeoutMs` | `0` | Default run budget in milliseconds; `0` leaves runs unbounded. |
| `transcriptTailBytes` | `1048576` | `updates.jsonl` tail window read when projecting a transcript. |
| `loginTimeoutMs` | `300000` | Wall-clock budget for a delegated `grok login`, which waits for a human. |
| `logoutTimeoutMs` | `30000` | Wall-clock budget for a delegated `grok logout`. |
| `versionProbeTimeoutMs` | `10000` | Wall-clock budget for the `--version` detection probe. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The adapter is a pure function of the mesh's `AgentHost`: `detect.ts` resolves the binary and probes `--version`, `sessions.ts` resolves the home, session root, and credential path and reads each session directory's `summary.json`, `transcript.ts` projects `updates.jsonl` (falling back to `chat_history.jsonl`), `tasks.ts` reads `plan.json` and `plan_mode.json`, `auth.ts` classifies the scope-keyed store and delegates `grok login`/`logout`, `run.ts` owns the streaming-json path, and `acp-run.ts` owns ACP authentication, session loading, permission decisions, and cancellation. The plugin's `apply` builds the host from the Cordis context and registers the adapter as an effect. Detection is resolved once and cached for the adapter's lifetime.

| File | What it owns |
|---|---|
| `src/index.ts` | The `grok` adapter: cached detection, capability declaration, transport inventory, and registration on `ctx.agentMesh`. |
| `src/detect.ts` | Binary resolution, `--version` probing, and the sandbox and approval vocabularies. |
| `src/sessions.ts` | Home, session-root, and credential-path resolution; `summary.json` projection; the `cwd` marker. |
| `src/transcript.ts` | `updates.jsonl` and `chat_history.jsonl` projection into mesh messages with the 16 KiB field cap. |
| `src/tasks.ts` | `plan.json` todos and the `plan_mode.json` lifecycle state. |
| `src/auth.ts` | Scope-keyed credential classification, environment precedence, delegated `grok login`/`logout`, and redaction. |
| `src/llm-models.ts` | Read-only projection of user model tables, API backends, headers and API-key references. |
| `src/run.ts` | `grok -p` streaming-json argv, stream mapping, cancellation, and exit classification. |
| `src/acp-run.ts` | `grok agent stdio` authentication, session loading, permission decisions, event projection, and process cancellation. |
| `src/config.ts` | The `GrokAdapterConfig`/`ResolvedGrokConfig` split and every default. |

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

The mesh tools remain separate: this package adds no prompt text or tool, and those tools still reach the `AgentAdapter` through [`@deepseek-ai/dsh-agent-mesh-tools`](../tools/README.md). It also registers `agent-grok` with `ctx.llm`; selecting a model from Grok's user-level `config.toml` sends requests directly to that model's configured endpoint.

#### Token effect

None by itself. A `mesh_*` tool call's token cost belongs to the tools package's result content; this adapter adds no text of its own to a request. A dispatched run's result also reaches the model only through `mesh_run`/`mesh_runs`.

#### KV Cache effect

None. This package contributes no model request content; the mesh tools package owns what enters a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The default `duplex-protocol` run uses `grok --no-auto-update agent stdio`; `headless-exec` selects `grok -p --output-format streaming-json`. ACP authentication uses advertised `xai.api_key` when `XAI_API_KEY` or `GROK_CODE_XAI_API_KEY` is set, otherwise advertised `cached_token` authentication.
- A resume requires advertised `session/load`, and a requested model must match one advertised ACP selector. ACP rejects CLI-only run options and non-default approval modes before sending the prompt; use `headless-exec` for those options.
- ACP permission requests use DSH approval and accept only one-shot allow or reject decisions. A protocol failure aborts pending permission requests before the run settles. `interrupt` is available; cancellation sends `session/cancel` and terminates the process after `interruptGraceMs` if it does not exit.
- `resolveMcpServer` reads the user `config.toml` and project `.grok/config.toml` layers for `mesh_mcp_connect`. DSH starts a supported stdio or Streamable HTTP server only after first-use approval; SSE and managed OAuth entries fail closed.
- Grok has no headless `--api-key` login, so the `api-key` flow returns guidance (set `XAI_API_KEY`, or run `grok login`) and the `interactive` flow returns guidance because the loopback flow needs a browser; only `device-code` and `oauth-loopback` delegate to the CLI. A delegated login is held open until it exits, so a printed URL or device code is reported after the flow finishes rather than streamed as it appears.
- Fake-process tests cover ACP authentication, streamed text, one-shot DSH approval, and process exit during a pending approval. No real Grok model run has been performed.
- Transcript reads are bounded tail windows of `updates.jsonl` (default 1 MiB); when that file is absent or empty the derived `chat_history.jsonl` model-message cache is substituted and the substitution is declared in `notes`, and unparsable records are skipped and counted.
- Session listing reads the `summary.json` of every session directory and applies no scan cap, unlike the Pi and OMP adapters; a very large store costs one summary read per session, and an unreadable summary yields an `unreadable` row with the reason declared.
- `AgentAdapter.listModels` stays unavailable and `capabilities().listModels` is `false`; this is separate from `ctx.llm`, which reads configured `[model.*]` and `[model_providers.*]` routes from the user `config.toml` without running a CLI probe.
- The direct model route maps Grok's `chat_completions`, `responses`, and `messages` backends, endpoint, context/output limits, static/environment headers, and `api_key`/`env_key`. It refuses query parameters, auth-provider commands, model sampling settings, and Grok login tokens; use an API key or an endpoint that accepts no key.
- Credential status reports one selected entry: account and team names are folded into the free-text `detail`, a store the adapter cannot parse is `misconfigured` rather than a fabricated logged-out state, and the adapter never reads secret material out of the store.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The fake ACP peer exercises authentication, streamed text, and one-shot DSH permission decisions without making model requests.

</details>
