import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const run = promisify(execFile);
const script = join(import.meta.dirname, "../../scripts/build-fixtures.mjs");

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function build(root: string, extra: string[] = []): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, "--root", root, ...extra]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skillbench-fixtures-"));
  await mkdir(join(root, "fixtures/base/src"), { recursive: true });
  await writeFile(join(root, "fixtures/base/src/index.js"), "export const value = 1;\n");
  await writeFile(join(root, "fixtures/base/src/guard.js"), "export const guard = true;\n");
  await writeFile(join(root, "fixtures/base/README.md"), "# Base\n");
  return root;
}

async function createOverlay(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<void> {
  const directory = join(root, "fixtures/overlays", name);
  await mkdir(join(directory, "files"), { recursive: true });
  await writeFile(join(directory, "overlay.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(directory, "files", relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
}

test("composes a fixture that replaces and adds files", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "broken",
    { baseFixture: "base", target: "base-broken", description: "Replaces the index.", removals: [] },
    { "src/index.js": "export const value = 2;\n", "src/extra.js": "export const extra = true;\n" },
  );

  const outcome = await build(root);
  assert.equal(outcome.code, 0);
  assert.equal(await readFile(join(root, "fixtures/base-broken/src/index.js"), "utf8"), "export const value = 2;\n");
  assert.equal(await readFile(join(root, "fixtures/base-broken/src/extra.js"), "utf8"), "export const extra = true;\n");
  assert.equal(await readFile(join(root, "fixtures/base-broken/README.md"), "utf8"), "# Base\n");
});

test("honors removals", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "no-guard",
    { baseFixture: "base", target: "base-no-guard", description: "Drops the guard.", removals: ["src/guard.js"] },
    { "src/index.js": "export const value = 3;\n" },
  );

  assert.equal((await build(root)).code, 0);
  await assert.rejects(readFile(join(root, "fixtures/base-no-guard/src/guard.js"), "utf8"));
});

test("check mode passes on a freshly built tree and fails after a hand edit", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "broken",
    { baseFixture: "base", target: "base-broken", description: "Replaces the index.", removals: [] },
    { "src/index.js": "export const value = 2;\n" },
  );
  assert.equal((await build(root)).code, 0);
  assert.equal((await build(root, ["--check"])).code, 0);

  await writeFile(join(root, "fixtures/base-broken/src/index.js"), "export const value = 99;\n");
  const drift = await build(root, ["--check"]);
  assert.equal(drift.code, 1);
  assert.match(drift.stderr, /base-broken\/src\/index\.js/u);
});

test("check mode reports a composed fixture that was never built", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "broken",
    { baseFixture: "base", target: "base-broken", description: "Replaces the index.", removals: [] },
    { "src/index.js": "export const value = 2;\n" },
  );
  const missing = await build(root, ["--check"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /base-broken/u);
});

test("rejects a target outside the fixtures directory", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "escape",
    { baseFixture: "base", target: "../escaped", description: "Escapes.", removals: [] },
    { "src/index.js": "export const value = 2;\n" },
  );
  const outcome = await build(root);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /target/u);
});

test("rejects an unknown base fixture", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "absent",
    { baseFixture: "missing", target: "missing-broken", description: "No base.", removals: [] },
    { "src/index.js": "export const value = 2;\n" },
  );
  const outcome = await build(root);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /missing/u);
});

test("rejects a symbolic link in an overlay", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "linked",
    { baseFixture: "base", target: "base-linked", description: "Contains a link.", removals: [] },
    { "src/index.js": "export const value = 2;\n" },
  );
  await symlink("/etc/hosts", join(root, "fixtures/overlays/linked/files/src/link.js"));
  const outcome = await build(root);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /symbolic link/u);
});

test("rejects a removal that names no file in the base", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "phantom",
    { baseFixture: "base", target: "base-phantom", description: "Removes nothing.", removals: ["src/absent.js"] },
    { "src/index.js": "export const value = 2;\n" },
  );
  const outcome = await build(root);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /src\/absent\.js/u);
});

test("passes in both modes when fixtures has no overlays directory", async () => {
  const root = await createRoot();
  assert.equal((await build(root)).code, 0);
  assert.equal((await build(root, ["--check"])).code, 0);
});
