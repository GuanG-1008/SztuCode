#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { githubRequest } from "./github_utils.js";

type Options = { url?: string; repo?: string; paths: string[]; ref: string; dest?: string; name?: string; method: "auto" | "download" | "git" };
type Source = { owner: string; repo: string; ref: string; paths: string[]; repoUrl?: string };
const exists = async (target: string) => { try { await stat(target); return true; } catch { return false; } };
function parseArgs(argv: string[]): Options {
  const options: Options = { paths: [], ref: "main", method: "auto" };
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.log("Usage: install_skill_from_github.ts (--repo owner/repo | --url github-url) --path repo/path [repo/path ...] [--ref ref] [--dest dir] [--name name] [--method auto|download|git]"); process.exit(0); }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]; if (!["--repo", "--url", "--path", "--ref", "--dest", "--name", "--method"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    if (arg === "--path") { while (argv[index + 1] && !argv[index + 1].startsWith("--")) options.paths.push(argv[++index]); if (!options.paths.length) throw new Error("Missing value for --path"); continue; }
    const value = argv[++index]; if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === "--repo") options.repo = value; else if (arg === "--url") options.url = value; else if (arg === "--ref") options.ref = value; else if (arg === "--dest") options.dest = value; else if (arg === "--name") options.name = value; else { if (!["auto", "download", "git"].includes(value)) throw new Error("Invalid method"); options.method = value as Options["method"]; }
  }
  return options;
}

function source(options: Options): Source {
  if (options.url || options.repo?.includes("://")) {
    const rawUrl = options.url ?? options.repo; if (!rawUrl) throw new Error("Provide --repo or --url.");
    const url = new URL(rawUrl); if (url.hostname !== "github.com") throw new Error("Only GitHub URLs are supported for download mode.");
    const parts = url.pathname.split("/").filter(Boolean); if (parts.length < 2) throw new Error("Invalid GitHub URL."); let ref = options.ref; let subpath = "";
    if (["tree", "blob"].includes(parts[2])) { if (parts.length < 4) throw new Error("GitHub URL missing ref or path."); ref = parts[3]; subpath = parts.slice(4).join("/"); } else subpath = parts.slice(2).join("/");
    const paths = options.paths.length ? options.paths : subpath ? [subpath] : []; if (!paths.length) throw new Error("Missing --path for GitHub URL."); return { owner: parts[0], repo: parts[1], ref, paths };
  }
  const parts = (options.repo ?? "").split("/").filter(Boolean); if (parts.length !== 2) throw new Error("--repo must be in owner/repo format."); if (!options.paths.length) throw new Error("Missing --path for --repo.");
  return { owner: parts[0], repo: parts[1], ref: options.ref, paths: options.paths };
}

function run(args: string[]) { const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", windowsHide: true }); if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "Command failed.").trim()); }
async function download(item: Source, temp: string): Promise<string> {
  const bytes = await githubRequest(`https://codeload.github.com/${item.owner}/${item.repo}/zip/${item.ref}`, "codex-skill-install"); const archive = unzipSync(bytes);
  const extract = path.join(temp, "download"); await mkdir(extract); const roots = new Set<string>();
  for (const [name, contents] of Object.entries(archive)) {
    const normalized = name.replace(/\\/g, "/"); const parts = normalized.split("/").filter(Boolean); if (!parts.length) continue;
    if (path.posix.isAbsolute(normalized) || parts.includes("..")) throw new Error("Archive contains files outside the destination."); roots.add(parts[0]);
    const target = path.resolve(extract, ...parts); const relative = path.relative(extract, target); if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Archive contains files outside the destination.");
    if (normalized.endsWith("/")) await mkdir(target, { recursive: true }); else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, contents); }
  }
  if (roots.size !== 1) throw new Error(roots.size ? "Unexpected archive layout." : "Downloaded archive was empty."); return path.join(extract, [...roots][0]);
}
function sparse(item: Source, temp: string, ssh = false): string {
  const target = path.join(temp, "repo"); const url = ssh ? `git@github.com:${item.owner}/${item.repo}.git` : `https://github.com/${item.owner}/${item.repo}.git`;
  run(["git", "clone", "--filter=blob:none", "--depth", "1", "--sparse", "--single-branch", "--branch", item.ref, url, target]); run(["git", "-C", target, "sparse-checkout", "set", ...item.paths]); run(["git", "-C", target, "checkout", item.ref]); return target;
}
async function prepare(item: Source, method: Options["method"], temp: string): Promise<string> {
  if (method !== "git") try { return await download(item, temp); } catch (error) { if (method === "download" || !/HTTP (401|403|404)/.test(error instanceof Error ? error.message : String(error))) throw error; }
  try { return sparse(item, temp); } catch { return sparse(item, temp, true); }
}
async function main() {
  const options = parseArgs(process.argv.slice(2)); const item = source(options);
  for (const value of item.paths) { const normalized = path.posix.normalize(value.replace(/\\/g, "/")); if (path.isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) throw new Error("Skill path must be a relative path inside the repo."); }
  const destination = path.resolve(options.dest || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills")); const tempBase = path.join(os.tmpdir(), "codex"); await mkdir(tempBase, { recursive: true }); const temp = await mkdtemp(path.join(tempBase, "skill-install-")); const installed: Array<[string, string]> = [];
  try {
    const root = await prepare(item, options.method, temp);
    for (const relative of item.paths) {
      const name = item.paths.length === 1 && options.name ? options.name : path.posix.basename(relative.replace(/\\/g, "/").replace(/\/$/, "")); if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new Error("Skill name must be a single path segment.");
      const sourceRoot = path.resolve(root, relative); if (!(await exists(path.join(sourceRoot, "SKILL.md")))) throw new Error("SKILL.md not found in selected skill directory."); const target = path.join(destination, name); if (await exists(target)) throw new Error(`Destination already exists: ${target}`);
      await mkdir(path.dirname(target), { recursive: true }); await cp(sourceRoot, target, { recursive: true }); installed.push([name, target]);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
  installed.forEach(([name, target]) => console.log(`Installed ${name} to ${target}`));
}
main().catch((error) => { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
