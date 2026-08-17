import { randomUUID } from "node:crypto";
import type { HandoffArtifact, WorkflowGraph, WorkflowRole, WorkflowTask } from "@sztucode/protocol";
import type { ChatMessage, ModelProvider } from "./agent-loop.js";
import { AgentLoop } from "./agent-loop.js";
import { EventBus } from "./event-bus.js";
import { PermissionManager } from "./permissions.js";
import { createPlanTools, createWorkspaceTools } from "./tools.js";
import { Workspace } from "./workspace.js";
import { WorkflowOrchestrator } from "./workflow.js";
import { buildSystemPrompt, loadAgentProfile } from "./prompt-loader.js";
import type { PermissionGate } from "./permissions.js";
import type { ToolPermission } from "./tools.js";
import { normalizeWorkflowPath, workflowPathIsAllowed } from "./workflow-scope.js";

const roleNames: Record<WorkflowRole, string> = { planner: "planner", coder: "coder", tester: "tester", reviewer: "reviewer" };
const workflowCoderTools = ["read_file", "write_file", "edit_file", "list_dir", "grep_search", "glob_search"];
type SubagentRunOptions = { signal?: AbortSignal; allowedPaths?: string[]; changedPaths?: Set<string>; scopeEscalations?: Set<string> };

export class SubagentManager {
  constructor(private readonly provider: ModelProvider, private readonly workspaceRoot: string, private readonly events: EventBus, private readonly permissions: PermissionManager) {}
  async run(role: WorkflowRole, goal: string, history: ChatMessage[] = [], parentRunId = "", options: SubagentRunOptions = {}): Promise<{ runId: string; text: string; tokens: number }> {
    const runId = randomUUID(); const ts = new Date().toISOString();
    this.events.publish({ type: "subagent.started", run_id: runId, parent_run_id: parentRunId, description: `${role}: ${goal.slice(0, 200)}`, ts });
    const profile = await loadAgentProfile(this.workspaceRoot, roleNames[role]);
    const rolePrompt = profile.systemPrompt || `Act as the ${role} role for this task.`;
    const tools = createWorkspaceTools(createPlanTools(this.events, runId));
    if (profile.allowedTools?.length) tools.restrictTo(profile.allowedTools);
    if (options.allowedPaths) tools.restrictTo(workflowCoderTools);
    const basePermissions = profile.permissionMode ? this.permissions.scoped(profile.permissionMode) : this.permissions;
    const permissions = options.allowedPaths ? scopedWorkflowPermissions(basePermissions, options.allowedPaths) : basePermissions;
    const basePrompt = await buildSystemPrompt(this.workspaceRoot, role, { permissionMode: profile.permissionMode ?? this.permissions.getMode(), toolNames: tools.list().map((tool) => tool.name), taskText: goal });
    const context = { workspace: new Workspace(this.workspaceRoot), signal: options.signal, onFileChanged: (relativePath: string) => { const normalized = normalizeWorkflowPath(relativePath); options.changedPaths?.add(normalized); if (options.allowedPaths && !workflowPathIsAllowed(normalized, options.allowedPaths)) options.scopeEscalations?.add(normalized); } };
    const loop = new AgentLoop(this.provider, tools, context, this.events, permissions);
    try { const result = await loop.run(runId, goal, profile.maxSteps || 20, [{ role: "system", content: `${basePrompt}\n\n# Role instructions\n${rolePrompt}` }, ...history], options.signal); this.events.publish({ type: "subagent.finished", run_id: runId, parent_run_id: parentRunId, status: "success", ts: new Date().toISOString() }); return { runId, text: result.text, tokens: result.usage.input_tokens + result.usage.output_tokens }; }
    catch (error) { this.events.publish({ type: "subagent.finished", run_id: runId, parent_run_id: parentRunId, status: "failed", ts: new Date().toISOString() }); throw error; }
  }
  async runWorkflow(graph: WorkflowGraph, options: { runId?: string; signal?: AbortSignal } = {}): Promise<import("@sztucode/protocol").WorkflowResult> {
    const workflowRunId = options.runId ?? randomUUID(); const started = new Date().toISOString();
    this.events.publish({ type: "workflow.started", run_id: workflowRunId, workflow_id: graph.workflow_id, goal: graph.goal, planner_summary: graph.planner_summary, tasks: graph.tasks.map((task) => snapshot(task, "pending", 0, "")), ts: started });
    const orchestrator = new WorkflowOrchestrator(
      (task, execution) => this.executeTask(graph.workflow_id, task, execution.completed, workflowRunId, execution.attempt, execution.signal),
      4,
      {
        onTaskUpdated: (result) => this.events.publish({ type: "workflow.task_updated", run_id: workflowRunId, workflow_id: graph.workflow_id, task: snapshot(result.task, result.status, result.attempts, result.error), ts: new Date().toISOString() }),
        onHandoff: (artifact) => {
          this.events.publish({ type: "workflow.handoff", run_id: workflowRunId, workflow_id: graph.workflow_id, artifact, ts: new Date().toISOString() });
          if (artifact.role === "reviewer") this.events.publish({ type: "workflow.reviewed", run_id: workflowRunId, workflow_id: graph.workflow_id, task_id: artifact.task_id, decision: artifact.review_decision ?? "return", diff_summary: artifact.diff_summary, test_summary: artifact.test_summary, security_summary: artifact.security_summary, conclusion: artifact.conclusion, ts: new Date().toISOString() });
        },
      },
    );
    const result = await orchestrator.run(graph, options.signal); this.events.publish({ type: "workflow.finished", run_id: workflowRunId, workflow_id: graph.workflow_id, status: result.status, reason: result.reason, total_tokens: result.total_tokens, elapsed_s: result.elapsed_s, ts: new Date().toISOString() }); return result;
  }
  private async executeTask(workflowId: string, task: WorkflowTask, completed: ReadonlyMap<string, HandoffArtifact>, parentRunId: string, attempt: number, signal: AbortSignal): Promise<HandoffArtifact> {
    const dependencyArtifacts = task.dependencies.map((id) => completed.get(id)).filter((artifact): artifact is HandoffArtifact => Boolean(artifact)); const started = Date.now(); const changedPaths = new Set<string>(); const scopeEscalations = new Set<string>();
    try {
      const result = await this.run(task.owner, workflowPrompt(workflowId, task, dependencyArtifacts, attempt), [], parentRunId, { signal, ...(task.owner === "coder" ? { allowedPaths: task.allowed_paths, changedPaths, scopeEscalations } : {}) });
      try { return artifactFromText(workflowId, task, result, attempt, started, [...changedPaths].sort(), [...scopeEscalations].sort()); }
      catch (error) { return failedArtifact(workflowId, task, error, attempt, started, [...changedPaths].sort(), [...scopeEscalations].sort(), result.tokens, result.runId); }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return failedArtifact(workflowId, task, error, attempt, started, [...changedPaths].sort(), [...scopeEscalations].sort());
    }
  }
}

