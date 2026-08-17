#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

type ObjectValue = Record<string, unknown>;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const color = /^#[0-9a-f]{6}$/i;
const isObject = (value: unknown): value is ObjectValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const existsFile = async (target: string) => { try { return (await stat(target)).isFile(); } catch { return false; } };

function unknownFields(value: ObjectValue, allowed: Set<string>, prefix: string, errors: string[]) {
  for (const key of Object.keys(value).sort()) if (!allowed.has(key)) errors.push(`${prefix} field \`${key}\` is not accepted by plugin validation`);
}

function requiredString(value: ObjectValue, key: string, errors: string[], prefix = "plugin.json"): string | null {
  const item = value[key]; if (typeof item !== "string" || !item.trim()) { errors.push(`${prefix} field \`${key}\` must be a non-empty string`); return null; }
  return item;
}

function optionalString(value: ObjectValue, key: string, errors: string[], prefix = "plugin.json") {
  if (value[key] != null && (typeof value[key] !== "string" || !String(value[key]).trim())) errors.push(`${prefix} field \`${key}\` must be a non-empty string`);
}

function optionalHttps(value: ObjectValue, key: string, errors: string[], prefix: string) {
  if (value[key] == null) return;
  try { const url = new URL(String(value[key])); if (typeof value[key] !== "string" || url.protocol !== "https:" || !url.host) throw new Error(); }
  catch { errors.push(`${prefix} field \`${key}\` must be an absolute \`https://\` URL`); }
}

function rejectTodos(value: unknown, location: string, errors: string[]) {
  if (typeof value === "string" && value.includes("[TODO:")) errors.push(`${location} still contains a \`[TODO: ...]\` placeholder`);
  else if (Array.isArray(value)) value.forEach((item, index) => rejectTodos(item, `${location}[${index}]`, errors));
  else if (isObject(value)) for (const [key, item] of Object.entries(value)) rejectTodos(item, `${location}.${key}`, errors);
}

async function jsonObject(target: string, label: string, errors: string[]): Promise<ObjectValue | null> {
  if (!(await existsFile(target))) { errors.push(`${label} is required`); return null; }
  try { const value: unknown = JSON.parse(await readFile(target, "utf8")); if (!isObject(value)) { errors.push(`${label} must contain a JSON object`); return null; } return value; }
  catch { errors.push(`${label} must contain valid JSON`); return null; }
}

function contractPath(value: unknown, expected: string, key: string, errors: string[]) {
  if (value == null) return;
  const normalized = typeof value === "string" && !path.isAbsolute(value) ? value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") : null;
  if (normalized !== expected) errors.push(`plugin.json field \`${key}\` must resolve to \`${expected}\``);
}

function serverEntries(value: unknown, label: string, errors: string[]) {
  if (!isObject(value)) { errors.push(`${label} must be an object`); return; }
  for (const [key, entry] of Object.entries(value)) { if (!key.trim()) errors.push(`${label} server names must be non-empty strings`); if (!isObject(entry)) errors.push(`${label} server \`${key}\` must be an object`); }
}

async function asset(base: string, root: string, value: unknown, label: string, errors: string[]) {
  if (typeof value !== "string" || !value.trim()) { errors.push(`${label} must be a non-empty relative path`); return; }
  const parts = value.replace(/\\/g, "/").split("/");
  if (path.isAbsolute(value) || parts.some((part) => !part || part === "." || part === "..")) { errors.push(`${label} must stay inside the plugin archive`); return; }
  const candidate = path.resolve(base, value); const relative = path.relative(path.resolve(root), candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) { errors.push(`${label} must stay inside the plugin archive`); return; }
  if (!(await existsFile(candidate))) errors.push(`${label} points to a missing file`);
}

