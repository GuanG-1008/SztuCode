import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const acronyms = new Set(["GH", "MCP", "API", "CI", "CLI", "LLM", "PDF", "PR", "UI", "URL", "SQL"]);
const brands: Record<string, string> = { openai: "OpenAI", openapi: "OpenAPI", github: "GitHub", pagerduty: "PagerDuty", datadog: "DataDog", sqlite: "SQLite", fastapi: "FastAPI" };
const smallWords = new Set(["and", "or", "to", "up", "with"]);
const allowed = new Set(["display_name", "short_description", "icon_small", "icon_large", "brand_color", "default_prompt"]);

export const normalizeSkillName = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/-{2,}/g, "-");

export function formatDisplayName(name: string): string {
  return name.split("-").filter(Boolean).map((word, index) => {
    const lower = word.toLowerCase(); const upper = word.toUpperCase();
    if (acronyms.has(upper)) return upper; if (brands[lower]) return brands[lower]; if (index > 0 && smallWords.has(lower)) return lower;
    return word[0].toUpperCase() + word.slice(1);
  }).join(" ");
}

export function shortDescription(displayName: string): string {
  let value = `Help with ${displayName} tasks`;
  if (value.length < 25) value = `Help with ${displayName} tasks and workflows`;
  if (value.length > 64) value = `Help with ${displayName}`;
  if (value.length > 64) value = `${displayName} helper`;
  if (value.length > 64) value = `${displayName.slice(0, 57).trimEnd()} helper`;
  if (value.length < 25) value = `${value} workflows`;
  return value.slice(0, 64).trimEnd();
}

export async function frontmatterName(skillRoot: string): Promise<string> {
  const target = path.join(skillRoot, "SKILL.md"); const text = await readFile(target, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text); if (!match) throw new Error("Invalid SKILL.md frontmatter format.");
  const value: unknown = parse(match[1]);
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).name !== "string" || !(value as Record<string, string>).name.trim()) throw new Error("Frontmatter 'name' is missing or invalid.");
  return (value as Record<string, string>).name.trim();
}

export async function writeOpenAiYaml(skillRoot: string, name: string, rawOverrides: string[]): Promise<string> {
  const overrides = new Map<string, string>(); const optional: string[] = [];
  for (const item of rawOverrides) {
    const separator = item.indexOf("="); if (separator < 0) throw new Error(`Invalid interface override '${item}'. Use key=value.`);
    const key = item.slice(0, separator).trim(); const value = item.slice(separator + 1).trim();
    if (!allowed.has(key)) throw new Error(`Unknown interface field '${key}'. Allowed: ${[...allowed].sort().join(", ")}`);
    overrides.set(key, value); if (!["display_name", "short_description"].includes(key) && !optional.includes(key)) optional.push(key);
  }
  const display = overrides.get("display_name") || formatDisplayName(name); const description = overrides.get("short_description") || shortDescription(display);
  if (description.length < 25 || description.length > 64) throw new Error(`short_description must be 25-64 characters (got ${description.length}).`);
  const quote = (value: string) => JSON.stringify(value); const lines = ["interface:", `  display_name: ${quote(display)}`, `  short_description: ${quote(description)}`];
  for (const key of optional) lines.push(`  ${key}: ${quote(overrides.get(key) ?? "")}`);
  const target = path.join(skillRoot, "agents", "openai.yaml"); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, `${lines.join("\n")}\n`, "utf8");
  console.log("[OK] Created agents/openai.yaml"); return target;
}
