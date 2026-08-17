import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleProvider } from "../src/providers/openai.js";
import { AnthropicMessagesProvider } from "../src/providers/anthropic.js";
import { ToolRegistry } from "../src/tools.js";

test("OpenAI Responses provider uses /responses and parses text and function calls", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const payload = { output_text: "done", output: [{ type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"a.txt"}' }], usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const tools = new ToolRegistry();
    tools.register({ name: "read_file", description: "read", permission: "read_only", schema: { type: "object" }, invoke: async () => ({ ok: true, output: "" }) });
    const result = await new OpenAiCompatibleProvider({ apiKey: "test", baseUrl: "http://mock/v1", model: "gpt-test", apiFormat: "openai_responses" }).complete([{ role: "user", content: "hi" }], tools);
    assert.equal(requestUrl, "http://mock/v1/responses");
    assert.equal((requestBody?.model), "gpt-test");
    assert.deepEqual(result.tool_calls, [{ id: "call-1", name: "read_file", input: { path: "a.txt" } }]);
    assert.equal(result.text, "done");
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 2 });
  } finally { globalThis.fetch = originalFetch; }
});

test("OpenAI chat provider parses SSE deltas and emits incremental text", async () => {
  const originalFetch = globalThis.fetch;
  const tokens: string[] = [];
  globalThis.fetch = (async () => {
    const encoder = new TextEncoder();
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: '{"path":"a' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.txt"}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const tools = new ToolRegistry();
    tools.register({ name: "read_file", description: "read", permission: "read_only", schema: { type: "object" }, invoke: async () => ({ ok: true, output: "" }) });
    const result = await new OpenAiCompatibleProvider({ apiKey: "test", baseUrl: "http://mock/v1", model: "gpt-test", stream: true }).complete([{ role: "user", content: "hi" }], tools, undefined, (token) => tokens.push(token));
    assert.deepEqual(tokens, ["hel", "lo"]);
    assert.equal(result.text, "hello");
    assert.deepEqual(result.tool_calls, [{ id: "call-1", name: "read_file", input: { path: "a.txt" } }]);
    assert.equal(result.streamed, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("Anthropic messages provider parses streaming text, tool JSON, and usage", async () => {
  const originalFetch = globalThis.fetch;
  const tokens: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.stream, true);
    const encoder = new TextEncoder();
    const frames = [
      `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 7 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "hel" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "lo" } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: "tool_use", id: "tool-1", name: "read_file", input: {} } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: "input_json_delta", partial_json: '.txt"}' } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } })}\n\n`,
    ];
    const stream = new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); } });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const tools = new ToolRegistry();
    tools.register({ name: "read_file", description: "read", permission: "read_only", schema: { type: "object" }, invoke: async () => ({ ok: true, output: "" }) });
    const result = await new AnthropicMessagesProvider({ apiKey: "test", baseUrl: "http://mock/v1", model: "claude-test" }).complete([{ role: "user", content: "hi" }], tools, undefined, (token) => tokens.push(token));
    assert.deepEqual(tokens, ["hel", "lo"]);
    assert.equal(result.text, "hello");
    assert.deepEqual(result.tool_calls, [{ id: "tool-1", name: "read_file", input: { path: "a.txt" } }]);
    assert.equal(result.usage?.input_tokens, 7);
    assert.equal(result.usage?.output_tokens, 4);
    assert.equal(result.streamed, true);
  } finally { globalThis.fetch = originalFetch; }
});
