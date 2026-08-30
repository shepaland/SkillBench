# SkillBench Stage 2A File Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, independently testable primitives for fixture workspace materialization, data-driven variant installation, and post-session private-oracle mounting without enabling run orchestration.

**Architecture:** Three public modules own the workspace, variant, and oracle lifecycles. A private filesystem helper centralizes symlink-rejecting tree copies and rollback bookkeeping, while typed lifecycle errors make expected failures stable for later orchestration.

**Tech Stack:** Node.js 22+, TypeScript 5.9 native ESM, Node `fs/promises`, Node test runner, existing canonical SHA-256 helpers, npm.

**Spec:** `docs/superpowers/specs/2026-08-30-skillbench-stage-2a-file-lifecycle-design.md`

## Global Constraints

- Runtime is Node.js 22 or newer and the package remains native ESM.
- Public messages, tests, fixtures, schemas, and documentation use concise international English; README keeps English first and a complete Russian translation second.
- Core code must not branch on named skills; variants remain data.
- Never place `.private/oracles/` content in an active agent workspace.
- Reject path traversal, symbolic-link escapes, duplicate destinations, overlapping destinations, and collisions with existing workspace content.
- Preserve the Stage 1 `hashTree()` and variant material-hash formulas.
- A failed operation removes only paths it created; cleanup never accepts a caller-selected deletion target.
- `list`, `dry-run`, `run`, `compare`, and `report` remain reserved and return exit code `2`.
- Do not add public cases, fixtures, variants, private oracles, run manifests, normalized results, or adapter orchestration.

## File Structure

- Create `src/domain/file-lifecycle-error.ts`: stable error codes and primary-plus-cleanup failure evidence.
- Create `src/filesystem/safe-tree.ts`: internal safe tree copy, containment, created-path rollback, and filesystem dependency boundary.
- Create `src/workspace/materialize-workspace.ts`: fixture copy, source integrity verification, and workspace cleanup lifecycle.
- Create `src/variants/install-variant.ts`: runtime mapping preflight, apply, installed hash verification, and rollback.
- Create `src/oracles/oracle-lifecycle.ts`: explicit oracle state machine and separate grading-area lifecycle.
- Create `tests/workspace/materialize-workspace.test.ts`: workspace success, integrity, symlink, failure, and cleanup coverage.
- Create `tests/variants/install-variant.test.ts`: control, mapped installation, safety, atomicity, and hash coverage.
- Create `tests/oracles/oracle-lifecycle.test.ts`: state transition, isolation, failure, and cleanup coverage.
- Modify `README.md`: describe Stage 2A accurately in English and Russian.
- Modify `AGENTS.md`: record the completed stage and Stage 2B boundary.

---

### Task 1: Safe Tree Copy and Materialized Workspace Lifecycle

**Files:**
- Create: `src/domain/file-lifecycle-error.ts`
- Create: `src/filesystem/safe-tree.ts`
- Create: `src/workspace/materialize-workspace.ts`
- Create: `tests/workspace/materialize-workspace.test.ts`

**Interfaces:**
- Produces: `FileLifecycleError`, `FileLifecycleErrorCode`, `SafeTreeFileSystem`, `copySafeTree()`, `rollbackCreatedPaths()`, `isSameOrInside()`, `materializeWorkspace()`, `MaterializedWorkspace`, and `WorkspaceFileSystem`.
- Consumes: `ContentHash`, `hashTree()`, and `ProjectPaths.resolveExisting()` from Stage 1.

- [ ] **Step 1: Write failing workspace lifecycle tests**

Create `tests/workspace/materialize-workspace.test.ts` with these concrete cases:

```ts
import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileLifecycleError } from "../../src/domain/file-lifecycle-error.js";
import { hashTree } from "../../src/integrity/content-hash.js";
import { ProjectPaths } from "../../src/paths/project-paths.js";
import { materializeWorkspace } from "../../src/workspace/materialize-workspace.js";
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

function isSymlinkUnsupported(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP");
}
```

