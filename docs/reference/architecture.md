# 架构说明

[返回文档中心](../README.md)

## 系统边界

SztuCode 是本地优先的双进程 Agent 系统：常驻 Python daemon 管理会话和运行，TUI、桌面端与 CLI 通过 TCP 上的 NDJSON/JSON-RPC 2.0 连接。客户端负责交互和展示，Agent 执行状态以 daemon 为准。

```text
Tauri Desktop ─┐
Textual TUI ───┼─ TCP / NDJSON / JSON-RPC 2.0 ─ sztu-code daemon
CLI ───────────┘                                  │
                                                  ├─ Session / Workspace
                                                  ├─ Agent Runner / Loop
                                                  ├─ LLM Provider
                                                  ├─ Tools / Permissions
                                                  ├─ Skills / Subagents / MCP
                                                  ├─ Memory / Compaction
                                                  └─ EventBus / Trace
```

## 进程与客户端

### `sztu-code`

daemon 入口位于 `src/sztu_code/core/app.py`，负责：

- 加载配置和日志；
- 初始化 Provider、Session Store、Workspace Manager 和 Permission Manager；
- 注册 JSON-RPC handler；
- 启动 TCP Server；
- 执行 Agent run 并广播事件；
- 在退出时取消并等待后台任务。

### `sztucode` / `sztu-tui`

Textual TUI 是终端产品入口。`sztucode` 接受项目目录、处理信任并在需要时自动启动 daemon；`sztu-tui` 直接连接已配置的 daemon。

### Tauri Desktop

`desktop/` 使用 Tauri 2、Vue 3 和 TypeScript。Rust 层负责原生窗口、目录选择和受控 TCP 桥；前端负责工作区、会话、执行时间线、权限、文件预览和 Diff 审阅。

### `sztu`

CLI 用于连通性检查、脚本调用和调试，不承载完整交互体验。

## 请求与事件链路

1. 客户端发送 JSON-RPC 命令，例如 `session.send_message`。
2. Socket Server 解析 envelope，并用 Pydantic 校验参数。
3. `CoreApp` handler 操作会话或启动后台 run。
4. `AgentRunner` 构建上下文、工具、权限和 Provider。
5. `AgentLoop` 迭代模型响应与工具结果。
6. EventBus 发布 run、step、tool、permission、LLM 和 change 事件。
7. IPC Broadcaster 将订阅事件推送到客户端。
8. 客户端按 `session_id` / `run_id` 合并实时事件和历史状态。

命令和事件的字段定义见自动生成的 [Wire Protocol](wire-protocol.md)。

## Agent 运行时

### 上下文

Runner 组合系统提示词、全局与项目 context、会话消息、notes 和当前目标。上下文预算由 `core/compact/` 计算；达到阈值时可截断工具结果并执行压缩。

### 工具

内置工具通过 Tool Registry 注册。工具参数使用 Pydantic 校验，运行时根据工具类型和具体输入计算权限：

- `read_only`：读取、列表和搜索；
- `workspace_write`：受工作区约束的写入和编辑；
- `danger_full_access`：Shell 等高风险能力。

工具返回统一的成功、输出和错误分类，调用链通过事件对客户端可见。

### 权限

Permission Manager 结合当前模式、持久化策略、工具权限和用户响应决定是否执行。审批状态通过 `permission.*` 事件广播，响应使用 `permission.respond`。

### Skills、Subagents 与 MCP

- Skills 从项目、用户和内置目录发现，通过描述匹配或显式调用注入工作流。
- Subagent 使用独立 run ID 和受限角色执行子任务，结果回填父运行。
- MCP 将外部 stdio/TCP Server 的能力适配为统一工具。

### Planner、Coder、Tester、Reviewer 工作流

`run_workflow` 先让只读 Planner 输出含依赖、负责人、完成条件和文件范围的结构化 DAG，再由 daemon 调度器按依赖执行 Coder、Tester 和 Reviewer：

- Coder 只获得读写文件工具，不获得 Shell；范围内编辑走普通写权限，越过 Planner 分配范围时升级为 `danger_full_access`。`normal`/`accept_edits` 会请求用户审批，`auto` 直接放行，批准后的范围升级写入交接证据；
- Tester 只读工作区并独立运行命令，必须提交命令、关键原始输出和结论；
- Reviewer 只读 Diff、测试和安全证据，必须给出 `accept` 或 `return`；
- DAG 调度器统一限制并发、嵌套深度、Token、墙钟和重试预算，并把失败、取消和超时传播到依赖任务与父工作流；
- `workflow.*` 事件与其他 EventBus 事件共用 `events.jsonl`、IPC 和 daemon Trace，TUI 与桌面时间线均可回放任务和交接证据。

范围升级仍受工作区根目录约束；`auto` 不允许写出当前 workspace。

## 数据持久化

主要本地数据：

| 路径 | 所有者 | 内容 |
| --- | --- | --- |
| `~/.sztu/sessions/` | Session Store | 会话、消息、notes、runs 和事件 |
| `~/.sztu/workspaces.json` | Workspace Manager | 最近和归档工作区 |
| `~/.sztu/policy.toml` | Permission Manager | 持久化允许/拒绝策略 |
| `~/.sztu/trusted-projects.json` | Trust | 已信任项目 |
| `~/.sztu/traces/daemon.jsonl` | Trace Writer | IPC、Event 和 LLM trace |
| `~/.sztu/client-settings.json` | 客户端设置 | Provider、模型、端点、凭据和权限模式 |

会话与 trace 可能包含源码、提示词和模型响应，应按敏感数据处理。

## 关键不变量

- 协议边界使用类型化模型，不让客户端猜测字段。
- daemon 是任务状态的唯一事实来源；客户端状态必须可从历史和事件恢复。
- 工作区工具不得越过已解析的工作区根目录。
- 高风险动作必须经过权限策略，模式切换不能绕过底层分类。
- 角色分配范围不是第二套静态沙箱；越界必须进入权限升级并留下 Trace 证据。
- 事件关联键和顺序必须足够支持断线重连、去重和回放。
- 生成的 Wire Protocol 必须与代码保持同步。

## 扩展入口

| 目标 | 主要位置 |
| --- | --- |
| 新命令/事件 | `core/bus/`、`core/app.py`、客户端 SDK |
| 新工具 | `core/tools/` |
| 新 Provider | `core/llm/` |
| 新权限规则 | `core/permissions/` |
| 新 Skill | `.sztu/skills/`、`~/.sztu/skills/` 或内置 Skills |
| 新 Agent 角色 | `core/agents/` |
| 新 MCP 接入 | `core/mcp/` 与配置文件 |

实现细节和提交标准见 [开发环境](../development/development.md) 与 [贡献指南](../CONTRIBUTING.md)。
