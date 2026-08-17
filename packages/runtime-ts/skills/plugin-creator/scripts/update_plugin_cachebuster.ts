#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const pluginArg = args.find((arg) => !arg.startsWith("--"));
const cachebusterIndex = args.indexOf("--cachebuster");
if (!pluginArg) throw new Error("Usage: update_plugin_cachebuster.ts <plugin-path> [--cachebuster value]");

const manifestPath = path.resolve(pluginArg, ".codex-plugin", "plugin.json");
const payload = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
if (typeof payload.version !== "string" || !payload.version.trim()) throw new Error(`${manifestPath} must contain a non-empty string 'version'.`);
const raw = cachebusterIndex >= 0 ? args[cachebusterIndex + 1] : new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const cachebuster = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
if (!cachebuster) throw new Error("Cachebuster must contain at least one letter or digit.");
const previous = payload.version;
payload.version = `${previous.split("+", 1)[0]}+codex.${cachebuster}`;
await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Updated plugin version: ${previous} -> ${payload.version}`);
