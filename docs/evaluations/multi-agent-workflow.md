# TypeScript 多智能体工作流现状

[返回文档中心](../README.md)

当前产品实现位于 `packages/runtime-ts/src/subagent.ts`、`packages/runtime-ts/src/workflow.ts` 和
`packages/protocol/src/workflow.ts`。早期 Python 工作流场景、pytest 门禁和在线运行脚本已经随旧产品
Runtime 退役，不再是当前代码的可执行证据。

## 当前链路

```text
WorkflowGraph
  -> validateWorkflowGraph
  -> WorkflowOrchestrator
  -> readyTaskIds
  -> SubagentManager
  -> planner / coder / tester / reviewer profile
  -> HandoffArtifact + workflow.* events
```

`WorkflowGraph` 使用 TypeScript 协议类型描述任务、依赖、完成条件、角色、允许路径和预算字段。
调度器拒绝重复任务 ID、未知依赖、自依赖和环；只有依赖成功的任务会进入 ready 集合，并受
`maxConcurrency` 限制并发执行。失败任务的下游任务会标记为 `blocked`。

每个角色通过独立 Agent profile 加载系统提示词、工具白名单、最大步数和权限模式。
`SubagentManager` 使用 scoped permission manager，子 Agent 的权限覆盖不会修改全局权限模式。
工作流会发布：

- `workflow.started`
- `workflow.task_updated`
- `workflow.handoff`
- `workflow.reviewed`
- `workflow.finished`
- `subagent.started`
- `subagent.finished`

## 当前可执行证据

运行 TypeScript 主链测试：

```bash
npm test
```

当前测试直接覆盖：

| 验收项 | 实现 | 测试证据 |
| --- | --- | --- |
| DAG 环检测 | `validateWorkflowGraph` | `workflow validation rejects dependency cycles` |
| 依赖就绪顺序 | `readyTaskIds` | `workflow scheduler returns only tasks whose dependencies succeeded` |
| 工作区路径边界 | `Workspace.resolve` | `workspace rejects traversal outside its root` |
| 角色工具白名单 | `loadAgentProfile` + `ToolRegistry.restrictTo` | `agent profiles load role prompts and enforce tool allowlists` |
| 子 Agent 权限隔离 | `PermissionManager.scoped` | `subagents apply profile permission modes without mutating the global mode` |

`packages/evaluation/tasks/internal-v1.json` 另外提供 10 个确定性 Node/TypeScript Coding Agent
fixture，其中 collaboration 类任务覆盖范围审计和依赖交接算法。它们验证评测 runner、任务隔离和
报告链路，不等价于生产多 Agent E2E：

```bash
npm run eval -- run \
  --manifest packages/evaluation/tasks/internal-v1.json \
  --repeat 1 \
  --output-dir tmp/eval/internal-reference
```

## 尚未完成的闭环

以下字段已经进入协议，但生产调度器尚未完整执行其语义：

- `allowed_paths` 尚未在每个子任务的工具层动态收窄，也没有把真实越界路径写入 `scope_escalations`；
- `token_budget`、`time_budget_s` 和 `max_retries` 尚未由 `WorkflowOrchestrator` 强制执行；
- handoff 的 `changed_paths`、命令输出、Diff、测试和安全结论目前主要来自角色结果模板，尚未全部由独立运行证据计算；
- 当前仓库没有替代旧 Python 五场景门禁的完整 TypeScript 多 Agent E2E 对比测试；
- 工作流取消、超时、重试和运行中任务清理尚未形成统一的端到端测试矩阵。

因此，当前可以声称的是“TypeScript 工作流骨架、角色化子 Agent、基础调度和事件协议已实现”，
不能声称旧 Python 阶段记录的五场景成本、成功率或 Reviewer 独立仲裁已经由当前实现重新证明。

后续扩展应以 [ADR-0002](../adr/0002-structured-multi-agent-workflow.md) 为设计输入，并先补上述
TypeScript 执行语义与可重复 E2E 门禁，再更新能力说明。
