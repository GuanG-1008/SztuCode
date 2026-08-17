#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

async function validate(root: string): Promise<string> {
  let text: string; try { text = await readFile(path.join(root, "SKILL.md"), "utf8"); } catch { throw new Error("SKILL.md not found"); }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text); if (!match) throw new Error(text.startsWith("---") ? "Invalid frontmatter format" : "No YAML frontmatter found");
  let value: unknown; try { value = parse(match[1]); } catch (error) { throw new Error(`Invalid YAML in frontmatter: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Frontmatter must be a YAML dictionary");
  const data = value as Record<string, unknown>; const allowed = new Set(["name", "description", "license", "allowed-tools", "metadata"]); const unexpected = Object.keys(data).filter((key) => !allowed.has(key)).sort();
  if (unexpected.length) throw new Error(`Unexpected key(s) in SKILL.md frontmatter: ${unexpected.join(", ")}. Allowed properties are: ${[...allowed].sort().join(", ")}`);
  if (!("name" in data)) throw new Error("Missing 'name' in frontmatter"); if (!("description" in data)) throw new Error("Missing 'description' in frontmatter");
  if (typeof data.name !== "string") throw new Error(`Name must be a string, got ${typeof data.name}`); const name = data.name.trim();
  if (name && !/^[a-z0-9-]+$/.test(name)) throw new Error(`Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)`);
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) throw new Error(`Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`); if (name.length > 64) throw new Error(`Name is too long (${name.length} characters). Maximum is 64 characters.`);
  if (typeof data.description !== "string") throw new Error(`Description must be a string, got ${typeof data.description}`); const description = data.description.trim();
  if (/[<>]/.test(description)) throw new Error("Description cannot contain angle brackets (< or >)"); if (description.length > 1024) throw new Error(`Description is too long (${description.length} characters). Maximum is 1024 characters.`);
  return "Skill is valid!";
}
async function main() { const arg = process.argv[2]; if (!arg || arg === "--help" || arg === "-h") { console.log("Usage: quick_validate.ts <skill-directory>"); return; } console.log(await validate(path.resolve(arg))); }
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
