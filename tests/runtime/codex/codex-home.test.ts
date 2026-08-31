import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DependencyError } from "../../../src/domain/errors.js";
import { CodexHome } from "../../../src/runtime/codex/codex-home.js";

async function sourceHomeWithCredentials(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "codex-source-"));
  await writeFile(join(home, "auth.json"), '{"token":"secret"}', "utf8");
  await writeFile(join(home, "config.toml"), 'model = "personal"', "utf8");
  return home;
}

test("copies only the credential file into a fresh home", async () => {
  const sourceHome = await sourceHomeWithCredentials();
  const home = await CodexHome.create({ sourceHome });

  assert.equal(await readFile(join(home.path, "auth.json"), "utf8"), '{"token":"secret"}');
  await assert.rejects(stat(join(home.path, "config.toml")));

  await home.cleanup();
  await assert.rejects(stat(home.path));
});

test("refuses to run when the runtime is not authenticated", async () => {
  const sourceHome = await mkdtemp(join(tmpdir(), "codex-empty-"));
  await assert.rejects(CodexHome.create({ sourceHome }), DependencyError);
});

test("cleanup is safe to call twice", async () => {
  const sourceHome = await sourceHomeWithCredentials();
  const home = await CodexHome.create({ sourceHome });
  await home.cleanup();
  await home.cleanup();
});
