import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

type State = { content: Buffer; digest: string };
type RecordEntry = { path: string; before_exists: boolean; before_digest?: string; after_exists: boolean; after_digest?: string; before_snapshot?: string; revertible: boolean };
const ignored = new Set([".git", "node_modules", ".venv", ".sztu", "dist", "build", "__pycache__"]);
const digest = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const ignoredPath = (relative: string) => relative.split(/[\\/]/).some((part) => ignored.has(part)) || /\.(pyc|pyo)$/i.test(relative);

export class WorkspaceChangeTracker {
  private before = new Map<string, State>();
  constructor(private readonly workspaceRoot: string, private readonly runId: string, private readonly runRoot = path.join(process.env.SZTU_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.cwd(), ".sztu"), "runs")) {}
  async capture(): Promise<void> { this.before = await this.snapshot(); }
  async finalize(): Promise<RecordEntry[]> {
    const after = await this.snapshot(); const records: RecordEntry[] = []; const snapshotRoot = path.join(this.runRoot, this.runId, "change-snapshots");
    for (const relative of [...new Set([...this.before.keys(), ...after.keys()])].sort()) {
      const previous = this.before.get(relative); const current = after.get(relative); if (previous && current && previous.digest === current.digest) continue;
      const record: RecordEntry = { path: relative, before_exists: Boolean(previous), before_digest: previous?.digest, after_exists: Boolean(current), after_digest: current?.digest, revertible: true };
      if (previous) { await mkdir(snapshotRoot, { recursive: true }); const name = `${records.length.toString().padStart(4, "0")}.bin`; await writeFile(path.join(snapshotRoot, name), previous.content); record.before_snapshot = name; }
      records.push(record);
    }
    const manifestRoot = path.join(this.runRoot, this.runId); await mkdir(manifestRoot, { recursive: true });
    await writeFile(path.join(manifestRoot, "changes.json"), `${JSON.stringify({ version: 1, run_id: this.runId, workspace_path: path.resolve(this.workspaceRoot), changes: records }, null, 2)}\n`, "utf8"); return records;
  }
  private async snapshot(): Promise<Map<string, State>> {
    const output = new Map<string, State>(); let total = 0;
    const walk = async (directory: string) => {
      let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const target = path.join(directory, entry.name); const relative = path.relative(this.workspaceRoot, target).split(path.sep).join("/"); if (ignoredPath(relative)) continue;
        if (entry.isDirectory()) { await walk(target); continue; } if (!entry.isFile()) continue;
        try { const info = await stat(target); if (info.size > 1_000_000 || total + info.size > 32 * 1024 * 1024) continue; const content = await readFile(target); total += content.length; output.set(relative, { content, digest: digest(content) }); } catch { /* concurrent/deleted file */ }
      }
    }; await walk(path.resolve(this.workspaceRoot)); return output;
  }
}

export async function revertRunChanges(runId: string, workspaceRoot: string, paths: string[], runRoot = path.join(process.env.SZTU_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.cwd(), ".sztu"), "runs")): Promise<{ reverted_paths: string[]; blocked_paths: Record<string, string> }> {
  const root = path.resolve(workspaceRoot); const manifestPath = path.join(runRoot, runId, "changes.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { workspace_path?: string; changes?: RecordEntry[] };
  if (manifest.workspace_path !== root || !Array.isArray(manifest.changes)) throw new Error("agent change record not found for this workspace"); if (!paths.length) throw new Error("select one or more agent-owned files to revert");
  const known = new Map(manifest.changes.map((entry) => [entry.path, entry])); const reverted: string[] = []; const blocked: Record<string, string> = {};
  for (const relative of [...new Set(paths)].sort()) {
    const entry = known.get(relative); if (!entry) { blocked[relative] = "path is not owned by this run"; continue; }
    const target = path.resolve(root, relative); if (path.relative(root, target).startsWith("..")) { blocked[relative] = "invalid recorded path"; continue; }
    try { const exists = await stat(target).then(() => true).catch(() => false); if (exists !== entry.after_exists) { blocked[relative] = "file changed since this Agent run; nothing was overwritten"; continue; } if (exists && digest(await readFile(target)) !== entry.after_digest) { blocked[relative] = "file changed since this Agent run; nothing was overwritten"; continue; }
      if (entry.before_exists) { if (!entry.before_snapshot) { blocked[relative] = "missing pre-run snapshot"; continue; } await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, await readFile(path.join(runRoot, runId, "change-snapshots", entry.before_snapshot))); } else if (exists) await unlink(target); reverted.push(relative);
    } catch { blocked[relative] = "unable to read or restore file"; }
  }
  return { reverted_paths: reverted, blocked_paths: blocked };
}

export async function activeRunChanges(runId: string, workspaceRoot: string, runRoot = path.join(process.env.SZTU_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.cwd(), ".sztu"), "runs")): Promise<Array<{ path: string; index_status: string; worktree_status: string; run_id: string; agent_owned: true; revertible: boolean }>> {
  try {
    const root = path.resolve(workspaceRoot); const manifest = JSON.parse(await readFile(path.join(runRoot, runId, "changes.json"), "utf8")) as { workspace_path?: string; changes?: RecordEntry[] };
    if (manifest.workspace_path !== root || !Array.isArray(manifest.changes)) return [];
    const output = [];
    for (const entry of manifest.changes) {
      const target = path.resolve(root, entry.path); if (path.relative(root, target).startsWith("..")) continue;
      const exists = await stat(target).then(() => true).catch(() => false); if (exists !== entry.after_exists) continue;
      if (exists && digest(await readFile(target)) !== entry.after_digest) continue;
      output.push({ path: entry.path, index_status: " ", worktree_status: entry.before_exists && entry.after_exists ? "M" : entry.after_exists ? "?" : "D", run_id: runId, agent_owned: true as const, revertible: entry.revertible });
    }
    return output;
  } catch { return []; }
}

export async function runChangeDiff(runId: string, workspaceRoot: string, relative: string, runRoot = path.join(process.env.SZTU_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.cwd(), ".sztu"), "runs")): Promise<string | null> {
  try {
    const root = path.resolve(workspaceRoot); const manifest = JSON.parse(await readFile(path.join(runRoot, runId, "changes.json"), "utf8")) as { workspace_path?: string; changes?: RecordEntry[] };
    const entry = manifest.changes?.find((item) => item.path === relative); if (manifest.workspace_path !== root || !entry) return null;
    const before = entry.before_exists && entry.before_snapshot ? await readFile(path.join(runRoot, runId, "change-snapshots", entry.before_snapshot)) : Buffer.alloc(0);
    const after = entry.after_exists ? await readFile(path.resolve(root, relative)) : Buffer.alloc(0); if (before.subarray(0, 8192).includes(0) || after.subarray(0, 8192).includes(0)) return null;
    const beforeLines = before.toString("utf8").split(/\r?\n/); const afterLines = after.toString("utf8").split(/\r?\n/);
    return [`--- a/${relative}`, `+++ b/${relative}`, `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`, ...beforeLines.map((line) => `-${line}`), ...afterLines.map((line) => `+${line}`)].join("\n");
  } catch { return null; }
}
