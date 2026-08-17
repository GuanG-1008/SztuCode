import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkspaceManager } from "./workspace-manager.js";

const exec = promisify(execFile);
export type ChangeSummary = { path: string; index_status: string; worktree_status: string; additions?: number; deletions?: number; run_id?: string | null; agent_owned?: boolean; revertible?: boolean };

export class GitManager {
  constructor(private readonly workspaces: WorkspaceManager) {}
  private async cwd(id: string): Promise<string> { return (await this.workspaces.get(id)).path; }
  async list(id: string): Promise<ChangeSummary[]> {
    const cwd = await this.cwd(id); try { const { stdout } = await exec("git", ["status", "--porcelain=v1"], { cwd }); return stdout.split(/\r?\n/).filter(Boolean).map((line) => ({ index_status: line[0] ?? " ", worktree_status: line[1] ?? " ", path: line.slice(3).trim() })); } catch { return []; }
  }
  async diff(id: string, file?: string | null): Promise<string> { const cwd = await this.cwd(id); const args = ["diff", "--no-ext-diff", "--", ...(file ? [file] : [])]; try { return (await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout; } catch { return ""; } }
  async stage(id: string, paths: string[]): Promise<string[]> { const cwd = await this.cwd(id); await exec("git", ["add", "--", ...paths], { cwd }); return paths; }
  async unstage(id: string, paths: string[]): Promise<string[]> { const cwd = await this.cwd(id); await exec("git", ["restore", "--staged", "--", ...paths], { cwd }); return paths; }
  async discard(id: string, paths: string[]): Promise<string[]> { const cwd = await this.cwd(id); await exec("git", ["restore", "--worktree", "--", ...paths], { cwd }); return paths; }
  async commit(id: string, message: string): Promise<string> { const cwd = await this.cwd(id); const result = await exec("git", ["commit", "-m", message], { cwd }); return (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim() || result.stdout.trim(); }
  async history(id: string, limit = 100, skip = 0): Promise<{ commits: Array<Record<string, unknown>>; has_more: boolean }> {
    const cwd = await this.cwd(id); const { stdout } = await exec("git", ["log", `--max-count=${limit + 1}`, `--skip=${skip}`, "--format=%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s"], { cwd }); const rows = stdout.split(/\r?\n/).filter(Boolean).map((row) => { const [hash, short_hash, parents, author, date, subject] = row.split("\x1f"); return { hash, short_hash, parents: parents ? parents.split(" ") : [], author, date, subject, is_head: false, is_outgoing: false, refs: [] }; }); return { commits: rows.slice(0, limit), has_more: rows.length > limit };
  }
}
