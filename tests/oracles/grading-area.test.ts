import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileLifecycleError } from "../../src/domain/file-lifecycle-error.js";
import { createGradingArea } from "../../src/oracles/grading-area.js";
import { snapshotTree } from "../../src/runs/snapshot.js";

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "skillbench-area-workspace-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src/cli.js"), "export const value = 1;\n");
  await writeFile(join(workspace, "README.md"), "# tiny\n");
  return workspace;
}

test("records every file of the workspace in the evidence file", async () => {
  const workspace = await createWorkspace();
  const snapshot = await snapshotTree(workspace);
  const area = await createGradingArea({ workspacePath: workspace, snapshot });

  try {
    const evidence = JSON.parse(await readFile(join(area.evidencePath, "workspace.json"), "utf8")) as {
      schemaVersion: number;
      files: Record<string, string>;
    };
    assert.equal(evidence.schemaVersion, 1);
    assert.deepEqual(Object.keys(evidence.files).sort(), ["README.md", "src/cli.js"]);
    for (const entry of snapshot) {
      assert.equal(evidence.files[entry.path], entry.contentHash);
    }
  } finally {
    await area.cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("copies the workspace into a reference tree the checks never write to", async () => {
  const workspace = await createWorkspace();
  const snapshot = await snapshotTree(workspace);
  const area = await createGradingArea({ workspacePath: workspace, snapshot });

  try {
    assert.equal(await readFile(join(area.referencePath, "src/cli.js"), "utf8"), "export const value = 1;\n");
    await area.verifyMaterial();
  } finally {
    await area.cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reports a reference tree that changed, naming the path", async () => {
  const workspace = await createWorkspace();
  const snapshot = await snapshotTree(workspace);
  const area = await createGradingArea({ workspacePath: workspace, snapshot });

  try {
    await writeFile(join(area.referencePath, "src/cli.js"), "export const value = 2;\n");
    await assert.rejects(
      () => area.verifyMaterial(),
      (error: unknown) =>
        error instanceof FileLifecycleError &&
        error.code === "CONTENT_HASH_MISMATCH" &&
        error.message.includes("src/cli.js"),
    );
  } finally {
    await area.cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reports an evidence file that changed, naming it rather than a workspace path", async () => {
  // The spec says nothing a check does may change what the evidence says. The evidence
  // directory is shared by every check and, unlike the reference tree, was never
  // re-verified — this is what closes that gap.
  const workspace = await createWorkspace();
  const snapshot = await snapshotTree(workspace);
  const area = await createGradingArea({ workspacePath: workspace, snapshot });

  try {
    await writeFile(join(area.evidencePath, "workspace.json"), '{ "schemaVersion": 1, "files": {} }\n');
    await assert.rejects(
      () => area.verifyMaterial(),
      (error: unknown) =>
        error instanceof FileLifecycleError &&
        error.code === "CONTENT_HASH_MISMATCH" &&
        error.message.includes("evidence file") &&
        error.message.includes("workspace.json") &&
        !error.message.includes(workspace),
    );
  } finally {
    await area.cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("gives every check its own copy, and one copy cannot reach another", async () => {
  const workspace = await createWorkspace();
  const snapshot = await snapshotTree(workspace);
  const area = await createGradingArea({ workspacePath: workspace, snapshot });

  try {
    const first = await area.createCheckCopy();
    await writeFile(join(first.path, "src/cli.js"), "export const value = 99;\n");

    const second = await area.createCheckCopy();
    assert.notEqual(first.path, second.path);
    assert.equal(await readFile(join(second.path, "src/cli.js"), "utf8"), "export const value = 1;\n");
    await area.verifyMaterial();

    await first.remove();
    await assert.rejects(() => stat(first.path));
    assert.equal(await readFile(join(second.path, "src/cli.js"), "utf8"), "export const value = 1;\n");
    await second.remove();
  } finally {
    await area.cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a check copy cannot reach the evidence file by a relative path", async () => {
  const workspace = await createWorkspace();
  const snapshot = await snapshotTree(workspace);
  const area = await createGradingArea({ workspacePath: workspace, snapshot });

  try {
    const copy = await area.createCheckCopy();
    // A copy used to sit at `<root>/check-XXXX/workspace`, with the evidence directory a
    // sibling of `check-XXXX` at `<root>/evidence` — reachable from the copy as
    // `../../evidence/workspace.json`. The copies and the material now live under their
    // own, separately named temporary roots, so that fixed relative path leads nowhere:
    // it must not resolve to the real evidence file, and nothing must exist there at all.
    const guessedEvidencePath = join(copy.path, "..", "..", "evidence", "workspace.json");
    assert.notEqual(guessedEvidencePath, join(area.evidencePath, "workspace.json"));
    await assert.rejects(() => stat(guessedEvidencePath));
    await copy.remove();
  } finally {
    await area.cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("hands out canonical paths, so a copied CLI entrypoint still recognizes itself", async () => {
  const workspace = await createWorkspace();
  const snapshot = await snapshotTree(workspace);
  const area = await createGradingArea({ workspacePath: workspace, snapshot });

  try {
    const copy = await area.createCheckCopy();
    assert.equal(copy.path, await realpath(copy.path));
    assert.equal(area.referencePath, await realpath(area.referencePath));
    assert.equal(area.evidencePath, await realpath(area.evidencePath));
    await copy.remove();
  } finally {
    await area.cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cleanup removes the whole area and is safe to call twice", async () => {
  const workspace = await createWorkspace();
  const snapshot = await snapshotTree(workspace);
  const area = await createGradingArea({ workspacePath: workspace, snapshot });
  const reference = area.referencePath;

  await area.cleanup();
  await area.cleanup();
  await assert.rejects(() => stat(reference));
  await rm(workspace, { recursive: true, force: true });
});

test("refuses a workspace that no longer matches the snapshot it was given", async () => {
  const workspace = await createWorkspace();
  const snapshot = await snapshotTree(workspace);
  await writeFile(join(workspace, "README.md"), "# changed\n");

  await assert.rejects(
    () => createGradingArea({ workspacePath: workspace, snapshot }),
    (error: unknown) => error instanceof FileLifecycleError && error.code === "CONTENT_HASH_MISMATCH",
  );
  await rm(workspace, { recursive: true, force: true });
});