type RolePayload = Partial<Pick<HandoffArtifact, "status" | "summary" | "commands" | "output" | "conclusion" | "diff_summary" | "test_summary" | "security_summary" | "review_decision">>;

function workflowPrompt(workflowId: string, task: WorkflowTask, dependencies: HandoffArtifact[], attempt: number): string {
  const contracts: Record<WorkflowRole, Record<string, unknown>> = {
    planner: { status: "succeeded|failed", summary: "planning result", conclusion: "completion assessment" },
    coder: { status: "succeeded|failed", summary: "what was implemented", conclusion: "completion assessment" },
    tester: { status: "succeeded|failed", summary: "verification scope", commands: ["exact command"], output: "key raw output", conclusion: "pass/fail conclusion", test_summary: "concise evidence" },
    reviewer: { status: "succeeded|failed", summary: "review scope", diff_summary: "actual diff findings", test_summary: "tester evidence assessment", security_summary: "security evidence or limitation", review_decision: "accept|return", conclusion: "arbitration reason" },
  };
  const rules: Record<WorkflowRole, string> = {
    planner: "Analyze only and do not modify files.",
    coder: "Only modify files under allowed_paths using write_file/edit_file. Do not run tests; the independent Tester owns verification.",
    tester: "Run checks yourself, do not modify files, and preserve exact commands and real output.",
    reviewer: "Inspect actual files and dependency evidence. Return work when any completion, test, or security gate is unsatisfied. Do not modify files.",
  };
  return `Execute this delegated workflow task.\nContext: ${JSON.stringify({ workflow_id: workflowId, task, attempt, dependency_evidence: dependencies })}\nRole rule: ${rules[task.owner]}\nFinish with exactly one JSON object and no Markdown fence.\nRequired contract: ${JSON.stringify(contracts[task.owner])}`;
}

