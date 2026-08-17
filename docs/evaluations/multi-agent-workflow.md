# 多智能体工作流验收与固定场景基线

[返回文档中心](../README.md)

Issue #18 的合并门禁使用 `eval/workflow/scenarios.json` 中五个固定任务。它们分别覆盖协议/桌面、配置/TUI、Subagent/权限、任务/Runner、Trace/文档；每个任务都要求修改两个相互依赖的 Python 模块。

## 端到端定义

`tests/integration/test_multi_agent_workflow_e2e.py` 不接受预制角色产物。每个场景都会执行以下步骤：

1. 在两个隔离工作区写入完全相同的初始文件和行为测试，并实际运行 pytest 证明初始状态失败；
2. 单 Agent 基线通过真实 `AgentLoop` 调用两次 `edit_file` 和一次 pytest；
3. 多 Agent 路径通过生产 `WorkflowRunTool` 派生真实 Planner、Coder、Tester、Reviewer 子运行；
4. Coder 的改动路径由执行前后文件摘要计算，不采用模型自述；
5. Tester 独立运行 pytest，Reviewer 独立读取两个文件、重跑 pytest，并基于 Diff、测试交接和范围审计作出仲裁；
6. 两条路径都必须从红灯转为绿灯，且最终两个模块的内容逐字节一致；
7. 多 Agent 的三份角色交接和 Reviewer 仲裁必须实际写入 JSONL Trace。

固定门禁使用确定性离线 provider，只负责选择下一次真实工具调用，因此不需要 API 密钥，也不会把模拟 token 当成模型成本。它验证的是编排、权限、文件副作用、独立验证和可追溯性；真实模型质量、token 与延迟比较属于补充评测，不能替代此门禁。

## DeepSeek V4 Flash 补充评测

2026-08-07 使用 DeepSeek 官方 API 的 `deepseek-v4-flash` 默认思考模式对同一批五个红灯任务做了在线复测。该结果属于历史 runner 记录，原始评测产物不再随仓库发布。

该次运行中，单 Agent 合计 65,050 tokens / 66.363 秒，多 Agent 合计 778,296 tokens / 596.455 秒，分别为 11.965 倍和 8.988 倍。结果说明结构化角色隔离提供了独立测试、审查和可追溯证据，但不是免费收益；调用方应根据任务风险选择是否启用。

在线实现允许采用与固定目标不同但行为等价的代码，因此以“初始测试失败、最终测试通过、两个分配模块确实改变、无越界、Reviewer 接受”为通过条件，不要求两条路径生成逐字节相同的源码。复跑脚本从环境读取凭证，不会把 API key 写入报告：

```bash
export OPENAI_BASE_URL=https://api.deepseek.com
export OPENAI_API_KEY
uv run python scripts/evaluate_workflow_live.py
```

可用 `SZTU_EVAL_SCENARIO=protocol-desktop` 只跑指定场景，或用逗号分隔多个场景；`SZTU_EVAL_REPORT` 可覆盖去敏报告路径。

## 验收证据

| 验收项 | 实现证据 | 可执行证据 |
| --- | --- | --- |
| Planner 结构化任务图 | `WorkflowGraph` / `WorkflowTask` 强类型模型；`WorkflowRunTool` 解析并校验 DAG、负责人、依赖、完成条件和范围 | `test_workflow_tool.py`；五场景均由真实 Planner 子运行产图 |
| Coder 写入边界 | 文件工具按 `allowed_paths` 动态分级；越界进入审批，`auto` 直接放行，拒绝不落盘；实际改动由摘要与审计合并 | `test_workflow_scope.py`；`test_workspace_bound_tools.py` |
| Tester 独立验证 | 独立 Tester profile；交接强制要求命令、输出和结论 | 五场景各自实际运行一次 Tester pytest，缺少任一证据即失败 |
| Reviewer 仲裁 | Reviewer 交接强制包含 Diff、测试、安全证据及 `accept` / `return` | 五场景各自读取产物并重跑 pytest；另有 Reviewer 退回单测 |
| 并发、深度、Token、时间、重试预算 | `WorkflowLimits`、任务级预算和 `SpawnAgentTool` 嵌套限制 | `test_workflow_orchestrator.py`、`test_spawn_agent_tool.py`、`test_config_env.py` |
| 失败、取消、超时传播 | 调度器取消运行中任务，并把依赖任务标记为 blocked | 三条独立单测分别覆盖失败、取消和超时 |
| 统一 Trace | 所有 `workflow.*` 事件复用 EventBus → TraceWriter 链 | 五场景读取真实 JSONL，要求 3 个 handoff、1 个 reviewed 和最终 finished |
| 至少五个跨模块任务及单 Agent 对比 | 五个固定红灯任务分别运行单 Agent 和四角色生产路径 | 5 组参数化集成测试，比较完成条件、产物、独立证据、Trace、token 与墙钟 |

## 运行方式

```bash
uv run pytest tests/integration/test_multi_agent_workflow_e2e.py -v
```

比较不同在线模型或提示词时，还必须固定模型版本、思考模式、权限模式、工作区快照和预算，并保留完整 Trace。在线结果应单独标明模型和运行日期，不得覆盖可重复的离线门禁。
