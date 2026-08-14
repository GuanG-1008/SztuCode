import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineStep } from "../src/components/timeline/types";
import { appendTokenBatch, createTokenFrameBatcher } from "../src/utils/timelineStream";

function emptyStep(): TimelineStep {
  return { step: 1, runId: "run-1", status: "thinking", tokens: [], toolCalls: [] };
}

test("appends a token batch without mutating the previous timeline step", () => {
  const previous = {
    ...emptyStep(),
    streamText: "Hello",
    events: [{ id: "text-1", kind: "text" as const, text: "Hello" }],
  };

  const next = appendTokenBatch(previous, [",", " world"]);

  assert.equal(next.streamText, "Hello, world");
  assert.equal(next.events?.at(-1)?.text, "Hello, world");
  assert.equal(previous.streamText, "Hello");
  assert.equal(previous.events.at(-1)?.text, "Hello");
});

test("coalesces tokens into one scheduled batch and preserves their order", () => {
  const scheduled: Array<() => void> = [];
  const batches: Array<{ runId: string; step: number; tokens: string[] }> = [];
  const batcher = createTokenFrameBatcher(
    (batch) => batches.push(batch),
    (callback) => { scheduled.push(callback); return scheduled.length; },
    () => undefined,
  );

  batcher.enqueue("run-1", 3, "A");
  batcher.enqueue("run-1", 3, "B");
  batcher.enqueue("run-1", 3, "C");

  assert.equal(scheduled.length, 1);
  assert.deepEqual(batches, []);
  scheduled[0]();
  assert.deepEqual(batches, [{ runId: "run-1", step: 3, tokens: ["A", "B", "C"] }]);
});

test("flushes pending tokens synchronously before a later run event", () => {
  const batches: Array<{ runId: string; step: number; tokens: string[] }> = [];
  const batcher = createTokenFrameBatcher(
    (batch) => batches.push(batch),
    () => 1,
    () => undefined,
  );

  batcher.enqueue("run-1", 2, "first");
  batcher.flushRun("run-1");

  assert.deepEqual(batches, [{ runId: "run-1", step: 2, tokens: ["first"] }]);
});
