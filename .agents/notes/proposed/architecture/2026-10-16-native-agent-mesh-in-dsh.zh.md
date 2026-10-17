# Agent Note: 在 fork 中原生集成多智能体

Status: proposed

[English](2026-10-16-native-agent-mesh-in-dsh.md) | 中文

## Problem

DeepSeek Harness 只驱动它自己的智能体，而一个人实际的编码工作分散在 Codex、Grok Build、Pi、OMP 等其它 CLI 智能体上——它们各有自己的会话存储、凭证文件、headless 协议和 todo/plan 模型。

MutiAgent 插件已经把这四者建模到一套统一 schema 上，并以 `dsh` bundle 的形式从外部驱动它们。该插件已经触及天花板，原因是结构性的而非偶然的：

- 它自带客户端 bundle，并通过自己认证的 HTTP+SSE 通道传输，因此它的界面是 Web GUI 里的一套平行应用，而不是其中的一部分。harness 自己的会话列表、模型选择器、能力菜单和设置不会跟随会话所绑定的智能体，因为没有任何 harness 接缝知道外部智能体的存在。
- 它重新索引各智能体本已存储的数据（自己的会话索引、自己的 tracking 动作、自己的偏好文件），同一个事实有了两个归属方，因而可能互相矛盾。
- 它通过自建的三套表面（原生工具、MCP server、HTTP 网关）暴露操作，因为树外的 bundle 无法直接扩展 harness 的表面。

所有者已决定 fork harness，把这些能力原生实现：每个事实只有一个归属，由 harness 自己的接缝承载功能，并且不保留任何让插件架构在树内存活的兼容层。

## Proposal

把多智能体能力族实现为 `packages/agent-mesh/` 下的一等包，只接在 harness 有文档的扩展点上。

### Constraints

以下是实现必须遵守的规则，也正是下面的形态之所以如此的原因。

1. **只用原生接缝。** 每个能力都挂在有文档的扩展点上——带 provider 的 Service Definition、`ctx.tools`、客户端 slot、session projection、`ctx.authorization` flow、`ctx.llm` adapter、`ctx.skills` provider。不做平行传输（HTTP 网关、MCP server、自带客户端应用），也不为 harness 服务已经拥有的事实再建一个注册表。
2. **每个事实只有一个归属。** 智能体的会话、transcript、凭证、todo、plan 存放在该智能体 CLI 自己保存它们的地方。mesh 读取这些存储，绝不写入。Harness 拥有会话到智能体的绑定和 mesh 自己的编排记录；另一个独立的 session-mark domain 只保存外部会话在浏览界面的置顶/归档选择。
3. **持久化状态是可加且可忽略的。** 不提升 `SESSION_FORMAT_VERSION`，不新增 required-on-read 的 session event，不改 session-query 的 SQLite schema。mesh 自己的持久化状态放在 mesh 自己的 storage domain 中，上游 Harness 即使不知道这些 domain 也不受影响；移除 mesh 不会改写智能体原生存储、Harness 会话、Workspace 或仍保留的标记。
4. **错误要响亮，降级要可见。** 缺失的二进制、读不了的存储、无法识别的原生记录，以及二进制本身不具备的能力，都以诊断、note 或拒绝的形式报告。未知的原生记录以 `unknown` 连同其原生类型保留，而不是被丢弃，因此协议修订会表现为可见的缺口。
5. **不要声称没有观察到验证过的能力。** adapter 只声明其二进制实际支持的能力；消费者需要 provider 不具备的能力时应当拒绝而不是猜测——与 agent-preset 路径既有的规则一致。
6. **移植的领域逻辑必须忠实并注明出处。** 插件的格式知识（会话存储布局、事件分类、CLI 协议）按路径逐条移植，而不是重新设计。凡是移植有偏差，或插件自身行为从未针对真实存储验证过的地方，adapter 的 note 必须写明。

### Capability to seam

