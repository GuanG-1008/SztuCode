#!/usr/bin/env node
import { stat } from "node:fs/promises";
import path from "node:path";
import { frontmatterName, writeOpenAiYaml } from "./skill_metadata.js";

async function main() {
  const args = process.argv.slice(2); if (!args.length || args.includes("--help") || args.includes("-h")) { console.log("Usage: generate_openai_yaml.ts <skill-dir> [--name name] [--interface key=value]"); return; }
  const root = path.resolve(args[0]); if (!(await stat(root)).isDirectory()) throw new Error(`Path is not a directory: ${root}`);
  const nameIndex = args.indexOf("--name"); const name = nameIndex >= 0 ? args[nameIndex + 1] : await frontmatterName(root);
  if (!name) throw new Error("Missing skill name.");
  const overrides: string[] = []; for (let index = 1; index < args.length; index += 1) if (args[index] === "--interface") { const value = args[++index]; if (!value) throw new Error("Missing value for --interface"); overrides.push(value); } else if (args[index] === "--name") index += 1; else throw new Error(`Unknown argument: ${args[index]}`);
  await writeOpenAiYaml(root, name, overrides);
}
main().catch((error) => { console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