async function validateAgent(pluginRoot: string, skillRoot: string, target: string, errors: string[]) {
  const name = path.basename(skillRoot); let payload: unknown;
  try { payload = parse(await readFile(target, "utf8")); } catch { errors.push(`skill \`${name}\` agent YAML must be valid YAML`); return; }
  if (!isObject(payload)) { errors.push(`skill \`${name}\` agent YAML must be an object`); return; }
  unknownFields(payload, new Set(["interface", "policy", "dependencies"]), `skill \`${name}\` agent`, errors);
  const ui = payload.interface;
  if (!isObject(ui)) { errors.push(`skill \`${name}\` agent field \`interface\` must be an object`); return; }
  unknownFields(ui, new Set(["display_name", "short_description", "icon_small", "icon_large", "brand_color", "default_prompt"]), `skill \`${name}\` agent field \`interface`, errors);
  requiredString(ui, "display_name", errors, `skill \`${name}\` agent interface`); requiredString(ui, "short_description", errors, `skill \`${name}\` agent interface`);
  for (const key of ["icon_small", "icon_large"]) if (ui[key] != null) await asset(skillRoot, pluginRoot, ui[key], `skill \`${name}\` agent field \`interface.${key}\``, errors);
  if (ui.brand_color != null && (typeof ui.brand_color !== "string" || !color.test(ui.brand_color))) errors.push(`skill \`${name}\` agent field \`interface.brand_color\` must use \`#RRGGBB\``);
  optionalString(ui, "default_prompt", errors, `skill \`${name}\` agent interface`);
  if (payload.policy != null) {
    if (!isObject(payload.policy)) errors.push(`skill \`${name}\` agent field \`policy\` must be an object`);
    else { unknownFields(payload.policy, new Set(["allow_implicit_invocation"]), `skill \`${name}\` agent field \`policy`, errors); if (payload.policy.allow_implicit_invocation != null && typeof payload.policy.allow_implicit_invocation !== "boolean") errors.push(`skill \`${name}\` agent field \`policy.allow_implicit_invocation\` must be a boolean`); }
  }
  if (payload.dependencies != null) {
    if (!isObject(payload.dependencies)) errors.push(`skill \`${name}\` agent field \`dependencies\` must be an object`);
    else unknownFields(payload.dependencies, new Set(["tools"]), `skill \`${name}\` agent field \`dependencies`, errors);
  }
}

async function validateSkills(root: string, errors: string[]) {
  const skills = path.join(root, "skills"); let entries;
  try { entries = await readdir(skills, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillRoot = path.join(skills, entry.name); const target = path.join(skillRoot, "SKILL.md");
    if (!(await existsFile(target))) { errors.push(`skill \`${entry.name}\` is missing \`SKILL.md\``); continue; }
    const contents = await readFile(target, "utf8"); const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents);
    if (!match) { errors.push(`skill \`${entry.name}\` must start with closed YAML frontmatter`); continue; }
    let frontmatter: unknown; try { frontmatter = parse(match[1]); } catch { errors.push(`skill \`${entry.name}\` frontmatter must be valid YAML`); continue; }
    if (!isObject(frontmatter)) { errors.push(`skill \`${entry.name}\` frontmatter must be an object`); continue; }
    if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) errors.push(`skill \`${entry.name}\` frontmatter field \`name\` must be non-empty`);
    if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) errors.push(`skill \`${entry.name}\` frontmatter field \`description\` must be non-empty`);
    const disabled = frontmatter["disable-model-invocation"] ?? frontmatter.disable_model_invocation;
    if (disabled != null && disabled !== false) errors.push(`skill \`${entry.name}\` frontmatter field \`disable-model-invocation\` must be false`);
    const agent = path.join(skillRoot, "agents", "openai.yaml"); if (await existsFile(agent)) await validateAgent(root, skillRoot, agent, errors);
  }
}