Add two dependency-injection cases in the same file:

```ts
test("preserves the copy failure and attaches cleanup failure evidence", async () => {
  const project = await createTempProject();
  const paths = await ProjectPaths.create(project.root);
  const fileSystem = {
    ...workspaceFileSystem,
    copyFile: async (): Promise<void> => {
      throw new Error("forced copy failure");
    },
    rm: async (): Promise<void> => {
      throw new Error("forced cleanup failure");
    },
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
```

Import `workspaceFileSystem` from the implementation so injected test doubles retain the exact Node-backed operations.

- [ ] **Step 2: Run the workspace test and verify RED**

Run:

```sh
node --import tsx --test tests/workspace/materialize-workspace.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/workspace/materialize-workspace.ts` or `src/domain/file-lifecycle-error.ts`.

- [ ] **Step 3: Implement stable lifecycle errors**

Create `src/domain/file-lifecycle-error.ts`:

```ts
import { SkillBenchError } from "./errors.js";

export type FileLifecycleErrorCode =
  | "UNSAFE_FILESYSTEM_INPUT"
  | "INSTALL_SOURCE_MISSING"
  | "INSTALL_DESTINATION_CONFLICT"
  | "CONTENT_HASH_MISMATCH"
  | "INVALID_LIFECYCLE_TRANSITION"
  | "CLEANUP_FAILURE";

export class FileLifecycleError extends SkillBenchError {
  public readonly cause: unknown;
  public readonly cleanupFailure: unknown;

  public constructor(
    public readonly code: FileLifecycleErrorCode,
    message: string,
    details: { readonly cause?: unknown; readonly cleanupFailure?: unknown } = {},
  ) {
    super(message, 2);
    this.cause = details.cause;
    this.cleanupFailure = details.cleanupFailure;
  }
}
```

- [ ] **Step 4: Implement the private safe-tree helper**

Create `src/filesystem/safe-tree.ts` with this dependency boundary and behavior:

```ts
import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Dirent } from "node:fs";
import { FileLifecycleError } from "../domain/file-lifecycle-error.js";

export interface SafeTreeFileSystem {
  lstat(path: string): ReturnType<typeof lstat>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  mkdir(path: string): Promise<unknown>;
  copyFile(source: string, destination: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

export const safeTreeFileSystem: SafeTreeFileSystem = { lstat, readdir, mkdir, copyFile, rm };

export function isSameOrInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export async function copySafeTree(
  source: string,
  destination: string,
  fileSystem: SafeTreeFileSystem = safeTreeFileSystem,
): Promise<readonly string[]> {
  const created: string[] = [];
  await copyEntry(source, destination, "", created, fileSystem);
  return created;
}

async function copyEntry(
  source: string,
  destination: string,
  relativePath: string,
  created: string[],
  fileSystem: SafeTreeFileSystem,
): Promise<void> {
  const status = await fileSystem.lstat(source);
  if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) {
    throw new FileLifecycleError(
      "UNSAFE_FILESYSTEM_INPUT",
      `unsupported filesystem entry: ${relativePath || "."}`,
    );
  }
  if (status.isFile()) {
    created.push(destination);
    await fileSystem.copyFile(source, destination);
    return;
  }
  await fileSystem.mkdir(destination);
  created.push(destination);
  const entries = await fileSystem.readdir(source, { withFileTypes: true });
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
    await copyEntry(
      join(source, entry.name),
      join(destination, entry.name),
      childRelative,
      created,
      fileSystem,
    );
  }
}

export async function rollbackCreatedPaths(
  created: readonly string[],
  fileSystem: SafeTreeFileSystem = safeTreeFileSystem,
): Promise<void> {
  for (const path of [...created].sort((left, right) => right.length - left.length)) {
    await fileSystem.rm(path, { recursive: true, force: true });
  }
}
```

- [ ] **Step 5: Implement workspace materialization and cleanup**

Create `src/workspace/materialize-workspace.ts` with these exact public types:

```ts
export interface WorkspaceFileSystem extends SafeTreeFileSystem {
  mkdtemp(prefix: string): Promise<string>;
}

export interface MaterializedWorkspace {
  readonly rootPath: string;
  readonly workspacePath: string;
  readonly fixtureHash: ContentHash;
  verifySource(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface MaterializeWorkspaceInput {
  readonly paths: ProjectPaths;
  readonly fixture: string;
  readonly tempParent?: string;
  readonly fileSystem?: WorkspaceFileSystem;
}
```

Export a Node-backed `workspaceFileSystem`. `materializeWorkspace()` must reject fixture paths outside `fixtures/`, resolve the source with `ProjectPaths.resolveExisting(fixture, "directory")`, freeze `hashTree(source)`, allocate `mkdtemp(join(tempParent ?? tmpdir(), "skillbench-workspace-"))`, and copy to `<root>/workspace` with `copySafeTree()`.

Use a closure-local `cleaned` boolean. `verifySource()` compares a fresh `hashTree(source)` to `fixtureHash` and throws `FileLifecycleError("CONTENT_HASH_MISMATCH", ...)`. `cleanup()` removes only the generated root and sets `cleaned = true` only after a successful `rm`. If copying fails, remove the generated root; if that removal also fails, wrap the primary error and attach the cleanup error:

```ts
try {
  await copySafeTree(source, workspacePath, fileSystem);
} catch (cause: unknown) {
  try {
    await fileSystem.rm(rootPath, { recursive: true, force: true });
  } catch (cleanupFailure: unknown) {
    throw new FileLifecycleError(
      cause instanceof FileLifecycleError ? cause.code : "UNSAFE_FILESYSTEM_INPUT",
      `workspace materialization failed: ${errorMessage(cause)}`,
      { cause, cleanupFailure },
    );
  }
  if (cause instanceof FileLifecycleError) throw cause;
  throw new FileLifecycleError(
    "UNSAFE_FILESYSTEM_INPUT",
    `workspace materialization failed: ${errorMessage(cause)}`,
    { cause },
  );
}
```

Keep `errorMessage()` private and deterministic: return `error.message` for `Error`, otherwise `String(error)`.

- [ ] **Step 6: Run focused and full checks**

Run:

```sh
node --import tsx --test tests/workspace/materialize-workspace.test.ts
npm run lint
npm run typecheck
```

Expected: all workspace tests PASS; lint and typecheck exit `0`.

- [ ] **Step 7: Commit the workspace lifecycle**

```sh
git add src/domain/file-lifecycle-error.ts src/filesystem/safe-tree.ts src/workspace/materialize-workspace.ts tests/workspace/materialize-workspace.test.ts
git commit -m "feat: materialize isolated fixture workspaces"
```

---

### Task 2: Data-Driven Variant Installation

**Files:**
- Create: `src/variants/install-variant.ts`
- Create: `tests/variants/install-variant.test.ts`
- Modify: `src/filesystem/safe-tree.ts`

**Interfaces:**
- Consumes: `CatalogVariant`, `ContentHash`, `hashTree()`, `hashValue()`, `ProjectPaths`, `copySafeTree()`, `rollbackCreatedPaths()`, and `FileLifecycleError`.
- Produces: `installVariant(input: InstallVariantInput): Promise<VariantInstallation>`, `InstallVariantInput`, and `VariantInstallation`.

- [ ] **Step 1: Write failing control and mapped-install tests**

Create `tests/variants/install-variant.test.ts`:

```ts
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadCatalog } from "../../src/catalog/load-catalog.js";
import { FileLifecycleError } from "../../src/domain/file-lifecycle-error.js";
import { hashTree, hashValue } from "../../src/integrity/content-hash.js";
import { materializeWorkspace } from "../../src/workspace/materialize-workspace.js";
import { installVariant } from "../../src/variants/install-variant.js";
import { ProjectPaths } from "../../src/paths/project-paths.js";
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
```

- [ ] **Step 2: Add exact preflight safety and atomicity tests**