| Capability（目前在插件中） | 原生归属 |
|---|---|
| 跨智能体的统一 schema | `packages/agent-mesh/mesh` 的类型与投影；各 adapter 的损失说明 |
| 智能体探测、版本、传输方式 | `ctx.agentMesh` 注册表、`AgentAdapter.detect()` |
| 按智能体分区的会话浏览、本机 TUI 恢复命令、transcript、原生 todo/plan | `ctx.agentMesh` 会话读取与 adapter 生成的本机 TUI 恢复 argv、`session.list` 外部原生会话行、Workspace 分组/搜索与 mesh 管理的置顶/归档标记，以及 Agent Mesh 面板 |
| 智能体能力（工具、skill、MCP、命令、上下文文件） | 原生 skill 目录可通过 `dsh-skill-filesystem` 读取；`mesh_capabilities` 枚举声明；`mesh_capability_read` 通过 `ctx.fs` 按需读取一个已声明的 skill 指令、命令模板或上下文文件；文件型原生命令会注册为 Agent 作用域的 `ctx.commands` 别名，排入包含精确 `mesh_run.commandName` 的任务并要求 DSH 审批；已绑定 Session 会把原生上下文文件作为持久化 runtime context；`mesh_mcp_connect` 在首次使用经 DSH 审批后启用受支持的 stdio 或 Streamable HTTP server；会报告原生工具名的 adapter 会贡献最多 `maxProxyTools` 个 Agent 作用域任务委托代理。代理接收自由文本任务并通过外部 CLI 派发；不会导入原生 JSON schema 或工具实现 |
| 智能体自身模型的路由 | 各 adapter 贡献的 `ctx.llm` configurable provider |
| 凭证状态、登录、登出 | 各智能体自有凭证读取与操作，通过 mesh controller 和面板暴露 |
| 委派运行、worktree 隔离、进度、冲突 | `ctx.agentMesh` runs 与 `ctx.meshCollaboration` worktree、任务派发、plan、todo 看板和冲突报告 |
| 共享 plan 与 todo 看板 | mesh 的 collaboration 记录 + harness 自身的 todo/plan 表面 |
| Mesh 与协作工具 | 通过 `ctx.tools` 注册的 11 个 `mesh_*` 工具和 13 个协作工具 |
| Web UI（Agents 面板与外部会话行） | `ui-agent-mesh` 面板，以及 `ui-workspace` 中的原生会话行和操作 |

### Package topology

```
packages/agent-mesh/
  mesh/        Service Definition `ctx.agentMesh`: canonical vocabulary, adapter
               contract and host port, registry, session-to-agent binding,
               diagnostics, run registry. Depends on no adapter.
  tools/       Consumer: the model-facing operations on `ctx.tools`.
  commands/    Consumer: global inspection commands and Agent-scoped
               file-backed native command aliases on `ctx.commands`.
  controller/  Consumer: the `remote.agentMesh` surface the Web Client reads.
  agent-codex/ agent-grok/ agent-pi/ agent-omp/
               Providers, one package per agent, each mountable on its own row.
packages/client/ui-agent-mesh/
               Consumer: the Agent Mesh panel.
```

一个注册表和 adapter SPI 服务四个 provider 包，每个智能体一个包。包拆分让各二进制的存储与协议实现归各自智能体所有，统一词汇与 mesh 生命周期仍归 `mesh/` 管理。

### Deliberately dropped from the plugin

- **HTTP+SSE 网关与 MCP server。** 在树内，harness 自己的工具与 remote 服务就是表面。harness 没有 MCP-server 接缝；新增一个属于另一个决策，不属于本次工作。
- **插件的会话索引与 import/untrack 跟踪。** 会话直接从各智能体自己的存储读取；第二份索引会让同一个事实有两个归属方。
- **插件的客户端 bundle。** 由注册进 harness slot 的一等客户端包取代。
- **插件的偏好文件。** 由 mesh 拥有的 storage domain 取代。

## Implementation status

当前工作区已实现：mesh 注册表与 run 服务、面向模型的 mesh 工具、经审批启用原生 MCP server、Remote controller、四个智能体 provider、协作服务与工具、Agent Mesh 面板、`session.list` 和 Workspace 浏览中的源端原生会话行、绑定 Session 的持久化原生上下文快照、文件型原生命令的 DSH 作用域 handler，以及 Agent 作用域的原生工具任务委托代理。原生命令 handler 会重新检查当前能力清单，并排入一条带精确 agent、命令名和工作目录的模型后续消息；`mesh_run` 与原生工具代理都需要 DSH 审批。代理只接收自由文本任务，会在派发前重新检查绑定关系和能力清单，并要求外部 CLI 使用指定的原生工具。选中的外部会话可按 adapter 生成适用于 DSH Host shell 的本机 TUI 恢复命令供用户复制；页面不会启动 CLI。Grok ACP 与 Pi RPC 提供双工运行，也可选择 streaming-json 与 JSON 无头模式。base bundle 挂载 mesh、工具、命令、controller、协作服务和四个 provider。专用的外部会话行保留 provider 的 native identity，不创建 Harness Session；列表与搜索也不会读取智能体转录正文。

