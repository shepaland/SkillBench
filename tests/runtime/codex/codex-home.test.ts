import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DependencyError } from "../../../src/domain/errors.js";
import { CodexHome } from "../../../src/runtime/codex/codex-home.js";
import { extractVersion } from "../../../src/runtime/codex/codex-version.js";

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

test("extractVersion yields 0.151.0 from the observed shape codex-cli 0.151.0", () => {
  const version = extractVersion("codex-cli 0.151.0");
  assert.equal(version, "0.151.0");
});

test("extractVersion yields the version token even with trailing metadata", () => {
  const version = extractVersion("codex-cli 0.151.0 (aarch64-apple-darwin)");
  assert.equal(version, "0.151.0");
});

test("extractVersion rejects output with no version-like token and includes the offending output", () => {
  const output = "codex (aarch64-apple-darwin)";
  assert.throws(
    () => extractVersion(output),
    (err: unknown) => {
      if (!(err instanceof DependencyError)) return false;
      return err.message.includes(output);
    },
  );
});
