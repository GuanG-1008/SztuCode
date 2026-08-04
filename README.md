# SztuCode

> 一个本地运行、事件驱动的 AI 编程 Agent。它不只封装模型 API，而是实现了从会话、工具调用、权限审批到上下文管理和可观测性的完整运行时。

[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![Vue](https://img.shields.io/badge/Vue-3-42B883?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![License](https://img.shields.io/badge/License-MIT-2F855A)](LICENSE)

SztuCode 面向本地代码仓库工作：用户从 TUI、桌面工作台或 CLI 发起任务，后台 daemon 负责运行 Agent Loop、调用工具、管理权限，并通过 JSON-RPC 事件流持续反馈执行状态。

项目适合用于：

- 学习 AI 编程 Agent 的完整工程链路；
- 构建可审计、可扩展的本地 Agent 运行时；
- 研究工具权限、上下文压缩、Skills、Subagents 与 MCP 集成；
- 在真实仓库中体验多轮对话、文件修改和 Git 变更审阅。

> [!IMPORTANT]
> SztuCode 目前处于快速开发阶段，接口和桌面界面仍可能调整。请勿在不了解权限模式的情况下，让 Agent 操作包含重要未提交内容的仓库。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| Agent Loop | 基于 ReAct 的多步推理、工具调用、结果回填与终止控制 |
| 多种客户端 | Textual TUI、Tauri + Vue 桌面工作台，以及用于调试和自动化的 CLI |
| 双协议模型接入 | 支持 Anthropic API 与 OpenAI-compatible API，可连接兼容服务商 |
| 工作区工具 | 文件读取、目录浏览、搜索、写入、精确编辑与受控 Shell 执行 |
| 权限系统 | 标准审批、计划模式、允许编辑和自动执行四种运行模式 |
| 会话与记忆 | 持久化会话、分层记忆、历史恢复和跨轮上下文 |
| 上下文治理 | token 水位统计、工具结果截断、自动或手动压缩 |
| 扩展机制 | Skills、Subagents 与 MCP 外部工具统一接入 |
| 可观测性 | IPC、EventBus、LLM 三层 trace，支持筛选、跟踪和回放 |
| 变更审阅 | 桌面端展示任务产生的文件变化，支持 Diff 审阅、接受与回退 |

## 系统架构

SztuCode 使用 daemon 与客户端分离的双进程架构。Agent 任务不会因为某个客户端退出而丢失，多个客户端也可以共享同一套会话和事件状态。

```text
┌──────────────────────────────────────────────────────────────┐
│ Clients                                                      │
│  Tauri Desktop          Textual TUI          CLI             │
└───────────────┬──────────────────┬───────────────┬───────────┘
                └──────────────────┼───────────────┘
                                   │ TCP / NDJSON
                                   │ JSON-RPC 2.0
┌──────────────────────────────────▼───────────────────────────┐
│ sztu-code daemon                                             │
│                                                              │
│ Session → Agent Runner → Agent Loop → LLM Provider           │
│                         │                                    │
│                         ├─ Tool Registry → Permission Manager│
│                         ├─ Skills / Subagents / MCP           │
│                         └─ Memory / Compaction                │
│                                                              │
│ EventBus → IPC events → clients                              │
│ Trace    → IPC / Event / LLM records                         │
└──────────────────────────────────────────────────────────────┘
```

默认监听地址为 `127.0.0.1:7437`。所有 IPC 消息都使用 Pydantic v2 模型定义，协议详情见 [Wire Protocol](docs/reference/wire-protocol.md)。

## 快速开始

### 环境要求

- Python `3.12.x`
- [uv](https://docs.astral.sh/uv/)
- 一个 Anthropic 或 OpenAI-compatible API 凭据
- 可选：Node.js 20+ 与 Rust，用于开发桌面工作台

### 1. 安装依赖

```bash
git clone https://github.com/rojim666/SztuCode.git
cd SztuCode
uv sync
```

### 2. 配置模型

复制环境变量模板：

```bash
cp .env.example .env
```

Anthropic 示例：

```dotenv
SZTU_LLM_PROVIDER=anthropic
SZTU_LLM_DEFAULT_MODEL=<your-provider-model-id>
ANTHROPIC_API_KEY=<your-api-key>
# ANTHROPIC_BASE_URL=https://api.anthropic.com
```

OpenAI-compatible 示例：

```dotenv
SZTU_LLM_PROVIDER=openai
SZTU_LLM_DEFAULT_MODEL=<your-provider-model-id>
OPENAI_API_KEY=<your-api-key>
OPENAI_BASE_URL=https://api.example.com
```

不要提交 `.env`。SztuCode 不会替你选择默认模型，`SZTU_LLM_DEFAULT_MODEL` 必须使用服务商实际提供的模型 ID。

### 3. 启动 TUI

推荐直接在目标项目目录启动：

```bash
uv run sztucode /path/to/your/project
```

`sztucode` 会在需要时自动拉起 daemon。首次打开目录时需要确认信任；也可以显式选择：

```bash
uv run sztucode . --trust       # 信任当前目录
uv run sztucode . --read-only   # 以只读模式打开
uv run sztucode . --replay RUN_ID
```

如果希望分别管理进程：

```bash
# 终端 1
uv run sztu-code

# 终端 2
uv run sztu-tui
```

### 4. 使用 CLI

CLI 主要用于连通性检查、脚本调用和调试：

```bash
uv run sztu ping
uv run sztu run --goal "分析当前项目并修复测试失败"
uv run sztu chat
uv run sztu core status
uv run sztu trace --follow
```

查看所有命令：

```bash
uv run sztu --help
uv run sztucode --help
```

## 桌面工作台

`desktop/` 是基于 Tauri 2 + Vue 3 的图形客户端，提供项目与会话管理、实时执行时间线、权限审批、文件浏览、代码预览和 Git 变更审阅。

桌面端目前需要单独启动 Python daemon：

```bash
# 终端 1：项目根目录
uv run sztu-code

# 终端 2
cd desktop
npm install
npm run tauri dev
```

桌面端构建与验证：

```bash
cd desktop
npm run build
npm run test:visual

cd src-tauri
cargo check
```

## 配置

配置按以下优先级合并，后者覆盖前者：

```text
内置默认值
  → ~/.sztu/config.toml
  → .sztu/config.toml
  → ~/.sztu/client-settings.json
  → .env
  → 系统环境变量
```

如果设置 `SZTU_CONFIG`，则使用指定 TOML 文件替代默认的两个 TOML 路径。桌面设置文件用于保存 Provider、模型、端点、凭据和权限模式，请注意它是本机明文配置。

常用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SZTU_HOST` | `127.0.0.1` | daemon 监听地址 |
| `SZTU_PORT` | `7437` | daemon 监听端口 |
| `SZTU_LOG_LEVEL` | `INFO` | 日志级别 |
| `SZTU_LOG_FILE` | `~/.sztu/logs/core.log` | daemon 日志路径 |
| `SZTU_LOG_FORMAT` | `text` | `text` 或 `json` |
| `SZTU_LLM_PROVIDER` | `anthropic` | `anthropic` 或 `openai` |
| `SZTU_LLM_DEFAULT_MODEL` | 无 | 服务商模型 ID，必须配置 |
| `SZTU_LLM_CONTEXT_WINDOW` | 自动 | 显式指定上下文窗口大小 |
| `SZTU_MAX_STEPS` | `20` | 单次 Agent 运行最大步数 |
| `SZTU_PERMISSION_MODE` | `normal` | `normal`、`plan`、`accept_edits` 或 `auto` |
| `SZTU_COMPACT_THRESHOLD` | `0` | 自动压缩阈值；`0` 表示关闭 |
| `SZTU_TRACE_ENABLED` | `true` | 是否记录系统 trace |
| `SZTU_TRACE_FILE` | `~/.sztu/traces/daemon.jsonl` | trace 文件路径 |

完整模板见 [.env.example](.env.example)，详细说明见 [配置参考](docs/getting-started/configuration.md)。

TOML 示例：

```toml
[core]
host = "127.0.0.1"
port = 7437

[logging]
level = "INFO"
file = "~/.sztu/logs/core.log"
format = "text"

[agent]
max_steps = 20

[llm]
provider = "anthropic"
default_model = "<your-provider-model-id>"

[permission]
mode = "normal"
timeout_s = 60

[compaction]
auto_threshold = 0.85
tool_result_limit = 8000
tool_result_keep = 4000
```

## 权限模式

| 模式 | 行为 |
| --- | --- |
| `normal` | 按工具风险和持久化策略请求审批 |
| `plan` | 面向分析与规划，限制产生修改的操作 |
| `accept_edits` | 自动接受受控文件编辑，其他高风险操作仍需审批 |
| `auto` | 尽可能自动执行；只应在可信且可恢复的工作区使用 |

无论使用哪种模式，都建议先提交或备份重要修改，并在独立分支上运行 Agent。

## 项目结构

```text
SztuCode/
├─ src/sztu_code/
│  ├─ core/          # daemon、Agent Loop、协议、工具、权限与扩展系统
│  ├─ tui/           # Textual 终端界面
│  ├─ cli/           # 命令行客户端
│  └─ desktop/       # 兼容桌面入口
├─ desktop/          # Tauri 2 + Vue 3 桌面工作台
├─ tests/            # 单元测试与集成测试
├─ eval/             # 轨迹分析与 SWE-bench 评估工具
├─ scripts/          # 协议文档等工程脚本
├─ docs/             # 使用、贡献、架构、运维与参考文档
└─ scripts/          # 协议生成等工程脚本
```

核心模块：

| 路径 | 职责 |
| --- | --- |
| `core/bus/` | JSON-RPC envelope、命令和事件模型 |
| `core/transport/` | TCP NDJSON 服务端、客户端和事件广播 |
| `core/loop.py` | Agent 主循环与工具调用编排 |
| `core/llm/` | Anthropic / OpenAI Provider 抽象 |
| `core/tools/` | 工具注册、参数校验、调用与错误分类 |
| `core/permissions/` | 权限策略、审批状态和拒绝追踪 |
| `core/session/` | 会话模型、存储与恢复 |
| `core/compact/` | 上下文预算和压缩 |
| `core/skills/` | Skills 发现与加载 |
| `core/subagent/` | 子 Agent 注册与执行 |
| `core/mcp/` | MCP 客户端、服务端与工具适配 |
| `core/trace/` | IPC、事件和 LLM 调用链追踪 |

## 开发与验证

安装开发依赖后运行：

```bash
uv sync

uv run ruff check src tests scripts
uv run mypy src
uv run pytest tests/unit -v
uv run pytest tests/integration -v
uv run pytest tests/ -v
```

协议模型发生变化时，必须重新生成并检查文档：

```bash
uv run python scripts/gen_protocol_doc.py
uv run python scripts/gen_protocol_doc.py --check
```

也可以使用 Makefile 中的组合命令：

```bash
make lint
make test
make integration-test
make docs
make verify-s0
```

## 扩展 SztuCode

- **新增协议命令或事件**：在 `core/bus/commands.py` 或 `core/bus/events.py` 添加模型，扩展联合类型，并重新生成 `docs/reference/wire-protocol.md`。
- **新增内置工具**：实现 `core/tools/` 的工具接口，声明参数模型和权限等级，再注册到 Tool Registry。
- **新增 Skill**：提供包含 front matter 的 `SKILL.md`，由 Skill Loader 自动发现并注入运行上下文。
- **接入 MCP**：在 TOML 的 `[[mcp.servers]]` 中配置 `stdio` 或 `tcp` 服务。
- **新增模型后端**：实现 `core/llm/` 的 Provider 接口，保持上层消息和工具调用语义一致。

相关文档：

- [文档中心](docs/README.md)
- [贡献指南](docs/CONTRIBUTING.md)
- [架构说明](docs/reference/architecture.md)
- [IPC 协议](docs/reference/wire-protocol.md)
- [测试指南](docs/development/testing.md)
- [评估指南](docs/guides/evaluation.md)
- [运维手册](docs/operations/runbook.md)

## 安全说明

- Agent 可以读取、修改和执行工作区中的内容，请仅信任你了解的目录。
- API Key 应保存在 `.env`、系统环境变量或本机客户端设置中，不要提交到 Git。
- `auto` 模式会减少交互式确认，应配合 Git 分支、备份和最小权限环境使用。
- Trace 可能包含提示词、模型响应和工具结果；共享日志前请先检查敏感信息。

## 贡献

欢迎通过 Issue 和 Pull Request 提交问题、设计建议和实现改进。提交代码前请确保：

1. 变更范围清晰，并包含与风险相匹配的测试；
2. `ruff`、`mypy` 和相关 `pytest` 用例通过；
3. 协议模型变化已同步更新 `docs/reference/wire-protocol.md`；
4. 不提交 `.env`、API Key、运行日志和本地评估产物。

详细流程与项目治理：

- [贡献指南](CONTRIBUTING.md)
- [社区行为准则](CODE_OF_CONDUCT.md)
- [项目路线图](docs/ROADMAP.md)
- [安全政策](SECURITY.md)
- [文档中心](docs/README.md)

## License

本项目使用 [MIT License](LICENSE)。