In the same test file add table-driven cases that rewrite `project.exampleManifestPath`, reload the catalog where possible, and call the installer for:

```ts
const conflicts = [
  ["same destination", [".codex/skills/shared", ".codex/skills/shared"]],
  ["ancestor overlap", [".codex/skills/shared", ".codex/skills/shared/nested"]],
  ["descendant overlap", [".codex/skills/shared/nested", ".codex/skills/shared"]],
] as const;
```

Create a second install source under `variants/example/other`, recompute the manifest hash with:

```ts
const contentHash = hashValue([
  { source: "variants/example/skill", contentHash: await hashTree(project.exampleInstallDirectory) },
  { source: "variants/example/other", contentHash: await hashTree(otherSource) },
]);
```

For each conflict assert `FileLifecycleError.code === "INSTALL_DESTINATION_CONFLICT"` and assert the workspace hash is unchanged. Add independent tests for:

- destination traversal `../outside`, expecting `UNSAFE_FILESYSTEM_INPUT`;
- a source changed after catalog loading, expecting `CONTENT_HASH_MISMATCH` after apply and absence of `.codex/skills/example` after rollback;
- an existing destination file or directory, expecting `INSTALL_DESTINATION_CONFLICT` with unchanged bytes;
- a destination ancestor symlink to an external directory, expecting `UNSAFE_FILESYSTEM_INPUT` and no external write;
- a manifest source outside `dirname(variant.source)`, expecting `UNSAFE_FILESYSTEM_INPUT`;
- a missing runtime destination, expecting `INSTALL_SOURCE_MISSING` with a message naming the runtime.

Use the existing platform symlink guard from `tests/paths/project-paths.test.ts` for the symlink case.

- [ ] **Step 3: Run the variant test and verify RED**

Run:

```sh
node --import tsx --test tests/variants/install-variant.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/variants/install-variant.ts`.

- [ ] **Step 4: Implement two-phase preflight and apply**

Create `src/variants/install-variant.ts` with these exact public interfaces:

```ts
import type { CatalogVariant } from "../catalog/load-catalog.js";
import type { ContentHash } from "../domain/model.js";

export interface InstallVariantInput {
  readonly variant: CatalogVariant;
  readonly runtime: string;
  readonly workspacePath: string;
}

export interface VariantInstallation {
  readonly destinations: readonly string[];
  readonly contentHash: ContentHash;
}

export async function installVariant(input: InstallVariantInput): Promise<VariantInstallation>;
```

Implementation rules, in order:

1. Derive the allowed source root with `dirname(input.variant.source)`. Every manifest `install.source` must equal that root's descendant according to normalized POSIX segments.
2. Require `installSourcePaths[index]` and `install.destinations[input.runtime]` for every mapping. A missing validated source or runtime destination throws `INSTALL_SOURCE_MISSING` before writes.
3. Create `ProjectPaths` for `workspacePath` and resolve every destination with `resolveOutput()` before writes. Convert its `ValidationError` to `UNSAFE_FILESYSTEM_INPUT`.
4. Sort destination strings bytewise for deterministic checks. Reject equality and either-direction `isSameOrInside()` overlap. Reject any destination that already exists; only `ENOENT` means available.
5. Apply mappings in manifest order. Before each `copySafeTree()`, create absent parents one segment at a time and record only directories this installer created.
6. Hash every installed destination and build records as `{ source: install.source, contentHash: await hashTree(destination) }`. Compare `hashValue(records)` with `variant.manifest.contentHash`.
7. On any apply or hash error, remove copied destination roots and installer-created empty parents deepest-first. Never remove a pre-existing path. Attach rollback failure as `cleanupFailure` while retaining the primary failure.
8. Freeze the returned destination array and record with `Object.freeze()`.

Use this hash block without substituting destination labels:

