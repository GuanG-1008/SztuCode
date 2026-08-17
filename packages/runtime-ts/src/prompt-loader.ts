import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const promptRoot = path.resolve(moduleDirectory, "../prompts/content");
const agentRoot = path.resolve(moduleDirectory, "../agents/builtin");
const instructionNames = ["AGENT.md", "AGENTS.md", "CLAUDE.md", "SZTUCODE.md", "CLAW.md"];

export type AgentProfile = { name: string; description: string; systemPrompt: string; allowedTools: string[]; permissionMode: string; maxSteps: number };

async function markdownGroup(group: string): Promise<string[]> {
  const root = path.join(promptRoot, group);
  try {
    const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
    return Promise.all(entries.map((entry) => readFile(path.join(root, entry.name), "utf8")));
  } catch { return []; }
}

async function firstPrompt(group: string, fragment: string): Promise<string> {
  const root = path.join(promptRoot, group);
  try {
    const name = (await readdir(root)).find((entry) => entry.endsWith(".md") && entry.includes(fragment));
    return name ? await readFile(path.join(root, name), "utf8") : "";
  } catch { return ""; }
}

async function gitSnapshot(root: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", root, "status", "--short", "--branch"], { timeout: 3_000, maxBuffer: 20_000 });
    return result.stdout.trim();
  } catch { return ""; }
}

async function projectInstructions(root: string): Promise<string> {
  const parts: string[] = [];
  let current = path.resolve(root);
  for (let depth = 0; depth < 6; depth += 1) {
    for (const name of instructionNames) {
      const file = path.join(current, name);
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        const text = (await readFile(file, "utf8")).trim();
        if (text) parts.push(`## ${name}\n${text.slice(0, 4_000)}`);
      } catch { /* optional instruction */ }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return parts.join("\n\n").slice(0, 12_000);
}

export async function buildSystemPrompt(workspaceRoot: string, role = "coder"): Promise<string> {
  const sections = [
    ...(await markdownGroup("main")),
    await firstPrompt("safety-prompts", "malicious-code-protection"),
    await firstPrompt("doing-tasks", "software-engineering-focus"),
    await firstPrompt("doing-tasks", "read-before-modifying"),
    await firstPrompt("doing-tasks", "security"),
    await firstPrompt("doing-tasks", "blocked-approach"),
    ...(await markdownGroup("output-efficiency")),
    await firstPrompt("tone-and-style", "concise-output-short"),
    `# Runtime context\n- Working directory: ${path.resolve(workspaceRoot)}\n- Date: ${new Date().toISOString().slice(0, 10)}\n- Agent role: ${role}`,
  ].filter(Boolean);
  const instructions = await projectInstructions(workspaceRoot);
  if (instructions) sections.push(`# Project instructions\n${instructions}`);
  const git = await gitSnapshot(workspaceRoot);
  if (git) sections.push(`# Git status snapshot\n${git}`);
  return sections.join("\n\n");
}

function parseTomlProfile(text: string, name: string): AgentProfile {
  const description = text.match(/^description\s*=\s*["']([^"']*)["']/m)?.[1] ?? `${name} agent`;
  const promptId = text.match(/^prompt_id\s*=\s*["']([^"']*)["']/m)?.[1] ?? "";
  const permissionMode = text.match(/^permission_mode\s*=\s*["']([^"']*)["']/m)?.[1] ?? "normal";
  const maxSteps = Number(text.match(/^max_steps\s*=\s*(\d+)/m)?.[1] ?? 20);
  const allowedTools = [...text.matchAll(/^[ \t]*"([^"]+)"[ \t]*,?$/gm)].map((match) => match[1]);
  const inlinePrompt = text.match(/system_prompt\s*=\s*"""([\s\S]*?)"""/)?.[1]?.trim() ?? "";
  return { name, description, systemPrompt: promptId || inlinePrompt, allowedTools, permissionMode, maxSteps };
}

export async function loadAgentProfile(workspaceRoot: string, name: string): Promise<AgentProfile> {
  const candidates = [path.join(workspaceRoot, ".sztu", "agents", `${name}.toml`), path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), ".sztu", "agents", `${name}.toml`), path.join(agentRoot, `${name}.toml`)];
  for (const file of candidates) {
    try {
      const profile = parseTomlProfile(await readFile(file, "utf8"), name);
      if (profile.systemPrompt) {
        const promptFile = path.join(promptRoot, "subagent-prompts", `agent-prompt-${profile.systemPrompt}.md`);
        try { profile.systemPrompt = await readFile(promptFile, "utf8"); } catch { /* inline/system prompt fallback */ }
      }
      return profile;
    } catch { /* try lower-priority profile */ }
  }
  return { name, description: `${name} agent`, systemPrompt: "", allowedTools: [], permissionMode: "normal", maxSteps: 20 };
}
