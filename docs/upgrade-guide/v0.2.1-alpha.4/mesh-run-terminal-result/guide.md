---
kind: upgrade-guide
description: "The `mesh_run` tool now waits for an external agent's terminal result instead of returning an in-progress run."
---

# `mesh_run` returns a terminal result

English | [中文](guide.zh.md)

## Change

`mesh_run` previously returned a run id while the external agent continued in the background. It now keeps the tool call open until the run reaches a terminal status, then returns the run id, final answer or classified error, and adapter notes. Consumers that parsed the immediate-dispatch result must handle the terminal fields and longer call duration.

## Migration

1. Update any consumer that assumes `mesh_run` returns before the agent finishes. Read `status`, optional `finalText` or `error`, and `notes` from its result.
2. Use `mesh_runs` after completion to inspect retained events. Confirm a successful call returns a terminal `status` and the agent's final answer when available.
