---
description: "agent-mesh 包组：外部编码智能体注册表、会话到智能体的绑定、读取各智能体自有存储的适配器，以及面向模型的工具。"
kind: "package-group"
---

# agent-mesh/ —— 外部编码智能体接入族

[English](README.md) | 中文

## Summary

agent-mesh 族把 Harness 接入 Codex、Grok Build、Pi 和 OMP，同时保留各智能体自己的存储与 CLI。用户可以查看会话、transcript、计划、凭证和运行；把 Harness 会话绑定到智能体；使用其配置的模型；并在 DSH 审批后启用原生 MCP server。绑定会话会把 adapter 声明的上下文文件作为持久化模型输入。适配器读取原生数据并报告无法投影的字段；面向模型的工具暴露这些能力，mesh 负责绑定和运行跟踪。Web 面板、人类命令和 worktree 协作包支持这些工作流。

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`mesh/`](mesh/README.zh.md) | 定义多智能体接缝：统一词汇、adapter provider 契约与宿主端口、adapter 注册表、持久化的会话到智能体绑定、诊断，以及 run 注册表 | `ctx.agentMesh` |
| [`tools/`](tools/README.zh.md) | 向模型暴露已安装智能体、声明的能力清单、绑定会话的自动上下文快照、按需读取声明的 skill／prompt／上下文文件、文件型命令派发、经审批的 Agent 专属 MCP 启用、原生会话与任务，以及 run 终态结果 | 注册到 `ctx.tools` |
| [`commands/`](commands/README.zh.md) | 注册六条全局查询命令，并为已绑定 agent 声明的文件型原生命令注册作用域别名 | `ctx.commands` |
| [`controller/`](controller/README.zh.md) | Web Client 读取的 Remote 表面：智能体、会话与原生 TUI argv、transcript、任务、凭证与登录、绑定，以及 run | `remote.agentMesh` |
| [`agent-codex/`](agent-codex/README.zh.md) | Codex：探测、rollout 存储、transcript、原生 plan、凭证、Responses 路由，以及可续接的 `codex app-server --stdio` run（也可选择 `headless-exec`） | 注册到 `ctx.agentMesh` 与 `ctx.llm` |
| [`agent-grok/`](agent-grok/README.zh.md) | Grok Build：探测、会话存储、ACP update、plan、凭证、已配置模型路由、ACP 双工运行与 streaming-json 运行 | 注册到 `ctx.agentMesh` 与 `ctx.llm` |
| [`agent-pi/`](agent-pi/README.zh.md) | Pi：探测、JSONL 会话树、transcript、凭证、已配置模型路由、RPC 双工运行与 `--mode json` 运行 | 注册到 `ctx.agentMesh` 与 `ctx.llm` |
| [`agent-omp/`](agent-omp/README.zh.md) | OMP：探测、会话存储、transcript、原生 todo 与 plan、已配置模型路由，以及 `--mode rpc-ui` run | 注册到 `ctx.agentMesh` 与 `ctx.llm` |
| [`collaboration/`](collaboration/README.zh.md) | worktree 隔离的多智能体协作：一份 collaboration、一份权威 plan、一块 todo 看板、按智能体的 worktree 及进度采样与同文件冲突报告，以及任务派发 | `ctx.meshCollaboration` |

## Related documentation

- [智能体 mesh 子系统](../../docs/subsystems/agent-mesh.zh.md) —— 接缝、provider 契约、runs、协作与各表面。
- [原生多智能体集成决策](../../.agents/notes/proposed/architecture/2026-10-16-native-agent-mesh-in-dsh.zh.md) —— 该能力族为何存在、刻意放弃了什么，以及它必须遵守的约束。

<a id="dev-note"></a>
## Dev Note

按智能体拆分的 adapter 是独立包，因此一个组合可以逐个选择智能体，而且每个包关于"未能验证什么"的说明都与作出该声明的那份代码放在一起。Web 面板位于 `packages/client/ui-agent-mesh`，也就是客户端包应在的位置。
