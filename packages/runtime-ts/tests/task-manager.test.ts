import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../src/event-bus.js";
import { TaskManager } from "../src/task-manager.js";
import { createPlanTools } from "../src/tools.js";

test("task manager persists tasks, resumes IDs, and clears completed dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-tasks-"));
  try {
    const first = new TaskManager(root);
    assert.equal((await first.create("first")).id, 1);
    assert.equal((await first.create("second", "", [1])).id, 2);
    const resumed = new TaskManager(root);
    assert.equal((await resumed.create("third")).id, 3);
    await resumed.update(1, { status: "completed" });
    assert.deepEqual((await resumed.get(2)).blocked_by, []);
    assert.match(await resumed.formatList(), /\[x\] #1: first/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("task manager rejects missing and self dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-task-validation-"));
  try {
    const manager = new TaskManager(root);
    await assert.rejects(manager.create("invalid", "", [99]), /not found/);
    await manager.create("valid");
    await assert.rejects(manager.update(1, { addBlockedBy: [1] }), /cannot block itself/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("plan tools expose task_get and publish persisted plan updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-plan-tools-"));
  try {
    const events = new EventBus(path.join(root, "events.jsonl")); const updates: unknown[] = []; events.subscribe((event) => { if (event.type === "plan.updated") updates.push(event.items); });
    const tools = createPlanTools(events, "run-1", "session-1", path.join(root, "tasks"));
    assert.equal(tools.find((tool) => tool.name === "task_create")?.permission, "workspace_write");
    assert.equal(tools.find((tool) => tool.name === "task_update")?.permission, "workspace_write");
    assert.equal(tools.find((tool) => tool.name === "task_get")?.permission, "read_only");
    assert.equal(tools.find((tool) => tool.name === "task_list")?.permission, "read_only");
    assert.equal((await tools.find((tool) => tool.name === "task_create")!.invoke({ subject: "persist me" }, {} as never)).ok, true);
    const detail = await tools.find((tool) => tool.name === "task_get")!.invoke({ task_id: 1 }, {} as never);
    assert.match(detail.output, /persist me/); assert.equal(updates.length, 1);
    const rebuilt = createPlanTools(events, "run-1", "session-1", path.join(root, "tasks"));
    assert.match((await rebuilt.find((tool) => tool.name === "task_list")!.invoke({}, {} as never)).output, /persist me/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
