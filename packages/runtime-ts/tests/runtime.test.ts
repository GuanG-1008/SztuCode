import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflowGraph, readyTaskIds } from "@sztucode/protocol/workflow";
import { Workspace, WorkspaceBoundaryError } from "../src/workspace.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSystemPrompt, loadAgentProfile } from "../src/prompt-loader.js";
import { parseRolePayload, scopedWorkflowPermissions, SubagentManager } from "../src/subagent.js";
import { PermissionManager } from "../src/permissions.js";
import { EventBus } from "../src/event-bus.js";
import type { ModelProvider } from "../src/agent-loop.js";
import { createWorkspaceTools } from "../src/tools.js";
import { WorkflowOrchestrator } from "../src/workflow.js";
import type { HandoffArtifact, WorkflowTask } from "@sztucode/protocol";
import { normalizeWorkflowPath, workflowPathIsAllowed } from "../src/workflow-scope.js";
import { AgentLoop } from "../src/agent-loop.js";
import { createMemoryTools, MemoryCatalog } from "../src/memory.js";
import { SessionStore } from "../src/session-store.js";
import { RunManager } from "../src/run-manager.js";

const task = (id: string, dependencies: string[] = []) => ({ id, title: id, description: id, owner: "coder" as const, dependencies, completion_criteria: ["done"], allowed_paths: ["src"], depth: 0, token_budget: 0, time_budget_s: 0, max_retries: null });
const artifact = (workflowTask: WorkflowTask, status: HandoffArtifact["status"] = "succeeded", tokens = 0): HandoffArtifact => ({ workflow_id: "w", task_id: workflowTask.id, role: workflowTask.owner, status, summary: status === "succeeded" ? "done" : "failed", changed_paths: [], scope_escalations: [], commands: [], output: "", conclusion: status, diff_summary: "", test_summary: "", security_summary: "", review_decision: null, tokens, elapsed_s: 0, attempt: 0, child_run_id: "" });

test("workflow validation rejects dependency cycles", () => {
  const graph = { workflow_id: "w", goal: "g", planner_summary: "p", tasks: [task("a", ["b"]), task("b", ["a"])] };
  assert.deepEqual(validateWorkflowGraph(graph), ["workflow graph contains a cycle"]);
});

test("workflow scheduler returns only tasks whose dependencies succeeded", () => {
  assert.deepEqual(readyTaskIds([{ id: "a", dependencies: [], status: "succeeded" }, { id: "b", dependencies: ["a"], status: "pending" }, { id: "c", dependencies: ["b"], status: "pending" }]), ["b"]);
});

test("workflow paths reject traversal and match assigned files, directories, and globs", () => {
  assert.equal(normalizeWorkflowPath("./src\\core.ts"), "src/core.ts");
  assert.equal(workflowPathIsAllowed("src/core.ts", ["src"]), true);
  assert.equal(workflowPathIsAllowed("tests/core.test.ts", ["tests/*.test.ts"]), true);
  assert.equal(workflowPathIsAllowed("docs/readme.md", ["src"]), false);
  assert.throws(() => normalizeWorkflowPath("C:\\outside.txt"), /inside the assigned workspace scope/);
  assert.throws(() => normalizeWorkflowPath("../outside.txt"), /inside the assigned workspace scope/);
});

test("workflow scope upgrades only out-of-scope file writes", async () => {
  const observed: Array<{ toolName: string; permission: string }> = [];
  const gate = scopedWorkflowPermissions({ check: async (_runId, _permissionId, toolName, _params, permission) => { observed.push({ toolName, permission }); return true; } }, ["src"]);
  await gate.check("r", "1", "write_file", { path: "src/main.ts" }, "workspace_write");
  await gate.check("r", "2", "edit_file", { path: "docs/readme.md" }, "workspace_write");
  assert.deepEqual(observed, [{ toolName: "write_file", permission: "workspace_write" }, { toolName: "edit_file", permission: "danger_full_access" }]);
});