已有验证包括包测试与组合测试；Loader 冒烟检查存储初始化、工具注册和四个 provider；真实存储冒烟通过 adapter 读取已安装的 Codex、Grok 和 Pi 存储。本机未安装 OMP，因此 OMP 用户存储和 CLI RPC 往返尚未验证。假协议测试覆盖 Grok ACP 认证、流式文本与 DSH 一次性审批，以及 Pi RPC 会话绑定、事件投影与原生 abort。之后的源代码变更新增 Pi 与 OMP 的 DSH 确认转发；这些审批路径尚未在当前工作树中运行。上一次记录的 Agent Mesh 与 `ui-agent-mesh` 专项覆盖运行通过 68 个测试文件、942 项测试；纳入的 72 个源文件语句、函数、分支和行覆盖率均为 100%。协作轮询代码及其测试是在该运行后加入的，之后尚未运行；因此这些覆盖率数值描述的是之前的源文件集，不代表当前工作树。Host 与 Client 的 `build:check` 通过；`test:docs` 通过 21/21 项，`doc-sync` 通过 43/43 项。keyless `agent-mesh-approval` snapshot 的 refresh 与 replay 均通过，并记录了被拒绝的 `mesh_run` 请求。四个 provider 的真实模型驱动运行、全仓覆盖率闸门和 Windows 矩阵仍未验证。

上面的映射表有两行落地方式不同，原因如下：

- **凭证。** adapter 报告凭证状态并执行登录/登出，通过面板与 Remote 表面暴露。它们**不**注册为 `ctx.authorization` flow：该接缝的契约是 flow 作为凭证的写入者，并在其 run 期间通过 `ctx.credentials` 提交记录；但凭证存储属于各智能体 CLI，而 mesh 不存储任何凭证（约束 2）。为满足该接缝而向 Harness 凭证库写一条标记记录，等于给智能体已经拥有的事实再造一个归属。
- **模型。** 每个 agent 包现在都会通过 `dsh-llm-pi-ai` 的 `NativeProviderLlmAdapter`，向 `ctx.llm` 注册独立的 `agent-codex`、`agent-grok`、`agent-pi` 或 `agent-omp` provider。读取器从智能体自有用户配置中投影受支持的 endpoint、protocol、model、header 与凭据引用。这不会让 `AgentAdapter.listModels` 变为可用，不会通过 agent CLI 派发 run，不会复用路由读取器无法刷新的 CLI OAuth，也不会把原生凭据复制到 Harness 凭据存储。路由不支持的认证与请求行为会被拒绝。

原生工具代理通过外部 agent 委托任务；它不会导入或直接调用外部工具实现或原生 JSON schema。会报告原生工具名的 adapter 会为已绑定 Agent 贡献最多 `maxProxyTools` 个 DSH 作用域工具，每个工具只接收自由文本 `task`。外部 CLI 会收到任务及使用指定原生工具的指令；每次调用都需要 DSH 审批，并在派发前重新检查当前绑定关系与清单。不报告工具名的 adapter 不会提供代理。文件型原生命令会注册为 Agent 作用域的 DSH 斜杠 handler，格式为 `/agent-<agent>-<command> <task>`。每个 handler 都会重新检查当前能力清单，并排入一条已记录的模型后续消息，写明精确 agent id、原生 `commandName` 和工作目录；模型只会在 DSH 审批后派发。handler 本身不会读取外部模板。`mesh_run.commandName` 通过 DSH 文件系统策略读取声明模板、移除 frontmatter，并将正文放在任务之前。`mesh_capability_read` 已支持模型通过 DSH 文件系统策略请求一个精确声明的 skill 指令、命令模板或上下文文件，单文件上限为 1 MiB。已绑定 Session 会在每个模型步骤前收到原生上下文文件对应的持久化 runtime-context 快照；上下文变更或移除时会替换旧快照。原生 skill 目录也可通过 `dsh-skill-filesystem` 读取，`mesh_capabilities` 会报告其他声明。`mesh_mcp_connect` 在首次使用经 DSH 审批后启用受支持的 MCP server，并对不支持的传输或托管认证 fail closed。Codex 默认 app-server 模式会把运行中提出的命令与文件变更审批请求转交 DSH；Grok ACP 会转发权限请求，并只接受一次性允许或拒绝；Pi RPC 与 OMP `rpc-ui` 会转发 `confirm` 请求，以及仅包含明确一次性允许/拒绝选项的 `select` 请求。`mesh_run`、`mesh_task_dispatch`、`mesh_worktree_remove` 的 DSH 前置审批仍是独立路径，只授权初始工具操作。本机未安装 OMP CLI，因此它的原生会话存储与 RPC UI 流程尚未用真实二进制验证。Harness 会话索引和 Workspace 浏览采用专用外部原生会话行，不会通过 `SessionPersistence` 暴露外部日志。

