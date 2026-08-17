import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const output = path.join(desktopRoot, "src-tauri", "resources", "runtime", "main.js");
const runtimeRoot = path.dirname(output);
await rm(runtimeRoot, { recursive: true, force: true }); await mkdir(runtimeRoot, { recursive: true });
const esbuild = path.join(repositoryRoot, "node_modules", "esbuild", "bin", "esbuild");
const result = spawnSync(process.execPath, [esbuild, path.join(repositoryRoot, "packages", "runtime-ts", "src", "main.ts"), "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`], { cwd: repositoryRoot, stdio: "inherit", windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
for (const directory of ["skills", "prompts", "agents"]) await cp(path.join(repositoryRoot, "packages", "runtime-ts", directory), path.join(runtimeRoot, directory), { recursive: true });
