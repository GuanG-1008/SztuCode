import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDotEnv } from "../src/env.js";

test("dotenv loader reads supported values without overriding the process environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sztu-env-test-")); const file = path.join(root, ".env"); const existing = process.env.SZTU_ENV_EXISTING;
  try {
    process.env.SZTU_ENV_EXISTING = "system";
    await writeFile(file, "# comment\nSZTU_ENV_PLAIN=value\nSZTU_ENV_QUOTED=\"hello world\"\nSZTU_ENV_EXISTING=file\n", "utf8");
    loadDotEnv(file);
    assert.equal(process.env.SZTU_ENV_PLAIN, "value"); assert.equal(process.env.SZTU_ENV_QUOTED, "hello world"); assert.equal(process.env.SZTU_ENV_EXISTING, "system");
  } finally { delete process.env.SZTU_ENV_PLAIN; delete process.env.SZTU_ENV_QUOTED; if (existing === undefined) delete process.env.SZTU_ENV_EXISTING; else process.env.SZTU_ENV_EXISTING = existing; await rm(root, { recursive: true, force: true }); }
});
