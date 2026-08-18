import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSkillAssets } from "../../scripts/prepare-skill-assets.js";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const output = path.join(desktopRoot, "src-tauri", "resources", "runtime", "main.js");
const runtimeRoot = path.dirname(output);
await rm(runtimeRoot, { recursive: true, force: true }); await mkdir(runtimeRoot, { recursive: true });
// Ship Node with the desktop bundle so installed clients can start the local daemon.
const bundledNode = path.join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node");
await cp(process.execPath, bundledNode);
if (process.platform !== "win32") await chmod(bundledNode, 0o755);
const esbuild = path.join(repositoryRoot, "node_modules", "esbuild", "bin", "esbuild");
const esbuildArgs = [path.join(repositoryRoot, "packages", "runtime-ts", "src", "main.ts"), "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`];
const esbuildIsScript = readFileSync(esbuild).subarray(0, 2).toString() === "#!/";
const result = spawnSync(esbuildIsScript ? process.execPath : esbuild, esbuildIsScript ? [esbuild, ...esbuildArgs] : esbuildArgs, { cwd: repositoryRoot, stdio: "inherit", windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
await prepareSkillAssets(path.join(repositoryRoot, "packages", "runtime-ts", "skills"), path.join(runtimeRoot, "skills"), repositoryRoot);
for (const directory of ["prompts", "agents"]) await cp(path.join(repositoryRoot, "packages", "runtime-ts", directory), path.join(runtimeRoot, directory), { recursive: true });