```ts
const material = [];
for (const mapping of mappings) {
  material.push({
    source: mapping.install.source,
    contentHash: await hashTree(mapping.destination),
  });
}
const contentHash = hashValue(material);
if (contentHash !== input.variant.manifest.contentHash) {
  throw new FileLifecycleError(
    "CONTENT_HASH_MISMATCH",
    `installed variant material has hash ${contentHash}; expected ${input.variant.manifest.contentHash}`,
  );
}
```

Add this exact helper to `safe-tree.ts`; it creates parents one segment at a
time and returns only paths that were absent and created by this call:

```ts
export async function createAbsentParents(
  root: string,
  destination: string,
  fileSystem: SafeTreeFileSystem = safeTreeFileSystem,
): Promise<readonly string[]>;
```

The implementation walks from `root` through `dirname(relative(root,
destination))`, calls `lstat()` on each candidate, rejects symbolic links and
non-directories, treats only `ENOENT` as absent, calls `mkdir(candidate)` without
`recursive`, and appends that candidate after successful creation. The
installer appends these returned paths to its private rollback list. No public
function accepts caller-provided rollback targets.

- [ ] **Step 5: Run focused and full checks**

Run:

```sh
node --import tsx --test tests/variants/install-variant.test.ts
node --import tsx --test tests/catalog/load-catalog.test.ts tests/paths/project-paths.test.ts tests/integrity/content-hash.test.ts
npm run lint
npm run typecheck
```

Expected: all tests PASS; lint and typecheck exit `0`.

- [ ] **Step 6: Commit variant installation**

```sh
git add src/filesystem/safe-tree.ts src/variants/install-variant.ts tests/variants/install-variant.test.ts
git commit -m "feat: install variants from validated manifests"
```

---

### Task 3: Private Oracle Lifecycle

**Files:**
- Create: `src/oracles/oracle-lifecycle.ts`
- Create: `tests/oracles/oracle-lifecycle.test.ts`

**Interfaces:**
- Consumes: `ProjectPaths`, `copySafeTree()`, `isSameOrInside()`, `FileLifecycleError`, and Node temporary-directory operations.
- Produces: `OracleLifecycle.create()`, `OracleLifecycle.state`, `markAgentClosed()`, `mountOracle()`, `cleanup()`, `OracleLifecycleState`, `MountedOracle`, and `OracleFileSystem`.

- [ ] **Step 1: Write failing state and isolation tests**

Create `tests/oracles/oracle-lifecycle.test.ts`:

```ts
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { FileLifecycleError } from "../../src/domain/file-lifecycle-error.js";
import { OracleLifecycle } from "../../src/oracles/oracle-lifecycle.js";
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
  } finally {
    await oracle.cleanup();
    await workspace.cleanup();
  }
});

test("cleanup is idempotent from every state and prevents later transitions", async () => {
  for (const closeFirst of [false, true]) {
    const project = await createTempProject();
    const paths = await ProjectPaths.create(project.root);
    const workspace = await materializeWorkspace({ paths, fixture: "fixtures/queuedesk" });
    const oracle = await OracleLifecycle.create({ paths, caseId: "F01", workspacePath: workspace.workspacePath });
    if (closeFirst) oracle.markAgentClosed();
    await oracle.cleanup();
    await oracle.cleanup();
    assert.equal(oracle.state, "cleaned");
    assert.throws(() => oracle.markAgentClosed(), (error: unknown) =>
      error instanceof FileLifecycleError && error.code === "INVALID_LIFECYCLE_TRANSITION");
    await assert.rejects(oracle.mountOracle(), (error: unknown) =>
      error instanceof FileLifecycleError && error.code === "INVALID_LIFECYCLE_TRANSITION");
    await workspace.cleanup();
  }
});
```

Remove unused imports after completing the full test file so lint stays clean.

- [ ] **Step 2: Add mount failure, symlink, and cleanup failure tests**

Add exact cases asserting:

