---
description: "agent mesh 的 Remote API：已注册的智能体、它们自己的会话与 transcript、原生任务、凭证状态与登录、会话绑定，以及派发的 run，供 Web Client 使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mesh-controller

[English](README.md) | 中文

<a id="summary"></a>

## 概述

当 Web Client 需要查看外部智能体的会话、转录、任务、凭据、绑定和运行，或处理登录与取消运行时，使用本包。Host 必须提供 `agentMesh` 服务，Client 必须选入其命名空间。`launchCommand` 会为已有原生会话返回 adapter argv 与 DSH Host shell 方言，但不会启动 CLI。凭据行提供 adapter 声明的登录流程，以及能否移除当前来源凭据的登出操作。CLI 无法移除环境变量凭据；凭据只经 `login` 输入，永不返回。

<a id="table-of-contents"></a>

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>

## 使用本包

在 `agentMesh` 服务可用的 Host 组合中挂载它；Client 侧还需要在 API remotes 组装（`@deepseek-ai/dsh-api-remotes`）中被选中，命名空间才会作为 `ctx.remote.agentMesh` 可达。两者都在已发布的 profile 行里，因此普通的 Web profile 已经具备。

<a id="understand-the-implementation"></a>

## 理解实现

服务以命名空间 `agentMesh` 扩展 `TypertRemoteService`；每个方法带 `@Remote` 且以 `signal: AbortSignal` 收尾。wire 类型放在 `./types`（Typert 生成器要求边界类型位于公开的 type 子路径），并生成到 `./typert` 与 `./remote`。

<a id="further-exploration"></a>

## 进一步探索

- [接缝 README](../mesh/README.zh.md) —— 每个方法所委托的服务。
- [协作包](../collaboration/README.zh.md) —— 独立的 `meshCollaboration` Remote 命名空间，提供 plan、看板、任务派发、worktree、进度与冲突信息。
- [API Gateway 参考](../../../docs/api-gateway.zh.md) —— Remote 机制。

<a id="model-experience"></a>

## 模型体验

None, as this package registers no prompt, tool, or session event, being the Client's view of a service whose tools own the model surface.

#### KV Cache effect

无直接影响；Remote 表面从不触碰模型请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- run 的实时事件通过轮询 `runs` 获取，没有 stream 模式的 Remote 方法。
- 本命名空间不暴露协作记录；协作包通过 `remote.meshCollaboration` 提供这些能力。
- `transcript` 与 `tasks` 通过列举智能体存储来定位会话。

<a id="dev-note"></a>

### 开发备注

生成的 `typert.host.*` 与 `typert.remote-client.*` 由 `pnpm run build:lib`（或无打包的 `tsx scripts/generate-typert.ts`）产生；改动签名、错误码表或命名空间后需重新生成。
