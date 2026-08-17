import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import net from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = path.join(repositoryRoot, "npm", "sztucode-tui");
const bin = path.join(packageRoot, "bin", "sztucode.js");

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("published npm entry starts and reuses the bundled TypeScript daemon", async () => {
  await execute(process.execPath, [path.join(packageRoot, "scripts", "install.js")], { cwd: repositoryRoot, timeout: 120_000 });
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "sztu-npm-entry-"));
  const port = await availablePort();
  const env = { ...process.env, SZTU_DATA_DIR: dataRoot, SZTU_TS_HOST: "127.0.0.1", SZTU_TS_PORT: String(port) };
  try {
    const version = await execute(process.execPath, [bin, "--version"], { cwd: packageRoot, env, timeout: 30_000 });
    assert.equal(version.stdout.trim(), "0.2.0");

    const ping = await execute(process.execPath, [bin, "ping"], { cwd: packageRoot, env, timeout: 30_000 });
    assert.match(ping.stdout, /started TypeScript daemon/);
    assert.equal((JSON.parse(ping.stdout.slice(ping.stdout.indexOf("{"))) as { server_version: string }).server_version, "ts-0.2.0");

    const status = await execute(process.execPath, [bin, "core", "status"], { cwd: packageRoot, env, timeout: 30_000 });
    assert.match(status.stdout, /running\s+ts-0\.2\.0/);
  } finally {
    await execute(process.execPath, [bin, "core", "stop"], { cwd: packageRoot, env, timeout: 30_000 }).catch(() => undefined);
  }

  const launcher = await readFile(bin, "utf8");
  assert.doesNotMatch(launcher, /python|\.venv|virtualenv/i);
});

test("published package and CLI report the product version", async () => {
  const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as { version: string };
  const publishedPackage = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
  assert.equal(publishedPackage.version, rootPackage.version);
  const version = await execute(process.execPath, [bin, "--version"], { cwd: packageRoot, timeout: 30_000 });
  assert.equal(version.stdout.trim(), rootPackage.version);
});
