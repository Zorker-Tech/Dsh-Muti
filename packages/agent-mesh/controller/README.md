---
description: "The agent mesh's Remote API: the registered agents, their own sessions and transcripts, native tasks, credential state and sign-in, session bindings, and dispatched runs for the Web Client."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mesh-controller

English | [中文](README.zh.md)

## Summary

Use this package when the Web Client needs external agents' sessions, transcripts, tasks, credentials, bindings, dispatched runs, sign-in, or run cancellation. Host composition must provide `agentMesh`; Client assembly must select its namespace. `launchCommand` returns adapter argv and the DSH Host shell dialect for an existing native session, but never starts the CLI. Credential rows expose adapter-declared login flows and whether logout can remove the observed source. Environment credentials cannot be removed by CLI logout. Credentials enter only through `login` and are never returned.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Use this package

Mount it in the Host composition with the `agentMesh` service available; the Client side needs it selected in the API remotes assembly (`@deepseek-ai/dsh-api-remotes`), which is where a namespace becomes reachable as `ctx.remote.agentMesh`. Both are part of the shipped profile rows, so an ordinary Web profile already has them.

## Understand the implementation

The service extends `TypertRemoteService` under the namespace `agentMesh`; each method is marked with `@Remote` and takes `signal: AbortSignal` last. Wire types live in `./types` (a public type subpath, as the Typert generator requires for boundary types) and are generated into `./typert` and `./remote`.

## Further Exploration

- [Seam README](../mesh/README.md) — the service every method delegates to.
- [Collaboration package](../collaboration/README.md) — the separate `meshCollaboration` Remote namespace for plans, boards, task dispatch, worktrees, progress, and conflicts.
- [API Gateway reference](../../../docs/api-gateway.md) — the Remote mechanism.

## Model Experience

None, as this package registers no prompt, tool, or session event, being the Client's view of a service whose tools own the model surface.

#### KV Cache effect

No direct effect; the Remote surface never touches a model request.

## Known Limitations and Deferred Work

- Live run events are polled from `runs`; there is no stream-mode Remote method.
- This namespace does not expose collaboration records; the collaboration package provides them through `remote.meshCollaboration`.
- `transcript` and `tasks` resolve a session by listing the agent's store.

### Dev Note

The generated `typert.host.*` and `typert.remote-client.*` artifacts are produced by `pnpm run build:lib` (or the bundle-free `tsx scripts/generate-typert.ts`); rerun after changing a signature, the code table, or the namespace.
