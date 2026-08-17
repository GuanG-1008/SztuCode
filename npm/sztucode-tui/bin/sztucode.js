#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(packageRoot, "runtime/main.js");
const cli = resolve(packageRoot, "cli/main.js");

if (!existsSync(runtime) || !existsSync(cli)) {
  console.error("The SztuCode package is incomplete: bundled TypeScript runtime files are missing.");
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
const commands = new Set(["ping", "run", "chat", "trace", "core", "version", "--version", "--help", "help"]);
const cliArgs = rawArgs.length === 0 ? ["chat"] : commands.has(rawArgs[0]) ? rawArgs : ["chat", ...rawArgs];
const child = spawn(process.execPath, [cli, ...cliArgs], {
  stdio: "inherit",
  windowsHide: false,
  env: { ...process.env, SZTU_AUTO_START: "1" },
});
child.on("error", (error) => { console.error(`Unable to start SztuCode: ${error.message}`); process.exitCode = 1; });
child.on("exit", (code, signal) => { if (signal && process.platform !== "win32") process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
