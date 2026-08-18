import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  const nativeEsbuild = process.platform === "win32"
    ? path.join(repositoryRoot, "node_modules", "@esbuild", `win32-${process.arch === "ia32" ? "ia32" : process.arch === "arm64" ? "arm64" : "x64"}`, "esbuild.exe")
    : esbuild;
  const esbuildCommand = (await import("node:fs")).existsSync(nativeEsbuild) ? nativeEsbuild : esbuild;
  const esbuildIsScript = esbuildCommand === esbuild && readFileSync(esbuild).subarray(0, 2).toString() === "#!/";
  for (const script of scripts) {
    const output = script.slice(0, -3) + ".mjs";
    const args = [script, "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`];
    const result = spawnSync(esbuildIsScript ? process.execPath : esbuildCommand, esbuildIsScript ? [esbuildCommand, ...args] : args, {
      cwd: repositoryRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`Failed to compile skill script: ${script}`);
  }
  await Promise.all(scripts.map((script) => unlink(script)));

  if (scripts.length === 0) return;
  const scriptNames = new Set(scripts.map((file) => path.basename(file, ".ts")));
  for (const file of files.filter((candidate) => candidate.endsWith(".md"))) {
    const original = await readFile(file, "utf8");
    const updated = original.split(/(?<=\n)/).map((line) => {
      let rewritten = line;
      let referencesCompiledScript = false;
      for (const name of scriptNames) {
        const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.ts\\b`, "g");
        if (pattern.test(rewritten)) { referencesCompiledScript = true; rewritten = rewritten.replace(pattern, `${name}.mjs`); }
      }
      return referencesCompiledScript ? rewritten.replace(/\bnpx\s+tsx\b/g, "node") : rewritten;
    }).join("");
    if (updated !== original) await writeFile(file, updated, "utf8");
  }
}
