import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadCatalog } from "../../src/catalog/load-catalog.js";
import { FileLifecycleError } from "../../src/domain/file-lifecycle-error.js";
import type { CatalogVariant } from "../../src/catalog/load-catalog.js";
import { hashTree, hashValue } from "../../src/integrity/content-hash.js";
import { materializeWorkspace } from "../../src/workspace/materialize-workspace.js";
import { installVariant } from "../../src/variants/install-variant.js";
import { ProjectPaths } from "../../src/paths/project-paths.js";
import { safeTreeFileSystem } from "../../src/filesystem/safe-tree.js";
import { createTempProject, writeJson } from "../helpers/temp-project.js";

test("installs an empty control without writing to the workspace", async () => {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root);
  const control = catalog.variants.find(({ manifest }) => manifest.id === "control");
  assert.ok(control);
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const before = await hashTree(workspace.workspacePath);
  try {
    const result = await installVariant({ variant: control, runtime: "codex", workspacePath: workspace.workspacePath });
    assert.deepEqual(result.destinations, []);
    assert.equal(result.contentHash, hashValue([]));
    assert.equal(await hashTree(workspace.workspacePath), before);
  } finally {
    await workspace.cleanup();
  }
});

test("installs mapped directories and verifies destination bytes with the Stage 1 formula", async () => {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root);
  const variant = catalog.variants.find(({ manifest }) => manifest.id === "example");
  assert.ok(variant);
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  try {
    const result = await installVariant({ variant, runtime: "codex", workspacePath: workspace.workspacePath });
    const destination = join(workspace.workspacePath, ".codex/skills/example");
    assert.equal(await readFile(join(destination, "SKILL.md"), "utf8"), "# Example skill\n");
    assert.deepEqual(result.destinations, [destination]);
    assert.equal(result.contentHash, variant.manifest.contentHash);
  } finally {
    await workspace.cleanup();
  }
});

const conflicts = [
  ["same destination", [".codex/skills/shared", ".codex/skills/shared"]],
  ["ancestor overlap", [".codex/skills/shared", ".codex/skills/shared/nested"]],
  ["descendant overlap", [".codex/skills/shared/nested", ".codex/skills/shared"]],
] as const;

for (const [name, destinations] of conflicts) {
  test(`rejects ${name} before changing the workspace`, async () => {
    const project = await createTempProject();
    const otherSource = join(project.exampleVariantDirectory, "other");
    await mkdir(otherSource);
    await writeFile(join(otherSource, "OTHER.md"), "other\n");
    const contentHash = hashValue([
      { source: "variants/example/skill", contentHash: await hashTree(project.exampleInstallDirectory) },
      { source: "variants/example/other", contentHash: await hashTree(otherSource) },
    ]);
    await writeJson(project.exampleManifestPath, {
      ...project.exampleManifest,
      installs: [
        { source: "variants/example/skill", destinations: { codex: destinations[0] } },
        { source: "variants/example/other", destinations: { codex: destinations[1] } },
      ],
      contentHash,
    });
    const variant = await exampleVariant(project.root);
    const paths = await ProjectPaths.create(project.root);
    const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
    const before = await hashTree(workspace.workspacePath);
    try {
      await assertFileLifecycleError(
        () => installVariant({ variant, runtime: "codex", workspacePath: workspace.workspacePath }),
        "INSTALL_DESTINATION_CONFLICT",
      );
      assert.equal(await hashTree(workspace.workspacePath), before);
    } finally {
      await workspace.cleanup();
    }
  });
}

test("rejects destination traversal before changing the workspace", async () => {
  const project = await createTempProject();
  const variant = await exampleVariant(project.root);
  const unsafeVariant = withInstall(variant, "variants/example/skill", "../outside");
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const before = await hashTree(workspace.workspacePath);
  try {
    await assertFileLifecycleError(
      () => installVariant({ variant: unsafeVariant, runtime: "codex", workspacePath: workspace.workspacePath }),
      "UNSAFE_FILESYSTEM_INPUT",
    );
    assert.equal(await hashTree(workspace.workspacePath), before);
  } finally {
    await workspace.cleanup();
  }
});

test("rolls back copied material when a source changes after catalog loading", async () => {
  const project = await createTempProject();
  const variant = await exampleVariant(project.root);
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const before = await hashTree(workspace.workspacePath);
  await writeFile(join(project.exampleInstallDirectory, "SKILL.md"), "changed after catalog load\n");
  try {
    await assertFileLifecycleError(
      () => installVariant({ variant, runtime: "codex", workspacePath: workspace.workspacePath }),
      "CONTENT_HASH_MISMATCH",
    );
    await assert.rejects(() => access(join(workspace.workspacePath, ".codex/skills/example")), { code: "ENOENT" });
    assert.equal(await hashTree(workspace.workspacePath), before);
  } finally {
    await workspace.cleanup();
  }
});

test("preserves a destination created after preflight when its copy creation fails", async () => {
  const project = await createTempProject();
  const variant = await exampleVariant(project.root);
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const destination = join(workspace.workspacePath, ".codex/skills/example");
  const originalMkdir = safeTreeFileSystem.mkdir.bind(safeTreeFileSystem);
  let injected = false;
  safeTreeFileSystem.mkdir = async (path: string): Promise<unknown> => {
    if (path === destination) {
      injected = true;
      await originalMkdir(path);
      await writeFile(join(path, "foreign.md"), "foreign destination\n");
      throw errno("EEXIST", "forced destination creation conflict");
    }
    return originalMkdir(path);
  };
  try {
    await assertFileLifecycleError(
      () => installVariant({ variant, runtime: "codex", workspacePath: workspace.workspacePath }),
      "UNSAFE_FILESYSTEM_INPUT",
    );
    assert.ok(injected);
    assert.equal(await readFile(join(destination, "foreign.md"), "utf8"), "foreign destination\n");
  } finally {
    safeTreeFileSystem.mkdir = originalMkdir;
    await workspace.cleanup();
  }
});

