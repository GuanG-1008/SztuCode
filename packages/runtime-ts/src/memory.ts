import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./tools.js";
import type { SessionStore } from "./session-store.js";

type MemoryLayer = "global" | "project" | "session";
type MemoryDocument = { name: MemoryLayer; content: string; source: string };

export class MemoryCatalog {
  private readonly documents = new Map<MemoryLayer, MemoryDocument>();

  constructor(documents: MemoryDocument[], private readonly inlineChars = 2_000) {
    for (const document of documents) if (document.content.trim()) this.documents.set(document.name, { ...document, content: document.content.trim() });
  }

  requiresReader(): boolean { return [...this.documents.values()].some((document) => document.content.length > this.inlineChars); }

  prompt(): string {
    const sections = [...this.documents.values()].map((document) => `## ${capitalize(document.name)} memory\n${this.promptContent(document)}`);
    if (!sections.length) return "";
    return `# Persistent memory\n${sections.join("\n\n")}`;
  }

  read(layer: string, query = "", offset = 0, limit = 1_600): string {
    const document = this.documents.get(layer as MemoryLayer);
    if (!document) throw new Error(`memory layer not found: ${layer}; available: ${[...this.documents.keys()].join(", ") || "none"}`);
    const safeLimit = Math.min(4_000, Math.max(1, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    if (query.trim()) return searchExcerpt(document.content, query.trim(), safeOffset, safeLimit);
    const excerpt = document.content.slice(safeOffset, safeOffset + safeLimit);
    const nextOffset = safeOffset + excerpt.length;
    return `${excerpt}\n\n[memory page: ${layer}, chars ${safeOffset}:${nextOffset}/${document.content.length}${nextOffset < document.content.length ? `, next_offset=${nextOffset}` : ", end"}]`;
  }

  private promptContent(document: MemoryDocument): string {
    if (document.content.length <= this.inlineChars) return document.content;
    const headings = document.content.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.replace(/^#+\s+/, "").slice(0, 120)).slice(0, 16);
    return `[Progressive memory: ${document.content.length} characters, source: ${document.source}]\nAvailable topics:\n${headings.length ? headings.map((heading) => `- ${heading}`).join("\n") : "- (no Markdown headings; use query search or paged reading)"}\nUse memory_read with layer="${document.name}" and a focused query.`;
  }
}

export async function loadMemoryCatalog(workspaceRoot: string, sessions?: SessionStore, sessionId?: string): Promise<MemoryCatalog> {
  const homeRoot = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
  const [globalMemory, projectMemory, sessionMemory] = await Promise.all([
    readText(path.join(homeRoot, ".sztu", "context.md")),
    readText(path.join(workspaceRoot, ".sztu", "context.md")),
    sessions && sessionId ? sessions.readNotes(sessionId) : Promise.resolve(""),
  ]);
  return new MemoryCatalog([
    { name: "global", content: globalMemory, source: "~/.sztu/context.md" },
    { name: "project", content: projectMemory, source: ".sztu/context.md" },
    { name: "session", content: sessionMemory, source: "session/notes.md" },
  ]);
}

export function createMemoryTools(catalog: MemoryCatalog, sessions?: SessionStore, sessionId?: string, runId = ""): Tool[] {
  const tools: Tool[] = [];
  if (catalog.requiresReader()) tools.push({ name: "memory_read", description: "Read a bounded excerpt from global, project, or session memory", permission: "read_only", schema: { type: "object", properties: { layer: { type: "string", enum: ["global", "project", "session"] }, query: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 4000 } }, required: ["layer"] }, async invoke(params) { try { return { ok: true, output: catalog.read(String(params.layer ?? ""), String(params.query ?? ""), Number(params.offset ?? 0), Number(params.limit ?? 1600)) }; } catch (error) { return { ok: false, output: "", error: error instanceof Error ? error.message : String(error), errorType: "runtime_error" }; } } });
  if (sessions && sessionId) {
    tools.push({ name: "note_save", description: "Save a concise durable fact or decision to this session", permission: "workspace_write", schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, async invoke(params) { const content = typeof params.content === "string" ? params.content.trim() : ""; if (!content) return { ok: false, output: "", error: "empty content", errorType: "schema_error" }; const noteId = await sessions.appendNote(sessionId, content, runId); return { ok: true, output: `saved (${noteId})` }; } });
    tools.push({ name: "note_update", description: "Replace an active session note while preserving its supersedes history", permission: "workspace_write", schema: { type: "object", properties: { note_id: { type: "string" }, content: { type: "string" } }, required: ["note_id", "content"] }, async invoke(params) { const noteId = typeof params.note_id === "string" ? params.note_id.trim() : ""; const content = typeof params.content === "string" ? params.content.trim() : ""; if (!noteId || !content) return { ok: false, output: "", error: "note_id and content are required", errorType: "schema_error" }; const nextId = await sessions.updateNote(sessionId, noteId, content, runId); return nextId ? { ok: true, output: `updated (${noteId} -> ${nextId})` } : { ok: false, output: "", error: `note not found: ${noteId}`, errorType: "runtime_error" }; } });
  }
  return tools;
}

const readText = async (file: string) => readFile(file, "utf8").then((text) => text.trim()).catch(() => "");
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function searchExcerpt(content: string, query: string, offset: number, limit: number): string {
  const lines = content.split(/\r?\n/); const needle = query.toLocaleLowerCase();
  const matches = lines.map((line, index) => line.toLocaleLowerCase().includes(needle) ? index : -1).filter((index) => index >= 0);
  if (offset >= matches.length) return `No memory matches for ${JSON.stringify(query)} after match offset ${offset}.`;
  let output = ""; let consumed = 0;
  for (const match of matches.slice(offset)) {
    const chunk = lines.slice(Math.max(0, match - 2), Math.min(lines.length, match + 3)).join("\n").trim(); const next = `${output ? "\n\n---\n\n" : ""}${chunk}`;
    if (output.length + next.length > limit) { output += next.slice(0, Math.max(0, limit - output.length)); break; }
    output += next; consumed += 1;
  }
  const nextMatch = offset + Math.max(1, consumed);
  return `${output}\n\n[memory search: ${JSON.stringify(query)}, matches ${offset + 1}-${Math.min(nextMatch, matches.length)}/${matches.length}${nextMatch < matches.length ? `, next_offset=${nextMatch}` : ", end"}]`;
}
