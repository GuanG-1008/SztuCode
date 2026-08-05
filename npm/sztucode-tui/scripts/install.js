import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const venvDir = resolve(packageRoot, ".venv");
const venvPython = process.platform === "win32"
  ? resolve(venvDir, "Scripts", "python.exe")
  : resolve(venvDir, "bin", "python");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
  });
}

function supportedVersion(command, prefixArgs) {
  const result = run(command, [...prefixArgs, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"], {
    capture: true,
  });
  if (result.status !== 0) return false;
  const [major, minor] = result.stdout.trim().split(".").map(Number);
  return major === 3 && (minor === 12 || minor === 13);
}

function findPython() {
  const candidates = process.platform === "win32"
    ? [
        ["py", ["-3.13"]],
        ["py", ["-3.12"]],
        ["python3.13", []],
        ["python3.12", []],
        ["python", []],
      ]
    : [
        ["python3.13", []],
        ["python3.12", []],
        ["python3", []],
        ["python", []],
      ];

  return candidates.find(([command, args]) => supportedVersion(command, args));
}

const wheels = readdirSync(resolve(packageRoot, "vendor")).filter((name) => name.endsWith(".whl"));
if (wheels.length !== 1) {
  console.error("sztucode-tui must contain exactly one wheel in vendor/.");
  process.exit(1);
}

if (!existsSync(venvPython)) {
  const python = findPython();
  if (!python) {
    console.error(
      "SztuCode requires Python 3.12 or 3.13. Install Python from " +
        "https://www.python.org/downloads/ and run npm install again.",
    );
    process.exit(1);
  }

  const result = run(python[0], [...python[1], "-m", "venv", venvDir]);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const wheel = resolve(packageRoot, "vendor", wheels[0]);
const install = run(venvPython, [
  "-m",
  "pip",
  "install",
  "--disable-pip-version-check",
  "--upgrade",
  wheel,
]);
if (install.status !== 0) process.exit(install.status ?? 1);

console.log("SztuCode TUI installed. Run `sztucode` or `sztucode-tui`.");
