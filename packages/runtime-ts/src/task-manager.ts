import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type TaskStatus = "pending" | "in_progress" | "completed";
export type PlanTask = { id: number; subject: string; description: string; status: TaskStatus; blocked_by: number[]; created_at: string; updated_at: string };

export class TaskManager {
  constructor(private readonly tasksDir: string) {}

  async create(subject: string, description = "", blockedBy: number[] = []): Promise<PlanTask> {
    const title = subject.trim();
    if (!title) throw new Error("subject is required");
    const dependencies = uniqueIds(blockedBy);
    for (const dependency of dependencies) await this.get(dependency).catch(() => { throw new Error(`blocked_by task ${dependency} not found`); });
    const tasks = await this.listAll();
    const now = new Date().toISOString();
    const task: PlanTask = { id: (tasks.at(-1)?.id ?? 0) + 1, subject: title, description, status: "pending", blocked_by: dependencies, created_at: now, updated_at: now };
    await this.save(task);
    return task;
  }

  async get(taskId: number): Promise<PlanTask> {
    if (!Number.isInteger(taskId) || taskId < 1) throw new Error(`task ${taskId} not found`);
    try { return parseTask(JSON.parse(await readFile(this.filePath(taskId), "utf8"))); }
    catch { throw new Error(`task ${taskId} not found`); }
  }

  async update(taskId: number, options: { status?: TaskStatus; addBlockedBy?: number[]; removeBlockedBy?: number[] }): Promise<PlanTask> {
    const task = await this.get(taskId);
    if (options.status !== undefined && !["pending", "in_progress", "completed"].includes(options.status)) throw new Error(`invalid status: ${options.status}`);
    const add = uniqueIds(options.addBlockedBy ?? []);
    for (const dependency of add) {
      if (dependency === taskId) throw new Error("a task cannot block itself");
      await this.get(dependency).catch(() => { throw new Error(`blocked_by task ${dependency} not found`); });
    }
    if (options.status) task.status = options.status;
    const remove = new Set(uniqueIds(options.removeBlockedBy ?? []));
    task.blocked_by = uniqueIds([...task.blocked_by, ...add]).filter((id) => !remove.has(id));
    task.updated_at = new Date().toISOString();
    await this.save(task);
    if (task.status === "completed") await this.clearDependency(task.id);
    return task;
  }

  async listAll(): Promise<PlanTask[]> {
    let files: string[];
    try { files = await readdir(this.tasksDir); } catch { return []; }
    const tasks = await Promise.all(files.filter((file) => /^task_\d+\.json$/.test(file)).map(async (file) => {
      try { return parseTask(JSON.parse(await readFile(path.join(this.tasksDir, file), "utf8"))); } catch { return null; }
    }));
    return tasks.filter((task): task is PlanTask => task !== null).sort((left, right) => left.id - right.id);
  }

  async formatList(): Promise<string> {
    const tasks = await this.listAll();
    if (!tasks.length) return "No tasks.";
    const marker: Record<TaskStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    return tasks.map((task) => `${marker[task.status]} #${task.id}: ${task.subject}${task.blocked_by.length ? ` (blocked by: ${JSON.stringify(task.blocked_by)})` : ""}`).join("\n");
  }

  private async clearDependency(completedId: number): Promise<void> {
    for (const task of await this.listAll()) {
      if (!task.blocked_by.includes(completedId)) continue;
      task.blocked_by = task.blocked_by.filter((id) => id !== completedId);
      task.updated_at = new Date().toISOString();
      await this.save(task);
    }
  }

  private async save(task: PlanTask): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });
    await writeFile(this.filePath(task.id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }

  private filePath(taskId: number): string { return path.join(this.tasksDir, `task_${taskId}.json`); }
}

function parseTask(value: unknown): PlanTask {
  if (!value || typeof value !== "object") throw new Error("invalid task");
  const item = value as Record<string, unknown>;
  const status = String(item.status ?? "pending") as TaskStatus;
  if (!Number.isInteger(Number(item.id)) || !String(item.subject ?? "").trim() || !["pending", "in_progress", "completed"].includes(status)) throw new Error("invalid task");
  return { id: Number(item.id), subject: String(item.subject), description: String(item.description ?? ""), status, blocked_by: uniqueIds(Array.isArray(item.blocked_by) ? item.blocked_by.map(Number) : []), created_at: String(item.created_at ?? ""), updated_at: String(item.updated_at ?? "") };
}

const uniqueIds = (values: number[]) => [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
