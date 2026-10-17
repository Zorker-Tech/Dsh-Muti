---
description: "worktree 隔离的多智能体协作：一份权威 plan、一块受修订保护的 todo 看板、按智能体的 git worktree 与进度采样，以及同文件、同代码块、功能区和基提交冲突报告。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-mesh-collaboration

[English](README.md) | 中文

<a id="summary"></a>

## 概述

当多个智能体需要在同一仓库的隔离 git worktree 中协作时使用本包。创建共享 plan 与受修订保护的 todo 看板，派发带依赖的任务并携带这些上下文，检查进度与文件、基提交间的潜在冲突。设置 `featureBoundaries` 可按路径前缀提示关联改动；`conflictPolicy: 'block'` 会把同代码块重叠标为 blocking，但不会停止派发。所有冲突结果仅供参考。

<a id="table-of-contents"></a>

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

在 mesh 接缝与至少一个 adapter 之后挂载；base bundle 已同时携带三者。通过 `mesh_collaboration_start` 或 `remote.meshCollaboration` 命名空间创建 collaboration，之后每个操作都以 id 寻址。worktree 创建需要真实 git 仓库与主机上的 `git` 二进制：git 不可用时操作以 `worktree/git-unavailable` 失败，而不是悄悄在共享目录里运行。`conflictPolicy: 'block'` 会把同代码块冲突标记为阻断级别以供审查，但不会阻止独立派发。`featureBoundaries` 接受仓库相对路径前缀，默认是空列表。

<a id="understand-the-implementation"></a>

## 理解实现

| File | Role |
|---|---|
| `src/index.ts` | `ctx.meshCollaboration` 服务：collaboration、plan、看板、任务、worktree 与派发 |
| `src/domain.ts` | 保存全部记录的持久化 domain（`agent_mesh_collab`） |
| `src/boards.ts` | plan 与 todo 看板规则，包括修订保护与原生任务观测 |
| `src/worktrees.ts` | worktree 生命周期、进度采样与预测冲突报告 |
| `src/git.ts` | 经宿主端口执行 git 命令，并分类其失败 |
| `src/tools.ts` | 十三个面向模型的工具 |
| `src/controller.ts` | `remote.meshCollaboration` 表面 |

每条记录都由 mesh 拥有且是可加的：不改 session 格式、session event 或 session-query schema，因此移除本包后 Harness 只读到它自己的数据。

<a id="further-exploration"></a>

## 进一步探索

- [接缝 README](../mesh/README.zh.md) —— 本包所基于的注册表、run 注册表与宿主端口。
- [智能体 mesh 子系统](../../../docs/subsystems/agent-mesh.zh.md) —— 协作在能力族中的位置。

<a id="model-experience"></a>

## 模型体验

### 创建与读取 collaboration

#### What the model sees

`mesh_collaboration_start` 接受标题、目标、仓库根，以及可选的种子任务（每个任务给出负责人、指令、可选的 `dependsOn` 兄弟项与隔离模式），并返回创建出的 collaboration。`mesh_collaborations` 列出每个 collaboration 及其 plan、看板计数、任务与 worktree，或按 id 读取其中一个；阶段行包含退出条件。schema 即 `packages/agent-mesh/collaboration/src/tools.ts` 所注册的内容；返回记录即服务自身的记录类型。

#### Token effect

工具可见时每次请求的固定 schema 成本。列表结果随其报告的 collaboration、任务与 worktree 数量增长；按 id 读取单个 collaboration 可保持其有界。

#### KV Cache effect

工具集合与可见性不变时前缀稳定；结果追加在可复用前缀之后。

### Plan 与 todo 看板

#### What the model sees

`mesh_plan_set` 替换目标、完整阶段列表、当前阶段、决策日志与模式（`inject` 会把 plan 放进派发的 prompt，`observe` 不会）；`mesh_plan_advance` 激活某阶段并把更早的阶段标记完成，若仍有更早阶段未完成则拒绝。`mesh_todos_set` 替换看板，并可携带 `expectedRevision`；过期修订会被拒绝并返回当前修订，而不是覆盖其它写入者的工作；依赖成环或未知阶段 id 会以带标签的错误拒绝。`mesh_todos_get` 读取看板，`mesh_todos_observe` 把某个智能体自己的原生任务（经 mesh 读取）折叠进来，而不覆盖已编写的条目。

#### Token effect

`mesh_todos_set` 随模型提交的整块看板增长，且该列表会留在调用历史中直到压缩。读取返回当前看板。

#### KV Cache effect

只追加；看板写入与其它工具调用一样，不会改写更早的消息。

### Worktree、冲突与派发

#### What the model sees

`mesh_worktrees` 列出 worktree 的基提交与基引用、改动文件、提交位置和是否干净；筛选路径不属于 Git 仓库时返回空列表。`mesh_worktree_create` 从某个基引用创建；`mesh_worktree_conflicts` 报告同一仓库活跃 worktree 之间的同文件改动、基提交行范围重叠、同一已配置功能区内的改动和不同基提交。同代码块级别默认为 `warning`，`conflictPolicy: 'block'` 时为 `blocking`；报告仍是提示，不会阻止独立派发。`mesh_worktree_remove` 在 worktree 不干净时拒绝，除非传入 `force`。`mesh_task_dispatch` 运行一个任务：创建或复用该任务的 worktree，发送指令连同 plan 与看板上下文，并把 run id 与状态记录到任务上；依赖未完成、或任务已在运行/已成功的，会带原因被拒绝。`mesh_task_dispatch` 与 `mesh_worktree_remove` 在启动智能体或删除 worktree 前都要求 DSH 用户批准；强制删除可能丢弃未提交的改动。

#### Token effect

冲突报告随参与比较的改动文件数量增长。派发返回任务记录，而不是智能体的 transcript，因此长时间运行的智能体不会撑大该结果。

#### KV Cache effect

除常规的工具调用追加外无直接影响。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 冲突报告属于启发式：未跟踪文件、二进制文件或无法读取的 diff 不含行范围；不同文件间未落入已配置功能前缀的语义冲突也无法检测。
- worktree 位于 `<repoRoot>/.dsh-agent-mesh/worktrees`，且不做垃圾回收；被移除的 collaboration 会留下其 worktree 目录，直到 `mesh_worktree_remove` 执行。
- 派发记录 run 与其 id，但不跟进它：读取智能体的答案需要用记录下来的 run id 调用 `mesh_runs`。
- 运行时审批转发仅适用于会暴露受支持请求的传输：Codex app-server 转发命令与文件变更请求，Grok ACP 转发权限请求，Pi RPC 与 OMP rpc-ui 转发确认，以及带有明确单次允许和拒绝选项的选择请求。未支持的请求会安全拒绝；本机未安装 OMP 二进制，因此其真实 CLI 往返仍未经验证。
- plan 以由 plan 与看板记录构造的上下文文本注入；除 `mesh_plan_set` 的 `mode` 外没有按智能体过滤上下文。
- 覆盖率：本包的测试以 fake 覆盖服务、看板、worktree 规则与错误路径。真实的 `git worktree` 往返只在存在 git 二进制与仓库处被验证，单元套件不覆盖。

<a id="dev-note"></a>

### 开发备注

持久化 domain 为 `agent_mesh_collab`（版本 1）。服务与其 Remote controller 由同一行挂载，因此挂载本包即可同时获得进程内 API 与客户端命名空间。
