import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ValidationError } from "../../src/domain/errors.js";
import { diffSnapshots, observeChangePaths, snapshotTree } from "../../src/runs/snapshot.js";

async function createTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skillbench-snapshot-"));
  await mkdir(join(root, "src/nested"), { recursive: true });
  await mkdir(join(root, "empty"), { recursive: true });
  await writeFile(join(root, "src/index.js"), "export const value = 1;\n");
  await writeFile(join(root, "src/nested/util.js"), "export const util = 2;\n");
  await writeFile(join(root, "README.md"), "# fixture\n");
  return root;
}

test("snapshots every file with a stable byte-ordered path list", async () => {
  const root = await createTree();

  const snapshot = await snapshotTree(root);

  assert.deepEqual(snapshot.map((entry) => entry.path), [
    "README.md",
    "src/index.js",
    "src/nested/util.js",
  ]);
  for (const entry of snapshot) {
    assert.match(entry.contentHash, /^sha256:[0-9a-f]{64}$/u);
  }
});

test("diffs added, modified, and removed files and ignores untouched files", async () => {
  const root = await createTree();
  const before = await snapshotTree(root);
  await writeFile(join(root, "src/index.js"), "export const value = 2;\n");
  await writeFile(join(root, "src/added.js"), "export const added = 3;\n");
  await rm(join(root, "README.md"));

  const changes = diffSnapshots(before, await snapshotTree(root));

  assert.deepEqual(changes, {
    added: ["src/added.js"],
    modified: ["src/index.js"],
    removed: ["README.md"],
  });
});

test("an emptied directory reports its files as removed", async () => {
  const root = await createTree();
  const before = await snapshotTree(root);
  await rm(join(root, "src/nested"), { recursive: true });

  const changes = diffSnapshots(before, await snapshotTree(root));

  assert.deepEqual(changes.removed, ["src/nested/util.js"]);
  assert.deepEqual(changes.added, []);
  assert.deepEqual(changes.modified, []);
});

test("rejects a symbolic link inside the tree", async (context) => {
  const root = await createTree();
  try {
    await symlink(join(root, "src/index.js"), join(root, "src/linked.js"));
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
      context.skip("symbolic links are unavailable on this platform");
      return;
    }
    throw error;
  }

  await assert.rejects(snapshotTree(root), (error: unknown) => error instanceof ValidationError);
});

test("observes changes outside allowed paths and inside forbidden paths", () => {
  const changes = {
    added: ["secrets/key.txt", "src/added.js"],
    modified: ["docs/guide.md"],
    removed: ["src/index.js"],
  };

  const observations = observeChangePaths(changes, ["src"], ["secrets"]);

  assert.deepEqual(observations, {
    outsideAllowed: ["docs/guide.md", "secrets/key.txt"],
    insideForbidden: ["secrets/key.txt"],
  });
});

test("an empty allowed list treats every change as outside", () => {
  const changes = { added: ["a.txt"], modified: [], removed: [] };

  assert.deepEqual(observeChangePaths(changes, [], []), {
    outsideAllowed: ["a.txt"],
    insideForbidden: [],
  });
});
