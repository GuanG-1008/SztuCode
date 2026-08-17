#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const index = args.indexOf("--marketplace-path");
const marketplacePath = path.resolve(index >= 0 && args[index + 1] ? args[index + 1] : path.join(os.homedir(), ".agents", "plugins", "marketplace.json"));

try {
  const payload = JSON.parse(await readFile(marketplacePath, "utf8")) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`${marketplacePath} must contain a JSON object.`);
  const name = (payload as Record<string, unknown>).name;
  if (typeof name !== "string" || !name.trim()) throw new Error(`${marketplacePath} must contain a non-empty string 'name'.`);
  console.log(name.trim());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