## Alternatives considered

**让插件保持现状，由 harness 组件通过 guard read 读取它**（在树内组件里写 `ctx.get('mutiAgent')` 之类的可选依赖）。这能保住单一代码库、无需维护 fork，但它无法让 harness 自己的表面跟随绑定的智能体：每一次这样的读取都是发布代码里针对一个通常不存在的服务的分支，客户端 bundle 仍是平行 UI，而插件继续拥有 harness 同时也拥有的事实。这条路正是天花板本身。

**把插件的包以 pinned copy 形式 vendor 进 fork，再加一层薄接缝。** 早先选过、现在否决：它把插件自己的运行时词汇（自己的 context、config、wire envelope）保留在树内，harness 依然无法原生扩展自己的表面，而且还要为一个现已先行的一方代码承担双仓库同步义务。把领域逻辑移植成原生包，既保住格式知识，又不保留那套架构。

**用 `SessionPersistence` provider 呈现外部智能体的会话**，让它们作为普通 Harness Session 出现在所有消费者中。否决这一方案，因为它会用 Harness Session 的身份、header、导出和搜索语义呈现外部日志；对于只被部分投影的记录，这是不受支持的保真度声明。专用的外部原生会话行提供相同的浏览操作，却不会把这些记录包装成 Harness Session。

**一开始就按智能体拆成四个 provider 包。** 若四个 adapter 确会分化，这是对的；在它们共享一套 SPI 时就拆，为时过早。之后拆分是机械工作。

**复用 `ctx.subagents` 承载 mesh 的 runs。** 委派接缝已经能以树外子进程运行 Codex 与 ACP 子代理，但它在设计上是一次性的：只返回子代理选定的答案，把中间流量留在父对话之外，也没有"用户发起的 run"、"worktree" 或"实时事件流"的概念。mesh 的 runs 保持为 mesh 服务；委派接缝保持它自己的语义。

## Acceptance criteria

- mesh 包能在本仓库的严格 TypeScript 设置下编译，并通过专项测试和逐文件覆盖率闸门。
- 每个 adapter 都能探测其二进制、列出并读取该智能体真实的会话存储、报告凭证状态，并派发一次原生 run；其 stdout 事件流被投影为统一事件，未知原生类型被保留。OMP 使用 RPC，并用原生 `abort` 中断回合。
- mesh 的持久化绑定是一个 mesh 拥有的 storage domain：不改 session 格式、不改 session event、不改 session-query schema；上游 harness 读取同一个 home 时只会看到它自己的数据。
- 操作可作为原生工具触达；`mesh_run`、`mesh_task_dispatch` 和 `mesh_worktree_remove` 在派发或删除前经过 Harness approval 闸门。
- 已绑定 Session 通过持久化 runtime-context 快照接收原生上下文文件，文件型原生命令通过 DSH 作用域 handler 排入带精确 `commandName` 的已记录模型任务。
- 完整交付还需通过全仓覆盖率闸门、录制会话 snapshot、每个 provider 的真实模型驱动运行、Windows 验证、每个声明原生中断能力的 adapter 的中断测试，以及每条受支持运行时审批路径的转发测试。
- 对现有表面造成外部可感知破坏性变更时，在完整落地阶段补一条 upgrade guide。

## Risks

- **移植保真度。** 插件的 parser 编码的是观察到的存储格式；忠实移植仍需每个智能体的 fixture 测试，而 OMP 的存储行为在插件里也从未对真实存储验证过。当前真实 CLI 往返只覆盖初始会话记录。adapter 必须写明哪些结论已验证。
- **范围。** 插件九个包约 5.7 万行。整体移植是多阶段工作；本 note 的拓扑是框架，每个能力各自带测试落地。
- **与 subagent 接缝重复。** Codex 已经能作为 subagent provider 运行。mesh 不得长出第二套、且会分叉的 Codex 集成；两者重叠之处，mesh 的 adapter 负责读取 Codex 自己的会话存储，subagent provider 仍是委派路径。
- **覆盖率。** 所有 Agent Mesh 包与面板的专项覆盖率均为 100%；全仓覆盖率闸门和 Windows 矩阵尚未重跑。
