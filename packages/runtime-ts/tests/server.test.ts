import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RuntimeServer } from "../src/server.js";

const execFileAsync = promisify(execFile);

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

test("desktop workspace, provider, file preview, and git contracts remain complete", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "sztu-runtime-contract-data-")); const projectRoot = await mkdtemp(path.join(os.tmpdir(), "sztu-runtime-contract-project-")); const previous = process.env.SZTU_DATA_DIR; process.env.SZTU_DATA_DIR = dataRoot;
  await mkdir(path.join(projectRoot, ".sztu", "skills", "contract-skill"), { recursive: true });
  await writeFile(path.join(projectRoot, ".sztu", "skills", "contract-skill", "SKILL.md"), "---\nname: contract-skill\ndescription: Contract fixture\n---\nUse the contract fixture.", "utf8");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"); await writeFile(path.join(projectRoot, "pixel.png"), png);
  await execFileAsync("git", ["init"], { cwd: projectRoot }); await execFileAsync("git", ["config", "user.name", "Sztu Test"], { cwd: projectRoot }); await execFileAsync("git", ["config", "user.email", "sztu@example.test"], { cwd: projectRoot }); await writeFile(path.join(projectRoot, "tracked.txt"), "tracked\n", "utf8"); await execFileAsync("git", ["add", "tracked.txt"], { cwd: projectRoot }); await execFileAsync("git", ["commit", "-m", "initial"], { cwd: projectRoot });
  const server = new RuntimeServer("127.0.0.1", 0); const address = await server.listen(); const port = Number(address.split(":").at(-1)); const socket = net.createConnection({ host: "127.0.0.1", port }); await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
  try {
    const opened = await rpc(socket, "workspace.open", { path: projectRoot }); const workspaceId = opened.workspace.workspace_id;
    await rpc(socket, "workspace.archive", { workspace_id: workspaceId }); const listed = await rpc(socket, "workspace.list"); assert.equal(listed.workspaces.find((item: any) => item.workspace_id === workspaceId)?.archived, true);
    const preview = await rpc(socket, "file.read", { workspace_id: workspaceId, path: "pixel.png" }); assert.equal(preview.binary, true); assert.equal(preview.mime_type, "image/png"); assert.equal(preview.media_base64, png.toString("base64"));
    const skills = await rpc(socket, "skill.list", { workspace_id: workspaceId }); assert.ok(skills.skills.some((item: any) => item.name === "contract-skill")); const status = await rpc(socket, "provider.status"); assert.ok(Array.isArray(status.skills)); assert.ok(status.skills.length > 0);
    const history = await rpc(socket, "git.history", { workspace_id: workspaceId }); assert.equal(history.commits[0].is_head, true); assert.ok(history.commits[0].refs.some((item: any) => item.kind === "head"));
  } finally { socket.destroy(); await server.close(); process.env.SZTU_DATA_DIR = previous; await rm(dataRoot, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); }
});

test("session lifecycle and model profiles preserve desktop invariants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-runtime-state-test-")); const previous = process.env.SZTU_DATA_DIR; process.env.SZTU_DATA_DIR = root;
  const server = new RuntimeServer("127.0.0.1", 0); const address = await server.listen(); const port = Number(address.split(":").at(-1)); const socket = net.createConnection({ host: "127.0.0.1", port }); await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
  try {
    const created = await rpc(socket, "session.create", { mode: "chat" }); const sessionId = created.session_id;
    await rpc(socket, "session.pin", { session_id: sessionId, pinned: true }); const archived = await rpc(socket, "session.archive", { session_id: sessionId }); assert.equal(archived.session.archived, true); assert.equal(archived.session.pinned, false);
    await assert.rejects(() => rpc(socket, "session.pin", { session_id: sessionId, pinned: true }), /archived session cannot be pinned/);
    await rpc(socket, "session.close", { session_id: sessionId }); const resumed = await rpc(socket, "session.resume", { session_id: sessionId }); assert.equal(resumed.session.status, "waiting_for_input");

    await rpc(socket, "settings.update", { permission_mode: "auto" }); const initialModels = await rpc(socket, "provider.model_list"); const builtin = initialModels.models.find((item: any) => item.id === "builtin-opencode-zen-deepseek-v4-flash-free"); assert.equal(builtin.builtin, true); assert.equal(builtin.has_api_key, true);
    const selectedBuiltin = await rpc(socket, "provider.model_select", { model_id: builtin.id }); assert.equal(selectedBuiltin.settings.permission_mode, "auto"); const status = await rpc(socket, "provider.status"); assert.equal(status.ready_for_next_run, true);
    await assert.rejects(() => rpc(socket, "provider.model_delete", { model_id: builtin.id }), /builtin profiles cannot be deleted/);

    const shared = { vendor: "Test", provider: "openai", api_format: "openai_chat_completions", model: "same-model", base_url: "https://example.test/v1", api_key: "secret", context_window: 16_000, max_output_tokens: 1024, temperature: null, top_p: null, reasoning_effort: "", timeout_s: 30, max_retries: 1, cache_control: true };
    const first = await rpc(socket, "provider.model_save", { ...shared, name: "First" }); const firstId = first.models.find((item: any) => item.name === "First").id;
    const second = await rpc(socket, "provider.model_save", { ...shared, name: "Second" }); const secondId = second.models.find((item: any) => item.name === "Second").id; assert.deepEqual(second.models.filter((item: any) => item.is_current).map((item: any) => item.id), [secondId]);
    await assert.rejects(() => rpc(socket, "provider.model_delete", { model_id: secondId }), /current model profile cannot be deleted/); const deleted = await rpc(socket, "provider.model_delete", { model_id: firstId }); assert.ok(!deleted.models.some((item: any) => item.id === firstId));
  } finally { socket.destroy(); await server.close(); process.env.SZTU_DATA_DIR = previous; await rm(root, { recursive: true, force: true }); }
});
