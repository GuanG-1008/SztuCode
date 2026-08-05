# 配置参考

[返回文档中心](../README.md)

## 配置优先级

SztuCode 按以下顺序加载配置，后者覆盖前者：

```text
内置默认值
  → ~/.sztu/config.toml
  → .sztu/config.toml
  → ~/.sztu/client-settings.json
  → .env
  → 系统环境变量
```

设置 `SZTU_CONFIG` 后，仅使用指定 TOML 文件替代默认的全局和项目 TOML。桌面设置文件会保存 Provider、模型、权限模式、Base URL 和 API Key；它是本机明文文件，应限制访问权限。

## Provider 配置

Anthropic：

```dotenv
SZTU_LLM_PROVIDER=anthropic
SZTU_LLM_DEFAULT_MODEL=<your-provider-model-id>
ANTHROPIC_API_KEY=<your-api-key>
# ANTHROPIC_BASE_URL=https://api.anthropic.com
```

OpenAI-compatible：

```dotenv
SZTU_LLM_PROVIDER=openai
SZTU_LLM_DEFAULT_MODEL=<your-provider-model-id>
OPENAI_API_KEY=<your-api-key>
OPENAI_BASE_URL=https://api.example.com
```

### DeepSeek V4 Pro（校园网）

桌面端模型选择器内置 `DeepSeek V4 Pro(校园网)`。在本机 `.env` 中配置：

```dotenv
SZTU_CAMPUS_DEEPSEEK_API_KEY=<your-campus-api-key>
```

该选项固定使用 `deepseek-v4-pro` 和 `https://apiai.sztu.edu.cn/v1`，仅在校园网或已连接学校 VPN 时可用。

opencode Zen 免费模型（**免 key**，OpenAI 兼容端点 `https://opencode.ai/zen/v1`）：

```dotenv
SZTU_LLM_PROVIDER=openai
SZTU_LLM_DEFAULT_MODEL=deepseek-v4-flash-free
OPENAI_BASE_URL=https://opencode.ai/zen/v1
# 免 key：不要设置 OPENAI_API_KEY
```

可选免费模型（实测可用）：`deepseek-v4-flash-free`、`ling-3.0-flash-free`、`nemotron-3-ultra-free`、`north-mini-code-free`、`longcat-2.0-free`、`mimo-v2.5-free`、`laguna-s-2.1-free`。端点直接可达（无需代理），支持流式与工具调用；注意有速率限制，适合个人日常使用。

SztuCode 不内置厂商模型 ID。模型名称、上下文窗口和端点必须与实际服务商一致。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SZTU_CONFIG` | 未设置 | 显式 TOML 路径 |
| `SZTU_HOST` | `127.0.0.1` | daemon 监听地址 |
| `SZTU_PORT` | `7437` | daemon 监听端口 |
| `SZTU_LOG_LEVEL` | `INFO` | 日志级别 |
| `SZTU_LOG_FILE` | `~/.sztu/logs/core.log` | daemon 日志路径；空字符串表示不写文件 |
| `SZTU_LOG_FORMAT` | `text` | `text` 或 `json` |
| `SZTU_LLM_PROVIDER` | `anthropic` | `anthropic` 或 `openai` |
| `SZTU_LLM_DEFAULT_MODEL` | 空 | 服务商模型 ID |
| `SZTU_LLM_CONTEXT_WINDOW` | Provider 默认 | 正整数上下文窗口 |
| `SZTU_MAX_STEPS` | `20` | 单次运行最大 Agent 步数 |
| `SZTU_PERMISSION_MODE` | `normal` | `normal`、`plan`、`accept_edits`、`auto` |
| `SZTU_PERMISSION_TIMEOUT_S` | `60` | 审批超时秒数；`0` 表示不超时 |
| `SZTU_COMPACT_THRESHOLD` | `0` | 自动压缩阈值，范围 0–1；`0` 关闭 |
| `SZTU_COMPACT_TOOL_LIMIT` | `8000` | 工具结果截断阈值 |
| `SZTU_COMPACT_TOOL_KEEP` | `4000` | 截断后保留字符数 |
| `SZTU_TRACE_ENABLED` | `true` | 是否记录 trace |
| `SZTU_TRACE_FILE` | `~/.sztu/traces/daemon.jsonl` | trace 文件路径 |
| `SZTU_TRACE_INCLUDE_LLM_PAYLOAD` | `true` | 是否记录完整 LLM payload |

## TOML 示例

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
context_window = 128000

[trace]
enabled = true
file = "~/.sztu/traces/daemon.jsonl"
include_llm_payload = false

[permission]
mode = "normal"
timeout_s = 60

[compaction]
auto_threshold = 0.85
tool_result_limit = 8000
tool_result_keep = 4000
```

## MCP Server

stdio 示例：

```toml
[[mcp.servers]]
name = "example"
transport = "stdio"
command = "example-mcp-server"
args = ["--stdio"]

[mcp.servers.env]
EXAMPLE_MODE = "local"
```

TCP 示例：

```toml
[[mcp.servers]]
name = "example-tcp"
transport = "tcp"
host = "127.0.0.1"
port = 3000
```

不要运行来源不明的 MCP Server。stdio 服务继承 daemon 启动环境中显式传入的配置，并可能获得本机访问能力。

## 权限模式

| 模式 | 用途 |
| --- | --- |
| `normal` | 根据风险和已保存策略逐次审批 |
| `plan` | 分析和规划，不执行产生修改的操作 |
| `accept_edits` | 自动允许受控编辑，其他高风险动作仍审批 |
| `auto` | 尽可能自动执行，仅用于可信且可恢复环境 |

持久化策略位于 `~/.sztu/policy.toml`。修改或共享该文件前应检查是否扩大了工具权限。

## 本地数据

| 路径 | 内容 |
| --- | --- |
| `~/.sztu/config.toml` | 全局配置 |
| `.sztu/config.toml` | 项目配置 |
| `~/.sztu/client-settings.json` | 桌面端 Provider、凭据和权限设置 |
| `~/.sztu/trusted-projects.json` | 已信任目录 |
| `~/.sztu/policy.toml` | 持久化权限策略 |
| `~/.sztu/sessions/` | 会话、消息、笔记和运行记录 |
| `~/.sztu/workspaces.json` | 最近工作区索引 |
| `~/.sztu/logs/` | daemon 与 TUI 日志 |
| `~/.sztu/traces/` | 系统 trace |

这些文件可能包含敏感内容，备份、共享或删除前请先确认影响。
