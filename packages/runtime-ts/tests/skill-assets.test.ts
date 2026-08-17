import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareSkillAssets } from "../../../scripts/prepare-skill-assets.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("published skill assets compile TypeScript scripts and rewrite instructions", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "sztu-skill-assets-"));
  const source = path.join(temporaryRoot, "source");
  const target = path.join(temporaryRoot, "target");
  await mkdir(path.join(source, "sample", "scripts"), { recursive: true });
  await writeFile(path.join(source, "sample", "scripts", "hello.ts"), "const value: string = 'ready'; console.log(value);\n", "utf8");
  await writeFile(path.join(source, "sample", "SKILL.md"), "Run `npx tsx scripts/hello.ts` and inspect `scripts/hello.ts`.\n", "utf8");

  await prepareSkillAssets(source, target, repositoryRoot);

  await assert.rejects(readFile(path.join(target, "sample", "scripts", "hello.ts"), "utf8"));
  assert.match(await readFile(path.join(target, "sample", "scripts", "hello.mjs"), "utf8"), /console\.log/);
  assert.equal(await readFile(path.join(target, "sample", "SKILL.md"), "utf8"), "Run `node scripts/hello.mjs` and inspect `scripts/hello.mjs`.\n");
});