- missing `.private/oracles/<case-id>` leaves state `agent_closed` and reports `INSTALL_SOURCE_MISSING`;
- a symlink anywhere in the private oracle is rejected as `UNSAFE_FILESYSTEM_INPUT`, removes the partial grading root, and leaves state `agent_closed`;
- `tempParent` equal to or inside `workspacePath` is rejected as `UNSAFE_FILESYSTEM_INPUT` before `mkdtemp()`, while a shared ancestor such as `tmpdir()` is accepted;
- forced copy failure cleans the grading root and leaves state `agent_closed`;
- forced `rm()` failure produces `CLEANUP_FAILURE`, leaves the prior state intact, and succeeds on retry after the injected failure is disabled;
- after a successful mount and cleanup, `access(mounted.gradingPath)` rejects with `ENOENT`.

Use an exported `oracleFileSystem` spread into the injected test doubles, following the workspace test pattern.

- [ ] **Step 3: Run the oracle test and verify RED**

Run:

```sh
node --import tsx --test tests/oracles/oracle-lifecycle.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/oracles/oracle-lifecycle.ts`.

- [ ] **Step 4: Implement the oracle state machine**

Create `src/oracles/oracle-lifecycle.ts` with these exact public interfaces:

```ts
export type OracleLifecycleState =
  | "agent_active"
  | "agent_closed"
  | "oracle_mounted"
  | "cleaned";

export interface MountedOracle {
  readonly gradingPath: string;
}

export interface CreateOracleLifecycleInput {
  readonly paths: ProjectPaths;
  readonly caseId: string;
  readonly workspacePath: string;
  readonly tempParent?: string;
  readonly fileSystem?: OracleFileSystem;
}

export class OracleLifecycle {
  public static async create(input: CreateOracleLifecycleInput): Promise<OracleLifecycle>;
  public get state(): OracleLifecycleState;
  public markAgentClosed(): void;
  public async mountOracle(): Promise<MountedOracle>;
  public async cleanup(): Promise<void>;
}
```

`OracleFileSystem` extends `SafeTreeFileSystem` with `mkdtemp()` and `realpath()`.
`create()` resolves the workspace and chosen temporary parent. It rejects a
temporary parent equal to or inside the workspace, but permits an ancestor such
as the operating system's `/tmp` directory. It must not resolve or retain the
private oracle source yet.

`markAgentClosed()` accepts only `agent_active`. `mountOracle()` accepts only
`agent_closed`, then resolves `.private/oracles/${caseId}` through
`ProjectPaths.resolveExisting(..., "directory")`, allocates a unique
`skillbench-oracle-` root under the chosen parent, and verifies that the
resolved root is neither equal to, inside, nor an ancestor of the resolved
workspace. It creates a `grading` child, safe-copies the source, and switches
state only after copy completion. The returned object is frozen.

Use a single transition guard:

```ts
private requireState(operation: string, expected: OracleLifecycleState): void {
  if (this.currentState !== expected) {
    throw new FileLifecycleError(
      "INVALID_LIFECYCLE_TRANSITION",
      `${operation} requires ${expected}; current state is ${this.currentState}`,
    );
  }
}
```

On mount failure, remove the new grading root, retain `agent_closed`, and preserve primary-plus-cleanup evidence exactly as Task 1 does. `cleanup()` is a no-op in `cleaned`; otherwise it removes the grading root if allocated and changes state to `cleaned` only after successful removal.

- [ ] **Step 5: Run focused and full checks**

Run:

```sh
node --import tsx --test tests/oracles/oracle-lifecycle.test.ts
node --import tsx --test tests/workspace/materialize-workspace.test.ts tests/variants/install-variant.test.ts
npm run lint
npm run typecheck
```

Expected: all tests PASS; lint and typecheck exit `0`.

- [ ] **Step 6: Commit oracle lifecycle enforcement**

```sh
git add src/oracles/oracle-lifecycle.ts tests/oracles/oracle-lifecycle.test.ts
git commit -m "feat: isolate private oracle lifecycle"
```

---

### Task 4: Delivery Documentation and Regression Gate

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Verify: `tests/cli/help.test.ts`
- Verify: `tests/cli/bin.test.ts`
- Verify: all `tests/**/*.test.ts`

