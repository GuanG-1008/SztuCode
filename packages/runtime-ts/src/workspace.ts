import path from "node:path";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";

export class WorkspaceBoundaryError extends Error {}

export class Workspace {
  readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }

  resolve(relativePath: string): string {
    const candidate = path.resolve(this.root, relativePath);
    const relative = path.relative(this.root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new WorkspaceBoundaryError(`Path escapes workspace: ${relativePath}`);
    return candidate;
  }

  async read(relativePath: string): Promise<string> { return readFile(this.resolve(relativePath), "utf8"); }
  async write(relativePath: string, content: string): Promise<void> { await writeFile(this.resolve(relativePath), content, "utf8"); }
  async list(relativePath = ".", maxDepth = 2, maxEntries = 200): Promise<string[]> {
    const root = this.resolve(relativePath); const output: string[] = [`${root}/`]; let count = 0;
    const walk = async (directory: string, depth: number, prefix: string): Promise<void> => {
      if (depth > maxDepth || count >= maxEntries) return;
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => Number(a.isFile()) - Number(b.isFile()) || a.name.localeCompare(b.name));
      for (let index = 0; index < entries.length && count < maxEntries; index += 1) {
        const entry = entries[index]; const last = index === entries.length - 1; const suffix = entry.isDirectory() ? "/" : "";
        output.push(`${prefix}${last ? "└── " : "├── "}${entry.name}${suffix}`); count += 1;
        if (entry.isDirectory() && depth < maxDepth) await walk(path.join(directory, entry.name), depth + 1, `${prefix}${last ? "    " : "│   "}`);
      }
      if (count >= maxEntries) output.push(`${prefix}... (truncated)`);
    };
    if (!(await stat(root)).isDirectory()) throw new Error(`not a directory: ${relativePath}`);
    await walk(root, 1, ""); return output;
  }
}
