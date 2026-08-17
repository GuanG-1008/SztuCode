import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("every desktop RPC request has a TypeScript runtime handler", async () => {
  const desktop = await readFile(path.join(repositoryRoot, "desktop/src/services/sztu-runtime.ts"), "utf8");
  const server = await readFile(path.join(repositoryRoot, "packages/runtime-ts/src/server.ts"), "utf8");
  const requested = new Set([...desktop.matchAll(/client\.request\(\s*["']([^"']+)["']/g)].map((match) => match[1]));
  const handled = new Set([...server.matchAll(/case\s+["']([^"']+)["']/g)].map((match) => match[1]));
  assert.deepEqual([...requested].filter((method) => !handled.has(method)), []);
  assert.ok(requested.size >= 50, "desktop RPC extraction unexpectedly found too few methods");
});