**Interfaces:**
- Consumes: completed Stage 2A modules and the existing CLI behavior.
- Produces: accurate bilingual user documentation and updated persistent project memory.

- [ ] **Step 1: Verify reserved CLI behavior before documentation changes**

Run:

```sh
node --import tsx --test tests/cli/help.test.ts
```

Expected: PASS, including exit code `2` and the existing unavailable-command messages for `list`, `dry-run`, `run`, `compare`, and `report`.

- [ ] **Step 2: Update the English README section**

Replace Stage 1-only claims with factual Stage 2A language. Add this paragraph after the opening purpose text:

```markdown
Stage 2A also provides internal file-lifecycle building blocks. Library callers can copy a fixture into an isolated temporary workspace, install a validated variant from its manifest, and copy a private oracle into a separate grading area only after marking the agent session closed. The command-line interface still validates catalogs only; it does not run agents or oracle checks yet.
```

Update `Generated artifacts` to state that Stage 2A tests create isolated workspace and grading directories only under the operating system temporary directory and clean them afterward. Update `Current limitations` so it says Stage 2A primitives are available internally, while orchestration, normalized results, and operational `dry-run` belong to Stage 2B.

- [ ] **Step 3: Mirror the README changes in Russian**

Add the complete corresponding paragraph after the Russian opening text:

```markdown
Этап 2A также добавляет внутренние средства для безопасной работы с файлами. Пользователь библиотеки может скопировать фикстуру в изолированный временный каталог, установить проверенный вариант по его манифесту и скопировать закрытый оракул в отдельный каталог проверки только после явного закрытия сессии агента. Командная строка пока только проверяет каталоги: она ещё не запускает агентов и проверки оракула.
```

Mirror every English delivery-state and limitation change in the Russian `Создаваемые файлы` and `Текущие ограничения` sections. Keep headings and section order unchanged.

- [ ] **Step 4: Update persistent project memory**

In `AGENTS.md`, replace the Stage 1-only `Current State` block with these facts:

```markdown
- Stage 1 and Stage 2A are complete.
- The repository validates benchmark catalogs and provides internal primitives for isolated fixture materialization, data-driven variant installation, and post-session private-oracle mounting.
- It does not run agents, execute oracle commands, freeze run manifests, normalize results, calculate metrics, compare variants, or generate reports.
- `validate` is implemented. `list`, `dry-run`, `run`, `compare`, and `report` are reserved commands and currently return exit code `2`.
- The next delivery stage is Stage 2B: run orchestration, frozen inputs, normalized results, and an operational `dry-run` command.
```

Add `src/filesystem/`, `src/workspace/`, `src/variants/`, and `src/oracles/` to the Architecture list with their actual responsibilities. Preserve all known limitations, especially TOCTOU and immutable-store concurrency.

- [ ] **Step 5: Run the complete verification gate**

Run:

```sh
npm run check
npm run build
node dist/src/cli.js validate --project . --public-only
node dist/src/cli.js dry-run
```

Expected:

- `npm run check`: lint, typecheck, and all tests PASS.
- `npm run build`: exits `0`.
- public validation: exits `0` and prints `Validated 0 cases and 0 variants.`.
- `dry-run`: exits `2` and reports `dry-run is not available in this build`.

- [ ] **Step 6: Inspect the final diff for scope and private/generated data**

Run:

```sh
git status --short
git diff --check
git diff --stat
git status --short --ignored
```

Expected: only the Stage 2A source, tests, `README.md`, and `AGENTS.md` are tracked changes. `dist/`, `.private/`, `runs/`, `.worktrees/`, and `.superpowers/` remain ignored and unstaged.

- [ ] **Step 7: Commit documentation and delivery state**

```sh
git add README.md AGENTS.md
git commit -m "docs: record stage 2a delivery"
```

- [ ] **Step 8: Record final evidence**

Run:

```sh
git status --short --branch
git log --oneline -5
```

Expected: clean working tree on the feature branch and four Stage 2A implementation commits after this plan commit.
