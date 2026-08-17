import { spawnSync } from "node:child_process";
import { cp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

async function walk(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }
  return files;
}

export async function prepareSkillAssets(source, target, repositoryRoot) {
  await rm(target, { recursive: true, force: true });
  await cp(source, target, {
    recursive: true,
    filter: (entry) => !entry.includes("__pycache__") && !entry.endsWith(".pyc"),
  });

  const files = await walk(target);
  const scripts = files.filter((file) => file.endsWith(".ts") && path.basename(path.dirname(file)) === "scripts");
  const esbuild = path.join(repositoryRoot, "node_modules", "esbuild", "bin", "esbuild");
  for (const script of scripts) {
    const output = script.slice(0, -3) + ".mjs";
    const result = spawnSync(process.execPath, [esbuild, script, "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`], {
      cwd: repositoryRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`Failed to compile skill script: ${script}`);
    await unlink(script);
  }

  if (scripts.length === 0) return;
  const scriptNames = new Set(scripts.map((file) => path.basename(file, ".ts")));
  for (const file of files.filter((candidate) => candidate.endsWith(".md"))) {
    const original = await readFile(file, "utf8");
    const updated = original.replace(/\b(?:(npx\s+tsx)\s+)?((?:\.\.\/|\.\/)?(?:[^\s`"']+\/)?scripts\/([\w-]+))\.ts\b/g, (match, runner, scriptPath, name) => {
      if (!scriptNames.has(name)) return match;
      return `${runner ? "node " : ""}${scriptPath}.mjs`;
    });
    if (updated !== original) await writeFile(file, updated, "utf8");
  }
}
