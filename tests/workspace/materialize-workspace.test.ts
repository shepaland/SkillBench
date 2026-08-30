import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileLifecycleError } from "../../src/domain/file-lifecycle-error.js";
import { hashTree } from "../../src/integrity/content-hash.js";
import { ProjectPaths } from "../../src/paths/project-paths.js";
import {
  materializeWorkspace,
  workspaceFileSystem,
} from "../../src/workspace/materialize-workspace.js";
import { createTempProject } from "../helpers/temp-project.js";

test("materializes a unique fixture copy and preserves nested and empty directories", async () => {
  const project = await createTempProject();
  await mkdir(join(project.fixtureDirectory, "nested/empty"), { recursive: true });
  await writeFile(join(project.fixtureDirectory, "nested/value.txt"), "fixture\n");
  const paths = await ProjectPaths.create(project.root);

  const first = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const second = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  try {
    assert.notEqual(first.workspacePath, second.workspacePath);
    assert.equal(await readFile(join(first.workspacePath, "nested/value.txt"), "utf8"), "fixture\n");
    await access(join(first.workspacePath, "nested/empty"));
    assert.equal(first.fixtureHash, await hashTree(project.fixtureDirectory));
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("detects source fixture mutation and cleanup is idempotent", async () => {
  const project = await createTempProject();
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });

  await workspace.verifySource();
  await writeFile(join(project.fixtureDirectory, "changed.txt"), "changed\n");
  await assert.rejects(
    workspace.verifySource(),
    (error: unknown) => error instanceof FileLifecycleError &&
      error.code === "CONTENT_HASH_MISMATCH",
  );
  await workspace.cleanup();
  await workspace.cleanup();
  await assert.rejects(access(workspace.workspacePath), { code: "ENOENT" });
});

test("rejects fixture symbolic links and removes the partial temporary root", async (context) => {
  const project = await createTempProject();
  try {
    await symlink(join(project.fixtureDirectory, "index.js"), join(project.fixtureDirectory, "linked.js"));
  } catch (error: unknown) {
    if (isSymlinkUnsupported(error)) {
      context.skip("symbolic links are unavailable on this platform");
      return;
    }
    throw error;
  }
  const paths = await ProjectPaths.create(project.root);

  await assert.rejects(
    materializeWorkspace({ paths, fixture: "fixtures/queuedesk", tempParent: tmpdir() }),
    (error: unknown) => error instanceof FileLifecycleError &&
      error.code === "UNSAFE_FILESYSTEM_INPUT",
  );
});

test("preserves the copy failure and attaches cleanup failure evidence", async () => {
  const project = await createTempProject();
  const paths = await ProjectPaths.create(project.root);
  const fileSystem = {
    ...workspaceFileSystem,
    copyFile: (): Promise<void> => Promise.reject(new Error("forced copy failure")),
    rm: (): Promise<void> => Promise.reject(new Error("forced cleanup failure")),
  };

  await assert.rejects(
    materializeWorkspace({ paths, fixture: "fixtures/queuedesk", fileSystem }),
    (error: unknown) => error instanceof FileLifecycleError &&
      error.message.includes("forced copy failure") &&
      error.cleanupFailure instanceof Error &&
      error.cleanupFailure.message === "forced cleanup failure",
  );
});

test("reports cleanup failure without marking the workspace cleaned", async () => {
  const project = await createTempProject();
  const paths = await ProjectPaths.create(project.root);
  let failCleanup = true;
  const fileSystem = {
    ...workspaceFileSystem,
    rm: async (path: string, options: { recursive: true; force: true }): Promise<void> => {
      if (failCleanup) throw new Error("forced cleanup failure");
      await workspaceFileSystem.rm(path, options);
    },
  };
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk", fileSystem });

  await assert.rejects(workspace.cleanup(), (error: unknown) =>
    error instanceof FileLifecycleError && error.code === "CLEANUP_FAILURE");
  failCleanup = false;
  await workspace.cleanup();
});

function isSymlinkUnsupported(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP");
}