test("removes parents created before parent creation fails", async () => {
  const project = await createTempProject();
  const variant = await exampleVariant(project.root);
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const failingParent = join(workspace.workspacePath, ".codex/skills");
  const originalMkdir = safeTreeFileSystem.mkdir.bind(safeTreeFileSystem);
  safeTreeFileSystem.mkdir = async (path: string): Promise<unknown> => {
    if (path === failingParent) throw errno("EACCES", "forced parent creation failure");
    return originalMkdir(path);
  };
  try {
    await assertFileLifecycleError(
      () => installVariant({ variant, runtime: "codex", workspacePath: workspace.workspacePath }),
      "UNSAFE_FILESYSTEM_INPUT",
    );
    await assert.rejects(() => access(join(workspace.workspacePath, ".codex")), { code: "ENOENT" });
  } finally {
    safeTreeFileSystem.mkdir = originalMkdir;
    await workspace.cleanup();
  }
});

for (const kind of ["file", "directory"] as const) {
  test(`rejects an existing destination ${kind} without changing its bytes`, async () => {
    const project = await createTempProject();
    const variant = await exampleVariant(project.root);
    const paths = await ProjectPaths.create(project.root);
    const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
    const destination = join(workspace.workspacePath, ".codex/skills/example");
    await mkdir(join(workspace.workspacePath, ".codex/skills"), { recursive: true });
    if (kind === "file") {
      await writeFile(destination, "existing file\n");
    } else {
      await mkdir(destination);
      await writeFile(join(destination, "existing.md"), "existing directory\n");
    }
    const before = await hashTree(workspace.workspacePath);
    try {
      await assertFileLifecycleError(
        () => installVariant({ variant, runtime: "codex", workspacePath: workspace.workspacePath }),
        "INSTALL_DESTINATION_CONFLICT",
      );
      assert.equal(await hashTree(workspace.workspacePath), before);
      if (kind === "file") assert.equal(await readFile(destination, "utf8"), "existing file\n");
      else assert.equal(await readFile(join(destination, "existing.md"), "utf8"), "existing directory\n");
    } finally {
      await workspace.cleanup();
    }
  });
}

test("rejects a destination ancestor symlink without writing externally", async () => {
  const project = await createTempProject();
  const variant = await exampleVariant(project.root);
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const outside = await mkdirTempDirectory();
  try {
    try {
      await symlink(outside, join(workspace.workspacePath, ".codex"));
    } catch (error: unknown) {
      if (isSymlinkUnsupported(error)) return;
      throw error;
    }
    await assertFileLifecycleError(
      () => installVariant({ variant, runtime: "codex", workspacePath: workspace.workspacePath }),
      "UNSAFE_FILESYSTEM_INPUT",
    );
    await assert.rejects(() => access(join(outside, "skills/example/SKILL.md")), { code: "ENOENT" });
  } finally {
    await workspace.cleanup();
  }
});

test("rejects a manifest source outside its variant directory", async () => {
  const project = await createTempProject();
  const variant = await exampleVariant(project.root);
  const unsafeVariant = withInstall(variant, "fixtures/queuedesk", ".codex/skills/example");
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const before = await hashTree(workspace.workspacePath);
  try {
    await assertFileLifecycleError(
      () => installVariant({ variant: unsafeVariant, runtime: "codex", workspacePath: workspace.workspacePath }),
      "UNSAFE_FILESYSTEM_INPUT",
    );
    assert.equal(await hashTree(workspace.workspacePath), before);
  } finally {
    await workspace.cleanup();
  }
});

test("reports a missing runtime destination before writing", async () => {
  const project = await createTempProject();
  await writeJson(project.exampleManifestPath, {
    ...project.exampleManifest,
    installs: [{ source: "variants/example/skill", destinations: {} }],
  });
  const variant = await exampleVariant(project.root);
  const paths = await ProjectPaths.create(project.root);
  const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
  const before = await hashTree(workspace.workspacePath);
  try {
    await assertFileLifecycleError(
      () => installVariant({ variant, runtime: "codex", workspacePath: workspace.workspacePath }),
      "INSTALL_SOURCE_MISSING",
      /codex/,
    );
    assert.equal(await hashTree(workspace.workspacePath), before);
  } finally {
    await workspace.cleanup();
  }
});

async function exampleVariant(root: string): Promise<CatalogVariant> {
  const catalog = await loadCatalog(root);
  const variant = catalog.variants.find(({ manifest }) => manifest.id === "example");
  assert.ok(variant);
  return variant;
}

function withInstall(variant: CatalogVariant, source: string, destination: string): CatalogVariant {
  return {
    ...variant,
    manifest: {
      ...variant.manifest,
      installs: [{ source, destinations: { codex: destination } }],
    },
  };
}

async function assertFileLifecycleError(
  operation: () => Promise<unknown>,
  code: FileLifecycleError["code"],
  message?: RegExp,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof FileLifecycleError);
    assert.equal(error.code, code);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
}

async function mkdirTempDirectory(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "skillbench-install-outside-"));
}

function isSymlinkUnsupported(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error.code === "EPERM") || (error.code === "EACCES") || (error.code === "ENOTSUP"));
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
