import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type StoredPermissionDecision = "allow" | "deny";

export function defaultPolicyPath(): string {
  const dataRoot = process.env.SZTU_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), ".sztu");
  return path.join(dataRoot, "policy.toml");
}

export function loadPermissionPolicy(filePath = defaultPolicyPath()): Map<string, StoredPermissionDecision> {
  const policy = new Map<string, StoredPermissionDecision>();
  let text = "";
  try { text = readFileSync(filePath, "utf8"); } catch { return policy; }
  let inAlways = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "[always]") { inAlways = true; continue; }
    if (line.startsWith("[")) { inAlways = false; continue; }
    if (!inAlways || !line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"(allow|deny)"$/);
    if (match) policy.set(match[1]!, match[2]! as StoredPermissionDecision);
  }
  return policy;
}

export function savePermissionPolicy(policy: ReadonlyMap<string, StoredPermissionDecision>, filePath = defaultPolicyPath()): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = ["# SztuCode persistent tool permissions", "", "[always]", ...[...policy].sort(([left], [right]) => left.localeCompare(right)).map(([tool, decision]) => `${tool} = "${decision}"`)];
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}
