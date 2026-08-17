import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const sources = [
  [resolve(repositoryRoot, "packages/runtime-ts/skills"), resolve(packageRoot, "skills")],
  [resolve(repositoryRoot, "packages/runtime-ts/prompts"), resolve(packageRoot, "prompts")],
  [resolve(repositoryRoot, "packages/runtime-ts/agents"), resolve(packageRoot, "agents")],
];
for (const [source, target] of sources) {
  if (!existsSync(source)) throw new Error(`Missing build output: ${source}`);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, filter: (entry) => !entry.includes("__pycache__") && !entry.endsWith(".pyc") });
}
const cliSource = resolve(repositoryRoot, "packages/cli/dist/main.js"); const cliTarget = resolve(packageRoot, "cli");
if (!existsSync(cliSource)) throw new Error(`Missing build output: ${cliSource}`);
rmSync(cliTarget, { recursive: true, force: true });
cpSync(cliSource, resolve(cliTarget, "main.js"), { recursive: false });
const runtimeTarget = resolve(packageRoot, "runtime"); rmSync(runtimeTarget, { recursive: true, force: true }); mkdirSync(runtimeTarget, { recursive: true });
const runtimeSource = resolve(repositoryRoot, "packages/runtime-ts/src/main.ts");
const esbuild = resolve(repositoryRoot, "node_modules/esbuild/bin/esbuild");
const bundled = await import("node:child_process").then(({ spawnSync }) => spawnSync(process.execPath, [esbuild, runtimeSource, "--bundle", "--platform=node", "--format=esm", `--outfile=${resolve(runtimeTarget, "main.js")}`], { cwd: repositoryRoot, stdio: "inherit", windowsHide: true }));
if (bundled.status !== 0) process.exit(bundled.status ?? 1);
console.log("Bundled the TypeScript runtime and CLI for npm publishing.");
