---
description: "agent-mesh 服务定义：统一的多智能体词汇、adapter provider 契约、adapter 注册表，以及 Harness 会话到其所属外部智能体的持久化绑定。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mesh

[English](README.md) | 中文

<a id="summary"></a>

## 概述

在 Harness 组合中与所需 adapter 包一起挂载本包，即可发现、浏览并派发外部编码智能体。`ctx.agentMesh` 读取智能体会话、跟踪 Harness 绑定和 run、保存置顶/归档选择并解析原生 MCP 配置。adapter 各自负责智能体格式，也可返回原生 TUI argv；DSH 不会启动 CLI。绑定与标记存放在 mesh 自有存储中；外部 id 不会成为 Harness SessionId，也不会改写 Session 日志。

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

先挂载它依赖的 storage 栈，再为每个智能体挂载一个 adapter：

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


注册表在 adapter 注册之前是空的，且 `bind()` 会拒绝没有 adapter 的智能体，因此只挂载接缝而不挂载 adapter 的组合会报告"没有智能体"，而不是悄悄接受一个它无法兑现的绑定。

<a id="understand-the-implementation"></a>

## 理解实现

- `types.ts` 是统一词汇：agent 描述、凭据、会话、transcript、原生任务、模型、run 事件与结果，以及 `AgentAdapter` provider 契约。目录读取会保留每个 agent 的独立失败；projection 会通过 `notes` 记录统一字段无法表达的源数据。`AgentHost.spawn()` 支持关闭 stdin 的批量输入，以及原生 RPC 传输使用的可写双工 stdin。
- `index.ts` 是服务：adapter 注册、诊断、原生 MCP 配置解析、`listSessions()`、Harness 会话绑定、外部会话标记和受跟踪的 run。MCP 解析只读取后续审批所需的声明，不会启动 server。
- `domain.ts` 声明 `agent_mesh` 用于 Harness 会话绑定，声明 `agent_mesh_session_marks` 用于外部原生会话置顶/归档选择。两个 domain 都独立于 Session 格式版本；标记仅保存 agent id、native id、disposition 与更新时间。
- `runs.ts` 保存有界的 run 事件与终态结果，并在服务卸载时取消仍在进行的 run。

<a id="further-exploration"></a>

## 进一步探索

- [原生多智能体集成决策](../../../.agents/notes/proposed/architecture/2026-10-16-native-agent-mesh-in-dsh.zh.md)
- [Group README](../README.zh.md)

<a id="model-experience"></a>

## 模型体验

None, as this seam registers no prompt, tool, or session event, and every model-facing surface over it belongs to a mounted adapter.

#### KV Cache effect

无直接影响；注册表与绑定从不触碰模型请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- mesh 服务跟踪 run；派发方可以读取 run 快照并取消仍在运行的项目。Worktree 隔离与跨智能体冲突报告属于独立的 collaboration 包，由该包组合 mesh。
- 绑定只针对 Harness 会话，没有 workspace 或 preset 级绑定。
- `diagnostics()` 只报告 adapter 能描述的内容；不会主动探测缺失的二进制。
- 沙箱化的文件系统 provider 可能拒绝 workspace 之外的路径；此时 adapter 读到的是空内容，并报告为不可读存储。

<a id="dev-note"></a>

### 开发备注

空注册表、adapter 失败、标记持久化与绑定行为由 `tests/mesh.spec.ts` 固定；`tests/runs.spec.ts` 覆盖保留的 run 事件与取消行为。