export function parseRolePayload(text: string, role: WorkflowRole): RolePayload {
  const trimmed = text.trim();
  if (role === "coder" && !trimmed.startsWith("{") && !trimmed.startsWith("```")) return { status: "succeeded", summary: trimmed || "coder completed without summary", conclusion: trimmed };
  const match = trimmed.match(/(?:```(?:json)?\s*)?(\{[\s\S]*\})(?:\s*```)?/i);
  if (!match) throw new Error(`${role} must return a JSON handoff object`);
  let value: unknown;
  try { value = JSON.parse(match[1]!); } catch { throw new Error(`${role} returned invalid JSON handoff`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${role} must return a JSON handoff object`);
  return value as RolePayload;
}

function artifactFromText(workflowId: string, task: WorkflowTask, result: { runId: string; text: string; tokens: number }, attempt: number, started: number, changedPaths: string[], scopeEscalations: string[]): HandoffArtifact {
  const payload = parseRolePayload(result.text, task.owner);
  const status = payload.status === "failed" ? "failed" : "succeeded";
  const decision = payload.review_decision === "accept" || payload.review_decision === "return" ? payload.review_decision : null;
  return {
    workflow_id: workflowId, task_id: task.id, role: task.owner, status,
    summary: stringValue(payload.summary) || `${task.title} completed`, changed_paths: changedPaths, scope_escalations: scopeEscalations,
    commands: Array.isArray(payload.commands) ? payload.commands.filter((item): item is string => typeof item === "string") : [], output: stringValue(payload.output), conclusion: stringValue(payload.conclusion),
    diff_summary: stringValue(payload.diff_summary), test_summary: stringValue(payload.test_summary), security_summary: stringValue(payload.security_summary), review_decision: decision,
    tokens: result.tokens, elapsed_s: (Date.now() - started) / 1000, attempt, child_run_id: result.runId,
  };
}

const stringValue = (value: unknown): string => typeof value === "string" ? value : "";

function failedArtifact(workflowId: string, task: WorkflowTask, error: unknown, attempt: number, started: number, changedPaths: string[], scopeEscalations: string[], tokens = 0, childRunId = ""): HandoffArtifact {
  return { workflow_id: workflowId, task_id: task.id, role: task.owner, status: "failed", summary: error instanceof Error ? error.message : String(error), changed_paths: changedPaths, scope_escalations: scopeEscalations, commands: [], output: "", conclusion: "failed", diff_summary: "", test_summary: "", security_summary: "", review_decision: null, tokens, elapsed_s: (Date.now() - started) / 1000, attempt, child_run_id: childRunId };
}

export function scopedWorkflowPermissions(base: PermissionGate, allowedPaths: string[]): PermissionGate {
  return { check: (runId, permissionId, toolName, params, permission, signal) => {
    const effective: ToolPermission = (toolName === "write_file" || toolName === "edit_file") && typeof params.path === "string" && !workflowPathIsAllowed(params.path, allowedPaths) ? "danger_full_access" : permission;
    return base.check(runId, permissionId, toolName, params, effective, signal);
  } };
}

function snapshot(task: WorkflowTask, status: import("@sztucode/protocol").WorkflowTaskStatus, attempt: number, error: string): import("@sztucode/protocol").WorkflowTaskSnapshot { return { id: task.id, title: task.title, owner: task.owner, status, dependencies: task.dependencies, completion_criteria: task.completion_criteria, allowed_paths: task.allowed_paths, attempt, error }; }
