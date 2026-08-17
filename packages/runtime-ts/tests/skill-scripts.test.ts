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
const skillCreatorScripts = path.join(repositoryRoot, "packages", "runtime-ts", "skills", "skill-creator", "scripts");
const skillInstallerScripts = path.join(repositoryRoot, "packages", "runtime-ts", "skills", "skill-installer", "scripts");
const runTs = (script: string, args: string[]) => execute(process.execPath, [tsx, script, ...args]);

test("read_marketplace_name prints the configured marketplace name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-marketplace-"));
  const marketplace = path.join(root, "marketplace.json");
  await writeFile(marketplace, '{"name":"team-local"}\n', "utf8");
  const { stdout } = await runTs(path.join(pluginScripts, "read_marketplace_name.ts"), ["--marketplace-path", marketplace]);
  assert.equal(stdout.trim(), "team-local");
});

test("update_plugin_cachebuster replaces an existing suffix", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-plugin-"));
  const manifestDirectory = path.join(root, ".codex-plugin");
  const manifest = path.join(manifestDirectory, "plugin.json");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(manifest, '{"name":"demo","version":"1.2.3+codex.old"}\n', "utf8");
  await runTs(path.join(pluginScripts, "update_plugin_cachebuster.ts"), [root, "--cachebuster", "Test_42"]);
  assert.equal((JSON.parse(await readFile(manifest, "utf8")) as { version: string }).version, "1.2.3+codex.test-42");
});

test("plugin scaffold passes the TypeScript validator", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-plugin-scaffold-"));
  const parent = path.join(root, "plugins");
  const marketplace = path.join(root, "marketplace.json");
  await runTs(path.join(pluginScripts, "create_basic_plugin.ts"), ["My Demo", "--path", parent, "--with-skills", "--with-mcp", "--with-apps", "--with-marketplace", "--marketplace-path", marketplace]);
  const plugin = path.join(parent, "my-demo");
  const skill = path.join(plugin, "skills", "sample");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: sample\ndescription: Sample skill\n---\nUse sample.\n", "utf8");
  const { stdout } = await runTs(path.join(pluginScripts, "validate_plugin.ts"), [plugin]);
  assert.match(stdout, /Plugin validation passed/);
  const market = JSON.parse(await readFile(marketplace, "utf8")) as { plugins: Array<{ name: string; source: { path: string } }> };
  assert.deepEqual(market.plugins, [{ name: "my-demo", source: { source: "local", path: "./plugins/my-demo" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }]);
});

test("skill initializer produces Node-first resources and valid editable metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-skill-scaffold-"));
  await runTs(path.join(skillCreatorScripts, "init_skill.ts"), ["GitHub API", "--path", root, "--resources", "scripts,references,assets", "--examples"]);
  const skill = path.join(root, "github-api");
  assert.match(await readFile(path.join(skill, "scripts", "example.mjs"), "utf8"), /node/);
  assert.match(await readFile(path.join(skill, "agents", "openai.yaml"), "utf8"), /display_name: "GitHub API"/);
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: github-api\ndescription: Work with GitHub APIs and repository automation.\n---\n\n# GitHub API\n", "utf8");
  const { stdout } = await runTs(path.join(skillCreatorScripts, "quick_validate.ts"), [skill]);
  assert.equal(stdout.trim(), "Skill is valid!");
});

test("skill installer rejects paths outside the source repository before network access", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "sztu-skill-install-"));
  await assert.rejects(
    runTs(path.join(skillInstallerScripts, "install_skill_from_github.ts"), ["--repo", "openai/skills", "--path", "../outside", "--dest", destination]),
    (error: unknown) => error instanceof Error && "stderr" in error && String((error as { stderr: string }).stderr).includes("relative path inside the repo"),
  );
});
