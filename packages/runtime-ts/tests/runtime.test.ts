import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflowGraph, readyTaskIds } from "@sztucode/protocol/workflow";
import { Workspace, WorkspaceBoundaryError } from "../src/workspace.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSystemPrompt, loadAgentProfile } from "../src/prompt-loader.js";
import { createWorkspaceTools } from "../src/tools.js";

const task = (id: string, dependencies: string[] = []) => ({ id, title: id, description: id, owner: "coder" as const, dependencies, completion_criteria: ["done"], allowed_paths: [], depth: 0, token_budget: 0, time_budget_s: 0, max_retries: null });

test("workflow validation rejects dependency cycles", () => {
  const graph = { workflow_id: "w", goal: "g", planner_summary: "p", tasks: [task("a", ["b"]), task("b", ["a"])] };
  assert.deepEqual(validateWorkflowGraph(graph), ["workflow graph contains a cycle"]);
});

test("workflow scheduler returns only tasks whose dependencies succeeded", () => {
  assert.deepEqual(readyTaskIds([{ id: "a", dependencies: [], status: "succeeded" }, { id: "b", dependencies: ["a"], status: "pending" }, { id: "c", dependencies: ["b"], status: "pending" }]), ["b"]);
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
    const tools = createWorkspaceTools().restrictTo(profile.allowedTools);
    assert.deepEqual(tools.list().map((tool) => tool.name).sort(), ["bash", "read_file"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
