import type { HandoffArtifact, WorkflowGraph, WorkflowResult, WorkflowTask, WorkflowTaskResult, WorkflowTaskStatus } from "@sztucode/protocol";
import { readyTaskIds, validateWorkflowGraph } from "@sztucode/protocol/workflow";

export type WorkflowTaskExecutor = (task: WorkflowTask, completed: Map<string, HandoffArtifact>) => Promise<HandoffArtifact>;

export class WorkflowOrchestrator {
  constructor(private readonly executeTask: WorkflowTaskExecutor, private readonly maxConcurrency = 4) {}

  async run(graph: WorkflowGraph): Promise<WorkflowResult> {
    const errors = validateWorkflowGraph(graph); if (errors.length) throw new Error(errors.join("; "));
    const startedAt = Date.now(); const results = new Map<string, WorkflowTaskResult>(); const completed = new Map<string, HandoffArtifact>();
    for (const task of graph.tasks) results.set(task.id, { task, status: "pending", attempts: 0, artifact: null, error: "", tokens: 0 });
    while ([...results.values()].some((result) => result.status === "pending" || result.status === "running")) {
      const ready = readyTaskIds([...results.values()].map((result) => ({ id: result.task.id, dependencies: result.task.dependencies, status: result.status }))).slice(0, this.maxConcurrency);
      if (!ready.length) {
        for (const result of results.values()) if (result.status === "pending") { result.status = "blocked"; result.error = "dependency failed or workflow stalled"; }
        break;
      }
      await Promise.all(ready.map(async (id) => {
        const result = results.get(id)!; result.status = "running"; result.attempts += 1;
        try { const artifact = await this.executeTask(result.task, completed); result.artifact = artifact; result.tokens = artifact.tokens; result.status = artifact.status === "succeeded" ? "succeeded" : "failed"; if (artifact.status === "succeeded") completed.set(id, artifact); }
        catch (error) { result.status = "failed"; result.error = error instanceof Error ? error.message : String(error); }
      }));
    }
    const values = [...results.values()]; const status = values.every((result) => result.status === "succeeded") ? "succeeded" : values.some((result) => result.status === "failed" || result.status === "blocked") ? "failed" : "cancelled";
    return { workflow_id: graph.workflow_id, status, reason: status === "succeeded" ? "" : "one or more tasks did not succeed", tasks: values, total_tokens: values.reduce((sum, result) => sum + result.tokens, 0), elapsed_s: (Date.now() - startedAt) / 1000 };
  }
}
