import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uri = /^[A-Za-z][A-Za-z0-9+.\-]*:/;
const fence = /^\s{0,3}(`{3,}|~{3,})/;
const link = /(?<!!)(?:\[[^\]]*\])\((?:<([^>]+)>|([^\s)]+))/g;

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(target));
    else if (entry.name.toLowerCase().endsWith(".md") && (target === path.join(root, entry.name) || target.startsWith(path.join(root, "docs")))) files.push(target);
  }
  return files;
}

const broken: string[] = [];
const checks: Promise<void>[] = [];
for (const file of await markdownFiles(root)) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  let activeFence = "";
  lines.forEach((line, lineIndex) => {
    const marker = fence.exec(line);
    if (marker) { if (!activeFence) activeFence = marker[1]; else if (marker[1][0] === activeFence[0] && marker[1].length >= activeFence.length) activeFence = ""; return; }
    if (activeFence) return;
    for (const match of line.matchAll(link)) {
      const target = (match[1] ?? match[2] ?? "").split(/[?#]/, 1)[0];
      if (!target || target.startsWith("/") || target.startsWith("#") || target.startsWith("//") || uri.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
      checks.push(stat(resolved).then(() => undefined, () => { broken.push(`${path.relative(root, file).replaceAll("\\", "/")}:${lineIndex + 1} -> ${target}`); }));
    }
  });
}
await Promise.all(checks);
if (broken.length) { console.error(broken.join("\n")); process.exitCode = 1; } else console.log(`OK: checked Markdown links under ${root}`);
