import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type RpcEvent = { type: string; run_id?: string; [key: string]: unknown };

class RpcClient {
  private readonly socket: net.Socket;
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  readonly events: RpcEvent[] = [];

  constructor(port: number) {
    this.socket = net.createConnection({ host: "127.0.0.1", port });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.receive(chunk));
  }

  connect(): Promise<void> {
    if (!this.socket.connecting) return Promise.resolve();
    return new Promise((resolve, reject) => { this.socket.once("connect", resolve); this.socket.once("error", reject); });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = String(++this.sequence);
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async waitFor(predicate: (event: RpcEvent) => boolean, timeoutMs = 15_000): Promise<RpcEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.find(predicate);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for runtime event");
  }

  close(): void { this.socket.destroy(); }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); newline = this.buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.kind === "event") { this.events.push(message.event); continue; }
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    }
  }
}

async function main(): Promise<void> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "sztu-ts-e2e-"));
  const mock = await startMockProvider();
  const daemonPort = await availablePort();
  const env = {
    ...process.env,
    SZTU_DATA_DIR: dataRoot,
    SZTU_TS_HOST: "127.0.0.1",
    SZTU_TS_PORT: String(daemonPort),
    SZTU_LLM_PROVIDER: "openai",
    SZTU_LLM_DEFAULT_MODEL: "e2e-mock",
    OPENAI_API_KEY: "e2e-test-key",
    OPENAI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
    SZTU_TRACE_FILE: path.join(dataRoot, "structured.jsonl"),
  };
  const daemon = spawn(process.execPath, ["packages/runtime-ts/dist/main.js"], { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let daemonOutput = "";
  daemon.stdout?.on("data", (chunk) => { daemonOutput += chunk.toString(); });
  daemon.stderr?.on("data", (chunk) => { daemonOutput += chunk.toString(); });
  let client: RpcClient | null = null;

  try {
    await waitUntilReady(daemonPort, env, daemon);
    const ping = await execute(process.execPath, ["packages/cli/dist/main.js", "ping"], { cwd: repositoryRoot, env, timeout: 30_000 });
    assert.equal(JSON.parse(ping.stdout).server_version, "ts-0.2.0");

    const cliRun = await execute(process.execPath, ["packages/cli/dist/main.js", "run", "--goal", "Read package.json and answer exactly E2E_OK"], { cwd: repositoryRoot, env, timeout: 30_000 });
    assert.match(cliRun.stdout, /\[tool\] read_file/);
    assert.match(cliRun.stdout, /E2E_OK/);
    assert.match(cliRun.stdout, /\[run\] success/);

    client = new RpcClient(daemonPort); await client.connect();
    await client.request("event.subscribe", { topics: ["*"], scope: "global" });
    const workspace = await client.request("workspace.open", { path: repositoryRoot });
    const created = await client.request("session.create", { mode: "chat", workspace_id: workspace.workspace.workspace_id, title: "TS E2E" });
    const sent = await client.request("session.send_message", { session_id: created.session_id, content: "Read package.json and answer E2E_OK", client_message_id: "ts-e2e-message" });
    const finished = await client.waitFor((event) => event.type === "run.finished" && event.run_id === sent.run_id);
    assert.equal(finished.status, "success");

    const history = await waitForHistory(client, created.session_id);
    const session = await client.request("session.get", { session_id: created.session_id });
    const runEvents = client.events.filter((event) => event.run_id === sent.run_id);
    assert.ok(runEvents.some((event) => event.type === "tool.call_finished"));
    assert.ok(runEvents.some((event) => event.type === "llm.usage"));
    assert.equal(session.session.latest_run_id, sent.run_id);
    assert.ok(history.run_stats[sent.run_id]);

    await client.request("core.shutdown", {}); client.close(); client = null;
    await waitForExit(daemon, 5_000);
    const traceRows = (await readFile(path.join(dataRoot, "structured.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const directions = new Set(traceRows.map((row) => row.direction));
    assert.ok(directions.has("CLIENT→CORE")); assert.ok(directions.has("CORE→CLIENT"));
    assert.ok(directions.has("CORE→LLM")); assert.ok(directions.has("LLM→CORE"));
    const sessions = await readdir(path.join(dataRoot, "sessions"));

    console.log(JSON.stringify({
      status: "passed", daemon_version: "ts-0.2.0", cli_tool_round_trip: true,
      session_id: created.session_id, run_id: sent.run_id, assistant: history.messages.at(-1)?.content,
      event_types: [...new Set(runEvents.map((event) => event.type))], trace_records: traceRows.length,
      trace_directions: [...directions], persisted_sessions: sessions.length, mock_requests: mock.requests(), daemon_exited: daemon.exitCode !== null,
    }, null, 2));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nDaemon output:\n${daemonOutput}`);
  } finally {
    client?.close();
    if (daemon.exitCode === null) daemon.kill("SIGTERM");
    await mock.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function waitForHistory(client: RpcClient, sessionId: string): Promise<any> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const history = await client.request("session.get_history", { session_id: sessionId });
    if (history.messages.some((message: any) => message.role === "assistant" && String(message.content).includes("E2E_OK")) && Object.keys(history.run_stats).length) return history;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Session history and run statistics were not persisted");
}

async function startMockProvider(): Promise<{ port: number; requests: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server = createServer((request, response) => {
    let raw = ""; request.setEncoding("utf8"); request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests += 1; const body = JSON.parse(raw || "{}");
      const hasToolResult = Array.isArray(body.messages) && body.messages.some((message: any) => message.role === "tool");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const emit = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (hasToolResult) emit({ choices: [{ delta: { content: "E2E_OK" } }] });
      else emit({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-read-${requests}`, function: { name: "read_file", arguments: JSON.stringify({ path: "package.json" }) } }] } }] });
      emit({ choices: [], usage: { prompt_tokens: hasToolResult ? 20 : 12, completion_tokens: hasToolResult ? 3 : 4 } });
      response.end("data: [DONE]\n\n");
    });
  });
  const port = await listen(server);
  return { port, requests: () => requests, close: () => closeServer(server) };
}

async function availablePort(): Promise<number> { const server = createServer(); const port = await listen(server); await closeServer(server); return port; }
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Unable to allocate test port"); return address.port;
}
async function closeServer(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
async function waitUntilReady(port: number, env: NodeJS.ProcessEnv, daemon: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (daemon.exitCode !== null) throw new Error(`Daemon exited before becoming ready (${daemon.exitCode})`);
    try { await execute(process.execPath, ["packages/cli/dist/main.js", "ping"], { cwd: repositoryRoot, env, timeout: 2_000 }); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(`Daemon did not listen on port ${port}`);
}
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Daemon did not exit after core.shutdown")), timeoutMs)),
  ]);
}

await main();
