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
