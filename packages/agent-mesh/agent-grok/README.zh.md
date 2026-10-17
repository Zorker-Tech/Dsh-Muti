---
description: "agent-mesh 的 Grok Build adapter：`grok` 与 `$GROK_HOME` 检测、只读会话存储与凭据、已配置模型路由，以及原生 ACP 运行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-grok

[English](README.md) | 中文

## 概述

挂载本包后，Harness 可以使用 Grok Build CLI 和它自己的会话。它读取有界 transcript 与原生 todo/plan 状态、按 scope 键控的凭据，通过 `ctx.llm` 暴露已配置的模型路由，并默认通过 ACP 运行 prompt，也可按需使用 streaming-json。适配器读取不会写入 Grok 文件；只有检测、凭据流程和运行派发会启动进程。Grok 不支持无头 API key 登录，因此登录请求会返回指引。

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

把该 adapter 挂在 mesh 与 LLM 服务之后；它注入 `agentMesh`、`llm`、`fs` 与 `subprocess`。

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

在运行 Grok Build CLI、且希望会话留在 Grok 自己存储中的机器上选择本 adapter。它是唯一能列出、读取或派发 Grok 会话的包，并且在被读取或派发之前保持惰性；没有该二进制的机器仍可挂载它，并会报告 `installed: false` 及原因。独立的 `ctx.llm` provider 会读取已配置的模型 endpoint，不启动 `grok models`。需要其他外部智能体的组合也可以挂载对应 adapter。

### Minimal configuration

上面的行在完全不带 `config` 时也可用：检测会搜索 `PATH` 与已知安装目录，home 依次回退到 `$GROK_HOME` 与 `~/.grok`，凭据文件依次回退到 `$GROK_AUTH_PATH` 与 `<home>/auth.json`。这里列出全部可接受的字段。

| Field | Default | Meaning |
|---|---|---|
| `binaryPath` | unset | 显式 `grok` 可执行文件，先于 `PATH` 与已知安装目录尝试。 |
| `homeDir` | unset | 显式 Grok home，先于 `$GROK_HOME` 与 `~/.grok` 尝试。 |
| `env` | `{}` | 本 adapter 启动的每个子进程的额外环境变量。 |
| `runMode` | `duplex-protocol` | `duplex-protocol` 使用 Grok ACP；`headless-exec` 使用 `grok -p --output-format streaming-json`。 |
| `interruptGraceMs` | `10000` | ACP 会话取消后，在终止进程前等待的时间。 |
| `model` | unset | 未被运行指定的模型，使用 Grok 自己的命名。 |
| `sandbox` | unset | 未被运行指定的沙箱 profile；取 `off`、`workspace`、`devbox`、`read-only`、`strict` 之一。 |
| `approval` | unset | 未被运行指定的审批模式；取 `default`、`acceptEdits`、`auto`、`dontAsk`、`bypassPermissions`、`plan` 之一。 |
| `maxTurns` | unset | 每次派发都传入的 `--max-turns` 值；未设置时沿用 Grok 自身的限制。 |
| `reasoningEffort` | unset | 每次派发都传入的 `--reasoning-effort` 值。 |
| `noPlan` | `false` | 每次派发都传入 `--no-plan`。 |
| `noSubagents` | `false` | 每次派发都传入 `--no-subagents`。 |
| `disableWebSearch` | `false` | 每次派发都传入 `--disable-web-search`。 |
| `timeoutMs` | `0` | 默认运行预算（毫秒）；`0` 表示运行不受时限。 |
| `transcriptTailBytes` | `1048576` | 投影 transcript 时读取的 `updates.jsonl` 尾部窗口。 |
| `loginTimeoutMs` | `300000` | 委托的 `grok login` 的挂钟预算，该流程会等待人工操作。 |
| `logoutTimeoutMs` | `30000` | 委托的 `grok logout` 的挂钟预算。 |
| `versionProbeTimeoutMs` | `10000` | `--version` 检测探测的挂钟预算。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

该 adapter 是 mesh 的 `AgentHost` 的纯函数：`detect.ts` 解析二进制并探测 `--version`，`sessions.ts` 解析 home、会话根与凭据路径，并读取每个会话目录的 `summary.json`，`transcript.ts` 投影 `updates.jsonl`（回退到 `chat_history.jsonl`），`tasks.ts` 读取 `plan.json` 与 `plan_mode.json`，`auth.ts` 分类按 scope 键控的存储并委托 `grok login`/`logout`，`run.ts` 拥有 streaming-json 路径，`acp-run.ts` 拥有 ACP 认证、会话加载、权限决策与取消。插件的 `apply` 从 Cordis 上下文构建宿主并把 adapter 注册为一个 effect。检测只解析一次并在 adapter 生命周期内缓存。

