import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const pluginScripts = path.join(repositoryRoot, "packages", "runtime-ts", "skills", "plugin-creator", "scripts");

test("read_marketplace_name prints the configured marketplace name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-marketplace-"));
  const marketplace = path.join(root, "marketplace.json");
  await writeFile(marketplace, '{"name":"team-local"}\n', "utf8");
  const { stdout } = await execute(process.execPath, [tsx, path.join(pluginScripts, "read_marketplace_name.ts"), "--marketplace-path", marketplace]);
  assert.equal(stdout.trim(), "team-local");
});

test("update_plugin_cachebuster replaces an existing suffix", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-plugin-"));
  const manifestDirectory = path.join(root, ".codex-plugin");
  const manifest = path.join(manifestDirectory, "plugin.json");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(manifest, '{"name":"demo","version":"1.2.3+codex.old"}\n', "utf8");
  await execute(process.execPath, [tsx, path.join(pluginScripts, "update_plugin_cachebuster.ts"), root, "--cachebuster", "Test_42"]);
  assert.equal((JSON.parse(await readFile(manifest, "utf8")) as { version: string }).version, "1.2.3+codex.test-42");
});
