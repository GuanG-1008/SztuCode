#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type JsonObject = Record<string, unknown>;
type Options = {
  pluginName: string; parent: string; marketplacePath: string; marketplaceName?: string;
  withSkills: boolean; withHooks: boolean; withScripts: boolean; withAssets: boolean;
  withMcp: boolean; withApps: boolean; withMarketplace: boolean; force: boolean;
  installPolicy: string; authPolicy: string; category: string;
};

const installPolicies = new Set(["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"]);
const authPolicies = new Set(["ON_INSTALL", "ON_USE"]);
const exists = async (target: string) => { try { await stat(target); return true; } catch { return false; } };
const normalizeName = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/-{2,}/g, "-");
const displayName = (value: string) => value.split(/[-_]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");

function usage(): never {
  console.log("Usage: create_basic_plugin.ts <plugin-name> [--path dir] [--with-skills] [--with-hooks] [--with-scripts] [--with-assets] [--with-mcp] [--with-apps] [--with-marketplace] [--marketplace-path file] [--marketplace-name name] [--install-policy value] [--auth-policy value] [--category value] [--force]");
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) usage();
  const options: Options = {
    pluginName: argv[0], parent: path.join(os.homedir(), "plugins"), marketplacePath: path.join(os.homedir(), ".agents", "plugins", "marketplace.json"),
    withSkills: false, withHooks: false, withScripts: false, withAssets: false, withMcp: false, withApps: false, withMarketplace: false, force: false,
    installPolicy: "AVAILABLE", authPolicy: "ON_INSTALL", category: "Productivity",
  };
  const flags: Record<string, keyof Options> = { "--with-skills": "withSkills", "--with-hooks": "withHooks", "--with-scripts": "withScripts", "--with-assets": "withAssets", "--with-mcp": "withMcp", "--with-apps": "withApps", "--with-marketplace": "withMarketplace", "--force": "force" };
  const values: Record<string, keyof Options> = { "--path": "parent", "--marketplace-path": "marketplacePath", "--marketplace-name": "marketplaceName", "--install-policy": "installPolicy", "--auth-policy": "authPolicy", "--category": "category" };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]; const flag = flags[arg];
    if (flag) { (options[flag] as boolean) = true; continue; }
    const key = values[arg]; if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index]; if (!value) throw new Error(`Missing value for ${arg}`); (options[key] as string) = value;
  }
  return options;
}

function pluginJson(name: string, withMcp: boolean, withApps: boolean): JsonObject {
  const title = displayName(name);
  const payload: JsonObject = {
    name, version: "0.1.0", description: `${title} plugin`, author: { name: "Local developer" }, skills: "./skills/",
    interface: { displayName: title, shortDescription: `Use ${title} in Codex.`, longDescription: `${title} adds a local Codex plugin scaffold.`, developerName: "Local developer", category: "Productivity", capabilities: [], defaultPrompt: `Help me use ${title}.` },
  };
  if (withMcp) payload.mcpServers = "./.mcp.json"; if (withApps) payload.apps = "./.app.json";
  return payload;
}

async function loadObject(target: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(target, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${target} must contain a JSON object.`);
  return value as JsonObject;
}

async function writeJson(target: string, payload: JsonObject, force: boolean) {
  if (!force && await exists(target)) throw new Error(`${target} already exists. Use --force to overwrite.`);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function updateMarketplace(options: Options, name: string) {
  const target = path.resolve(options.marketplacePath); const present = await exists(target);
  const payload = present ? await loadObject(target) : { name: options.marketplaceName ?? "personal", interface: { displayName: displayName(options.marketplaceName ?? "personal") }, plugins: [] };
  if (payload.interface != null && (!payload.interface || typeof payload.interface !== "object" || Array.isArray(payload.interface))) throw new Error("marketplace.json field 'interface' must be an object.");
  if (options.marketplaceName != null && payload.name !== options.marketplaceName) throw new Error(`${target} already uses marketplace name '${String(payload.name)}'. Create a new marketplace file to use '${options.marketplaceName}' instead.`);
  const plugins = payload.plugins ??= []; if (!Array.isArray(plugins)) throw new Error(`${target} field 'plugins' must be an array.`);
  const entry = { name, source: { source: "local", path: `./plugins/${name}` }, policy: { installation: options.installPolicy, authentication: options.authPolicy }, category: options.category };
  const index = plugins.findIndex((item) => item && typeof item === "object" && (item as JsonObject).name === name);
  if (index >= 0 && !options.force) throw new Error(`Marketplace entry '${name}' already exists in ${target}. Use --force to overwrite that entry.`);
  if (index >= 0) plugins[index] = entry; else plugins.push(entry);
  await writeJson(target, payload, true); return target;
}

async function main() {
  const options = parseArgs(process.argv.slice(2)); const raw = options.pluginName; const name = normalizeName(raw);
  if (name !== raw) console.log(`Note: Normalized plugin name from '${raw}' to '${name}'.`);
  if (!name) throw new Error("Plugin name must include at least one letter or digit.");
  if (name.length > 64) throw new Error(`Plugin name '${name}' is too long (${name.length} characters). Maximum is 64 characters.`);
  if (options.marketplaceName != null && !/^[A-Za-z0-9_-]+$/.test(options.marketplaceName.trim())) throw new Error("Marketplace name may only contain ASCII letters, digits, `_`, and `-`.");
  if (!installPolicies.has(options.installPolicy)) throw new Error(`Invalid install policy: ${options.installPolicy}`);
  if (!authPolicies.has(options.authPolicy)) throw new Error(`Invalid auth policy: ${options.authPolicy}`);
  const root = path.resolve(options.parent, name); await mkdir(root, { recursive: true });
  const manifest = path.join(root, ".codex-plugin", "plugin.json"); await writeJson(manifest, pluginJson(name, options.withMcp, options.withApps), options.force);
  for (const [directory, enabled] of [["skills", options.withSkills], ["hooks", options.withHooks], ["scripts", options.withScripts], ["assets", options.withAssets]] as const) if (enabled) await mkdir(path.join(root, directory), { recursive: true });
  if (options.withMcp) { const target = path.join(root, ".mcp.json"); if (options.force || !(await exists(target))) await writeJson(target, { mcpServers: {} }, true); }
  if (options.withApps) { const target = path.join(root, ".app.json"); if (options.force || !(await exists(target))) await writeJson(target, { apps: {} }, true); }
  const marketplace = options.withMarketplace ? await updateMarketplace(options, name) : null;
  console.log(`Created plugin scaffold: ${root}`); console.log(`plugin manifest: ${manifest}`); if (marketplace) console.log(`marketplace manifest: ${marketplace}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
