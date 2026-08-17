import { randomUUID } from "node:crypto";
import type { HandoffArtifact, WorkflowGraph, WorkflowRole, WorkflowTask } from "@sztucode/protocol";
import type { ChatMessage, ModelProvider } from "./agent-loop.js";
import { AgentLoop } from "./agent-loop.js";
import { EventBus } from "./event-bus.js";
import { PermissionManager } from "./permissions.js";
import { createWorkspaceTools } from "./tools.js";
import { Workspace } from "./workspace.js";
import { WorkflowOrchestrator } from "./workflow.js";
import { buildSystemPrompt, loadAgentProfile } from "./prompt-loader.js";

const roleNames: Record<WorkflowRole, string> = { planner: "planner", coder: "coder", tester: "tester", reviewer: "reviewer" };

export class SubagentManager {
  constructor(private readonly provider: ModelProvider, private readonly workspaceRoot: string, private readonly events: EventBus, private readonly permissions: PermissionManager) {}
  async run(role: WorkflowRole, goal: string, history: ChatMessage[] = [], parentRunId = ""): Promise<{ runId: string; text: string }> {
    const runId = randomUUID(); const ts = new Date().toISOString();
    this.events.publish({ type: "subagent.started", run_id: runId, parent_run_id: parentRunId, description: `${role}: ${goal.slice(0, 200)}`, ts });
    const profile = await loadAgentProfile(this.workspaceRoot, roleNames[role]);
    const basePrompt = await buildSystemPrompt(this.workspaceRoot, role);
    const rolePrompt = profile.systemPrompt || `Act as the ${role} role for this task.`;
    const tools = createWorkspaceTools().restrictTo(profile.allowedTools);
    const loop = new AgentLoop(this.provider, tools, { workspace: new Workspace(this.workspaceRoot) }, this.events, this.permissions.scoped(profile.permissionMode));
    try { const result = await loop.run(runId, goal, profile.maxSteps || 20, [{ role: "system", content: `${basePrompt}\n\n# Role instructions\n${rolePrompt}` }, ...history]); this.events.publish({ type: "subagent.finished", run_id: runId, parent_run_id: parentRunId, status: "success", ts: new Date().toISOString() }); return { runId, text: result.text }; }
    catch (error) { this.events.publish({ type: "subagent.finished", run_id: runId, parent_run_id: parentRunId, status: "failed", ts: new Date().toISOString() }); throw error; }
  }
  async runWorkflow(graph: WorkflowGraph): Promise<import("@sztucode/protocol").WorkflowResult> {
    const workflowRunId = randomUUID(); const started = new Date().toISOString();
    this.events.publish({ type: "workflow.started", run_id: workflowRunId, workflow_id: graph.workflow_id, goal: graph.goal, planner_summary: graph.planner_summary, tasks: graph.tasks.map((task) => snapshot(task, "pending", 0, "")), ts: started });
    const orchestrator = new WorkflowOrchestrator(async (task, completed) => { this.events.publish({ type: "workflow.task_updated", run_id: workflowRunId, workflow_id: graph.workflow_id, task: snapshot(task, "running", 1, ""), ts: new Date().toISOString() }); const artifact = await this.executeTask(graph.workflow_id, task, completed, workflowRunId); this.events.publish({ type: "workflow.handoff", run_id: workflowRunId, workflow_id: graph.workflow_id, artifact, ts: new Date().toISOString() }); this.events.publish({ type: "workflow.task_updated", run_id: workflowRunId, workflow_id: graph.workflow_id, task: snapshot(task, artifact.status === "succeeded" ? "succeeded" : "failed", 1, artifact.status === "succeeded" ? "" : artifact.summary), ts: new Date().toISOString() }); if (task.owner === "reviewer") this.events.publish({ type: "workflow.reviewed", run_id: workflowRunId, workflow_id: graph.workflow_id, task_id: task.id, decision: artifact.review_decision ?? "return", diff_summary: artifact.diff_summary, test_summary: artifact.test_summary, security_summary: artifact.security_summary, conclusion: artifact.conclusion, ts: new Date().toISOString() }); return artifact; });
    const result = await orchestrator.run(graph); this.events.publish({ type: "workflow.finished", run_id: workflowRunId, workflow_id: graph.workflow_id, status: result.status, reason: result.reason, total_tokens: result.total_tokens, elapsed_s: result.elapsed_s, ts: new Date().toISOString() }); return result;
  }
  private async executeTask(workflowId: string, task: WorkflowTask, completed: Map<string, HandoffArtifact>, parentRunId: string): Promise<HandoffArtifact> {
    const dependencies = [...completed.values()].map((item) => item.summary).join("\n"); const started = Date.now();
    try { const result = await this.run(task.owner, `${task.description}\nCompletion criteria:\n${task.completion_criteria.join("\n")}\nDependency evidence:\n${dependencies}`, [], parentRunId); return { workflow_id: workflowId, task_id: task.id, role: task.owner, status: "succeeded", summary: result.text || `${task.title} completed`, changed_paths: [], scope_escalations: [], commands: task.owner === "tester" ? ["agent-managed validation"] : [], output: task.owner === "tester" ? result.text : "", conclusion: result.text, diff_summary: task.owner === "reviewer" ? result.text : "", test_summary: task.owner === "reviewer" ? "reviewed provided test evidence" : "", security_summary: task.owner === "reviewer" ? "reviewed tool and permission evidence" : "", review_decision: task.owner === "reviewer" ? "accept" : null, tokens: 0, elapsed_s: (Date.now() - started) / 1000, attempt: 1, child_run_id: result.runId }; }
    catch (error) { return { workflow_id: workflowId, task_id: task.id, role: task.owner, status: "failed", summary: error instanceof Error ? error.message : String(error), changed_paths: [], scope_escalations: [], commands: [], output: "", conclusion: "failed", diff_summary: "", test_summary: "", security_summary: "", review_decision: null, tokens: 0, elapsed_s: (Date.now() - started) / 1000, attempt: 1, child_run_id: "" }; }
  }
}

function snapshot(task: WorkflowTask, status: import("@sztucode/protocol").WorkflowTaskStatus, attempt: number, error: string): import("@sztucode/protocol").WorkflowTaskSnapshot { return { id: task.id, title: task.title, owner: task.owner, status, dependencies: task.dependencies, completion_criteria: task.completion_criteria, allowed_paths: task.allowed_paths, attempt, error }; }
