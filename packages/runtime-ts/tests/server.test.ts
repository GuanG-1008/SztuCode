import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeServer } from "../src/server.js";

async function rpc(socket: net.Socket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = `${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: string) => { buffer += chunk; const index = buffer.indexOf("\n"); if (index < 0) return; const message = JSON.parse(buffer.slice(0, index)); socket.off("data", onData); if (message.error) reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else resolve(message.result); };
    socket.on("data", onData); socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

test("runtime server exposes JSON-RPC and classified errors over NDJSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-runtime-test-")); const previous = process.env.SZTU_DATA_DIR; process.env.SZTU_DATA_DIR = root;
  const server = new RuntimeServer("127.0.0.1", 0); const address = await server.listen(); const port = Number(address.split(":").at(-1)); const socket = net.createConnection({ host: "127.0.0.1", port }); await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
  try {
    const pong = await rpc(socket, "core.ping", { client: "test" }); assert.equal(pong.server_version, "ts-0.2.0");
    await assert.rejects(() => rpc(socket, "session.send_message", { session_id: "missing", content: "x" }), (error: any) => error.code === -32004);
    await assert.rejects(() => rpc(socket, "unknown.method"), (error: any) => error.code === -32601);
  } finally { socket.destroy(); await server.close(); process.env.SZTU_DATA_DIR = previous; await rm(root, { recursive: true, force: true }); }
});

test("manual session.compact uses provider summary and persists continuation messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-runtime-compact-test-")); const previous = process.env.SZTU_DATA_DIR; process.env.SZTU_DATA_DIR = root;
  let compactionPrompt = "";
  const server = new RuntimeServer("127.0.0.1", 0, {
    complete: async (messages) => {
      compactionPrompt = String(messages[0]?.content ?? "");
      return { text: "Goal\nKeep the API contract.\nProgress\nEarlier work is complete.\nDecisions\nUse the TypeScript runtime.\nOpen Issues\nNone known.\nNext Steps\nContinue with the current task.", tool_calls: [], stop_reason: "end_turn", usage: { output_tokens: 30 } };
    },
  });
  const address = await server.listen(); const port = Number(address.split(":").at(-1)); const socket = net.createConnection({ host: "127.0.0.1", port }); await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
  try {
    const created = await rpc(socket, "session.create", { mode: "chat" });
    for (let index = 0; index < 12; index += 1) await server.sessions.appendMessage(created.session_id, { role: index % 2 ? "assistant" : "user", content: `message ${index} with enough detail to make the old context worth summarizing` });
    const result = await rpc(socket, "session.compact", { session_id: created.session_id, focus: "preserve the API contract" });
    assert.equal(result.used_model, true);
    assert.ok(result.removed_messages > 0);
    assert.match(compactionPrompt, /preserve the API contract/);
    const history = await rpc(socket, "session.history", { session_id: created.session_id });
    assert.match(history.messages[0].content, /This session continues from an earlier context/);
  } finally { socket.destroy(); await server.close(); process.env.SZTU_DATA_DIR = previous; await rm(root, { recursive: true, force: true }); }
});
