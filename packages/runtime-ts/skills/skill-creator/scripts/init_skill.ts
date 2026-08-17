#!/usr/bin/env node
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeSkillName, writeOpenAiYaml } from "./skill_metadata.js";

const allowedResources = new Set(["scripts", "references", "assets"]);
const exists = async (target: string) => { try { await stat(target); return true; } catch { return false; } };
const title = (name: string) => name.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
const skillTemplate = (name: string) => `---
name: ${name}
description: [TODO: Explain what the skill does and the specific scenarios, file types, or tasks that trigger it.]
---

# ${title(name)}

## Overview

[TODO: Explain what this skill enables in 1-2 sentences.]

## Workflow

[TODO: Choose a structure that fits the skill: sequential workflow, task categories,
reference guidelines, or capabilities. Add concrete steps, decision points, examples,
and links to bundled scripts or references. Delete this guidance when finished.]

## Resources (optional)

- \`scripts/\`: executable helpers for deterministic or repetitive work
- \`references/\`: detailed documentation loaded only when relevant
- \`assets/\`: templates, images, fonts, or starter files copied into output

[TODO: Remove this section when no bundled resources are required.]
`;
const exampleScript = (name: string) => `#!/usr/bin/env node
// Replace this placeholder with deterministic helper logic or delete it.
console.log("Example helper for ${name}");
`;
const exampleReference = (name: string) => `# Reference Documentation for ${title(name)}

Replace this placeholder with focused API documentation, workflow guidance, examples,
error handling, and troubleshooting details that do not belong in SKILL.md.
`;
const exampleAsset = `# Example Asset File

Replace this placeholder with a real template, image, font, starter project, or data file.
Assets are intended for output generation rather than context loading.
`;

type Options = { rawName: string; output: string; resources: string[]; examples: boolean; overrides: string[] };
function parseArgs(argv: string[]): Options {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.log("Usage: init_skill.ts <skill-name> --path <output-directory> [--resources scripts,references,assets] [--examples] [--interface key=value]"); process.exit(0); }
  const options: Options = { rawName: argv[0], output: "", resources: [], examples: false, overrides: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--examples") options.examples = true;
    else if (["--path", "--resources", "--interface"].includes(arg)) {
      const value = argv[++index]; if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === "--path") options.output = value;
      else if (arg === "--interface") options.overrides.push(value);
      else options.resources = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.output) throw new Error("--path is required.");
  const invalid = options.resources.filter((item) => !allowedResources.has(item)); if (invalid.length) throw new Error(`Unknown resource type(s): ${invalid.sort().join(", ")}. Allowed: ${[...allowedResources].sort().join(", ")}`);
  if (options.examples && !options.resources.length) throw new Error("--examples requires --resources to be set.");
  return options;
}

async function createResources(root: string, name: string, resources: string[], examples: boolean) {
  for (const resource of resources) {
    const directory = path.join(root, resource); await mkdir(directory, { recursive: true });
    if (!examples) { console.log(`[OK] Created ${resource}/`); continue; }
    if (resource === "scripts") { await writeFile(path.join(directory, "example.mjs"), exampleScript(name), "utf8"); console.log("[OK] Created scripts/example.mjs"); }
    else if (resource === "references") { await writeFile(path.join(directory, "api_reference.md"), exampleReference(name), "utf8"); console.log("[OK] Created references/api_reference.md"); }
    else { await writeFile(path.join(directory, "example_asset.txt"), exampleAsset, "utf8"); console.log("[OK] Created assets/example_asset.txt"); }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2)); const name = normalizeSkillName(options.rawName);
  if (!name) throw new Error("Skill name must include at least one letter or digit."); if (name.length > 64) throw new Error(`Skill name '${name}' is too long (${name.length} characters). Maximum is 64 characters.`);
  if (name !== options.rawName) console.log(`Note: Normalized skill name from '${options.rawName}' to '${name}'.`);
  const root = path.resolve(options.output, name); if (await exists(root)) throw new Error(`Skill directory already exists: ${root}`);
  console.log(`Initializing skill: ${name}\n   Location: ${options.output}\n   Resources: ${options.resources.join(", ") || "none (create as needed)"}\n`);
  await mkdir(root, { recursive: true }); console.log(`[OK] Created skill directory: ${root}`);
  await writeFile(path.join(root, "SKILL.md"), skillTemplate(name), "utf8"); console.log("[OK] Created SKILL.md");
  await writeOpenAiYaml(root, name, options.overrides); await createResources(root, name, options.resources, options.examples);
  console.log(`\n[OK] Skill '${name}' initialized successfully at ${root}`);
  console.log("\nNext steps:\n1. Complete the TODO items in SKILL.md\n2. Customize or remove placeholder resources\n3. Adjust agents/openai.yaml if needed\n4. Run the validator\n5. Forward-test realistic requests");
}

main().catch((error) => { console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
