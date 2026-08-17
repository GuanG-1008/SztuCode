import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelProvider } from "../src/agent-loop.js";
import { ToolRegistry } from "../src/tools.js";
import { TraceWriter, TracingProvider, type TraceRecord } from "../src/trace.js";

test("TraceWriter appends records in emit order and flush waits for persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-trace-writer-"));
  const file = path.join(root, "nested", "trace.jsonl");
  try {
    const writer = new TraceWriter(file);
    writer.emit(record("CLIENT→CORE", "command"));
    writer.emit(record("CORE", "event"));
    writer.emit(record("LLM→CORE", "api_response"));
    await writer.flush();
    const rows = (await readFile(file, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as TraceRecord);
    assert.deepEqual(rows.map((row) => row.direction), ["CLIENT→CORE", "CORE", "LLM→CORE"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TracingProvider records correlated calls, responses, and errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-tracing-provider-"));
  const file = path.join(root, "trace.jsonl");
  try {
    const writer = new TraceWriter(file);
    const success: ModelProvider = { complete: async () => ({ text: "done", tool_calls: [], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 } }) };
    const provider = new TracingProvider(success, writer);
    await provider.complete([{ role: "user", content: "hello" }], new ToolRegistry(), undefined, undefined, { runId: "run-1", step: 3, purpose: "agent" });
    const failure = new TracingProvider({ complete: async () => { throw new Error("model unavailable"); } }, writer, false);
    await assert.rejects(() => failure.complete([], new ToolRegistry(), undefined, undefined, { runId: "run-2", step: 1 }), /model unavailable/);
    await writer.flush();
    const rows = (await readFile(file, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as TraceRecord);
    assert.deepEqual(rows.map((row) => row.kind), ["api_call", "api_response", "api_call", "api_error"]);
    assert.deepEqual(rows.slice(0, 2).map((row) => [row.run_id, row.step]), [["run-1", 3], ["run-1", 3]]);
    assert.equal(rows[1]?.data.text, "done");
    assert.equal(rows[3]?.data.error, "model unavailable");
    assert.equal("messages" in (rows[2]?.data ?? {}), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function record(direction: TraceRecord["direction"], kind: string): TraceRecord {
  return { ts: "2026-01-01T00:00:00.000Z", direction, layer: direction.includes("LLM") ? "llm" : "event", kind, data: {} };
}
