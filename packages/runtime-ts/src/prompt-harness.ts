import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionMode } from "@sztucode/protocol";

export type PromptRuntimeContext = { permissionMode?: PermissionMode; memoryEnabled?: boolean; toolNames?: Iterable<string>; taskText?: string };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prompts/content");
const toolRules: Array<[string[], string[]]> = [
  [["read_file"], ["read-files"]], [["edit_file"], ["edit-files"]], [["write_file"], ["create-files"]],
  [["glob_search", "list_dir"], ["search-files"]], [["grep_search"], ["search-content"]],
  [["bash"], ["reserve-bash", "sztucode-tool-environment"]], [["spawn_agent"], ["delegate-exploration"]],
  [["task_create", "task_update", "task_list", "task_get"], ["task-management"]],
];
const cautious = /(?:\b(?:delete|remove|drop|reset|rebase|push|publish|deploy|release|overwrite|credential|secret|production)\b|删除|清空|重置|变基|推送|发布|部署|覆盖|密钥|生产环境)/i;
const cache = new Map<string, Promise<Map<string, { content: string; status: "active" | "reference-only" }>>>();

export async function runtimePromptEntries(context: PromptRuntimeContext): Promise<string[]> {
  const tools = new Set(context.toolNames ?? []); const selected: string[] = [];
  for (const [names, prompts] of toolRules) if (names.some((name) => tools.has(name))) selected.push(...prompts);
  if (tools.size > 1) selected.push("parallel-tool-calls");
  const entries: string[] = [];
  for (const id of [...new Set(selected)]) entries.push(await activePrompt("tool-usage-policy", id));
  if (cautious.test(context.taskText ?? "")) entries.push(await activePrompt("executing-actions-with-care", "executing-actions-with-care"));
  if (context.permissionMode === "auto") entries.push(await activePrompt("safety-prompts", "auto-mode"));
  if (context.memoryEnabled) entries.push(await activePrompt("memory-system-prompts", "auto-memory"));
  return entries;
}

export async function composeRuntimePrompt(base: string, context: PromptRuntimeContext): Promise<string> {
  return [base, ...await runtimePromptEntries(context)].filter(Boolean).join("\n\n");
}

async function activePrompt(group: string, id: string): Promise<string> {
  const entry = (await loadGroup(group)).get(id);
  if (!entry) throw new Error(`unknown prompt id: ${group}/${id}`);
  if (entry.status !== "active") throw new Error(`prompt is reference-only: ${group}/${id}`);
  return entry.content;
}

function loadGroup(group: string): Promise<Map<string, { content: string; status: "active" | "reference-only" }>> {
  const existing = cache.get(group); if (existing) return existing;
  const loading = (async () => {
    if (!/^[A-Za-z0-9_-]+$/.test(group)) throw new Error(`invalid prompt group: ${group}`);
    const groupRoot = path.join(root, group); const index = JSON.parse(await readFile(path.join(groupRoot, "index.json"), "utf8")) as { version?: number; sections?: unknown[] };
    if (index.version !== 1 || !Array.isArray(index.sections) || !index.sections.length) throw new Error(`invalid prompt index: ${group}`);
    const output = new Map<string, { content: string; status: "active" | "reference-only" }>();
    for (const raw of index.sections) {
      if (!raw || typeof raw !== "object") throw new Error(`invalid prompt entry: ${group}`);
      const entry = raw as Record<string, unknown>; const id = String(entry.id ?? ""); const file = String(entry.file ?? ""); const rawStatus = entry.status ?? "active";
      if (rawStatus !== "active" && rawStatus !== "reference-only") throw new Error(`invalid prompt status: ${group}/${id}`);
      const status = rawStatus;
      if (!id || output.has(id) || path.basename(file) !== file || path.extname(file) !== ".md") throw new Error(`invalid prompt entry: ${group}/${id}`);
      const content = (await readFile(path.join(groupRoot, file), "utf8")).trim(); if (!content) throw new Error(`empty prompt entry: ${group}/${id}`);
      output.set(id, { content, status });
    }
    return output;
  })();
  cache.set(group, loading); return loading;
}
