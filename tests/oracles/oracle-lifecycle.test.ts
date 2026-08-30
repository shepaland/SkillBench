import assert from "node:assert/strict";
import { access, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { FileLifecycleError } from "../../src/domain/file-lifecycle-error.js";
import {
  OracleLifecycle,
  oracleFileSystem,
} from "../../src/oracles/oracle-lifecycle.js";
import { ProjectPaths } from "../../src/paths/project-paths.js";
import { materializeWorkspace } from "../../src/workspace/materialize-workspace.js";
import { createTempProject } from "../helpers/temp-project.js";

test("mounts a private oracle only after explicit agent closure and outside the workspace", async () => {
  const project = await createTempProject();
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const oracle = await OracleLifecycle.create({ paths, caseId: "F01", workspacePath: workspace.workspacePath });
  try {
    assert.equal(oracle.state, "agent_active");
    await assert.rejects(
      oracle.mountOracle(),
      (error: unknown) => error instanceof FileLifecycleError &&
        error.code === "INVALID_LIFECYCLE_TRANSITION",
    );
    oracle.markAgentClosed();
    assert.equal(oracle.state, "agent_closed");
    const mounted = await oracle.mountOracle();
    assert.equal(oracle.state, "oracle_mounted");
    assert.equal(relative(workspace.workspacePath, mounted.gradingPath).startsWith(".."), true);
    assert.equal(relative(mounted.gradingPath, workspace.workspacePath).startsWith(".."), true);
    assert.equal(await readFile(join(mounted.gradingPath, "assertions.js"), "utf8"),
      "export const assertions = ['functional'];\n");
    assert.equal(Object.isFrozen(mounted), true);
  } finally {
    await oracle.cleanup();
    await workspace.cleanup();
  }
});

test("cleanup is idempotent from every state and prevents later transitions", async () => {
  for (const stateBeforeCleanup of ["agent_active", "agent_closed", "oracle_mounted"] as const) {
    const project = await createTempProject();
    const paths = await ProjectPaths.create(project.root);
    const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
    const oracle = await OracleLifecycle.create({ paths, caseId: "F01", workspacePath: workspace.workspacePath });
    if (stateBeforeCleanup !== "agent_active") oracle.markAgentClosed();
    if (stateBeforeCleanup === "oracle_mounted") await oracle.mountOracle();
    await oracle.cleanup();
    await oracle.cleanup();
    assert.equal(oracle.state, "cleaned");
    assert.throws(() => {
      oracle.markAgentClosed();
    }, (error: unknown) =>
      error instanceof FileLifecycleError && error.code === "INVALID_LIFECYCLE_TRANSITION");
    await assert.rejects(oracle.mountOracle(), (error: unknown) =>
      error instanceof FileLifecycleError && error.code === "INVALID_LIFECYCLE_TRANSITION");
    await workspace.cleanup();
  }
});

test("reports a missing private oracle without changing the closed state", async () => {
  const project = await createTempProject();
  await rm(project.oracleDirectory, { recursive: true, force: true });
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const oracle = await OracleLifecycle.create({ paths, caseId: "F01", workspacePath: workspace.workspacePath });
  try {
    oracle.markAgentClosed();
    await assert.rejects(oracle.mountOracle(), (error: unknown) =>
      error instanceof FileLifecycleError && error.code === "INSTALL_SOURCE_MISSING");
    assert.equal(oracle.state, "agent_closed");
  } finally {
    await oracle.cleanup();
    await workspace.cleanup();
  }
});

test("rejects private oracle symbolic links and removes the partial grading root", async (context) => {
  const project = await createTempProject();
  let rootPath: string | undefined;
  try {
    await symlink(join(project.oracleDirectory, "assertions.js"), join(project.oracleDirectory, "linked.js"));
  } catch (error: unknown) {
    if (isSymlinkUnsupported(error)) {
      context.skip("symbolic links are unavailable on this platform");
      return;
    }
    throw error;
  }
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const fileSystem = {
    ...oracleFileSystem,
    mkdtemp: async (prefix: string): Promise<string> => {
      rootPath = await oracleFileSystem.mkdtemp(prefix);
      return rootPath;
    },
  };
  const oracle = await OracleLifecycle.create({
    paths,
    caseId: "F01",
    workspacePath: workspace.workspacePath,
    fileSystem,
  });
  try {
    oracle.markAgentClosed();
    await assert.rejects(oracle.mountOracle(), (error: unknown) =>
      error instanceof FileLifecycleError && error.code === "UNSAFE_FILESYSTEM_INPUT");
    assert.equal(oracle.state, "agent_closed");
    assert.ok(rootPath);
    await assert.rejects(access(join(rootPath, "grading")), { code: "ENOENT" });
  } finally {
    await oracle.cleanup();
    await workspace.cleanup();
  }
});

test("rejects temporary parents inside the workspace before allocation and accepts a shared ancestor", async () => {
  const project = await createTempProject();
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  let allocated = false;
  const fileSystem = {
    ...oracleFileSystem,
    mkdtemp: async (prefix: string): Promise<string> => {
      allocated = true;
      return oracleFileSystem.mkdtemp(prefix);
    },
  };
  try {
    await assert.rejects(
      OracleLifecycle.create({
        paths,
        caseId: "F01",
        workspacePath: workspace.workspacePath,
        tempParent: workspace.workspacePath,
        fileSystem,
      }),
      (error: unknown) => error instanceof FileLifecycleError && error.code === "UNSAFE_FILESYSTEM_INPUT",
    );
    assert.equal(allocated, false);

    const oracle = await OracleLifecycle.create({
      paths,
      caseId: "F01",
      workspacePath: workspace.workspacePath,
      tempParent: tmpdir(),
      fileSystem,
    });
    try {
      oracle.markAgentClosed();
      const mounted = await oracle.mountOracle();
      assert.equal(relative(workspace.workspacePath, mounted.gradingPath).startsWith(".."), true);
    } finally {
      await oracle.cleanup();
    }
  } finally {
    await workspace.cleanup();
  }
});

test("does not remove the workspace when an allocated oracle root overlaps it", async () => {
  const project = await createTempProject();
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  let attemptedWorkspaceRemoval = false;
  const fileSystem = {
    ...oracleFileSystem,
    mkdtemp: (): Promise<string> => Promise.resolve(workspace.workspacePath),
    rm: async (path: string, options: { recursive: true; force: true }): Promise<void> => {
      if (path === workspace.workspacePath) {
        attemptedWorkspaceRemoval = true;
        throw new Error("workspace must never be removed");
      }
      await oracleFileSystem.rm(path, options);
    },
  };
  const oracle = await OracleLifecycle.create({
    paths,
    caseId: "F01",
    workspacePath: workspace.workspacePath,
    fileSystem,
  });
  try {
    oracle.markAgentClosed();
    await assert.rejects(oracle.mountOracle(), (error: unknown) =>
      error instanceof FileLifecycleError && error.code === "UNSAFE_FILESYSTEM_INPUT");
    assert.equal(attemptedWorkspaceRemoval, false);
    await access(join(workspace.workspacePath, "index.js"));
  } finally {
    await oracle.cleanup();
    await workspace.cleanup();
  }
});

test("cleans its allocated root when copying the oracle fails", async () => {
  const project = await createTempProject();
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  let rootPath: string | undefined;
  const fileSystem = {
    ...oracleFileSystem,
    mkdtemp: async (prefix: string): Promise<string> => {
      rootPath = await oracleFileSystem.mkdtemp(prefix);
      return rootPath;
    },
    copyFile: (): Promise<void> => Promise.reject(new Error("forced copy failure")),
  };
  const oracle = await OracleLifecycle.create({
    paths,
    caseId: "F01",
    workspacePath: workspace.workspacePath,
    fileSystem,
  });
  try {
    oracle.markAgentClosed();
    await assert.rejects(oracle.mountOracle(), (error: unknown) =>
      error instanceof FileLifecycleError && error.message.includes("forced copy failure"));
    assert.equal(oracle.state, "agent_closed");
    assert.ok(rootPath);
    await assert.rejects(access(rootPath), { code: "ENOENT" });
  } finally {
    await oracle.cleanup();
    await workspace.cleanup();
  }
});

test("preserves mounted state when cleanup fails and retries after the failure is disabled", async () => {
  const project = await createTempProject();
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  let failCleanup = false;
  const fileSystem = {
    ...oracleFileSystem,
    rm: async (path: string, options: { recursive: true; force: true }): Promise<void> => {
      if (failCleanup) throw new Error("forced cleanup failure");
      await oracleFileSystem.rm(path, options);
    },
  };
  const oracle = await OracleLifecycle.create({
    paths,
    caseId: "F01",
    workspacePath: workspace.workspacePath,
    fileSystem,
  });
  try {
    oracle.markAgentClosed();
    await oracle.mountOracle();
    failCleanup = true;
    await assert.rejects(oracle.cleanup(), (error: unknown) =>
      error instanceof FileLifecycleError && error.code === "CLEANUP_FAILURE");
    assert.equal(oracle.state, "oracle_mounted");
    failCleanup = false;
    await oracle.cleanup();
    assert.equal(oracle.state, "cleaned");
  } finally {
    failCleanup = false;
    await oracle.cleanup();
    await workspace.cleanup();
  }
});

test("removes mounted grading material on successful cleanup", async () => {
  const project = await createTempProject();
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const oracle = await OracleLifecycle.create({ paths, caseId: "F01", workspacePath: workspace.workspacePath });
  try {
    oracle.markAgentClosed();
    const mounted = await oracle.mountOracle();
    await oracle.cleanup();
    await assert.rejects(access(mounted.gradingPath), { code: "ENOENT" });
  } finally {
    await oracle.cleanup();
    await workspace.cleanup();
  }
});

function isSymlinkUnsupported(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP");
}