| File | What it owns |
|---|---|
| `src/index.ts` | `grok` adapter：缓存的检测、能力声明、传输清单，以及注册到 `ctx.agentMesh`。 |
| `src/detect.ts` | 二进制解析、`--version` 探测，以及沙箱与审批词汇表。 |
| `src/sessions.ts` | home、会话根与凭据路径解析；`summary.json` 投影；`cwd` 标记。 |
| `src/transcript.ts` | 把 `updates.jsonl` 与 `chat_history.jsonl` 投影为 mesh 消息，并施加 16 KiB 字段上限。 |
| `src/tasks.ts` | `plan.json` 的 todos 与 `plan_mode.json` 的生命周期状态。 |
| `src/auth.ts` | 按 scope 键控的凭据分类、环境变量优先级、委托的 `grok login`/`logout`，以及脱敏。 |
| `src/llm-models.ts` | 只读投影用户模型表、API 后端、headers 与 API key 引用。 |
| `src/run.ts` | `grok -p` streaming-json 的 argv、事件流映射、取消与退出分类。 |
| `src/acp-run.ts` | `grok agent stdio` 认证、会话加载、权限决策、事件投影与进程取消。 |
| `src/config.ts` | `GrokAdapterConfig`/`ResolvedGrokConfig` 的拆分与全部默认值。 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [mesh 接缝](../mesh/README.zh.md) — 本 adapter 投影到的注册表与运行词汇。
- [mesh 工具](../tools/README.zh.md) — 经本 adapter 读取的面向模型的工具。
- [Group README](../README.zh.md) — 接缝、各 adapter、工具与 controller 如何配合。
- [Agent mesh 子系统](../../../docs/subsystems/agent-mesh.zh.md) — 规范类型与 adapter 契约。
- [原生多智能体集成决策](../../../.agents/notes/proposed/architecture/2026-10-16-native-agent-mesh-in-dsh.zh.md) — 该家族有意舍弃的内容。

-----

<a id="model-experience"></a>
## 模型体验

### Adapter records

#### What the model sees

mesh 工具保持独立：本包不添加 prompt 文本或工具；这些工具仍通过 [`@deepseek-ai/dsh-agent-mesh-tools`](../tools/README.zh.md) 访问 `AgentAdapter`。它还会向 `ctx.llm` 注册 `agent-grok`；用户选择 Grok 用户级 `config.toml` 中的模型后，请求会直接发送到该模型配置的 endpoint。

#### Token effect

自身没有。`mesh_*` 工具调用的 token 成本属于工具包的结果内容；本 adapter 不向请求添加任何自己的文本。派发运行的结果同样只经 `mesh_run`/`mesh_runs` 到达模型。

#### KV Cache effect

无。本包不贡献任何模型请求内容；进入请求的内容由 mesh 工具包拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 默认的 `duplex-protocol` 运行使用 `grok --no-auto-update agent stdio`；`headless-exec` 选择 `grok -p --output-format streaming-json`。设置 `XAI_API_KEY` 或 `GROK_CODE_XAI_API_KEY` 时，ACP 认证使用其声明的 `xai.api_key`；否则使用其声明的 `cached_token`。
- resume 需要 CLI 声明 `session/load`，请求模型必须匹配一个声明的 ACP 选择器。ACP 会在发送 prompt 前拒绝 CLI 专属运行选项与非默认审批模式；这些选项请使用 `headless-exec`。
- ACP 权限请求使用 DSH 审批，并且只接受一次性允许或拒绝。协议失败会在运行结束前中止待处理的权限请求。`interrupt` 可用；取消会发送 `session/cancel`，若进程未退出则在 `interruptGraceMs` 后终止它。
- `resolveMcpServer` 会为 `mesh_mcp_connect` 读取用户 `config.toml` 与项目 `.grok/config.toml` 层。DSH 只会在首次使用审批后启动受支持的 stdio 或 Streamable HTTP server；SSE 与托管 OAuth 条目会 fail closed。
- Grok 没有无头 `--api-key` 登录，因此 `api-key` 流程返回指引（设置 `XAI_API_KEY`，或运行 `grok login`），而 `interactive` 流程也返回指引，因为 loopback 流程需要浏览器；只有 `device-code` 与 `oauth-loopback` 委托给 CLI。被委托的登录会一直保持到它退出，因此打印出的 URL 或设备码是在流程结束后报告，而不是出现时即时流式给出。
- 假进程测试覆盖 ACP 认证、流式文本、一次性 DSH 审批及审批等待期间进程退出；没有执行真实 Grok 模型运行。
- transcript 读取是 `updates.jsonl` 的有界尾部窗口（默认 1 MiB）；该文件缺失或为空时改用派生的 `chat_history.jsonl` 模型消息缓存，并在 `notes` 中声明这一替换；无法解析的记录被跳过并计数。
- 会话列出会读取每个会话目录的 `summary.json` 且不施加扫描上限，与 Pi 和 OMP 的 adapter 不同；非常大的存储会为每个会话付一次 summary 读取，而无法读取的 summary 会产生一行 `unreadable` 并声明原因。
- `AgentAdapter.listModels` 仍不可用，`capabilities().listModels` 为 `false`；它与 `ctx.llm` 不同，后者会从用户 `config.toml` 读取 `[model.*]` 与 `[model_providers.*]` 路由，不运行 CLI 探测。
- 直连模型路由映射 Grok 的 `chat_completions`、`responses`、`messages` 后端、endpoint、上下文/输出上限、静态或环境 headers 以及 `api_key`/`env_key`。查询参数、认证 provider 命令、模型采样设置与 Grok 登录 token 不受支持；可使用 API key 或无需 key 的 endpoint。
- 凭据状态只报告选中的一个条目：账号与团队名被并入自由文本 `detail`，adapter 无法解析的存储报告为 `misconfigured`，而不是捏造已登出状态，且 adapter 从不从存储中读出秘密材料。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

假 ACP 对端在不发起模型请求的情况下测试认证、流式文本和一次性 DSH 权限决策。

</details>