async function validate(root: string): Promise<string[]> {
  const errors: string[] = []; const target = path.join(root, ".codex-plugin", "plugin.json");
  const manifest = await jsonObject(target, "`.codex-plugin/plugin.json`", errors); if (!manifest) return errors;
  rejectTodos(manifest, "$", errors);
  unknownFields(manifest, new Set(["id", "name", "version", "description", "skills", "apps", "mcpServers", "interface", "author", "homepage", "repository", "license", "keywords"]), "plugin.json", errors);
  optionalString(manifest, "id", errors); requiredString(manifest, "name", errors); const version = requiredString(manifest, "version", errors); if (version && !semver.test(version)) errors.push("plugin.json field `version` must be strict semver"); requiredString(manifest, "description", errors);
  if (!isObject(manifest.author)) errors.push("plugin.json field `author` must be an object"); else { unknownFields(manifest.author, new Set(["name", "email", "url"]), "plugin.json author", errors); requiredString(manifest.author, "name", errors, "plugin.json author"); optionalString(manifest.author, "email", errors, "plugin.json author"); optionalHttps(manifest.author, "url", errors, "plugin.json author"); }
  contractPath(manifest.skills, "skills", "skills", errors); contractPath(manifest.apps, ".app.json", "apps", errors);
  if (manifest.apps != null) { const app = await jsonObject(path.join(root, ".app.json"), "`.app.json`", errors); if (app) { unknownFields(app, new Set(["apps"]), "`.app.json`", errors); if (!isObject(app.apps)) errors.push("`.app.json` field `apps` must be an object"); } }
  if (typeof manifest.mcpServers === "string") { contractPath(manifest.mcpServers, ".mcp.json", "mcpServers", errors); const mcp = await jsonObject(path.join(root, ".mcp.json"), "`.mcp.json`", errors); if (mcp) { unknownFields(mcp, new Set(["mcpServers"]), "`.mcp.json`", errors); serverEntries(mcp.mcpServers, "`.mcp.json` field `mcpServers`", errors); } }
  else if (manifest.mcpServers != null) serverEntries(manifest.mcpServers, "plugin.json field `mcpServers`", errors);
  await validateSkills(root, errors);
  if (!isObject(manifest.interface)) errors.push("plugin.json field `interface` must be an object"); else {
    const ui = manifest.interface; unknownFields(ui, new Set(["displayName", "shortDescription", "longDescription", "developerName", "category", "capabilities", "websiteURL", "privacyPolicyURL", "termsOfServiceURL", "brandColor", "composerIcon", "logo", "logoDark", "screenshots", "defaultPrompt", "default_prompt"]), "plugin.json interface", errors);
    for (const key of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) requiredString(ui, key, errors, "plugin.json interface");
    if (ui.defaultPrompt == null && ui.default_prompt == null) errors.push("plugin.json field `interface.defaultPrompt` or `interface.default_prompt` is required");
    if (!Array.isArray(ui.capabilities) || !ui.capabilities.every((item) => typeof item === "string" && item.trim())) errors.push("plugin.json field `interface.capabilities` must be an array of strings");
    for (const key of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) optionalHttps(ui, key, errors, "plugin.json interface");
    if (ui.brandColor != null && (typeof ui.brandColor !== "string" || !color.test(ui.brandColor))) errors.push("plugin.json field `interface.brandColor` must use `#RRGGBB`");
    for (const key of ["composerIcon", "logo", "logoDark"]) if (ui[key] != null) await asset(root, root, ui[key], `plugin.json field \`interface.${key}\``, errors);
    if (!Array.isArray(ui.screenshots ?? [])) errors.push("plugin.json field `interface.screenshots` must be an array"); else for (let index = 0; index < (ui.screenshots as unknown[] | undefined ?? []).length; index += 1) await asset(root, root, (ui.screenshots as unknown[])[index], `plugin.json field \`interface.screenshots[${index}]\``, errors);
  }
  return errors;
}

async function main() {
  const arg = process.argv[2]; if (!arg || arg === "--help" || arg === "-h") { console.log("Usage: validate_plugin.ts <plugin-path>"); return; }
  const root = path.resolve(arg); const errors = await validate(root);
  if (errors.length) { console.error(`Plugin validation failed:\n${errors.map((item) => `- ${item}`).join("\n")}`); process.exitCode = 1; }
  else console.log(`Plugin validation passed: ${root}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
