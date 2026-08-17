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
`maxConcurrency` 限制并发执行。失败任务的下游任务会标记为 `blocked`。任务级
`max_retries`、`time_budget_s` 和 `token_budget` 分别约束重试次数、每次尝试的墙钟时间和
累计模型 Token；超时会通过 `AbortSignal` 中止模型、权限等待或工具调用。

每个角色通过独立 Agent profile 加载系统提示词、工具白名单、最大步数和权限模式。
`SubagentManager` 使用 scoped permission manager，子 Agent 的权限覆盖不会修改全局权限模式。
Coder 工作流只开放可审计的工作区文件工具，并要求非空 `allowed_paths`。范围外文件写入在执行前
升级为 `danger_full_access`，批准并成功写入后才进入 `scope_escalations`；实际变更路径由
`write_file`/`edit_file` 的成功结果记录。Tester 和 Reviewer 必须返回结构化 JSON 交接，调度器
会拒绝缺少命令、原始输出、Diff、测试、安全结论或仲裁决定的产物，Reviewer 的 `return` 会把任务
标为 `rejected`。
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
| 重试、超时和 Token 预算 | `WorkflowOrchestrator` | `workflow retries...`、`workflow enforces...`、`workflow rejects token overages...` |
| 并发上限和失败传播 | `WorkflowOrchestrator` | `workflow respects the concurrency limit`、`workflow rejects token overages and blocks dependent tasks` |
| Coder 路径升级证据 | `workflow-scope.ts` + `SubagentManager` | `workflow coder records approved out-of-scope writes...` |
| Tester/Reviewer 结构化交接 | `parseRolePayload` + handoff 校验 | `workflow role payloads parse fenced JSON...`、`workflow rejects mismatched and incomplete handoff evidence` |

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

以下闭环仍未完成：

- Coder 的 `changed_paths` 对 `write_file`/`edit_file` 是运行时证据；工作流主动禁用 `bash`，因此尚未提供任意 shell 写入的路径归属；
- Tester 的命令、输出和结论及 Reviewer 的 Diff、测试、安全结论来自其独立子 Agent 的结构化结果并经过非空校验，但尚未由 daemon 对命令执行记录和文件 Diff 做二次交叉验证；
- 当前仓库没有替代旧 Python 五场景门禁的完整 TypeScript 多 Agent E2E 对比测试；
- `workflow.run` 仍是同步 RPC，尚未提供工作流级取消句柄、全局墙钟/总 Token 预算和运行中任务清理的完整端到端测试矩阵。

因此，当前可以声称的是“TypeScript 工作流 DAG、角色化子 Agent、任务预算、路径升级、结构化交接
与确定性校验已实现”，不能声称旧 Python 阶段记录的五场景成本、成功率或完整 Reviewer 质量结论
已经由当前实现重新证明。

后续扩展应以 [ADR-0002](../adr/0002-structured-multi-agent-workflow.md) 为设计输入，并先补上述
TypeScript 执行语义与可重复 E2E 门禁，再更新能力说明。
