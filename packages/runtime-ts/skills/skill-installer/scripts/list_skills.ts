#!/usr/bin/env node
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { githubApiContentsUrl, githubRequest } from "./github_utils.js";

function parseArgs(argv: string[]) {
  const options = { repo: "openai/skills", path: "skills/.curated", ref: "main", format: "text" };
  if (argv.includes("--help") || argv.includes("-h")) { console.log("Usage: list_skills.ts [--repo owner/repo] [--path repo/path] [--ref ref] [--format text|json]"); process.exit(0); }
  for (let index = 0; index < argv.length; index += 1) { const arg = argv[index]; if (!["--repo", "--path", "--ref", "--format"].includes(arg)) throw new Error(`Unknown argument: ${arg}`); const value = argv[++index]; if (!value) throw new Error(`Missing value for ${arg}`); options[arg.slice(2) as keyof typeof options] = value; }
  if (!["text", "json"].includes(options.format)) throw new Error("--format must be text or json"); return options;
}

async function installed(): Promise<Set<string>> {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills");
  try { const entries = await readdir(root, { withFileTypes: true }); return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)); } catch { return new Set(); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2)); const url = githubApiContentsUrl(options.repo, options.path, options.ref);
  let bytes: Uint8Array; try { bytes = await githubRequest(url, "codex-skill-list"); } catch (error) { const value = error instanceof Error ? error.message : String(error); if (value.includes("HTTP 404")) throw new Error(`Skills path not found: https://github.com/${options.repo}/tree/${options.ref}/${options.path}`); throw new Error(`Failed to fetch skills: ${value}`); }
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes)); if (!Array.isArray(payload)) throw new Error("Unexpected skills listing response.");
  const skills = payload.filter((item): item is { name: string; type: string } => Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "dir" && typeof (item as { name?: unknown }).name === "string").map((item) => item.name).sort();
  const present = await installed(); if (options.format === "json") console.log(JSON.stringify(skills.map((name) => ({ name, installed: present.has(name) })))); else skills.forEach((name, index) => console.log(`${index + 1}. ${name}${present.has(name) ? " (already installed)" : ""}`));
}
main().catch((error) => { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
