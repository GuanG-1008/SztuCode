import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ContentBlock } from "./context.js";

export type SessionStatus = "active" | "waiting_for_input" | "closed";
export type SessionMode = "one_shot" | "chat";
export type SessionMessage = { role: "user" | "assistant"; content: string | ContentBlock[]; ts: string; run_id?: string };
export type SessionRunEvent = { type: string; run_id?: string; [key: string]: unknown };
export type RunStats = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; elapsed_s: number; context_pct: number };
export type Session = { id: string; mode: SessionMode; status: SessionStatus; title: string; created_at: string; updated_at: string; run_ids: string[]; run_stats: Record<string, RunStats>; archived: boolean; pinned: boolean; workspace_id: string | null };

export class SessionStore {
  constructor(private readonly root: string = path.join(process.env.SZTU_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.cwd(), ".sztu"), "sessions")) {}
  async create(mode: SessionMode = "chat", workspaceId: string | null = null, title = ""): Promise<Session> {
    const id = randomUUID(); const ts = new Date().toISOString();
    const session: Session = { id, mode, status: "active", title: title.trim().slice(0, 200) || "新会话", created_at: ts, updated_at: ts, run_ids: [], run_stats: {}, archived: false, pinned: false, workspace_id: workspaceId };
    await this.save(session); return session;
  }
  async get(id: string): Promise<Session> { return JSON.parse(await readFile(path.join(this.root, id, "meta.json"), "utf8")) as Session; }
  async rename(id: string, title: string): Promise<Session> { const session = await this.get(id); session.title = title.trim().slice(0, 200); session.updated_at = new Date().toISOString(); await this.save(session); return session; }
  async setArchived(id: string, archived: boolean): Promise<Session> { const session = await this.get(id); session.archived = archived; if (archived) session.pinned = false; else if (session.mode === "chat") session.status = "waiting_for_input"; session.updated_at = new Date().toISOString(); await this.save(session); return session; }
  async setPinned(id: string, pinned: boolean): Promise<Session> { const session = await this.get(id); if (pinned && session.archived) throw new Error("archived session cannot be pinned"); session.pinned = pinned; session.updated_at = new Date().toISOString(); await this.save(session); return session; }
  async close(id: string): Promise<Session> { const session = await this.get(id); session.status = "closed"; session.updated_at = new Date().toISOString(); await this.save(session); return session; }
  async setStatus(id: string, status: SessionStatus): Promise<Session> { const session = await this.get(id); session.status = status; session.updated_at = new Date().toISOString(); await this.save(session); return session; }
  async delete(id: string): Promise<void> { const { rm } = await import("node:fs/promises"); await rm(path.join(this.root, id), { recursive: true, force: true }); }
  async list(includeArchived = false): Promise<Session[]> {
    await mkdir(this.root, { recursive: true }); const result: Session[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try { const session = await this.get(entry.name); if (includeArchived || !session.archived) result.push(session); } catch { /* ignore incomplete sessions */ }
    }
    return result.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
  }
  async appendMessage(id: string, message: Omit<SessionMessage, "ts"> & { ts?: string }): Promise<void> {
    await mkdir(path.join(this.root, id), { recursive: true });
    const row = { ...message, ts: message.ts ?? new Date().toISOString() };
    await writeFile(path.join(this.root, id, "thread.jsonl"), `${JSON.stringify(row)}\n`, { encoding: "utf8", flag: "a" });
    const session = await this.get(id); session.updated_at = row.ts; if (message.role === "user" && session.title === "新会话") session.title = (typeof message.content === "string" ? message.content : "图片消息").slice(0, 80); await this.save(session);
  }
  async history(id: string): Promise<SessionMessage[]> {
    try { return (await readFile(path.join(this.root, id, "thread.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SessionMessage); } catch { return []; }
  }
  async appendRunEvent(id: string, event: SessionRunEvent): Promise<void> { await mkdir(path.join(this.root, id, "runs"), { recursive: true }); await writeFile(path.join(this.root, id, "runs", `${event.run_id ?? "unknown"}.jsonl`), `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" }); }
  async contextInjections(id: string): Promise<Array<{ run_id: string; source: string; label: string; chars: number; preview: string; text: string; ts: string }>> {
    const output: Array<{ run_id: string; source: string; label: string; chars: number; preview: string; text: string; ts: string }> = [];
    try { for (const entry of await readdir(path.join(this.root, id, "runs"), { withFileTypes: true })) { if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue; const lines = (await readFile(path.join(this.root, id, "runs", entry.name), "utf8")).split(/\r?\n/).filter(Boolean); for (const line of lines) { try { const event = JSON.parse(line) as Record<string, unknown>; if (event.type !== "context.injected") continue; const text = String(event.text ?? event.preview ?? ""); output.push({ run_id: String(event.run_id ?? entry.name.slice(0, -6)), source: String(event.source ?? "system"), label: String(event.label ?? "上下文注入"), chars: Number(event.chars ?? text.length), preview: String(event.preview ?? text.slice(0, 160)), text, ts: String(event.ts ?? "") }); } catch { /* ignore corrupt event rows */ } } } } catch { /* no run event directory */ }
    return output.sort((a, b) => a.ts.localeCompare(b.ts));
  }
  async replaceHistory(id: string, messages: Array<Omit<SessionMessage, "ts"> & { ts?: string }>): Promise<void> {
    const session = await this.get(id); const updatedAt = new Date().toISOString(); const file = path.join(this.root, id, "thread.jsonl");
    try { const { copyFile } = await import("node:fs/promises"); await copyFile(file, `${file}.${Date.now()}.bak`); } catch { /* no existing history */ }
    const rows = messages.map((message) => ({ ...message, ts: message.ts ?? updatedAt }));
    await writeFile(file, rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "", "utf8");
    session.updated_at = updatedAt; await this.save(session);
  }
  async attachRun(id: string, runId: string): Promise<void> { const session = await this.get(id); if (!session.run_ids.includes(runId)) session.run_ids.push(runId); session.updated_at = new Date().toISOString(); await this.save(session); }
  async recordRunStats(id: string, runId: string, stats: RunStats): Promise<void> { const session = await this.get(id); session.run_stats ??= {}; session.run_stats[runId] = stats; session.updated_at = new Date().toISOString(); await this.save(session); }
  private async save(session: Session): Promise<void> { const dir = path.join(this.root, session.id); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "meta.json"), `${JSON.stringify({ ...session, run_stats: session.run_stats ?? {} }, null, 2)}\n`, "utf8"); }
}
