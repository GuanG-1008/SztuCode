import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./tools.js";

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };
export type McpToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };

export class McpClient {
  private id = 0; private readonly pending = new Map<string, Pending>(); private buffer = ""; private process: ChildProcessWithoutNullStreams | null = null; private socket: net.Socket | null = null;
  async connectStdio(command: string, args: string[] = [], env: Record<string, string> = {}): Promise<void> { this.process = spawn(command, args, { stdio: "pipe", env: { ...process.env, ...env }, windowsHide: true }); this.process.stdout.setEncoding("utf8"); this.process.stdout.on("data", (chunk: string) => this.receive(chunk)); await this.initialize(); }
  async connectTcp(host: string, port: number): Promise<void> { this.socket = net.createConnection({ host, port }); this.socket.setEncoding("utf8"); this.socket.on("data", (chunk: string) => this.receive(chunk)); await new Promise<void>((resolve, reject) => { this.socket!.once("connect", resolve); this.socket!.once("error", reject); }); await this.initialize(); }
  async listTools(): Promise<McpToolDefinition[]> { const result = await this.call("tools/list", {}); return (result.tools as McpToolDefinition[] | undefined) ?? []; }
  async callTool(name: string, arguments_: Record<string, unknown>): Promise<string> { const result = await this.call("tools/call", { name, arguments: arguments_ }); return Array.isArray(result.content) ? result.content.filter((item): item is { type: string; text?: string } => !!item && typeof item === "object").filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") : ""; }
  async close(): Promise<void> { this.process?.kill(); this.socket?.destroy(); }
  private async initialize(): Promise<void> { await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sztucode-ts", version: "0.2.0" } }); this.notify("notifications/initialized", {}); }
  private call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> { const id = String(++this.id); this.send({ jsonrpc: "2.0", id, method, params }); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  private notify(method: string, params: Record<string, unknown>): void { this.send({ jsonrpc: "2.0", method, params }); }
  private send(message: Record<string, unknown>): void { const line = `${JSON.stringify(message)}\n`; if (this.process) this.process.stdin.write(line); else if (this.socket) this.socket.write(line); else throw new Error("MCP client is not connected"); }
  private receive(chunk: string): void { this.buffer += chunk; let newline = this.buffer.indexOf("\n"); while (newline >= 0) { const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); newline = this.buffer.indexOf("\n"); try { const message = JSON.parse(line) as { id?: string | number; result?: Record<string, unknown>; error?: { message?: string } }; const id = String(message.id ?? ""); const pending = this.pending.get(id); if (!pending) continue; this.pending.delete(id); if (message.error) pending.reject(new Error(message.error.message ?? "MCP error")); else pending.resolve(message.result ?? {}); } catch { /* ignore non-JSON output */ } } }
}

export function mcpTool(client: McpClient, definition: McpToolDefinition, prefix = "mcp"): Tool {
  return { name: `${prefix}__${definition.name}`, description: definition.description, permission: "danger_full_access", schema: definition.inputSchema, async invoke(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> { try { return { ok: true, output: await client.callTool(definition.name, params) }; } catch (error) { return { ok: false, output: "", error: error instanceof Error ? error.message : String(error), errorType: "runtime_error" }; } } };
}

export type McpServerConfig = { command?: string; args?: string[]; env?: Record<string, string>; host?: string; port?: number; enabled?: boolean };
export class McpManager {
  private readonly clients: McpClient[] = []; private readonly tools: Tool[] = []; private readonly states: Array<{ name: string; status: string; tool_count: number; error?: string }> = [];
  constructor(private readonly configPath = process.env.SZTU_MCP_CONFIG ?? "") {}
  async load(): Promise<void> {
    if (!this.configPath) return;
    let servers: Record<string, McpServerConfig>; try { const { readFile } = await import("node:fs/promises"); const payload = JSON.parse(await readFile(this.configPath, "utf8")) as { mcpServers?: Record<string, McpServerConfig> }; servers = payload.mcpServers ?? {}; } catch { return; }
    for (const [name, config] of Object.entries(servers)) {
      if (config.enabled === false) continue; const client = new McpClient();
      try { if (config.command) await client.connectStdio(config.command, config.args ?? [], config.env ?? {}); else if (config.host && config.port) await client.connectTcp(config.host, config.port); else throw new Error("command or host/port is required"); const definitions = await client.listTools(); this.clients.push(client); this.tools.push(...definitions.map((definition) => mcpTool(client, definition, `mcp__${name}`))); this.states.push({ name, status: "connected", tool_count: definitions.length }); } catch (error) { await client.close(); this.states.push({ name, status: "failed", tool_count: 0, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  listTools(): Tool[] { return [...this.tools]; }
  statuses(): Array<{ name: string; status: string; tool_count: number; error?: string }> { return [...this.states]; }
  async close(): Promise<void> { await Promise.all(this.clients.map((client) => client.close())); this.clients.length = 0; this.tools.length = 0; this.states.length = 0; }
}
