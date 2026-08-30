import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectPaths } from "../../src/paths/project-paths.js";

test("project paths reject traversal, absolute paths, and symbolic link escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbench-project-"));
  const outside = await mkdtemp(join(tmpdir(), "skillbench-outside-"));
  await mkdir(join(root, "fixtures", "base"), { recursive: true });
  await writeFile(join(outside, "secret.txt"), "secret");

  const paths = await ProjectPaths.create(root);
  await assert.rejects(() => paths.resolveExisting("../outside", "file"), /escapes project root/);
  await assert.rejects(() => paths.resolveExisting("/etc/passwd", "file"), /must be relative/);

  try {
    await symlink(outside, join(root, "linked"));
  } catch (error: unknown) {
    if (isSymlinkUnsupported(error)) {
      return;
    }
    throw error;
  }

  await assert.rejects(() => paths.resolveExisting("linked/secret.txt", "file"), /symbolic link/);
});

test("project paths resolve existing directories and output paths within the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbench-project-"));
  await mkdir(join(root, "fixtures", "base"), { recursive: true });
  const paths = await ProjectPaths.create(root);

  assert.equal(await paths.resolveExisting("fixtures/base", "directory"), join(root, "fixtures/base"));
  assert.equal(await paths.resolveOutput("runs/run-1/result.json"), join(root, "runs/run-1/result.json"));
});

test("project paths normalize Windows separators but reject unsafe manifest path segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbench-project-"));
  const paths = await ProjectPaths.create(root);

  assert.equal(await paths.resolveOutput("fixtures\\base"), join(root, "fixtures/base"));

  for (const relativePath of ["", "fixtures//base", "fixtures/./base", "C:\\base", "a\0b"]) {
    await assert.rejects(() => paths.resolveOutput(relativePath), /path/);
  }
});

function isSymlinkUnsupported(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error.code === "EPERM") || (error.code === "EACCES") || (error.code === "ENOTSUP"));
}
