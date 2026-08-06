#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const python = process.platform === "win32"
  ? resolve(packageRoot, ".venv", "Scripts", "python.exe")
  : resolve(packageRoot, ".venv", "bin", "python");

if (!existsSync(python)) {
  console.error(
    "SztuCode is not installed correctly. Reinstall it with " +
      "`npm install --global sztucode-tui`.",
  );
  process.exit(1);
}

const child = spawn(
  python,
  ["-m", "sztu_code.tui.launcher", ...process.argv.slice(2)],
  { stdio: "inherit", windowsHide: false },
);

child.on("error", (error) => {
  console.error(`Unable to start SztuCode: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal && process.platform !== "win32") {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