test("permission always decisions persist while full-access calls still require approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-permission-policy-"));
  try {
    const policyPath = path.join(root, "policy.toml");
    const firstEvents = new EventBus(path.join(root, "first-events.jsonl"));
    const first = new PermissionManager(firstEvents, 100, policyPath);
    const pending = first.check("run-1", "permission-1", "write_file", { path: "src/a.ts" }, "workspace_write");
    assert.equal(first.respond("permission-1", "always_allow"), true);
    assert.equal(await pending, true);

    const second = new PermissionManager(new EventBus(path.join(root, "second-events.jsonl")), 10, policyPath);
    assert.equal(await second.check("run-2", "permission-2", "write_file", { path: "src/b.ts" }, "workspace_write"), true);
    assert.equal(await second.check("run-2", "permission-3", "write_file", { path: "docs/b.ts" }, "danger_full_access"), false);
    assert.match(await readFile(policyPath, "utf8"), /write_file = "allow"/);

    const denyPending = second.check("run-2", "permission-4", "edit_file", { path: "src/a.ts" }, "workspace_write");
    assert.equal(second.respond("permission-4", "always_deny"), true);
    assert.equal(await denyPending, false);
    const third = new PermissionManager(new EventBus(path.join(root, "third-events.jsonl")), 10, policyPath);
    assert.equal(await third.check("run-3", "permission-5", "edit_file", { path: "src/b.ts" }, "workspace_write"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent loop injects a traceable intervention after repeated permission denials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-denial-intervention-"));
  try {
    const events = new EventBus(path.join(root, "events.jsonl"));
    const trace: string[] = [];
    events.subscribe((event) => trace.push(event.type));
    const seenMessages: string[] = [];
    let calls = 0;
    const provider: ModelProvider = { complete: async (messages) => {
      seenMessages.push(messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n"));
      calls += 1;
      return calls <= 3 ? { text: "", tool_calls: [{ id: `write-${calls}`, name: "write_file", input: { path: "result.txt", content: "blocked" } }], stop_reason: "tool_use" } : { text: "changed approach", tool_calls: [], stop_reason: "end_turn" };
    } };
    const loop = new AgentLoop(provider, createWorkspaceTools(), { workspace: new Workspace(root) }, events, { check: async () => false });
    const result = await loop.run("denial-run", "write result", 5);
    assert.equal(result.text, "changed approach");
    assert.match(seenMessages[3] ?? "", /repeatedly rejected/);
    assert.ok(trace.includes("denial.intervention"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("memory catalog progressively discloses long context and returns bounded excerpts", () => {
  const catalog = new MemoryCatalog([{ name: "project", source: ".sztu/context.md", content: "# Build\nsecret build details\n## Tests\nuse npm test" }], 10);
  assert.equal(catalog.requiresReader(), true);
  assert.match(catalog.prompt(), /Build/);
  assert.doesNotMatch(catalog.prompt(), /secret build details/);
  assert.match(catalog.read("project", "npm", 0, 80), /npm test/);
  assert.ok(catalog.read("project", "", 0, 10).length < 100);
});

test("session notes preserve only active versions and memory tools expose the chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-session-memory-"));
  try {
    const sessions = new SessionStore(root); const session = await sessions.create();
    const catalog = new MemoryCatalog([]); const tools = createMemoryTools(catalog, sessions, session.id, "run-1");
    const saved = await tools.find((tool) => tool.name === "note_save")!.invoke({ content: "Use SQLite" }, { workspace: new Workspace(root) });
    const oldId = saved.output.match(/note-[a-f0-9]+/)?.[0]; assert.ok(oldId);
    const updated = await tools.find((tool) => tool.name === "note_update")!.invoke({ note_id: oldId, content: "Use PostgreSQL" }, { workspace: new Workspace(root) });
    assert.equal(updated.ok, true);
    const notes = await sessions.readNotes(session.id);
    assert.doesNotMatch(notes, /Use SQLite/);
    assert.match(notes, /Use PostgreSQL/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("run manager exposes note tools and injects saved session memory on the next run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-run-memory-"));
  try {
    const sessions = new SessionStore(path.join(root, "sessions")); const session = await sessions.create(); const events = new EventBus(path.join(root, "events.jsonl"));
    const prompts: string[] = []; let calls = 0;
    const provider: ModelProvider = { complete: async (messages, tools) => {
      prompts.push(messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n")); calls += 1;
      if (calls === 1) { assert.ok(tools.get("note_save")); assert.ok(tools.get("note_update")); return { text: "", tool_calls: [{ id: "remember", name: "note_save", input: { content: "Use PostgreSQL" } }], stop_reason: "tool_use" }; }
      return { text: "done", tool_calls: [], stop_reason: "end_turn" };
    } };
    const manager = new RunManager(events, provider, root, undefined, () => [], async () => ({ contextWindow: 16_000, maxOutputTokens: 1_000 }), sessions);
    manager.permissions.setMode("accept_edits");
    const waitFor = async (runId: string) => { const deadline = Date.now() + 5_000; while (manager.get(runId).status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5)); assert.notEqual(manager.get(runId).status, "running"); };
    const first = manager.start("remember database", [], undefined, root, session.id); await waitFor(first);
    const second = manager.start("what database", [], undefined, root, session.id); await waitFor(second);
    assert.match(prompts.at(-1) ?? "", /Use PostgreSQL/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workflow retries failed tasks exactly max_retries times", async () => {
  const workflowTask = { ...task("retry"), max_retries: 2 };
  let calls = 0;
  const result = await new WorkflowOrchestrator(async (current) => { calls += 1; return artifact(current, calls === 3 ? "succeeded" : "failed", 2); }).run({ workflow_id: "w", goal: "g", planner_summary: "p", tasks: [workflowTask] });
  assert.equal(calls, 3);
  assert.equal(result.tasks[0]?.attempts, 3);
  assert.equal(result.tasks[0]?.tokens, 6);
  assert.equal(result.tasks[0]?.artifact?.attempt, 3);
  assert.equal(result.status, "succeeded");
});

test("workflow enforces the wall clock budget on every retry attempt", async () => {
  const workflowTask = { ...task("slow"), time_budget_s: 0.02, max_retries: 2 };
  let aborted = 0;
  const result = await new WorkflowOrchestrator((_current, execution) => new Promise((_resolve, reject) => {
    execution.signal.addEventListener("abort", () => { aborted += 1; reject(execution.signal.reason); }, { once: true });
  })).run({ workflow_id: "w", goal: "g", planner_summary: "p", tasks: [workflowTask] });
  assert.equal(aborted, 3);
  assert.equal(result.tasks[0]?.status, "timed_out");
  assert.equal(result.tasks[0]?.attempts, 3);
  assert.equal(result.status, "timed_out");
});

test("workflow rejects token overages and blocks dependent tasks", async () => {
  const first = { ...task("first"), token_budget: 5 };
  const second = task("second", ["first"]);
  const result = await new WorkflowOrchestrator(async (current) => artifact(current, "succeeded", 6)).run({ workflow_id: "w", goal: "g", planner_summary: "p", tasks: [first, second] });
  assert.equal(result.tasks[0]?.status, "rejected");
  assert.match(result.tasks[0]?.error ?? "", /token budget exceeded/);
  assert.equal(result.tasks[1]?.status, "blocked");
  assert.equal(result.tasks[1]?.attempts, 0);
  assert.equal(result.total_tokens, 6);
  assert.equal(result.status, "failed");
});

test("workflow respects the concurrency limit", async () => {
  const tasks = [task("a"), task("b"), task("c"), task("d")];
  let active = 0; let peak = 0;
  const result = await new WorkflowOrchestrator(async (current) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1; return artifact(current);
  }, 2).run({ workflow_id: "w", goal: "g", planner_summary: "p", tasks });
  assert.equal(peak, 2);
  assert.equal(result.status, "succeeded");
});

test("workflow rejects mismatched and incomplete handoff evidence", async () => {
  const coder = { ...task("coder"), max_retries: 1 };
  let coderCalls = 0;
  const coderResult = await new WorkflowOrchestrator(async (current) => { coderCalls += 1; return { ...artifact(current), workflow_id: "wrong" }; }).run({ workflow_id: "w", goal: "g", planner_summary: "p", tasks: [coder] });
  assert.equal(coderCalls, 2);
  assert.equal(coderResult.tasks[0]?.status, "failed");
  assert.match(coderResult.tasks[0]?.error ?? "", /does not match workflow task identity/);

  const tester = { ...task("tester"), owner: "tester" as const, allowed_paths: [] };
  const testerResult = await new WorkflowOrchestrator(async (current) => artifact(current)).run({ workflow_id: "w", goal: "g", planner_summary: "p", tasks: [tester] });
  assert.equal(testerResult.tasks[0]?.status, "failed");
  assert.match(testerResult.tasks[0]?.error ?? "", /tester handoff requires commands/);
});

test("workflow role payloads parse fenced JSON and reject narrative tester output", () => {
  assert.deepEqual(parseRolePayload('```json\n{"status":"succeeded","summary":"ok","commands":["npm test"]}\n```', "tester"), { status: "succeeded", summary: "ok", commands: ["npm test"] });
  assert.throws(() => parseRolePayload("all tests passed", "tester"), /must return a JSON handoff object/);
  assert.equal(parseRolePayload("implemented", "coder").summary, "implemented");
});

test("workspace rejects traversal outside its root", () => {
  const workspace = new Workspace("C:/workspace");
  assert.throws(() => workspace.resolve("../secrets.txt"), WorkspaceBoundaryError);
});

test("system prompt loads TypeScript-owned prompts and project instructions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-prompt-"));
  try {
    await writeFile(path.join(root, "AGENTS.md"), "PROJECT_SENTINEL: follow repository rules", "utf8");
    const prompt = await buildSystemPrompt(root);
    assert.match(prompt, /SztuCode/);
    assert.match(prompt, /PROJECT_SENTINEL/);
    assert.match(prompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent profiles load role prompts and enforce tool allowlists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-agent-"));
  try {
    await mkdir(path.join(root, ".sztu", "agents"), { recursive: true });
    await writeFile(path.join(root, ".sztu", "agents", "tester.toml"), '[agent]\ndescription = "test"\nsystem_prompt = """Only validate."""\nallowed_tools = [\n  "read_file",\n  "bash",\n]\nmax_steps = 7\n', "utf8");
    const profile = await loadAgentProfile(root, "tester");
    assert.equal(profile.systemPrompt, "Only validate.");
    assert.equal(profile.maxSteps, 7);
    assert.equal(profile.permissionMode, null);
    const tools = createWorkspaceTools().restrictTo(profile.allowedTools);
    assert.deepEqual(tools.list().map((tool) => tool.name).sort(), ["bash", "read_file"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("subagents apply profile permission modes without mutating the global mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-subagent-permissions-"));
  try {
    await mkdir(path.join(root, ".sztu", "agents"), { recursive: true });
    const events = new EventBus(path.join(root, "events.jsonl"));
    const permissions = new PermissionManager(events, 20);
    const provider = (): ModelProvider => {
      let calls = 0;
      return { complete: async () => ++calls === 1
        ? { text: "", tool_calls: [{ id: "write-1", name: "write_file", input: { path: "result.txt", content: "written" } }], stop_reason: "tool_use" }
        : { text: "done", tool_calls: [], stop_reason: "end_turn" } };
    };

    permissions.setMode("auto");
    await writeFile(path.join(root, ".sztu", "agents", "coder.toml"), '[agent]\npermission_mode = "plan"\nallowed_tools = [\n  "write_file",\n]\nmax_steps = 3\n', "utf8");
    await new SubagentManager(provider(), root, events, permissions).run("coder", "write result.txt");
    await assert.rejects(() => readFile(path.join(root, "result.txt"), "utf8"));
    assert.equal(permissions.getMode(), "auto");

    permissions.setMode("plan");
    await writeFile(path.join(root, ".sztu", "agents", "coder.toml"), '[agent]\npermission_mode = "auto"\nallowed_tools = [\n  "write_file",\n]\nmax_steps = 3\n', "utf8");
    await new SubagentManager(provider(), root, events, permissions).run("coder", "write result.txt");
    assert.equal(await readFile(path.join(root, "result.txt"), "utf8"), "written");
    assert.equal(permissions.getMode(), "plan");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workflow coder records approved out-of-scope writes as changed paths and escalations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-workflow-scope-"));
  try {
    const events = new EventBus(path.join(root, "events.jsonl"));
    const permissions = new PermissionManager(events, 20);
    permissions.setMode("auto");
    let calls = 0;
    const provider: ModelProvider = { complete: async () => ++calls === 1
      ? { text: "", tool_calls: [{ id: "write-outside", name: "write_file", input: { path: "docs/result.txt", content: "approved" } }], stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 2 } }
      : { text: "implemented", tool_calls: [], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 1 } } };
    const workflowTask = { ...task("code"), allowed_paths: ["src"] };
    const result = await new SubagentManager(provider, root, events, permissions).runWorkflow({ workflow_id: "w", goal: "g", planner_summary: "p", tasks: [workflowTask] });
    assert.equal(await readFile(path.join(root, "docs", "result.txt"), "utf8"), "approved");
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.tasks[0]?.artifact?.changed_paths, ["docs/result.txt"]);
    assert.deepEqual(result.tasks[0]?.artifact?.scope_escalations, ["docs/result.txt"]);
    assert.equal(result.tasks[0]?.tokens, 10);
  } finally { await rm(root, { recursive: true, force: true }); }
});
