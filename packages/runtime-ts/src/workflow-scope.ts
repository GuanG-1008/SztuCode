export function normalizeWorkflowPath(value: string): string {
  const raw = value.replace(/\\/g, "/").trim();
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new Error(`path must stay inside the assigned workspace scope: ${value}`);
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`path must stay inside the assigned workspace scope: ${value}`);
    parts.push(part);
  }
  return parts.join("/") || ".";
}

export function workflowPathIsAllowed(value: string, allowedPaths: string[]): boolean {
  const candidate = normalizeWorkflowPath(value);
  return allowedPaths.some((rawScope) => {
    const scope = normalizeWorkflowPath(rawScope);
    if (scope === ".") return true;
    if (/[*?[]/.test(scope)) return globRegex(scope).test(candidate);
    return candidate === scope || candidate.startsWith(`${scope.replace(/\/$/, "")}/`);
  });
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") { source += ".*"; index += 1; }
      else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) source += "\\[";
      else { source += pattern.slice(index, end + 1); index = end; }
    } else source += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
