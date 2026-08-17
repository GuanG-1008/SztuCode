import { access, readFile } from "node:fs/promises";
import path from "node:path";

type Finding = { name: string; confidence: "confirmed" | "likely"; evidence: Array<{ path: string; rule: string; detail?: string; strength: "confirmed" | "supporting" | "weak" }> };
const exists = async (file: string) => access(file).then(() => true, () => false);
export async function profileProject(root: string) {
  const languages: Finding[] = []; const frameworks: Finding[] = []; const packageManagers: Finding[] = []; const buildTools: Finding[] = []; const evidence: Finding["evidence"] = [];
  const add = (target: Finding[], name: string, file: string, rule: string) => { const item = { path: file, rule, strength: "confirmed" as const }; target.push({ name, confidence: "confirmed", evidence: [item] }); evidence.push(item); };
  if (await exists(path.join(root, "pyproject.toml"))) { add(languages, "Python", "pyproject.toml", "Python project manifest"); add(buildTools, "PyPA", "pyproject.toml", "PEP 517 project"); }
  if (await exists(path.join(root, "package.json"))) { add(languages, "TypeScript/JavaScript", "package.json", "Node project manifest"); const value = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string }; const deps = { ...value.dependencies, ...value.devDependencies }; if (deps.vue) add(frameworks, "Vue", "package.json", "Vue dependency"); if (deps.react) add(frameworks, "React", "package.json", "React dependency"); if (deps.typescript) add(languages, "TypeScript", "package.json", "TypeScript dependency"); add(packageManagers, value.packageManager?.split("@")[0] || "npm", "package.json", "Node package manager"); }
  if (await exists(path.join(root, "Cargo.toml"))) { add(languages, "Rust", "Cargo.toml", "Cargo manifest"); add(packageManagers, "Cargo", "Cargo.toml", "Rust package manager"); }
  return { root_path: root, monorepo: await exists(path.join(root, "packages")), projects: [{ path: ".", languages, frameworks, package_managers: packageManagers, build_tools: buildTools, evidence, validation_plan: [] }], scan_limited: false };
}
