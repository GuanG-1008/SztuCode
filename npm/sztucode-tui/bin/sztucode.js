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

const daemon = spawn(process.execPath, [runtime], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: { ...process.env, SZTU_TS_PORT: process.env.SZTU_PORT ?? "7438" },
});
daemon.unref();

const child = spawn(process.execPath, [cli, "chat", ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: false,
});
child.on("error", (error) => { console.error(`Unable to start SztuCode: ${error.message}`); process.exitCode = 1; });
child.on("exit", (code, signal) => { if (signal && process.platform !== "win32") process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
