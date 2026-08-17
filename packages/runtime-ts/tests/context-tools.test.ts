import assert from "node:assert/strict";
import test from "node:test";
import { ContextManager, TokenCounter, truncateText } from "../src/context.js";
import { createWorkspaceTools, ToolRegistry } from "../src/tools.js";
import { Workspace } from "../src/workspace.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceChangeTracker, activeRunChanges, revertRunChanges } from "../src/changes.js";

test("token counter handles CJK and fallback text", () => { const counter = new TokenCounter(); assert.ok(counter.count("中文") > counter.count("ab")); });
test("truncateText preserves a bounded result and marker", () => { const result = truncateText("a".repeat(200), 80); assert.ok(result.length <= 80); assert.match(result, /original=200/); });
test("context compaction keeps recent messages", () => { const context = new ContextManager(Array.from({ length: 10 }, (_, index) => ({ role: "user" as const, content: `message-${index}` }))); const result = context.compact(3); assert.equal(result.removedMessages, 7); assert.match(String(context.messages.at(-1)?.content), /message-9/); });
test("context compaction uses a validated model summary and preserves recent turns", async () => {
  const history = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `message-${index} with important implementation detail` }));
  const context = new ContextManager(history);
  let prompt = "";
  const provider = { complete: async (messages: any[]) => { prompt = String(messages[0].content); return { text: "Goal\nThe user requested a migration.\n\nProgress\nThe runtime is implemented.\n\nOpen Issues\nNone.\n\nNext Steps\nRun the tests.", usage: { output_tokens: 24 }, stop_reason: "end_turn" }; } };
  const result = await context.compactWithProvider(provider, "preserve API contract", 3);
  assert.equal(result.usedModel, true);
  assert.equal(result.removedMessages, 7);
  assert.match(prompt, /preserve API contract/);
  assert.match(String(context.messages[0]?.content), /Goal/);
  assert.match(String(context.messages.at(-1)?.content), /message-9/);
});
test("context compaction falls back safely when the model returns an invalid summary", async () => {
  const context = new ContextManager(Array.from({ length: 10 }, (_, index) => ({ role: "user" as const, content: `message-${index}` })));
  const result = await context.compactWithProvider({ complete: async () => ({ text: "too short" }) }, "", 3);
  assert.equal(result.usedModel, false);
  assert.equal(result.removedMessages, 7);
  assert.match(String(context.messages.at(-1)?.content), /message-9/);
});
test("workspace tools support nested writes and grep", async () => { const root = await mkdtemp(path.join(os.tmpdir(), "sztu-ts-")); try { const tools = createWorkspaceTools(); const context = { workspace: new Workspace(root) }; assert.equal((await tools.get("write_file")!.invoke({ path: "src/a.ts", content: "needle" }, context)).ok, true); const result = await tools.get("grep_search")!.invoke({ pattern: "needle" }, context); assert.match(result.output, /src\/a.ts:1/); assert.equal(await readFile(path.join(root, "src/a.ts"), "utf8"), "needle"); } finally { await rm(root, { recursive: true, force: true }); } });
test("tool registry resolves built-in and tool-declared aliases without advertising duplicates", async () => {
  const tools = createWorkspaceTools();
  for (const [alias, canonical] of Object.entries({ read: "read_file", Read: "read_file", write: "write_file", Write: "write_file", edit: "edit_file", Edit: "edit_file", glob: "glob_search", Glob: "glob_search", grep: "grep_search", Grep: "grep_search", ls: "list_dir", List: "list_dir" })) {
    assert.equal(tools.get(alias)?.name, canonical);
    assert.equal(tools.canonicalName(alias), canonical);
  }
  assert.equal(tools.list().some((tool) => tool.name === "read"), false);
  assert.equal(new ToolRegistry().get("read"), undefined);

  const custom = new ToolRegistry();
  custom.register({ name: "inspect", aliases: ["i", "Inspect"], description: "inspect", permission: "read_only", schema: { type: "object" }, async invoke() { return { ok: true, output: "ok" }; } });
  assert.equal(custom.get("i")?.name, "inspect");
  assert.deepEqual(custom.restrictTo(["Inspect"]).list().map((tool) => tool.name), ["inspect"]);
});
test("run snapshots revert only an unchanged agent result", async () => { const root = await mkdtemp(path.join(os.tmpdir(), "sztu-change-")); const runs = await mkdtemp(path.join(os.tmpdir(), "sztu-runs-")); try { await writeFile(path.join(root, "a.txt"), "before"); const tracker = new WorkspaceChangeTracker(root, "run-1", runs); await tracker.capture(); await writeFile(path.join(root, "a.txt"), "after"); await tracker.finalize(); assert.equal((await activeRunChanges("run-1", root, runs))[0]?.agent_owned, true); await writeFile(path.join(root, "a.txt"), "user edit"); const blocked = await revertRunChanges("run-1", root, ["a.txt"], runs); assert.match(blocked.blocked_paths["a.txt"], /changed since/); await writeFile(path.join(root, "a.txt"), "after"); const reverted = await revertRunChanges("run-1", root, ["a.txt"], runs); assert.deepEqual(reverted.reverted_paths, ["a.txt"]); assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "before"); } finally { await rm(root, { recursive: true, force: true }); await rm(runs, { recursive: true, force: true }); } });
