# SkillBench Stage 2B Run Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Stage 2A file-lifecycle primitives into a complete run pipeline with working `list`, `dry-run`, and `run` commands backed by the deterministic fake adapter.

**Architecture:** A linear pipeline of small, independently testable steps — freeze, materialize, install, snapshot, execute, diff, grade, persist — sequenced by a thin runner that owns rollback. `dry-run` reuses the freeze step, so the printed plan and the executed plan cannot drift. Results store raw assertion outcomes only; metric formulas belong to a later stage.

**Tech Stack:** Node.js 22+, TypeScript 5.9 native ESM, Commander 14, Ajv 8 (2020 dialect), Node `fs/promises` and `child_process`, Node test runner, npm.

**Spec:** `docs/superpowers/specs/2026-08-30-skillbench-stage-2b-run-orchestration-design.md`

## Global Constraints

- Runtime is Node.js 22 or newer and the package remains native ESM.
- Public messages, tests, fixtures, schemas, and documentation use concise international English; the README keeps English first and a complete Russian translation second.
- Core code must not branch on named skills; variants remain data. Runtime-specific behavior lives in adapters.
- Never place `.private/oracles/` content in an active agent workspace. Mount an oracle only after the agent session is marked closed, and remove it afterwards.
- Never execute arbitrary shell text. Oracle and verification commands use the `TypedCommand` executors `node`, `npm`, and `git` with explicit arguments.
- Reject path traversal and symbolic-link escapes in every new filesystem walk.
- Preserve raw and partial evidence when any pipeline step fails.
- `compare` and `report` remain reserved and return exit code `2`.
- Do not add public cases, fixtures, variants, or private oracle content to the repository. `runs/` and `.private/` stay ignored by Git.
- Existing exported signatures in `src/domain/`, `src/integrity/`, `src/paths/`, `src/storage/`, `src/filesystem/`, `src/workspace/`, `src/variants/`, and `src/oracles/oracle-lifecycle.ts` must keep working unchanged.
- After each task run `npm run check`; before the final commit of the stage also run `npm run build`.

## File Structure

**Created:**

- `src/runs/snapshot.ts` — workspace tree snapshots, change sets, allowed/forbidden path observations.
- `src/runs/freeze-inputs.ts` — run identifiers and the frozen run manifest.
- `src/runs/result.ts` — normalized result types and the evidence writer.
- `src/runs/execute-run.ts` — the pipeline runner.
- `src/oracles/oracle-manifest.ts` — oracle manifest types and loading.
- `src/oracles/run-oracle.ts` — typed-command oracle execution.
- `src/runtime/select-adapter.ts` — runtime identifier to adapter, including the case-derived fake script.
- `src/commands/list.ts`, `src/commands/dry-run.ts`, `src/commands/run.ts`.
- `schemas/oracle.schema.json` — published oracle manifest schema.
- `tests/runs/snapshot.test.ts`, `tests/runs/freeze-inputs.test.ts`, `tests/runs/execute-run.test.ts`.
- `tests/oracles/run-oracle.test.ts`.
- `tests/commands/list.test.ts`, `tests/commands/dry-run.test.ts`, `tests/commands/run.test.ts`.

**Modified:**

- `src/domain/model.ts` — add `FrozenRunManifest`, `OracleManifest`, `OracleCheck`.
- `src/schemas/validator.ts` — add `validateOracle`.
- `src/catalog/load-catalog.ts` — add oracle manifest and assertion-correspondence issues.
- `src/cli/create-program.ts` — register `list`, `dry-run`, `run`; keep `compare` and `report` reserved.
- `tests/helpers/temp-project.ts` — publish an oracle manifest in the temporary project.
- `AGENTS.md`, `README.md` — delivery state.

---

### Task 1: Workspace Snapshots and Change Sets

**Files:**
- Create: `src/runs/snapshot.ts`
- Test: `tests/runs/snapshot.test.ts`

**Interfaces:**
- Consumes: `hashFile` from `src/integrity/content-hash.js`, `ValidationError` from `src/domain/errors.js`, `ContentHash` from `src/domain/model.js`.
- Produces:
  - `interface SnapshotEntry { readonly path: string; readonly contentHash: ContentHash }`
  - `type TreeSnapshot = readonly SnapshotEntry[]`
  - `interface ChangeSet { readonly added: readonly string[]; readonly modified: readonly string[]; readonly removed: readonly string[] }`
  - `interface ChangePathObservations { readonly outsideAllowed: readonly string[]; readonly insideForbidden: readonly string[] }`
  - `async function snapshotTree(root: string): Promise<TreeSnapshot>`
  - `function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): ChangeSet`
  - `function observeChangePaths(changes: ChangeSet, allowedChangePaths: readonly string[], forbiddenChangePaths: readonly string[]): ChangePathObservations`

- [ ] **Step 1: Write the failing snapshot and diff tests**

Create `tests/runs/snapshot.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the snapshot test and verify RED**

Run: `npx tsx --test tests/runs/snapshot.test.ts`
Expected: FAIL — `Cannot find module '../../src/runs/snapshot.js'`.

- [ ] **Step 3: Implement the snapshot module**

Create `src/runs/snapshot.ts`:

```ts
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../domain/errors.js";
import type { ContentHash } from "../domain/model.js";
import { hashFile } from "../integrity/content-hash.js";

export interface SnapshotEntry {
  readonly path: string;
  readonly contentHash: ContentHash;
}

export type TreeSnapshot = readonly SnapshotEntry[];

export interface ChangeSet {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly removed: readonly string[];
}

export interface ChangePathObservations {
  readonly outsideAllowed: readonly string[];
  readonly insideForbidden: readonly string[];
}

export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const entries: SnapshotEntry[] = [];
  await collect(root, "", entries);
  entries.sort((left, right) => comparePaths(left.path, right.path));
  return Object.freeze(entries);
}

export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): ChangeSet {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry.contentHash]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry.contentHash]));

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, contentHash] of afterByPath) {
    const previous = beforeByPath.get(path);
    if (previous === undefined) {
      added.push(path);
    } else if (previous !== contentHash) {
      modified.push(path);
    }
  }
  for (const path of beforeByPath.keys()) {
    if (!afterByPath.has(path)) {
      removed.push(path);
    }
  }

  added.sort(comparePaths);
  modified.sort(comparePaths);
  removed.sort(comparePaths);
  return Object.freeze({
    added: Object.freeze(added),
    modified: Object.freeze(modified),
    removed: Object.freeze(removed),
  });
}

export function observeChangePaths(
  changes: ChangeSet,
  allowedChangePaths: readonly string[],
  forbiddenChangePaths: readonly string[],
): ChangePathObservations {
  const allowed = allowedChangePaths.map(normalize);
  const forbidden = forbiddenChangePaths.map(normalize);
  const changed = [...changes.added, ...changes.modified, ...changes.removed].sort(comparePaths);

  const outsideAllowed: string[] = [];
  const insideForbidden: string[] = [];
  for (const path of changed) {
    if (!allowed.some((prefix) => isInside(prefix, path))) {
      outsideAllowed.push(path);
    }
    if (forbidden.some((prefix) => isInside(prefix, path))) {
      insideForbidden.push(path);
    }
  }

  return Object.freeze({
    outsideAllowed: Object.freeze(outsideAllowed),
    insideForbidden: Object.freeze(insideForbidden),
  });
}

async function collect(absolutePath: string, relativePath: string, entries: SnapshotEntry[]): Promise<void> {
  const status = await lstat(absolutePath);
  if (status.isSymbolicLink()) {
    throw new ValidationError(`symbolic links are not supported in workspace snapshots: ${relativePath || absolutePath}`);
  }
  if (status.isFile()) {
    entries.push({ path: relativePath, contentHash: await hashFile(absolutePath) });
    return;
  }
  if (!status.isDirectory()) {
    throw new ValidationError(`unsupported entry in workspace snapshot: ${relativePath || absolutePath}`);
  }

  for (const child of await readdir(absolutePath)) {
    const childRelativePath = relativePath === "" ? child : `${relativePath}/${child}`;
    await collect(join(absolutePath, child), childRelativePath, entries);
  }
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

function isInside(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
```

- [ ] **Step 4: Run the snapshot test and verify GREEN**

Run: `npx tsx --test tests/runs/snapshot.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full checks**

Run: `npm run check`
Expected: lint, typecheck, and the whole suite pass.

- [ ] **Step 6: Commit**

```bash
git add src/runs/snapshot.ts tests/runs/snapshot.test.ts
git commit -m "feat: snapshot workspace trees and derive change sets"
```

---

### Task 2: Frozen Run Inputs and Run Identity

**Files:**
- Create: `src/runs/freeze-inputs.ts`
- Modify: `src/domain/model.ts`
- Test: `tests/runs/freeze-inputs.test.ts`

**Interfaces:**
- Consumes: `CatalogCase` and `CatalogVariant` from `src/catalog/load-catalog.js`, `hashValue` from `src/integrity/content-hash.js`, `DependencyError` from `src/domain/errors.js`.
- Produces:
  - In `src/domain/model.ts`: `interface FrozenRunManifest extends RunManifest { readonly schemaVersion: 1; readonly runId: string; readonly caseId: string; readonly variantId: string; readonly runtime: string }`
  - `interface RunConfiguration { readonly runtime: string; readonly model: string; readonly reasoningEffort: string; readonly sandbox: string; readonly runtimeVersion: string; readonly adapterVersion: string }`
  - `interface FreezeRunInputsInput { readonly catalogCase: CatalogCase; readonly variant: CatalogVariant; readonly configuration: RunConfiguration; readonly repetitionIndex: number; readonly runId: string }`
  - `function freezeRunInputs(input: FreezeRunInputsInput): FrozenRunManifest`
  - `function createRunId(now: Date, suffix: string): string`
  - `function defaultRunIdSuffix(): string`
  - `function runDirectory(manifest: FrozenRunManifest): string`

- [ ] **Step 1: Write the failing freeze tests**

Create `tests/runs/freeze-inputs.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { loadCatalog } from "../../src/catalog/load-catalog.js";
import { DependencyError } from "../../src/domain/errors.js";
import {
  createRunId,
  freezeRunInputs,
  runDirectory,
  type RunConfiguration,
} from "../../src/runs/freeze-inputs.js";
import { createTempProject } from "../helpers/temp-project.js";

const configuration: RunConfiguration = {
  runtime: "fake",
  model: "fake-model",
  reasoningEffort: "medium",
  sandbox: "workspace-write",
  runtimeVersion: "1.0.0",
  adapterVersion: "1.0.0",
};

test("builds a run identifier from a UTC instant and a suffix", () => {
  assert.equal(createRunId(new Date("2026-08-30T17:53:02.000Z"), "a1b2c3"), "20260830T175302Z-a1b2c3");
});

test("rejects a suffix that is not six lowercase alphanumerics", () => {
  assert.throws(() => createRunId(new Date("2026-08-30T17:53:02.000Z"), "AB!"), DependencyError);
});

test("freezes every input and stays stable across repeated freezes", async () => {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root);
  const catalogCase = catalog.cases[0];
  const variant = catalog.variants.find((candidate) => candidate.manifest.id === "example");
  assert.ok(catalogCase !== undefined && variant !== undefined);

  const first = freezeRunInputs({
    catalogCase,
    variant,
    configuration,
    repetitionIndex: 0,
    runId: "20260830T175302Z-a1b2c3",
  });
  const second = freezeRunInputs({
    catalogCase,
    variant,
    configuration,
    repetitionIndex: 0,
    runId: "20260830T175302Z-a1b2c3",
  });

  assert.deepEqual(first, second);
  assert.equal(first.caseId, "F01");
  assert.equal(first.variantId, "example");
  assert.equal(first.runtime, "fake");
  assert.equal(first.repetitionIndex, 0);
  assert.equal(first.fixtureHash, catalogCase.fixtureHash);
  assert.equal(first.oracleHash, catalogCase.oracleHash);
  assert.equal(first.variantHash, variant.manifest.contentHash);
  assert.deepEqual(first.limits, catalogCase.manifest.limits);
  assert.equal(runDirectory(first), "runs/F01/example/20260830T175302Z-a1b2c3");
});

test("refuses to freeze when the private oracle hash is unavailable", async () => {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root, { requirePrivateOracles: false });
  const catalogCase = catalog.cases[0];
  const variant = catalog.variants.find((candidate) => candidate.manifest.id === "example");
  assert.ok(catalogCase !== undefined && variant !== undefined);

  assert.throws(
    () => freezeRunInputs({
      catalogCase,
      variant,
      configuration,
      repetitionIndex: 0,
      runId: "20260830T175302Z-a1b2c3",
    }),
    (error: unknown) => error instanceof DependencyError && /oracle/u.test(error.message),
  );
});

test("refuses a variant that is incompatible with the selected runtime", async () => {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root);
  const catalogCase = catalog.cases[0];
  const variant = catalog.variants.find((candidate) => candidate.manifest.id === "example");
  assert.ok(catalogCase !== undefined && variant !== undefined);

  assert.throws(
    () => freezeRunInputs({
      catalogCase,
      variant,
      configuration: { ...configuration, runtime: "codex" },
      repetitionIndex: 0,
      runId: "20260830T175302Z-a1b2c3",
    }),
    (error: unknown) => error instanceof DependencyError && /runtime/u.test(error.message),
  );
});
```

- [ ] **Step 2: Run the freeze test and verify RED**

Run: `npx tsx --test tests/runs/freeze-inputs.test.ts`
Expected: FAIL — `Cannot find module '../../src/runs/freeze-inputs.js'`.

- [ ] **Step 3: Teach the temporary test project about the `fake` runtime**

The shared helper currently declares only the `codex` runtime, so no test variant is compatible with the runtime this stage executes. In `tests/helpers/temp-project.ts`:

- change `controlManifest.compatibleRuntimes` to `["codex", "fake"]`;
- change `exampleManifest.compatibleRuntimes` to `["codex", "fake"]`;
- change the example install destinations to `{ codex: ".codex/skills/example", fake: ".agent/skills/example" }`.

Every compatible runtime needs a destination, otherwise the catalog reports `MISSING_RUNTIME_DESTINATION`. Existing tests that pass `runtime: "codex"` keep working unchanged.

Run `npx tsx --test tests/catalog/load-catalog.test.ts tests/variants/install-variant.test.ts` and expect PASS before continuing.

- [ ] **Step 4: Extend the domain model**

Append to `src/domain/model.ts`:

```ts
export interface FrozenRunManifest extends RunManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly caseId: string;
  readonly variantId: string;
  readonly runtime: string;
}
```

- [ ] **Step 5: Implement freezing and run identity**

Create `src/runs/freeze-inputs.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { CatalogCase, CatalogVariant } from "../catalog/load-catalog.js";
import { DependencyError } from "../domain/errors.js";
import type { FrozenRunManifest } from "../domain/model.js";
import { hashValue } from "../integrity/content-hash.js";

export interface RunConfiguration {
  readonly runtime: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sandbox: string;
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
}

export interface FreezeRunInputsInput {
  readonly catalogCase: CatalogCase;
  readonly variant: CatalogVariant;
  readonly configuration: RunConfiguration;
  readonly repetitionIndex: number;
  readonly runId: string;
}

const runIdPattern = /^\d{8}T\d{6}Z-[0-9a-z]{6}$/u;

export function createRunId(now: Date, suffix: string): string {
  if (!/^[0-9a-z]{6}$/u.test(suffix)) {
    throw new DependencyError(`run identifier suffix must be six lowercase alphanumerics: ${suffix}`);
  }
  const instant = now.toISOString();
  const compact = `${instant.slice(0, 4)}${instant.slice(5, 7)}${instant.slice(8, 10)}T${instant.slice(11, 13)}${instant.slice(14, 16)}${instant.slice(17, 19)}Z`;
  return `${compact}-${suffix}`;
}

export function defaultRunIdSuffix(): string {
  return randomBytes(4).toString("hex").slice(0, 6);
}

export function freezeRunInputs(input: FreezeRunInputsInput): FrozenRunManifest {
  const { catalogCase, variant, configuration } = input;

  if (!runIdPattern.test(input.runId)) {
    throw new DependencyError(`run identifier is malformed: ${input.runId}`);
  }
  if (!Number.isSafeInteger(input.repetitionIndex) || input.repetitionIndex < 0) {
    throw new DependencyError("repetition index must be a non-negative safe integer");
  }
  if (!variant.manifest.compatibleRuntimes.includes(configuration.runtime)) {
    throw new DependencyError(
      `variant ${variant.manifest.id} is not compatible with runtime ${configuration.runtime}`,
    );
  }
  if (catalogCase.fixtureHash === undefined) {
    throw new DependencyError(`fixture hash is unavailable for case ${catalogCase.manifest.id}`);
  }
  if (catalogCase.oracleHash === undefined) {
    throw new DependencyError(`private oracle hash is unavailable for case ${catalogCase.manifest.id}`);
  }
  if (variant.materialHash === undefined) {
    throw new DependencyError(`variant material hash is unavailable for variant ${variant.manifest.id}`);
  }

  return Object.freeze({
    schemaVersion: 1,
    runId: input.runId,
    caseId: catalogCase.manifest.id,
    variantId: variant.manifest.id,
    runtime: configuration.runtime,
    caseHash: hashValue(catalogCase.manifest),
    variantHash: variant.manifest.contentHash,
    fixtureHash: catalogCase.fixtureHash,
    oracleHash: catalogCase.oracleHash,
    model: configuration.model,
    reasoningEffort: configuration.reasoningEffort,
    sandbox: configuration.sandbox,
    runtimeVersion: configuration.runtimeVersion,
    adapterVersion: configuration.adapterVersion,
    limits: Object.freeze({ ...catalogCase.manifest.limits }),
    repetitionIndex: input.repetitionIndex,
  });
}

export function runDirectory(manifest: FrozenRunManifest): string {
  return `runs/${manifest.caseId}/${manifest.variantId}/${manifest.runId}`;
}
```

- [ ] **Step 6: Run the freeze test and verify GREEN**

Run: `npx tsx --test tests/runs/freeze-inputs.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Run the full checks**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/domain/model.ts src/runs/freeze-inputs.ts tests/runs/freeze-inputs.test.ts tests/helpers/temp-project.ts
git commit -m "feat: freeze run inputs into an immutable manifest"
```

---

### Task 3: Oracle Manifest Schema and Loading

**Files:**
- Create: `schemas/oracle.schema.json`, `src/oracles/oracle-manifest.ts`
- Modify: `src/domain/model.ts`, `src/schemas/validator.ts`, `tests/helpers/temp-project.ts`
- Test: `tests/schemas/oracle-schema.test.ts`

**Interfaces:**
- Consumes: `ManifestValidator` from `src/schemas/validator.js`, `TypedCommand` and `AssertionDeclaration` from `src/domain/model.js`, `ValidationError` from `src/domain/errors.js`.
- Produces:
  - In `src/domain/model.ts`: `interface OracleCheck { readonly assertionId: string; readonly command: TypedCommand; readonly workingDirectory: string; readonly timeoutMs: number }` and `interface OracleManifest { readonly schemaVersion: 1; readonly caseId: string; readonly checks: readonly OracleCheck[] }`
  - In `src/schemas/validator.ts`: `public validateOracle(value: unknown): OracleManifest`
  - In `src/oracles/oracle-manifest.ts`: `async function loadOracleManifest(gradingPath: string, validator: ManifestValidator): Promise<OracleManifest>` and `function assertOracleCoversAssertions(manifest: OracleManifest, assertions: readonly AssertionDeclaration[]): void`
  - In `tests/helpers/temp-project.ts`: the returned `TempProject` gains `readonly oracleManifestPath: string` and the oracle directory contains a valid `oracle.json` covering `assert-1`.

- [ ] **Step 1: Write the failing oracle schema tests**

Create `tests/schemas/oracle-schema.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ValidationError } from "../../src/domain/errors.js";
import { assertOracleCoversAssertions, loadOracleManifest } from "../../src/oracles/oracle-manifest.js";
import { ManifestValidator } from "../../src/schemas/validator.js";

const publishedSchemas = join(import.meta.dirname, "../../schemas");

const validManifest = {
  schemaVersion: 1,
  caseId: "F01",
  checks: [
    {
      assertionId: "assert-1",
      command: { executor: "node", args: ["checks/functional.js"] },
      workingDirectory: "checks",
      timeoutMs: 5_000,
    },
  ],
};

async function writeOracle(value: unknown): Promise<string> {
  const gradingPath = await mkdtemp(join(tmpdir(), "skillbench-oracle-manifest-"));
  await writeFile(join(gradingPath, "oracle.json"), `${JSON.stringify(value)}\n`);
  return gradingPath;
}

test("loads a valid oracle manifest", async () => {
  const validator = await ManifestValidator.create(publishedSchemas);
  const gradingPath = await writeOracle(validManifest);

  const manifest = await loadOracleManifest(gradingPath, validator);

  assert.equal(manifest.caseId, "F01");
  assert.equal(manifest.checks[0]?.command.executor, "node");
});

test("rejects a shell executor, an absolute working directory, and a non-positive timeout", async () => {
  const validator = await ManifestValidator.create(publishedSchemas);

  for (const invalid of [
    { ...validManifest, checks: [{ ...validManifest.checks[0], command: { executor: "bash", args: ["-c", "ls"] } }] },
    { ...validManifest, checks: [{ ...validManifest.checks[0], workingDirectory: "/etc" }] },
    { ...validManifest, checks: [{ ...validManifest.checks[0], workingDirectory: "../escape" }] },
    { ...validManifest, checks: [{ ...validManifest.checks[0], timeoutMs: 0 }] },
    { ...validManifest, checks: [] },
  ]) {
    const gradingPath = await writeOracle(invalid);
    await assert.rejects(
      loadOracleManifest(gradingPath, validator),
      (error: unknown) => error instanceof ValidationError,
    );
  }
});

test("rejects a missing oracle manifest with a ValidationError", async () => {
  const validator = await ManifestValidator.create(publishedSchemas);
  const gradingPath = await mkdtemp(join(tmpdir(), "skillbench-oracle-manifest-"));

  await assert.rejects(
    loadOracleManifest(gradingPath, validator),
    (error: unknown) => error instanceof ValidationError && /oracle\.json/u.test(error.message),
  );
});

test("requires a one-to-one correspondence between case assertions and oracle checks", () => {
  const manifest = {
    schemaVersion: 1 as const,
    caseId: "F01",
    checks: [
      { assertionId: "assert-1", command: { executor: "node" as const, args: ["a.js"] }, workingDirectory: "checks", timeoutMs: 1_000 },
    ],
  };

  assert.doesNotThrow(() => assertOracleCoversAssertions(manifest, [
    { id: "assert-1", dimension: "functional", critical: true },
  ]));

  assert.throws(
    () => assertOracleCoversAssertions(manifest, [
      { id: "assert-1", dimension: "functional", critical: true },
      { id: "assert-2", dimension: "regression", critical: false },
    ]),
    (error: unknown) => error instanceof ValidationError && /assert-2/u.test(error.message),
  );

  assert.throws(
    () => assertOracleCoversAssertions(manifest, [
      { id: "assert-9", dimension: "functional", critical: true },
    ]),
    (error: unknown) => error instanceof ValidationError && /assert-1/u.test(error.message),
  );
});

test("rejects a duplicated assertion identifier in the oracle", () => {
  const manifest = {
    schemaVersion: 1 as const,
    caseId: "F01",
    checks: [
      { assertionId: "assert-1", command: { executor: "node" as const, args: ["a.js"] }, workingDirectory: "checks", timeoutMs: 1_000 },
      { assertionId: "assert-1", command: { executor: "node" as const, args: ["b.js"] }, workingDirectory: "checks", timeoutMs: 1_000 },
    ],
  };

  assert.throws(
    () => assertOracleCoversAssertions(manifest, [{ id: "assert-1", dimension: "functional", critical: true }]),
    (error: unknown) => error instanceof ValidationError && /duplicated/u.test(error.message),
  );
});
```

- [ ] **Step 2: Run the oracle schema test and verify RED**

Run: `npx tsx --test tests/schemas/oracle-schema.test.ts`
Expected: FAIL — `Cannot find module '../../src/oracles/oracle-manifest.js'`.

- [ ] **Step 3: Publish the oracle schema**

Create `schemas/oracle.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://skillbench.dev/schemas/oracle.schema.json",
  "title": "SkillBench oracle manifest",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "caseId", "checks"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "caseId": { "$ref": "#/$defs/id" },
    "checks": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": { "$ref": "#/$defs/check" }
    }
  },
  "$defs": {
    "id": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{1,63}$" },
    "relativePath": {"type": "string", "pattern": "^(?![A-Za-z]:)(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\0]+$"},
    "typedCommand": {
      "type": "object",
      "additionalProperties": false,
      "required": ["executor", "args"],
      "properties": {
        "executor": { "enum": ["node", "npm", "git"] },
        "args": { "type": "array", "items": { "type": "string" } }
      }
    },
    "check": {
      "type": "object",
      "additionalProperties": false,
      "required": ["assertionId", "command", "workingDirectory", "timeoutMs"],
      "properties": {
        "assertionId": { "$ref": "#/$defs/id" },
        "command": { "$ref": "#/$defs/typedCommand" },
        "workingDirectory": { "$ref": "#/$defs/relativePath" },
        "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 3600000 }
      }
    }
  }
}
```

The `relativePath` definition above is copied verbatim from `schemas/case.schema.json` so all three schemas share one path rule. Confirm it still matches before writing the file.

- [ ] **Step 4: Extend the domain model and validator**

Append to `src/domain/model.ts`:

```ts
export interface OracleCheck {
  readonly assertionId: string;
  readonly command: TypedCommand;
  readonly workingDirectory: string;
  readonly timeoutMs: number;
}

export interface OracleManifest {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly checks: readonly OracleCheck[];
}
```

In `src/schemas/validator.ts`, extend `ManifestKind` to `"case" | "variant" | "oracle"`, read `oracle.schema.json` alongside the other two in `create`, hold the compiled `oracleSchema`, and add:

```ts
  public validateOracle(value: unknown): OracleManifest {
    return this.validate("oracle", this.oracleSchema, value);
  }
```

Add a matching overload signature for `validate` returning `OracleManifest`, and widen the final assertion to `CaseManifest | VariantManifest | OracleManifest`.

- [ ] **Step 5: Implement oracle manifest loading**

Create `src/oracles/oracle-manifest.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../domain/errors.js";
import type { AssertionDeclaration, OracleManifest } from "../domain/model.js";
import type { ManifestValidator } from "../schemas/validator.js";

export const oracleManifestFilename = "oracle.json";

export async function loadOracleManifest(
  gradingPath: string,
  validator: ManifestValidator,
): Promise<OracleManifest> {
  let text: string;
  try {
    text = await readFile(join(gradingPath, oracleManifestFilename), "utf8");
  } catch (cause: unknown) {
    throw new ValidationError(`could not read ${oracleManifestFilename}: ${errorMessage(cause)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause: unknown) {
    throw new ValidationError(`invalid JSON in ${oracleManifestFilename}: ${errorMessage(cause)}`);
  }

  return validator.validateOracle(value);
}

export function assertOracleCoversAssertions(
  manifest: OracleManifest,
  assertions: readonly AssertionDeclaration[],
): void {
  const checkIds = new Set<string>();
  for (const check of manifest.checks) {
    if (checkIds.has(check.assertionId)) {
      throw new ValidationError(`oracle assertion ID ${JSON.stringify(check.assertionId)} is duplicated`);
    }
    checkIds.add(check.assertionId);
  }

  const declaredIds = new Set(assertions.map(({ id }) => id));
  const missing = [...declaredIds].filter((id) => !checkIds.has(id)).sort();
  const extra = [...checkIds].filter((id) => !declaredIds.has(id)).sort();

  if (missing.length > 0) {
    throw new ValidationError(`oracle has no check for declared assertion(s): ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    throw new ValidationError(`oracle declares check(s) for undeclared assertion(s): ${extra.join(", ")}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 6: Publish an oracle manifest in the test project**

In `tests/helpers/temp-project.ts`:

- copy `oracle.schema.json` into the temporary `schemas/` directory alongside the other two;
- add `const oracleManifestPath = join(oracleDirectory, "oracle.json");` and write this content before the manifests are written:

```ts
  await mkdir(join(oracleDirectory, "checks"), { recursive: true });
  await writeFile(
    join(oracleDirectory, "checks/assert-1.js"),
    "process.exit(0);\n",
  );
  await writeFile(
    oracleManifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      caseId: "F01",
      checks: [
        {
          assertionId: "assert-1",
          command: { executor: "node", args: ["assert-1.js"] },
          workingDirectory: "checks",
          timeoutMs: 10_000,
        },
      ],
    }, null, 2)}\n`,
  );
```

- add `oracleManifestPath` to the `TempProject` interface and to the returned object.

Because the oracle directory contents change, the fixture hash is unaffected but the case manifest is not: no case field references oracle contents, so no other helper change is needed.

- [ ] **Step 7: Run the oracle schema test and verify GREEN**

Run: `npx tsx --test tests/schemas/oracle-schema.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Run the full checks**

Run: `npm run check`
Expected: all pass, including the existing catalog and validate tests that use `createTempProject`.

- [ ] **Step 9: Commit**

```bash
git add schemas/oracle.schema.json src/domain/model.ts src/schemas/validator.ts src/oracles/oracle-manifest.ts tests/schemas/oracle-schema.test.ts tests/helpers/temp-project.ts
git commit -m "feat: publish and validate the oracle manifest schema"
```

---

### Task 4: Typed-Command Oracle Execution

**Files:**
- Create: `src/oracles/run-oracle.ts`
- Test: `tests/oracles/run-oracle.test.ts`

**Interfaces:**
- Consumes: `OracleManifest`, `OracleCheck`, `AssertionDeclaration` from `src/domain/model.js`; `assertOracleCoversAssertions` from `src/oracles/oracle-manifest.js`.
- Produces:
  - `type AssertionOutcome = "passed" | "failed" | "error"`
  - `interface AssertionResult { readonly assertionId: string; readonly dimension: AssertionDeclaration["dimension"]; readonly critical: boolean; readonly outcome: AssertionOutcome; readonly exitCode: number | null; readonly durationMs: number; readonly detail: string }`
  - `interface OracleSpawnRequest { readonly executor: "node" | "npm" | "git"; readonly args: readonly string[]; readonly cwd: string; readonly timeoutMs: number; readonly env: Readonly<Record<string, string>> }`
  - `interface OracleSpawnResult { readonly exitCode: number | null; readonly timedOut: boolean; readonly detail: string }`
  - `type OracleSpawn = (request: OracleSpawnRequest) => Promise<OracleSpawnResult>`
  - `const defaultOracleSpawn: OracleSpawn`
  - `interface RunOracleInput { readonly manifest: OracleManifest; readonly assertions: readonly AssertionDeclaration[]; readonly gradingPath: string; readonly workspacePath: string; readonly spawn?: OracleSpawn; readonly nowMs?: () => number }`
  - `async function runOracle(input: RunOracleInput): Promise<readonly AssertionResult[]>`

- [ ] **Step 1: Write the failing oracle execution tests**

Create `tests/oracles/run-oracle.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ValidationError } from "../../src/domain/errors.js";
import type { AssertionDeclaration, OracleManifest } from "../../src/domain/model.js";
import { runOracle } from "../../src/oracles/run-oracle.js";

const assertions: readonly AssertionDeclaration[] = [
  { id: "pass-check", dimension: "functional", critical: true },
  { id: "fail-check", dimension: "regression", critical: false },
];

function check(assertionId: string, script: string) {
  return {
    assertionId,
    command: { executor: "node" as const, args: [script] },
    workingDirectory: "checks",
    timeoutMs: 10_000,
  };
}

async function createGradingArea(): Promise<{ gradingPath: string; workspacePath: string }> {
  const gradingPath = await mkdtemp(join(tmpdir(), "skillbench-grading-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "skillbench-graded-workspace-"));
  await mkdir(join(gradingPath, "checks"), { recursive: true });
  await writeFile(join(workspacePath, "marker.txt"), "present\n");
  await writeFile(
    join(gradingPath, "checks/pass.js"),
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "const workspace = process.env.SKILLBENCH_WORKSPACE ?? '';\n" +
      "process.exit(readFileSync(join(workspace, 'marker.txt'), 'utf8') === 'present\\n' ? 0 : 3);\n",
  );
  await writeFile(join(gradingPath, "checks/fail.js"), "process.exit(4);\n");
  await writeFile(join(gradingPath, "checks/hang.js"), "setTimeout(() => {}, 60_000);\n");
  await writeFile(join(gradingPath, "package.json"), '{ "type": "module" }\n');
  return { gradingPath, workspacePath };
}

test("maps exit codes to passed and failed and reads the workspace through the environment", async () => {
  const { gradingPath, workspacePath } = await createGradingArea();
  const manifest: OracleManifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [check("pass-check", "pass.js"), check("fail-check", "fail.js")],
  };

  const results = await runOracle({ manifest, assertions, gradingPath, workspacePath });

  assert.deepEqual(results.map((result) => [result.assertionId, result.outcome, result.exitCode]), [
    ["pass-check", "passed", 0],
    ["fail-check", "failed", 4],
  ]);
  assert.equal(results[0]?.dimension, "functional");
  assert.equal(results[0]?.critical, true);
  assert.equal(results[1]?.critical, false);
});

test("a timeout produces error for that assertion only", async () => {
  const { gradingPath, workspacePath } = await createGradingArea();
  const manifest: OracleManifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [
      { ...check("pass-check", "hang.js"), timeoutMs: 200 },
      check("fail-check", "fail.js"),
    ],
  };

  const results = await runOracle({ manifest, assertions, gradingPath, workspacePath });

  assert.equal(results[0]?.outcome, "error");
  assert.match(results[0]?.detail ?? "", /timed out/u);
  assert.equal(results[1]?.outcome, "failed");
});

test("a check that cannot be spawned produces error and the other checks still run", async () => {
  const { gradingPath, workspacePath } = await createGradingArea();
  const manifest: OracleManifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [check("pass-check", "pass.js"), check("fail-check", "fail.js")],
  };
  let call = 0;

  const results = await runOracle({
    manifest,
    assertions,
    gradingPath,
    workspacePath,
    spawn: async () => {
      call += 1;
      if (call === 1) {
        throw new Error("spawn ENOENT");
      }
      return { exitCode: 0, timedOut: false, detail: "" };
    },
  });

  assert.equal(results[0]?.outcome, "error");
  assert.match(results[0]?.detail ?? "", /spawn ENOENT/u);
  assert.equal(results[1]?.outcome, "passed");
});

test("results are ordered by the case assertion order, not the oracle order", async () => {
  const { gradingPath, workspacePath } = await createGradingArea();
  const manifest: OracleManifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [check("fail-check", "fail.js"), check("pass-check", "pass.js")],
  };

  const results = await runOracle({ manifest, assertions, gradingPath, workspacePath });

  assert.deepEqual(results.map((result) => result.assertionId), ["pass-check", "fail-check"]);
});

test("refuses to execute when the oracle does not cover every declared assertion", async () => {
  const { gradingPath, workspacePath } = await createGradingArea();
  const manifest: OracleManifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [check("pass-check", "pass.js")],
  };
  let spawned = false;

  await assert.rejects(
    runOracle({
      manifest,
      assertions,
      gradingPath,
      workspacePath,
      spawn: async () => {
        spawned = true;
        return { exitCode: 0, timedOut: false, detail: "" };
      },
    }),
    (error: unknown) => error instanceof ValidationError,
  );
  assert.equal(spawned, false);
});

test("rejects a working directory that escapes the grading area", async () => {
  const { gradingPath, workspacePath } = await createGradingArea();
  const manifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [
      { ...check("pass-check", "pass.js"), workingDirectory: "checks/../../escape" },
      check("fail-check", "fail.js"),
    ],
  } as OracleManifest;

  const results = await runOracle({ manifest, assertions, gradingPath, workspacePath });

  assert.equal(results[0]?.outcome, "error");
  assert.match(results[0]?.detail ?? "", /escapes/u);
});
```

- [ ] **Step 2: Run the oracle execution test and verify RED**

Run: `npx tsx --test tests/oracles/run-oracle.test.ts`
Expected: FAIL — `Cannot find module '../../src/oracles/run-oracle.js'`.

- [ ] **Step 3: Implement oracle execution**

Create `src/oracles/run-oracle.ts`:

```ts
import { execFile } from "node:child_process";
import type { AssertionDeclaration, OracleCheck, OracleManifest } from "../domain/model.js";
import { ProjectPaths } from "../paths/project-paths.js";
import { assertOracleCoversAssertions } from "./oracle-manifest.js";

export type AssertionOutcome = "passed" | "failed" | "error";

export interface AssertionResult {
  readonly assertionId: string;
  readonly dimension: AssertionDeclaration["dimension"];
  readonly critical: boolean;
  readonly outcome: AssertionOutcome;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly detail: string;
}

export interface OracleSpawnRequest {
  readonly executor: "node" | "npm" | "git";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface OracleSpawnResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly detail: string;
}

export type OracleSpawn = (request: OracleSpawnRequest) => Promise<OracleSpawnResult>;

export interface RunOracleInput {
  readonly manifest: OracleManifest;
  readonly assertions: readonly AssertionDeclaration[];
  readonly gradingPath: string;
  readonly workspacePath: string;
  readonly spawn?: OracleSpawn;
  readonly nowMs?: () => number;
}

export const defaultOracleSpawn: OracleSpawn = async (request) =>
  new Promise<OracleSpawnResult>((resolve, reject) => {
    const child = execFile(
      resolveExecutable(request.executor),
      [...request.args],
      { cwd: request.cwd, timeout: request.timeoutMs, env: { ...request.env }, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, timedOut: false, detail: "" });
          return;
        }

        const timedOut = error.killed === true || error.signal !== null;
        const exitCode = typeof error.code === "number" ? error.code : null;
        if (exitCode === null && !timedOut) {
          reject(error);
          return;
        }
        resolve({
          exitCode,
          timedOut,
          detail: timedOut ? "check timed out" : truncate(stderr.toString()),
        });
      },
    );
    child.once("error", reject);
  });

export async function runOracle(input: RunOracleInput): Promise<readonly AssertionResult[]> {
  assertOracleCoversAssertions(input.manifest, input.assertions);

  const spawn = input.spawn ?? defaultOracleSpawn;
  const nowMs = input.nowMs ?? (() => Date.now());
  const checkById = new Map(input.manifest.checks.map((check) => [check.assertionId, check]));
  const gradingPaths = await ProjectPaths.create(input.gradingPath);
  const env = {
    ...filterEnvironment(process.env),
    SKILLBENCH_WORKSPACE: input.workspacePath,
    SKILLBENCH_ORACLE: input.gradingPath,
  };

  const results: AssertionResult[] = [];
  for (const assertion of input.assertions) {
    const check = checkById.get(assertion.id);
    if (check === undefined) {
      throw new Error(`assertion ${assertion.id} has no oracle check after correspondence validation`);
    }
    results.push(await executeCheck(assertion, check, gradingPaths, env, spawn, nowMs));
  }
  return Object.freeze(results);
}

async function executeCheck(
  assertion: AssertionDeclaration,
  check: OracleCheck,
  gradingPaths: ProjectPaths,
  env: Readonly<Record<string, string>>,
  spawn: OracleSpawn,
  nowMs: () => number,
): Promise<AssertionResult> {
  const startedMs = nowMs();

  let cwd: string;
  try {
    cwd = await gradingPaths.resolveExisting(check.workingDirectory, "directory");
  } catch (cause: unknown) {
    return build(assertion, "error", null, nowMs() - startedMs, `working directory escapes or is missing: ${errorMessage(cause)}`);
  }

  try {
    const outcome = await spawn({
      executor: check.command.executor,
      args: check.command.args,
      cwd,
      timeoutMs: check.timeoutMs,
      env,
    });
    if (outcome.timedOut) {
      return build(assertion, "error", outcome.exitCode, nowMs() - startedMs, outcome.detail || "check timed out");
    }
    return outcome.exitCode === 0
      ? build(assertion, "passed", 0, nowMs() - startedMs, "")
      : build(assertion, "failed", outcome.exitCode, nowMs() - startedMs, outcome.detail);
  } catch (cause: unknown) {
    return build(assertion, "error", null, nowMs() - startedMs, errorMessage(cause));
  }
}

function build(
  assertion: AssertionDeclaration,
  outcome: AssertionOutcome,
  exitCode: number | null,
  durationMs: number,
  detail: string,
): AssertionResult {
  return Object.freeze({
    assertionId: assertion.id,
    dimension: assertion.dimension,
    critical: assertion.critical,
    outcome,
    exitCode,
    durationMs,
    detail: truncate(detail),
  });
}

function resolveExecutable(executor: "node" | "npm" | "git"): string {
  switch (executor) {
    case "node":
      return process.execPath;
    case "npm":
      return process.platform === "win32" ? "npm.cmd" : "npm";
    case "git":
      return "git";
  }
}

function filterEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function truncate(detail: string): string {
  const collapsed = detail.replaceAll("\n", "; ").trim();
  return collapsed.length > 500 ? `${collapsed.slice(0, 500)}…` : collapsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

Note on the escaping working directory: `ProjectPaths.resolveExisting` rejects a `..` segment with the message `manifest path escapes project root`, which is why both the wrapper message and the test look for `escapes`.

- [ ] **Step 4: Run the oracle execution test and verify GREEN**

Run: `npx tsx --test tests/oracles/run-oracle.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full checks**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/oracles/run-oracle.ts tests/oracles/run-oracle.test.ts
git commit -m "feat: execute oracle checks as typed commands"
```

---

### Task 5: Normalized Result Types and Evidence Writer

**Files:**
- Create: `src/runs/result.ts`
- Test: `tests/runs/result.test.ts`

**Interfaces:**
- Consumes: `ImmutableJsonStore` from `src/storage/immutable-json-store.js`, `FrozenRunManifest` from `src/domain/model.js`, `ChangeSet` and `ChangePathObservations` from `src/runs/snapshot.js`, `AssertionResult` from `src/oracles/run-oracle.js`, `RuntimeExecution` from `src/runtime/runtime-adapter.js`, `runDirectory` from `src/runs/freeze-inputs.js`.
- Produces:
  - `type RunStatus = "completed" | "exhausted" | "errored"`
  - `type PipelineStep = "freeze" | "materialize" | "install" | "baseline_snapshot" | "execute" | "final_snapshot" | "grade" | "verify_fixture" | "write_result"`
  - `interface RunCosts { readonly inputTokens: number | null; readonly outputTokens: number | null; readonly wallClockMs: number; readonly unplannedUserTurns: number }`
  - `interface RunResult { readonly schemaVersion: 1; readonly runId: string; readonly manifest: FrozenRunManifest; readonly status: RunStatus; readonly failedStep: PipelineStep | null; readonly failureMessage: string; readonly assertions: readonly AssertionResult[]; readonly changes: ChangeSet; readonly changePathObservations: ChangePathObservations; readonly costs: RunCosts; readonly adapter: { readonly runtime: string; readonly runtimeVersion: string; readonly adapterVersion: string } }`
  - `class RunEvidenceWriter` with `constructor(store: ImmutableJsonStore, manifest: FrozenRunManifest)`, `writeManifest(): Promise<void>`, `writeTranscript(execution: RuntimeExecution): Promise<void>`, `writeChanges(changes: ChangeSet, observations: ChangePathObservations): Promise<void>`, `writeResult(result: RunResult): Promise<void>`, and a readonly `directory: string`.
  - `function hasFailedCriticalAssertion(result: RunResult): boolean`

- [ ] **Step 1: Write the failing evidence writer tests**

Create `tests/runs/result.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadCatalog } from "../../src/catalog/load-catalog.js";
import { ProjectPaths } from "../../src/paths/project-paths.js";
import { freezeRunInputs, type RunConfiguration } from "../../src/runs/freeze-inputs.js";
import { hasFailedCriticalAssertion, RunEvidenceWriter, type RunResult } from "../../src/runs/result.js";
import { ImmutableJsonStore } from "../../src/storage/immutable-json-store.js";
import { createTempProject } from "../helpers/temp-project.js";

const configuration: RunConfiguration = {
  runtime: "fake",
  model: "fake-model",
  reasoningEffort: "medium",
  sandbox: "workspace-write",
  runtimeVersion: "1.0.0",
  adapterVersion: "1.0.0",
};

async function createWriter() {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root);
  const catalogCase = catalog.cases[0];
  const variant = catalog.variants.find((candidate) => candidate.manifest.id === "example");
  assert.ok(catalogCase !== undefined && variant !== undefined);
  const manifest = freezeRunInputs({
    catalogCase,
    variant,
    configuration,
    repetitionIndex: 0,
    runId: "20260830T175302Z-a1b2c3",
  });
  const paths = await ProjectPaths.create(project.root);
  const writer = new RunEvidenceWriter(new ImmutableJsonStore(paths), manifest);
  return { project, manifest, writer };
}

test("writes the manifest into the run directory before anything else", async () => {
  const { project, writer } = await createWriter();

  await writer.writeManifest();

  assert.equal(writer.directory, "runs/F01/example/20260830T175302Z-a1b2c3");
  const written = await readFile(join(project.root, writer.directory, "manifest.json"), "utf8");
  assert.match(written, /"runId":"20260830T175302Z-a1b2c3"/u);
  assert.ok(written.endsWith("\n"));
});

test("writing the same manifest twice is idempotent", async () => {
  const { writer } = await createWriter();

  await writer.writeManifest();
  await writer.writeManifest();
});

test("writes transcript, changes, and result as separate records", async () => {
  const { project, manifest, writer } = await createWriter();
  const result: RunResult = {
    schemaVersion: 1,
    runId: manifest.runId,
    manifest,
    status: "completed",
    failedStep: null,
    failureMessage: "",
    assertions: [{
      assertionId: "assert-1",
      dimension: "functional",
      critical: true,
      outcome: "passed",
      exitCode: 0,
      durationMs: 5,
      detail: "",
    }],
    changes: { added: [], modified: ["src/index.js"], removed: [] },
    changePathObservations: { outsideAllowed: [], insideForbidden: [] },
    costs: { inputTokens: 10, outputTokens: 20, wallClockMs: 30, unplannedUserTurns: 0 },
    adapter: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
  };

  await writer.writeTranscript({
    events: [{ type: "session_started", atMs: 0 }],
    process: { exitCode: 0, signal: null, timedOut: false },
    usage: { inputTokens: 10, outputTokens: 20 },
    elapsedMs: 30,
    metadata: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
  });
  await writer.writeChanges(result.changes, result.changePathObservations);
  await writer.writeResult(result);

  for (const filename of ["transcript.json", "changes.json", "result.json"]) {
    const written = await readFile(join(project.root, writer.directory, filename), "utf8");
    assert.ok(written.endsWith("\n"));
  }
  assert.equal(hasFailedCriticalAssertion(result), false);
});

test("detects a failed critical assertion and ignores a failed non-critical one", async () => {
  const { manifest } = await createWriter();
  const base = {
    schemaVersion: 1 as const,
    runId: manifest.runId,
    manifest,
    status: "completed" as const,
    failedStep: null,
    failureMessage: "",
    changes: { added: [], modified: [], removed: [] },
    changePathObservations: { outsideAllowed: [], insideForbidden: [] },
    costs: { inputTokens: null, outputTokens: null, wallClockMs: 0, unplannedUserTurns: 0 },
    adapter: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
  };

  assert.equal(
    hasFailedCriticalAssertion({
      ...base,
      assertions: [{ assertionId: "a", dimension: "functional", critical: false, outcome: "failed", exitCode: 1, durationMs: 1, detail: "" }],
    }),
    false,
  );
  assert.equal(
    hasFailedCriticalAssertion({
      ...base,
      assertions: [{ assertionId: "a", dimension: "functional", critical: true, outcome: "error", exitCode: null, durationMs: 1, detail: "" }],
    }),
    true,
  );
});
```

- [ ] **Step 2: Run the result test and verify RED**

Run: `npx tsx --test tests/runs/result.test.ts`
Expected: FAIL — `Cannot find module '../../src/runs/result.js'`.

- [ ] **Step 3: Implement the result types and writer**

Create `src/runs/result.ts`:

```ts
import type { FrozenRunManifest } from "../domain/model.js";
import type { AssertionResult } from "../oracles/run-oracle.js";
import type { RuntimeExecution } from "../runtime/runtime-adapter.js";
import type { ImmutableJsonStore } from "../storage/immutable-json-store.js";
import { runDirectory } from "./freeze-inputs.js";
import type { ChangePathObservations, ChangeSet } from "./snapshot.js";

export type RunStatus = "completed" | "exhausted" | "errored";

export type PipelineStep =
  | "freeze"
  | "materialize"
  | "install"
  | "baseline_snapshot"
  | "execute"
  | "final_snapshot"
  | "grade"
  | "verify_fixture"
  | "write_result";

export interface RunCosts {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly wallClockMs: number;
  readonly unplannedUserTurns: number;
}

export interface RunResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly manifest: FrozenRunManifest;
  readonly status: RunStatus;
  readonly failedStep: PipelineStep | null;
  readonly failureMessage: string;
  readonly assertions: readonly AssertionResult[];
  readonly changes: ChangeSet;
  readonly changePathObservations: ChangePathObservations;
  readonly costs: RunCosts;
  readonly adapter: {
    readonly runtime: string;
    readonly runtimeVersion: string;
    readonly adapterVersion: string;
  };
}

export class RunEvidenceWriter {
  public readonly directory: string;

  public constructor(
    private readonly store: ImmutableJsonStore,
    private readonly manifest: FrozenRunManifest,
  ) {
    this.directory = runDirectory(manifest);
  }

  public async writeManifest(): Promise<void> {
    await this.store.write(`${this.directory}/manifest.json`, this.manifest);
  }

  public async writeTranscript(execution: RuntimeExecution): Promise<void> {
    await this.store.write(`${this.directory}/transcript.json`, {
      schemaVersion: 1,
      runId: this.manifest.runId,
      events: execution.events,
      process: execution.process,
      usage: execution.usage,
      elapsedMs: execution.elapsedMs,
      metadata: execution.metadata,
    });
  }

  public async writeChanges(changes: ChangeSet, observations: ChangePathObservations): Promise<void> {
    await this.store.write(`${this.directory}/changes.json`, {
      schemaVersion: 1,
      runId: this.manifest.runId,
      changes,
      changePathObservations: observations,
    });
  }

  public async writeResult(result: RunResult): Promise<void> {
    await this.store.write(`${this.directory}/result.json`, result);
  }
}

export function hasFailedCriticalAssertion(result: RunResult): boolean {
  return result.assertions.some((assertion) => assertion.critical && assertion.outcome !== "passed");
}
```

The canonical JSON serializer rejects `undefined`, so every optional field is written as `null` or an empty string rather than omitted. Keep it that way.

- [ ] **Step 4: Run the result test and verify GREEN**

Run: `npx tsx --test tests/runs/result.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full checks**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/runs/result.ts tests/runs/result.test.ts
git commit -m "feat: normalize run results and persist evidence"
```

---

### Task 6: Runtime Selection and the Case-Derived Fake Script

**Files:**
- Create: `src/runtime/select-adapter.ts`
- Test: `tests/runtime/select-adapter.test.ts`

**Interfaces:**
- Consumes: `FakeAdapter` and `FakeScript` from `src/runtime/fake-adapter.js`, `CaseManifest` from `src/domain/model.js`, `DependencyError` from `src/domain/errors.js`.
- Produces:
  - `const supportedRuntimes: readonly string[]` — currently `["fake"]`
  - `function createFakeScript(caseManifest: CaseManifest): FakeScript`
  - `interface SelectedAdapter { readonly adapter: RuntimeAdapter; readonly runtimeVersion: string; readonly adapterVersion: string }`
  - `function selectAdapter(runtime: string, caseManifest: CaseManifest): SelectedAdapter`

- [ ] **Step 1: Write the failing runtime selection tests**

Create `tests/runtime/select-adapter.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DependencyError } from "../../src/domain/errors.js";
import type { CaseManifest } from "../../src/domain/model.js";
import { selectAdapter, supportedRuntimes } from "../../src/runtime/select-adapter.js";

const caseManifest = {
  schemaVersion: 1,
  id: "F01",
  title: "Example",
  categories: ["implementation"],
  fixture: { path: "fixtures/queuedesk", contentHash: "sha256:" + "0".repeat(64) },
  promptSteps: [
    { id: "step-1", prompt: "Do the work." },
    { id: "step-2", prompt: "Confirm the work." },
  ],
  publicVerification: [{ executor: "npm", args: ["test"] }],
  limits: { wallClockMs: 60_000, outputBytes: 100_000, tokenLimit: 100_000 },
  allowedChangePaths: ["src"],
  forbiddenChangePaths: ["secrets"],
  assertions: [{ id: "assert-1", dimension: "functional", critical: true }],
} as unknown as CaseManifest;

test("publishes the supported runtimes", () => {
  assert.deepEqual([...supportedRuntimes], ["fake"]);
});

test("rejects an unknown runtime identifier", () => {
  assert.throws(() => selectAdapter("codex", caseManifest), DependencyError);
});

test("the fake runtime produces a deterministic transcript for every prompt step", async () => {
  const first = selectAdapter("fake", caseManifest);
  const second = selectAdapter("fake", caseManifest);
  const input = {
    workspace: "/tmp/workspace",
    promptSteps: caseManifest.promptSteps,
    config: {
      model: "fake-model",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
      limits: caseManifest.limits,
    },
    onContinuation: async () => {},
  };

  const firstExecution = await first.adapter.execute(input);
  const secondExecution = await second.adapter.execute(input);

  assert.deepEqual(firstExecution.events, secondExecution.events);
  assert.equal(firstExecution.process.timedOut, false);
  assert.equal(firstExecution.metadata.runtime, "fake");
  assert.equal(firstExecution.metadata.runtimeVersion, first.runtimeVersion);
  assert.equal(firstExecution.metadata.adapterVersion, first.adapterVersion);
  assert.deepEqual(
    firstExecution.events.filter((event) => event.type === "prompt_sent").map((event) => event.stepId),
    ["step-1", "step-2"],
  );
  assert.equal(firstExecution.events.filter((event) => event.type === "completion_claim").length, 2);
});
```

- [ ] **Step 2: Run the selection test and verify RED**

Run: `npx tsx --test tests/runtime/select-adapter.test.ts`
Expected: FAIL — `Cannot find module '../../src/runtime/select-adapter.js'`.

- [ ] **Step 3: Implement runtime selection**

Create `src/runtime/select-adapter.ts`:

```ts
import { DependencyError } from "../domain/errors.js";
import type { CaseManifest } from "../domain/model.js";
import { FakeAdapter, type FakeScript } from "./fake-adapter.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";

export const supportedRuntimes: readonly string[] = Object.freeze(["fake"]);

const fakeRuntimeVersion = "1.0.0";
const fakeAdapterVersion = "1.0.0";

export interface SelectedAdapter {
  readonly adapter: RuntimeAdapter;
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
}

export function createFakeScript(caseManifest: CaseManifest): FakeScript {
  return Object.freeze({
    steps: Object.freeze(caseManifest.promptSteps.map((step) => Object.freeze({
      stepId: step.id,
      events: Object.freeze([
        Object.freeze({
          type: "assistant_message" as const,
          afterMs: 10,
          text: `Working on ${step.id}.`,
        }),
        Object.freeze({
          type: "completion_claim" as const,
          afterMs: 10,
          text: `Finished ${step.id}.`,
        }),
      ]),
    }))),
    closeAfterMs: 10,
    process: Object.freeze({ exitCode: 0, signal: null, timedOut: false }),
    usage: Object.freeze({ inputTokens: 100, outputTokens: 100 }),
    metadata: Object.freeze({
      runtimeVersion: fakeRuntimeVersion,
      adapterVersion: fakeAdapterVersion,
    }),
  });
}

export function selectAdapter(runtime: string, caseManifest: CaseManifest): SelectedAdapter {
  if (runtime !== "fake") {
    throw new DependencyError(
      `runtime ${runtime} is not available in this build; supported runtimes: ${supportedRuntimes.join(", ")}`,
    );
  }

  return Object.freeze({
    adapter: new FakeAdapter(createFakeScript(caseManifest)),
    runtimeVersion: fakeRuntimeVersion,
    adapterVersion: fakeAdapterVersion,
  });
}
```

- [ ] **Step 4: Run the selection test and verify GREEN**

Run: `npx tsx --test tests/runtime/select-adapter.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full checks**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/select-adapter.ts tests/runtime/select-adapter.test.ts
git commit -m "feat: select a runtime adapter from a case"
```

---

### Task 7: The Pipeline Runner

**Files:**
- Create: `src/runs/execute-run.ts`
- Test: `tests/runs/execute-run.test.ts`

**Interfaces:**
- Consumes: `materializeWorkspace` from `src/workspace/materialize-workspace.js`, `installVariant` from `src/variants/install-variant.js`, `OracleLifecycle` from `src/oracles/oracle-lifecycle.js`, `loadOracleManifest` from `src/oracles/oracle-manifest.js`, `runOracle` from `src/oracles/run-oracle.js`, `snapshotTree`/`diffSnapshots`/`observeChangePaths` from `src/runs/snapshot.js`, `freezeRunInputs` from `src/runs/freeze-inputs.js`, `RunEvidenceWriter` from `src/runs/result.js`, `ManifestValidator` from `src/schemas/validator.js`.
- Produces:
  - `interface ExecuteRunInput { readonly paths: ProjectPaths; readonly store: ImmutableJsonStore; readonly validator: ManifestValidator; readonly catalogCase: CatalogCase; readonly variant: CatalogVariant; readonly configuration: RunConfiguration; readonly adapter: RuntimeAdapter; readonly runId: string; readonly repetitionIndex: number; readonly keepWorkspace?: boolean; readonly tempParent?: string }`
  - `async function executeRun(input: ExecuteRunInput): Promise<RunResult>`

`executeRun` never throws for a run-level failure; it returns a `RunResult`. It throws only when the run manifest itself cannot be frozen or written, because there is then no run to describe.

- [ ] **Step 1: Write the failing runner tests**

Create `tests/runs/execute-run.test.ts`:

```ts
import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadCatalog, type CatalogCase, type CatalogVariant } from "../../src/catalog/load-catalog.js";
import { ProjectPaths } from "../../src/paths/project-paths.js";
import { executeRun } from "../../src/runs/execute-run.js";
import type { RunConfiguration } from "../../src/runs/freeze-inputs.js";
import { ManifestValidator } from "../../src/schemas/validator.js";
import { selectAdapter } from "../../src/runtime/select-adapter.js";
import { ImmutableJsonStore } from "../../src/storage/immutable-json-store.js";
import { createTempProject, type TempProject } from "../helpers/temp-project.js";

const configuration: RunConfiguration = {
  runtime: "fake",
  model: "fake-model",
  reasoningEffort: "medium",
  sandbox: "workspace-write",
  runtimeVersion: "1.0.0",
  adapterVersion: "1.0.0",
};

interface Harness {
  readonly project: TempProject;
  readonly catalogCase: CatalogCase;
  readonly variant: CatalogVariant;
  readonly paths: ProjectPaths;
  readonly store: ImmutableJsonStore;
  readonly validator: ManifestValidator;
}

async function createHarness(): Promise<Harness> {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root);
  assert.deepEqual(catalog.issues, []);
  const catalogCase = catalog.cases[0];
  const variant = catalog.variants.find((candidate) => candidate.manifest.id === "example");
  assert.ok(catalogCase !== undefined && variant !== undefined);
  const paths = await ProjectPaths.create(project.root);
  return {
    project,
    catalogCase,
    variant,
    paths,
    store: new ImmutableJsonStore(paths),
    validator: await ManifestValidator.create(join(project.root, "schemas")),
  };
}

function runInput(harness: Harness, runId: string, overrides: Record<string, unknown> = {}) {
  return {
    paths: harness.paths,
    store: harness.store,
    validator: harness.validator,
    catalogCase: harness.catalogCase,
    variant: harness.variant,
    configuration,
    adapter: selectAdapter("fake", harness.catalogCase.manifest).adapter,
    runId,
    repetitionIndex: 0,
    ...overrides,
  };
}

test("a successful run writes every evidence file and reports completed", async () => {
  const harness = await createHarness();

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2c3"));

  assert.equal(result.status, "completed");
  assert.equal(result.failedStep, null);
  assert.deepEqual(result.assertions.map((assertion) => assertion.outcome), ["passed"]);
  assert.deepEqual(result.changes, { added: [], modified: [], removed: [] });
  assert.equal(result.costs.unplannedUserTurns, 0);
  assert.equal(result.adapter.runtime, "fake");

  const directory = join(harness.project.root, "runs/F01/example/20260830T175302Z-a1b2c3");
  for (const filename of ["manifest.json", "transcript.json", "changes.json", "result.json"]) {
    await access(join(directory, filename));
  }
  const stored = JSON.parse(await readFile(join(directory, "result.json"), "utf8")) as { status: string };
  assert.equal(stored.status, "completed");
});

test("a failing oracle check reports completed with a failed assertion", async () => {
  const harness = await createHarness();
  await writeFile(join(harness.project.oracleDirectory, "checks/assert-1.js"), "process.exit(7);\n");

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2c4"));

  assert.equal(result.status, "completed");
  assert.equal(result.assertions[0]?.outcome, "failed");
  assert.equal(result.assertions[0]?.exitCode, 7);
});

test("a missing private oracle reports errored at the grade step and keeps earlier evidence", async () => {
  const harness = await createHarness();
  await rm(harness.project.oracleDirectory, { recursive: true, force: true });

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2c5"));

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "grade");
  assert.notEqual(result.failureMessage, "");
  const directory = join(harness.project.root, "runs/F01/example/20260830T175302Z-a1b2c5");
  for (const filename of ["manifest.json", "transcript.json", "changes.json", "result.json"]) {
    await access(join(directory, filename));
  }
});

test("an exhausted adapter reports exhausted and still grades", async () => {
  const harness = await createHarness();
  const exhaustedAdapter = {
    execute: async () => ({
      events: [{ type: "session_started" as const, atMs: 0 }, { type: "session_closed" as const, atMs: 1 }],
      process: { exitCode: null, signal: "SIGKILL" as NodeJS.Signals, timedOut: true },
      usage: { inputTokens: 1, outputTokens: 1 },
      elapsedMs: 1,
      metadata: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
    }),
  };

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2c6", { adapter: exhaustedAdapter }));

  assert.equal(result.status, "exhausted");
  assert.equal(result.assertions.length, 1);
});

test("an adapter failure reports errored at the execute step", async () => {
  const harness = await createHarness();
  const brokenAdapter = {
    execute: async () => {
      throw new Error("adapter crashed");
    },
  };

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2c7", { adapter: brokenAdapter }));

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "execute");
  assert.match(result.failureMessage, /adapter crashed/u);
});

test("a source fixture change during the run reports errored at the fixture verification step", async () => {
  const harness = await createHarness();
  const mutatingAdapter = {
    execute: async () => {
      await writeFile(join(harness.project.fixtureDirectory, "injected.txt"), "changed\n");
      return {
        events: [{ type: "session_started" as const, atMs: 0 }, { type: "session_closed" as const, atMs: 1 }],
        process: { exitCode: 0, signal: null, timedOut: false },
        usage: { inputTokens: 1, outputTokens: 1 },
        elapsedMs: 1,
        metadata: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
      };
    },
  };

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2c8", { adapter: mutatingAdapter }));

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "verify_fixture");
});

test("agent changes appear in the change set with allowed and forbidden observations", async () => {
  const harness = await createHarness();
  let workspacePath = "";
  const editingAdapter = {
    execute: async (input: { workspace: string }) => {
      workspacePath = input.workspace;
      await writeFile(join(input.workspace, "index.js"), "export const queued = [1];\n");
      return {
        events: [{ type: "session_started" as const, atMs: 0 }, { type: "session_closed" as const, atMs: 1 }],
        process: { exitCode: 0, signal: null, timedOut: false },
        usage: { inputTokens: 1, outputTokens: 1 },
        elapsedMs: 1,
        metadata: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
      };
    },
  };

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2c9", { adapter: editingAdapter }));

  assert.notEqual(workspacePath, "");
  assert.deepEqual(result.changes.modified, ["index.js"]);
  assert.deepEqual(result.changePathObservations.outsideAllowed, ["index.js"]);
  assert.deepEqual(result.changePathObservations.insideForbidden, []);
});

test("the workspace is removed by default and preserved with keepWorkspace", async () => {
  const harness = await createHarness();
  const observed: string[] = [];
  const observingAdapter = {
    execute: async (input: { workspace: string }) => {
      observed.push(input.workspace);
      return {
        events: [{ type: "session_started" as const, atMs: 0 }, { type: "session_closed" as const, atMs: 1 }],
        process: { exitCode: 0, signal: null, timedOut: false },
        usage: null,
        elapsedMs: 1,
        metadata: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
      };
    },
  };

  await executeRun(runInput(harness, "20260830T175302Z-a1b2d0", { adapter: observingAdapter }));
  await executeRun(runInput(harness, "20260830T175302Z-a1b2d1", { adapter: observingAdapter, keepWorkspace: true }));

  assert.equal(observed.length, 2);
  await assert.rejects(access(observed[0] ?? ""), { code: "ENOENT" });
  await access(observed[1] ?? "");
});

test("the variant material is installed before the baseline snapshot", async () => {
  const harness = await createHarness();
  let installedDuringSession = false;
  const inspectingAdapter = {
    execute: async (input: { workspace: string }) => {
      installedDuringSession = await access(join(input.workspace, ".agent/skills/example/SKILL.md"))
        .then(() => true)
        .catch(() => false);
      return {
        events: [{ type: "session_started" as const, atMs: 0 }, { type: "session_closed" as const, atMs: 1 }],
        process: { exitCode: 0, signal: null, timedOut: false },
        usage: null,
        elapsedMs: 1,
        metadata: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
      };
    },
  };

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2d2", { adapter: inspectingAdapter }));

  assert.equal(installedDuringSession, true);
  assert.deepEqual(result.changes.added, []);
});
```

The last test uses `.agent/skills/example/SKILL.md`: the `fake` destination Task 2 added to `tests/helpers/temp-project.ts`, joined with the single file in the example install source.

- [ ] **Step 2: Run the runner test and verify RED**

Run: `npx tsx --test tests/runs/execute-run.test.ts`
Expected: FAIL — `Cannot find module '../../src/runs/execute-run.js'`.

- [ ] **Step 3: Implement the runner**

Create `src/runs/execute-run.ts`:

```ts
import type { CatalogCase, CatalogVariant } from "../catalog/load-catalog.js";
import type { RuntimeLimits } from "../domain/model.js";
import type { RuntimeAdapter, RuntimeExecution, TranscriptEvent } from "../runtime/runtime-adapter.js";
import { OracleLifecycle } from "../oracles/oracle-lifecycle.js";
import { loadOracleManifest } from "../oracles/oracle-manifest.js";
import { runOracle, type AssertionResult } from "../oracles/run-oracle.js";
import type { ProjectPaths } from "../paths/project-paths.js";
import type { ManifestValidator } from "../schemas/validator.js";
import type { ImmutableJsonStore } from "../storage/immutable-json-store.js";
import { installVariant } from "../variants/install-variant.js";
import { materializeWorkspace, type MaterializedWorkspace } from "../workspace/materialize-workspace.js";
import { freezeRunInputs, type RunConfiguration } from "./freeze-inputs.js";
import { RunEvidenceWriter, type PipelineStep, type RunResult, type RunStatus } from "./result.js";
import { diffSnapshots, observeChangePaths, snapshotTree, type TreeSnapshot } from "./snapshot.js";

export interface ExecuteRunInput {
  readonly paths: ProjectPaths;
  readonly store: ImmutableJsonStore;
  readonly validator: ManifestValidator;
  readonly catalogCase: CatalogCase;
  readonly variant: CatalogVariant;
  readonly configuration: RunConfiguration;
  readonly adapter: RuntimeAdapter;
  readonly runId: string;
  readonly repetitionIndex: number;
  readonly keepWorkspace?: boolean;
  readonly tempParent?: string;
}

const emptyChanges = Object.freeze({
  added: Object.freeze([]),
  modified: Object.freeze([]),
  removed: Object.freeze([]),
});
const emptyObservations = Object.freeze({
  outsideAllowed: Object.freeze([]),
  insideForbidden: Object.freeze([]),
});

export async function executeRun(input: ExecuteRunInput): Promise<RunResult> {
  const manifest = freezeRunInputs({
    catalogCase: input.catalogCase,
    variant: input.variant,
    configuration: input.configuration,
    repetitionIndex: input.repetitionIndex,
    runId: input.runId,
  });
  const writer = new RunEvidenceWriter(input.store, manifest);
  await writer.writeManifest();

  let workspace: MaterializedWorkspace | undefined;
  let lifecycle: OracleLifecycle | undefined;
  let step: PipelineStep = "materialize";
  let baseline: TreeSnapshot = [];
  let execution: RuntimeExecution | undefined;
  let changes = emptyChanges;
  let observations = emptyObservations;
  let assertions: readonly AssertionResult[] = [];
  let status: RunStatus = "completed";
  let failedStep: PipelineStep | null = null;
  let failureMessage = "";

  try {
    workspace = await materializeWorkspace({
      paths: input.paths,
      fixture: input.catalogCase.manifest.fixture.path,
      ...(input.tempParent === undefined ? {} : { tempParent: input.tempParent }),
    });

    step = "install";
    await installVariant({
      variant: input.variant,
      runtime: input.configuration.runtime,
      workspacePath: workspace.workspacePath,
    });

    step = "baseline_snapshot";
    baseline = await snapshotTree(workspace.workspacePath);

    step = "execute";
    lifecycle = await OracleLifecycle.create({
      paths: input.paths,
      caseId: input.catalogCase.manifest.id,
      workspacePath: workspace.workspacePath,
      ...(input.tempParent === undefined ? {} : { tempParent: input.tempParent }),
    });
    execution = await input.adapter.execute({
      workspace: workspace.workspacePath,
      promptSteps: input.catalogCase.manifest.promptSteps,
      config: {
        model: input.configuration.model,
        reasoningEffort: input.configuration.reasoningEffort,
        sandbox: input.configuration.sandbox,
        limits: input.catalogCase.manifest.limits,
      },
      onContinuation: async () => {},
    });
    await writer.writeTranscript(execution);

    step = "final_snapshot";
    changes = diffSnapshots(baseline, await snapshotTree(workspace.workspacePath));
    observations = observeChangePaths(
      changes,
      input.catalogCase.manifest.allowedChangePaths,
      input.catalogCase.manifest.forbiddenChangePaths,
    );
    await writer.writeChanges(changes, observations);

    step = "grade";
    lifecycle.markAgentClosed();
    const mounted = await lifecycle.mountOracle();
    const oracleManifest = await loadOracleManifest(mounted.gradingPath, input.validator);
    assertions = await runOracle({
      manifest: oracleManifest,
      assertions: input.catalogCase.manifest.assertions,
      gradingPath: mounted.gradingPath,
      workspacePath: workspace.workspacePath,
    });

    step = "verify_fixture";
    await workspace.verifySource();

    status = isExhausted(execution, input.catalogCase.manifest.limits) ? "exhausted" : "completed";
  } catch (error: unknown) {
    status = "errored";
    failedStep = step;
    failureMessage = errorMessage(error);
  } finally {
    await cleanupQuietly(lifecycle);
    if (input.keepWorkspace !== true) {
      await cleanupQuietly(workspace);
    }
  }

  const result: RunResult = Object.freeze({
    schemaVersion: 1,
    runId: manifest.runId,
    manifest,
    status,
    failedStep,
    failureMessage,
    assertions,
    changes,
    changePathObservations: observations,
    costs: Object.freeze({
      inputTokens: execution?.usage?.inputTokens ?? null,
      outputTokens: execution?.usage?.outputTokens ?? null,
      wallClockMs: execution?.elapsedMs ?? 0,
      unplannedUserTurns: countUnplannedUserTurns(execution, input.catalogCase),
    }),
    adapter: Object.freeze({
      runtime: execution?.metadata.runtime ?? input.configuration.runtime,
      runtimeVersion: execution?.metadata.runtimeVersion ?? input.configuration.runtimeVersion,
      adapterVersion: execution?.metadata.adapterVersion ?? input.configuration.adapterVersion,
    }),
  });

  await writer.writeResult(result);
  return result;
}

function isExhausted(execution: RuntimeExecution, limits: RuntimeLimits): boolean {
  if (execution.process.timedOut) return true;
  if (execution.elapsedMs >= limits.wallClockMs) return true;
  if (execution.usage !== null &&
    execution.usage.inputTokens + execution.usage.outputTokens >= limits.tokenLimit) {
    return true;
  }
  return outputBytes(execution.events) >= limits.outputBytes;
}

function outputBytes(events: readonly TranscriptEvent[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type === "assistant_message" || event.type === "completion_claim") {
      total += Buffer.byteLength(event.text, "utf8");
    }
  }
  return total;
}

function countUnplannedUserTurns(
  execution: RuntimeExecution | undefined,
  catalogCase: CatalogCase,
): number {
  if (execution === undefined) return 0;
  const declared = new Set(catalogCase.manifest.promptSteps.map(({ id }) => id));
  return execution.events.filter((event) => event.type === "prompt_sent" && !declared.has(event.stepId)).length;
}

async function cleanupQuietly(target: { cleanup(): Promise<void> } | undefined): Promise<void> {
  if (target === undefined) return;
  try {
    await target.cleanup();
  } catch {
    // Cleanup failure must not replace the recorded run outcome.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

Two details that matter and are easy to get wrong:

1. The `finally` block cleans the oracle lifecycle before the workspace, so private material is never left behind even when the workspace is preserved.
2. `writeResult` runs after the `finally` block, so a cleanup failure cannot prevent the result from being recorded.

- [ ] **Step 4: Run the runner test and verify GREEN**

Run: `npx tsx --test tests/runs/execute-run.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the full checks**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/runs/execute-run.ts tests/runs/execute-run.test.ts
git commit -m "feat: orchestrate a benchmark run end to end"
```

---

### Task 8: The `list` Command

**Files:**
- Create: `src/commands/list.ts`
- Modify: `src/cli/create-program.ts`
- Test: `tests/commands/list.test.ts`

**Interfaces:**
- Consumes: `loadCatalog` from `src/catalog/load-catalog.js`, `CommandIo` from `src/commands/validate.js`, `InvocationError` and `FindingError` from `src/domain/errors.js`.
- Produces:
  - `interface ListOptions { readonly project: string; readonly json: boolean }`
  - `async function runList(target: string | undefined, options: ListOptions, io: CommandIo): Promise<void>`

- [ ] **Step 1: Write the failing list tests**

Create `tests/commands/list.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { runList } from "../../src/commands/list.js";
import { InvocationError } from "../../src/domain/errors.js";
import { createTempProject } from "../helpers/temp-project.js";

function createIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

test("lists cases with their assertion count and oracle availability", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runList("cases", { project: project.root, json: false }, io);

  assert.match(stdout(), /F01/u);
  assert.match(stdout(), /Implement QueueDesk behavior/u);
  assert.match(stdout(), /implementation/u);
});

test("lists variants with their compatible runtimes", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runList("variants", { project: project.root, json: false }, io);

  assert.match(stdout(), /control/u);
  assert.match(stdout(), /example/u);
  assert.match(stdout(), /fake/u);
});

test("no target lists both sections", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runList(undefined, { project: project.root, json: false }, io);

  assert.match(stdout(), /F01/u);
  assert.match(stdout(), /example/u);
});

test("--json emits a parseable document with both collections", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runList(undefined, { project: project.root, json: true }, io);

  const parsed = JSON.parse(stdout()) as {
    cases: { id: string; assertionCount: number; oracleAvailable: boolean }[];
    variants: { id: string; compatibleRuntimes: string[] }[];
  };
  assert.deepEqual(parsed.cases.map((entry) => entry.id), ["F01"]);
  assert.equal(parsed.cases[0]?.assertionCount, 1);
  assert.equal(parsed.cases[0]?.oracleAvailable, true);
  assert.deepEqual(parsed.variants.map((entry) => entry.id), ["control", "example"]);
});

test("an unknown target raises an invocation error", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  await assert.rejects(
    runList("oracles", { project: project.root, json: false }, io),
    (error: unknown) => error instanceof InvocationError && error.exitCode === 2,
  );
});
```

- [ ] **Step 2: Run the list test and verify RED**

Run: `npx tsx --test tests/commands/list.test.ts`
Expected: FAIL — `Cannot find module '../../src/commands/list.js'`.

- [ ] **Step 3: Implement the list command**

Create `src/commands/list.ts`:

```ts
import { resolve } from "node:path";
import { loadCatalog, type Catalog } from "../catalog/load-catalog.js";
import { FindingError, InvocationError } from "../domain/errors.js";
import type { CommandIo } from "./validate.js";

export interface ListOptions {
  readonly project: string;
  readonly json: boolean;
}

export async function runList(
  target: string | undefined,
  options: ListOptions,
  io: CommandIo,
): Promise<void> {
  if (target !== undefined && target !== "cases" && target !== "variants") {
    throw new InvocationError(`unknown list target ${JSON.stringify(target)}; expected cases or variants`);
  }

  const catalog = await loadCatalog(resolve(options.project), { requirePrivateOracles: true });
  const blockingIssues = catalog.issues.filter((issue) => !issue.code.startsWith("ORACLE_"));
  for (const issue of blockingIssues) {
    io.stderr(`${issue.source}: ${issue.code}: ${issue.message}\n`);
  }
  if (blockingIssues.length > 0) {
    throw new FindingError(`Listing found ${blockingIssues.length.toString()} finding(s).`);
  }

  if (options.json) {
    io.stdout(`${JSON.stringify(toJson(catalog, target), null, 2)}\n`);
    return;
  }

  if (target !== "variants") {
    io.stdout("Cases:\n");
    for (const entry of catalog.cases) {
      io.stdout(
        `  ${entry.manifest.id}  ${entry.manifest.title}  [${entry.manifest.categories.join(", ")}]  assertions=${entry.manifest.assertions.length.toString()}  oracle=${entry.oracleHash === undefined ? "missing" : "available"}\n`,
      );
    }
  }
  if (target !== "cases") {
    io.stdout("Variants:\n");
    for (const entry of catalog.variants) {
      io.stdout(
        `  ${entry.manifest.id}  ${entry.manifest.displayName}  [${entry.manifest.claimedCategories.join(", ")}]  runtimes=${entry.manifest.compatibleRuntimes.join(", ")}\n`,
      );
    }
  }
}

function toJson(catalog: Catalog, target: string | undefined): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  if (target !== "variants") {
    document["cases"] = catalog.cases.map((entry) => ({
      id: entry.manifest.id,
      title: entry.manifest.title,
      categories: entry.manifest.categories,
      assertionCount: entry.manifest.assertions.length,
      oracleAvailable: entry.oracleHash !== undefined,
    }));
  }
  if (target !== "cases") {
    document["variants"] = catalog.variants.map((entry) => ({
      id: entry.manifest.id,
      displayName: entry.manifest.displayName,
      claimedCategories: entry.manifest.claimedCategories,
      compatibleRuntimes: entry.manifest.compatibleRuntimes,
    }));
  }
  return document;
}
```

- [ ] **Step 4: Register the command**

In `src/cli/create-program.ts`, remove `"list"` from `unavailableCommands` and add:

```ts
  program
    .command("list")
    .description("List benchmark cases and variants")
    .argument("[target]", "cases or variants")
    .option("--project <path>", "SkillBench project root", ".")
    .option("--json", "emit machine-readable JSON", false)
    .action(async (target: string | undefined, options: ListOptions) => runList(target, options, io));
```

Import `runList` and `type ListOptions` from `../commands/list.js`.

- [ ] **Step 5: Run the list and CLI tests and verify GREEN**

Run: `npx tsx --test tests/commands/list.test.ts tests/cli/help.test.ts`
Expected: PASS. The help test still finds `list` in the help output.

- [ ] **Step 6: Run the full checks**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/commands/list.ts src/cli/create-program.ts tests/commands/list.test.ts
git commit -m "feat: list benchmark cases and variants"
```

---

### Task 9: The `dry-run` Command

**Files:**
- Create: `src/commands/dry-run.ts`
- Modify: `src/cli/create-program.ts`
- Test: `tests/commands/dry-run.test.ts`

**Interfaces:**
- Consumes: `loadCatalog`, `freezeRunInputs`, `createRunId`, `defaultRunIdSuffix`, `selectAdapter`, `supportedRuntimes`.
- Produces:
  - `interface RunSelectionOptions { readonly project: string; readonly case: string; readonly variant: string; readonly runtime: string; readonly model: string; readonly reasoning: string; readonly sandbox: string; readonly json: boolean }`
  - `async function runDryRun(options: RunSelectionOptions, io: CommandIo, clock?: () => Date, suffix?: () => string): Promise<void>`
  - `async function resolveRunTargets(options: RunSelectionOptions): Promise<{ readonly catalogCase: CatalogCase; readonly variant: CatalogVariant; readonly configuration: RunConfiguration; readonly paths: ProjectPaths; readonly projectRoot: string; readonly validator: ManifestValidator }>` — exported so `run` reuses the same resolution and error messages.

- [ ] **Step 1: Write the failing dry-run tests**

Create `tests/commands/dry-run.test.ts`:

```ts
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runDryRun } from "../../src/commands/dry-run.js";
import { DependencyError, InvocationError } from "../../src/domain/errors.js";
import { createTempProject } from "../helpers/temp-project.js";

function createIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

function options(root: string, overrides: Record<string, unknown> = {}) {
  return {
    project: root,
    case: "F01",
    variant: "example",
    runtime: "fake",
    model: "fake-model",
    reasoning: "medium",
    sandbox: "workspace-write",
    json: false,
    ...overrides,
  };
}

test("prints the frozen plan and writes nothing", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runDryRun(options(project.root), io, () => new Date("2026-08-30T17:53:02.000Z"), () => "a1b2c3");

  const printed = stdout();
  assert.match(printed, /20260830T175302Z-a1b2c3/u);
  assert.match(printed, /step-1/u);
  assert.match(printed, /assert-1/u);
  assert.match(printed, /functional/u);
  assert.match(printed, /npm test/u);
  await assert.rejects(readdir(join(project.root, "runs")), { code: "ENOENT" });
});

test("--json emits the same content as a parseable document", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runDryRun(options(project.root, { json: true }), io, () => new Date("2026-08-30T17:53:02.000Z"), () => "a1b2c3");

  const parsed = JSON.parse(stdout()) as {
    manifest: { runId: string; caseId: string };
    promptSteps: { id: string }[];
    assertions: { id: string; dimension: string; critical: boolean }[];
    allowedChangePaths: string[];
    forbiddenChangePaths: string[];
    publicVerification: { executor: string; args: string[] }[];
  };
  assert.equal(parsed.manifest.runId, "20260830T175302Z-a1b2c3");
  assert.equal(parsed.manifest.caseId, "F01");
  assert.deepEqual(parsed.promptSteps.map((step) => step.id), ["step-1"]);
  assert.deepEqual(parsed.assertions, [{ id: "assert-1", dimension: "functional", critical: true }]);
  assert.deepEqual(parsed.allowedChangePaths, ["src"]);
  assert.deepEqual(parsed.forbiddenChangePaths, ["secrets"]);
  assert.deepEqual(parsed.publicVerification, [{ executor: "npm", args: ["test"] }]);
});

test("an unknown case identifier raises an invocation error", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  await assert.rejects(
    runDryRun(options(project.root, { case: "F99" }), io),
    (error: unknown) => error instanceof InvocationError && error.exitCode === 2,
  );
});

test("an unknown variant identifier raises an invocation error", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  await assert.rejects(
    runDryRun(options(project.root, { variant: "missing" }), io),
    (error: unknown) => error instanceof InvocationError && error.exitCode === 2,
  );
});

test("an unknown runtime raises a dependency error", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  await assert.rejects(
    runDryRun(options(project.root, { runtime: "codex" }), io),
    (error: unknown) => error instanceof DependencyError && error.exitCode === 2,
  );
});

test("a missing private oracle refuses to freeze the plan", async () => {
  const project = await createTempProject();
  await rm(project.oracleDirectory, { recursive: true, force: true });
  const { io } = createIo();

  await assert.rejects(
    runDryRun(options(project.root), io),
    (error: unknown) => error instanceof DependencyError && /oracle/u.test(error.message),
  );
});
```

- [ ] **Step 2: Run the dry-run test and verify RED**

Run: `npx tsx --test tests/commands/dry-run.test.ts`
Expected: FAIL — `Cannot find module '../../src/commands/dry-run.js'`.

- [ ] **Step 3: Implement dry-run and shared target resolution**

Create `src/commands/dry-run.ts`:

```ts
import { join, resolve } from "node:path";
import { loadCatalog, type CatalogCase, type CatalogVariant } from "../catalog/load-catalog.js";
import { DependencyError, InvocationError } from "../domain/errors.js";
import { ProjectPaths } from "../paths/project-paths.js";
import { createRunId, defaultRunIdSuffix, freezeRunInputs, type RunConfiguration } from "../runs/freeze-inputs.js";
import { selectAdapter } from "../runtime/select-adapter.js";
import { ManifestValidator } from "../schemas/validator.js";
import type { CommandIo } from "./validate.js";

export interface RunSelectionOptions {
  readonly project: string;
  readonly case: string;
  readonly variant: string;
  readonly runtime: string;
  readonly model: string;
  readonly reasoning: string;
  readonly sandbox: string;
  readonly json: boolean;
}

export interface ResolvedRunTargets {
  readonly projectRoot: string;
  readonly paths: ProjectPaths;
  readonly validator: ManifestValidator;
  readonly catalogCase: CatalogCase;
  readonly variant: CatalogVariant;
  readonly configuration: RunConfiguration;
}

export async function resolveRunTargets(options: RunSelectionOptions): Promise<ResolvedRunTargets> {
  const projectRoot = resolve(options.project);
  const catalog = await loadCatalog(projectRoot, { requirePrivateOracles: true });

  const catalogCase = catalog.cases.find((entry) => entry.manifest.id === options.case);
  if (catalogCase === undefined) {
    throw new InvocationError(`unknown case ${JSON.stringify(options.case)}`);
  }
  const variant = catalog.variants.find((entry) => entry.manifest.id === options.variant);
  if (variant === undefined) {
    throw new InvocationError(`unknown variant ${JSON.stringify(options.variant)}`);
  }

  const relevantIssues = catalog.issues.filter(
    (issue) => issue.source === catalogCase.source || issue.source === variant.source,
  );
  if (relevantIssues.length > 0) {
    throw new DependencyError(
      relevantIssues.map((issue) => `${issue.source}: ${issue.code}: ${issue.message}`).join("\n"),
    );
  }

  const selected = selectAdapter(options.runtime, catalogCase.manifest);
  return {
    projectRoot,
    paths: await ProjectPaths.create(projectRoot),
    validator: await ManifestValidator.create(join(projectRoot, "schemas")),
    catalogCase,
    variant,
    configuration: {
      runtime: options.runtime,
      model: options.model,
      reasoningEffort: options.reasoning,
      sandbox: options.sandbox,
      runtimeVersion: selected.runtimeVersion,
      adapterVersion: selected.adapterVersion,
    },
  };
}

export async function runDryRun(
  options: RunSelectionOptions,
  io: CommandIo,
  clock: () => Date = () => new Date(),
  suffix: () => string = defaultRunIdSuffix,
): Promise<void> {
  const targets = await resolveRunTargets(options);
  const manifest = freezeRunInputs({
    catalogCase: targets.catalogCase,
    variant: targets.variant,
    configuration: targets.configuration,
    repetitionIndex: 0,
    runId: createRunId(clock(), suffix()),
  });
  const caseManifest = targets.catalogCase.manifest;

  if (options.json) {
    io.stdout(`${JSON.stringify({
      manifest,
      promptSteps: caseManifest.promptSteps,
      allowedChangePaths: caseManifest.allowedChangePaths,
      forbiddenChangePaths: caseManifest.forbiddenChangePaths,
      publicVerification: caseManifest.publicVerification,
      assertions: caseManifest.assertions,
    }, null, 2)}\n`);
    return;
  }

  io.stdout(`Run plan for case ${manifest.caseId} and variant ${manifest.variantId}\n`);
  io.stdout(`  run id: ${manifest.runId}\n`);
  io.stdout(`  runtime: ${manifest.runtime} ${manifest.runtimeVersion} (adapter ${manifest.adapterVersion})\n`);
  io.stdout(`  model: ${manifest.model}  reasoning: ${manifest.reasoningEffort}  sandbox: ${manifest.sandbox}\n`);
  io.stdout(`  limits: wallClockMs=${manifest.limits.wallClockMs.toString()} outputBytes=${manifest.limits.outputBytes.toString()} tokenLimit=${manifest.limits.tokenLimit.toString()}\n`);
  io.stdout(`  case hash: ${manifest.caseHash}\n`);
  io.stdout(`  variant hash: ${manifest.variantHash}\n`);
  io.stdout(`  fixture hash: ${manifest.fixtureHash}\n`);
  io.stdout(`  oracle hash: ${manifest.oracleHash}\n`);

  io.stdout("Prompt steps:\n");
  for (const step of caseManifest.promptSteps) {
    io.stdout(`  ${step.id}: ${step.prompt}\n`);
  }
  io.stdout(`Allowed change paths: ${caseManifest.allowedChangePaths.join(", ")}\n`);
  io.stdout(`Forbidden change paths: ${caseManifest.forbiddenChangePaths.join(", ")}\n`);
  io.stdout("Public verification:\n");
  for (const command of caseManifest.publicVerification) {
    io.stdout(`  ${command.executor} ${command.args.join(" ")}\n`);
  }
  io.stdout("Assertions:\n");
  for (const assertion of caseManifest.assertions) {
    io.stdout(`  ${assertion.id}  ${assertion.dimension}  ${assertion.critical ? "critical" : "diagnostic"}\n`);
  }
  io.stdout("No workspace was created and no agent was started.\n");
}
```

A blocking catalog issue on the selected case or variant — an unavailable fixture, an unavailable or malformed private oracle, a hash mismatch — raises a `DependencyError`, not a `FindingError`. The spec assigns exit code `2` to an unavailable dependency and reserves exit code `1` for a run that executed and did not solve the case.

- [ ] **Step 4: Register the command**

In `src/cli/create-program.ts`, remove `"dry-run"` from `unavailableCommands` and add:

```ts
  program
    .command("dry-run")
    .description("Freeze run inputs and print the execution plan without starting an agent")
    .requiredOption("--case <id>", "case identifier")
    .requiredOption("--variant <id>", "variant identifier")
    .option("--project <path>", "SkillBench project root", ".")
    .option("--runtime <id>", "runtime adapter", "fake")
    .option("--model <id>", "model identifier", "fake-model")
    .option("--reasoning <effort>", "reasoning effort", "medium")
    .option("--sandbox <mode>", "sandbox mode", "workspace-write")
    .option("--json", "emit machine-readable JSON", false)
    .action(async (options: RunSelectionOptions) => runDryRun(options, io));
```

- [ ] **Step 5: Run the dry-run test and verify GREEN**

Run: `npx tsx --test tests/commands/dry-run.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full checks**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/commands/dry-run.ts src/cli/create-program.ts tests/commands/dry-run.test.ts
git commit -m "feat: print a frozen execution plan"
```

---

### Task 10: The `run` Command

**Files:**
- Create: `src/commands/run.ts`
- Modify: `src/cli/create-program.ts`
- Test: `tests/commands/run.test.ts`

**Interfaces:**
- Consumes: `resolveRunTargets` and `RunSelectionOptions` from `src/commands/dry-run.js`, `executeRun` from `src/runs/execute-run.js`, `selectAdapter` from `src/runtime/select-adapter.js`, `hasFailedCriticalAssertion` from `src/runs/result.js`, `ImmutableJsonStore` from `src/storage/immutable-json-store.js`.
- Produces:
  - `interface RunCommandOptions extends RunSelectionOptions { readonly runs: string; readonly keepWorkspace: boolean }`
  - `async function runRun(options: RunCommandOptions, io: CommandIo, clock?: () => Date, suffix?: () => string): Promise<void>`

- [ ] **Step 1: Write the failing run tests**

Create `tests/commands/run.test.ts`:

```ts
import assert from "node:assert/strict";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runRun } from "../../src/commands/run.js";
import { DependencyError, FindingError, InvocationError } from "../../src/domain/errors.js";
import { createTempProject } from "../helpers/temp-project.js";

function createIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

function options(root: string, overrides: Record<string, unknown> = {}) {
  return {
    project: root,
    case: "F01",
    variant: "example",
    runtime: "fake",
    model: "fake-model",
    reasoning: "medium",
    sandbox: "workspace-write",
    runs: "1",
    keepWorkspace: false,
    json: false,
    ...overrides,
  };
}

function sequentialSuffixes(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return index.toString().padStart(6, "0");
  };
}

test("a passing run reports completed and writes one run directory", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runRun(options(project.root), io, () => new Date("2026-08-30T17:53:02.000Z"), sequentialSuffixes());

  assert.match(stdout(), /completed/u);
  const directories = await readdir(join(project.root, "runs/F01/example"));
  assert.equal(directories.length, 1);
});

test("--runs 3 produces three independent run directories", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  await runRun(options(project.root, { runs: "3" }), io, () => new Date("2026-08-30T17:53:02.000Z"), sequentialSuffixes());

  const directories = await readdir(join(project.root, "runs/F01/example"));
  assert.equal(directories.length, 3);
  assert.equal(new Set(directories).size, 3);
});

test("a failed critical assertion raises a finding error", async () => {
  const project = await createTempProject();
  await writeFile(join(project.oracleDirectory, "checks/assert-1.js"), "process.exit(9);\n");
  const { io } = createIo();

  await assert.rejects(
    runRun(options(project.root), io, () => new Date("2026-08-30T17:53:02.000Z"), sequentialSuffixes()),
    (error: unknown) => error instanceof FindingError && error.exitCode === 1,
  );
});

test("a missing private oracle raises a dependency error", async () => {
  const project = await createTempProject();
  await rm(project.oracleDirectory, { recursive: true, force: true });
  const { io } = createIo();

  await assert.rejects(
    runRun(options(project.root), io),
    (error: unknown) => error instanceof DependencyError && error.exitCode === 2,
  );
});

test("--runs must be a positive integer", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  for (const runs of ["0", "-1", "two", "1.5"]) {
    await assert.rejects(
      runRun(options(project.root, { runs }), io),
      (error: unknown) => error instanceof InvocationError && error.exitCode === 2,
    );
  }
});

test("--json emits one summary document for every run", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runRun(options(project.root, { runs: "2", json: true }), io, () => new Date("2026-08-30T17:53:02.000Z"), sequentialSuffixes());

  const parsed = JSON.parse(stdout()) as { runs: { runId: string; status: string; failedCriticalAssertions: string[] }[] };
  assert.equal(parsed.runs.length, 2);
  for (const entry of parsed.runs) {
    assert.equal(entry.status, "completed");
    assert.deepEqual(entry.failedCriticalAssertions, []);
  }
});

test("a later run still executes after an earlier run errors", async () => {
  const project = await createTempProject();
  const { io } = createIo();
  await writeFile(join(project.oracleDirectory, "oracle.json"), "{ not json\n");

  await assert.rejects(
    runRun(options(project.root, { runs: "2" }), io, () => new Date("2026-08-30T17:53:02.000Z"), sequentialSuffixes()),
    (error: unknown) => error instanceof DependencyError && error.exitCode === 2,
  );

  const directories = await readdir(join(project.root, "runs/F01/example"));
  assert.equal(directories.length, 2);
});
```

- [ ] **Step 2: Run the run test and verify RED**

Run: `npx tsx --test tests/commands/run.test.ts`
Expected: FAIL — `Cannot find module '../../src/commands/run.js'`.

- [ ] **Step 3: Implement the run command**

Create `src/commands/run.ts`:

```ts
import { DependencyError, FindingError, InvocationError } from "../domain/errors.js";
import { executeRun } from "../runs/execute-run.js";
import { createRunId, defaultRunIdSuffix } from "../runs/freeze-inputs.js";
import { hasFailedCriticalAssertion, type RunResult } from "../runs/result.js";
import { selectAdapter } from "../runtime/select-adapter.js";
import { ImmutableJsonStore } from "../storage/immutable-json-store.js";
import { resolveRunTargets, type RunSelectionOptions } from "./dry-run.js";
import type { CommandIo } from "./validate.js";

export interface RunCommandOptions extends RunSelectionOptions {
  readonly runs: string;
  readonly keepWorkspace: boolean;
}

export async function runRun(
  options: RunCommandOptions,
  io: CommandIo,
  clock: () => Date = () => new Date(),
  suffix: () => string = defaultRunIdSuffix,
): Promise<void> {
  const repetitions = parseRepetitions(options.runs);
  const targets = await resolveRunTargets(options);
  const store = new ImmutableJsonStore(targets.paths);
  const results: RunResult[] = [];

  for (let repetitionIndex = 0; repetitionIndex < repetitions; repetitionIndex += 1) {
    results.push(await executeRun({
      paths: targets.paths,
      store,
      validator: targets.validator,
      catalogCase: targets.catalogCase,
      variant: targets.variant,
      configuration: targets.configuration,
      adapter: selectAdapter(options.runtime, targets.catalogCase.manifest).adapter,
      runId: createRunId(clock(), suffix()),
      repetitionIndex,
      keepWorkspace: options.keepWorkspace,
    }));
  }

  report(results, options.json, io);

  const errored = results.filter((result) => result.status === "errored");
  if (errored.length > 0) {
    throw new DependencyError(
      errored.map((result) => `${result.runId}: ${result.failedStep ?? "unknown"}: ${result.failureMessage}`).join("\n"),
    );
  }

  const unsolved = results.filter(
    (result) => result.status === "exhausted" || hasFailedCriticalAssertion(result),
  );
  if (unsolved.length > 0) {
    throw new FindingError(`${unsolved.length.toString()} of ${results.length.toString()} run(s) did not solve the case.`);
  }
}

function report(results: readonly RunResult[], json: boolean, io: CommandIo): void {
  if (json) {
    io.stdout(`${JSON.stringify({
      runs: results.map((result) => ({
        runId: result.runId,
        status: result.status,
        failedStep: result.failedStep,
        failureMessage: result.failureMessage,
        failedCriticalAssertions: result.assertions
          .filter((assertion) => assertion.critical && assertion.outcome !== "passed")
          .map((assertion) => assertion.assertionId),
        changedPaths: result.changes.added.length + result.changes.modified.length + result.changes.removed.length,
        costs: result.costs,
      })),
    }, null, 2)}\n`);
    return;
  }

  for (const result of results) {
    const passed = result.assertions.filter((assertion) => assertion.outcome === "passed").length;
    io.stdout(
      `${result.runId}  ${result.status}  assertions=${passed.toString()}/${result.assertions.length.toString()}  wallClockMs=${result.costs.wallClockMs.toString()}\n`,
    );
    if (result.failedStep !== null) {
      io.stderr(`${result.runId}: failed at ${result.failedStep}: ${result.failureMessage}\n`);
    }
  }
}

function parseRepetitions(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new InvocationError(`--runs must be a positive integer: ${value}`);
  }
  const repetitions = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(repetitions) || repetitions > 1_000) {
    throw new InvocationError(`--runs must be between 1 and 1000: ${value}`);
  }
  return repetitions;
}
```

- [ ] **Step 4: Register the command**

In `src/cli/create-program.ts`, remove `"run"` from `unavailableCommands` — the list becomes `["compare", "report"]` — and add:

```ts
  program
    .command("run")
    .description("Execute one or more benchmark runs for a case and variant")
    .requiredOption("--case <id>", "case identifier")
    .requiredOption("--variant <id>", "variant identifier")
    .option("--project <path>", "SkillBench project root", ".")
    .option("--runs <count>", "number of repetitions", "1")
    .option("--runtime <id>", "runtime adapter", "fake")
    .option("--model <id>", "model identifier", "fake-model")
    .option("--reasoning <effort>", "reasoning effort", "medium")
    .option("--sandbox <mode>", "sandbox mode", "workspace-write")
    .option("--keep-workspace", "preserve the workspace for investigation", false)
    .option("--json", "emit machine-readable JSON", false)
    .action(async (options: RunCommandOptions) => runRun(options, io));
```

- [ ] **Step 5: Run the run and CLI tests and verify GREEN**

Run: `npx tsx --test tests/commands/run.test.ts tests/cli/help.test.ts`
Expected: PASS. The help test still lists all six commands.

- [ ] **Step 6: Verify the reserved commands still return 2**

Run:

```bash
npx tsx -e "import('./src/cli.js').then(async ({ main }) => { for (const name of ['compare', 'report']) { console.log(name, await main(['node', 'skillbench', name])); } })"
```

Expected: `compare 2` and `report 2`.

- [ ] **Step 7: Run the full checks**

Run: `npm run check`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/commands/run.ts src/cli/create-program.ts tests/commands/run.test.ts
git commit -m "feat: execute benchmark runs from the command line"
```

---

### Task 11: Catalog Validation of Oracle Coverage

**Files:**
- Modify: `src/catalog/load-catalog.ts`
- Test: `tests/catalog/oracle-coverage.test.ts`

**Interfaces:**
- Consumes: `loadOracleManifest` and `assertOracleCoversAssertions` from `src/oracles/oracle-manifest.js`.
- Produces: two new `CatalogIssueCode` values, `ORACLE_MANIFEST_INVALID` and `ORACLE_ASSERTION_MISMATCH`, reported against the case source. `--public-only` (`requirePrivateOracles: false`) skips both, exactly as it already skips `ORACLE_UNAVAILABLE`.

- [ ] **Step 1: Write the failing coverage tests**

Create `tests/catalog/oracle-coverage.test.ts`:

```ts
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadCatalog } from "../../src/catalog/load-catalog.js";
import { createTempProject } from "../helpers/temp-project.js";

test("a valid project reports no oracle issues", async () => {
  const project = await createTempProject();

  const catalog = await loadCatalog(project.root);

  assert.deepEqual(catalog.issues, []);
});

test("an oracle that misses a declared assertion is reported", async () => {
  const project = await createTempProject();
  await writeFile(
    project.oracleManifestPath,
    `${JSON.stringify({ schemaVersion: 1, caseId: "F01", checks: [{ assertionId: "assert-9", command: { executor: "node", args: ["assert-1.js"] }, workingDirectory: "checks", timeoutMs: 1000 }] })}\n`,
  );

  const catalog = await loadCatalog(project.root);

  assert.deepEqual(
    catalog.issues.map((issue) => issue.code),
    ["ORACLE_ASSERTION_MISMATCH"],
  );
});

test("an unparseable oracle manifest is reported", async () => {
  const project = await createTempProject();
  await writeFile(project.oracleManifestPath, "{ not json\n");

  const catalog = await loadCatalog(project.root);

  assert.deepEqual(
    catalog.issues.map((issue) => issue.code),
    ["ORACLE_MANIFEST_INVALID"],
  );
});

test("a missing oracle manifest is reported", async () => {
  const project = await createTempProject();
  await rm(project.oracleManifestPath);

  const catalog = await loadCatalog(project.root);

  assert.deepEqual(
    catalog.issues.map((issue) => issue.code),
    ["ORACLE_MANIFEST_INVALID"],
  );
});

test("--public-only skips oracle manifest checks entirely", async () => {
  const project = await createTempProject();
  await writeFile(project.oracleManifestPath, "{ not json\n");

  const catalog = await loadCatalog(project.root, { requirePrivateOracles: false });

  assert.deepEqual(catalog.issues, []);
});
```

- [ ] **Step 2: Run the coverage test and verify RED**

Run: `npx tsx --test tests/catalog/oracle-coverage.test.ts`
Expected: FAIL — the mismatch and invalid-manifest cases report no issues.

- [ ] **Step 3: Implement the catalog checks**

In `src/catalog/load-catalog.ts`:

1. Add `"ORACLE_ASSERTION_MISMATCH"` and `"ORACLE_MANIFEST_INVALID"` to `CatalogIssueCode`.
2. Import `assertOracleCoversAssertions` and `loadOracleManifest` from `../oracles/oracle-manifest.js`.
3. Pass the `ManifestValidator` instance into `validateCase` — it is already created in `loadCatalog`; add it as a parameter.
4. Inside the `if (requirePrivateOracle)` block, after `oracleHash` is computed, add:

```ts
      try {
        const oracleManifest = await loadOracleManifest(oraclePath, validator);
        assertOracleCoversAssertions(oracleManifest, manifest.assertions);
      } catch (error: unknown) {
        addIssue(
          issues,
          source,
          /assertion/u.test(errorMessage(error)) ? "ORACLE_ASSERTION_MISMATCH" : "ORACLE_MANIFEST_INVALID",
          errorMessage(error).replaceAll("\n", "; "),
        );
      }
```

Place it inside the `else` branch that already computes `oracleHash`, so an empty or unavailable oracle still reports only its existing issue.

- [ ] **Step 4: Run the coverage test and verify GREEN**

Run: `npx tsx --test tests/catalog/oracle-coverage.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full checks**

Run: `npm run check`
Expected: all pass, including the existing validate command tests.

- [ ] **Step 6: Commit**

```bash
git add src/catalog/load-catalog.ts tests/catalog/oracle-coverage.test.ts
git commit -m "feat: validate oracle coverage of declared assertions"
```

---

### Task 12: Delivery Documentation and Regression Gate

**Files:**
- Modify: `AGENTS.md`, `README.md`

- [ ] **Step 1: Verify the real CLI behavior before writing about it**

Run:

```bash
npm run build
node dist/src/cli.js --help
node dist/src/cli.js compare; echo "compare exit=$?"
node dist/src/cli.js report; echo "report exit=$?"
```

Expected: help lists all six commands; `compare` and `report` both exit `2`. Write documentation only about behavior these commands actually show.

- [ ] **Step 2: Update the English README section**

In the English half of `README.md`:

- replace the sentence stating that the tool only validates with one describing three working commands: `validate` checks the catalog, `list` shows cases and variants, `dry-run` freezes and prints a plan, and `run` executes one or more runs against the deterministic fake runtime;
- state plainly that no live coding agent is connected yet and that comparisons, metrics, and reports are not implemented;
- document the run directory layout `runs/<case>/<variant>/<run-id>/` with its four files;
- document the three run statuses and what each means for later metrics;
- document the private oracle manifest `.private/oracles/<case-id>/oracle.json`, that its schema is published as `schemas/oracle.schema.json`, and that each check maps one assertion to one typed command;
- add the command examples:

```sh
node dist/src/cli.js list --project .
node dist/src/cli.js dry-run --project . --case <case-id> --variant <variant-id>
node dist/src/cli.js run --project . --case <case-id> --variant <variant-id> --runs 2
```

- [ ] **Step 3: Mirror the changes in the Russian section**

Apply the same edits to the Russian half, keeping it a complete translation of the English half. Do not add or drop content in either language.

- [ ] **Step 4: Update persistent project memory**

In `AGENTS.md`:

- change **Current State** to say Stage 1, Stage 2A, and Stage 2B are complete; `validate`, `list`, `dry-run`, and `run` are implemented; `compare` and `report` remain reserved and return `2`; `run` executes against the deterministic fake runtime only; the next stage is Stage 3, the Codex adapter and multi-step prompt execution;
- add to **Architecture**: `src/runs/` owns snapshots, frozen inputs, results, and the pipeline runner; `src/oracles/` additionally owns the oracle manifest and typed-command execution; `src/runtime/select-adapter.ts` maps a runtime identifier to an adapter;
- add to **Known Limitations**: runs execute sequentially, and the fake runtime produces a scripted transcript that does not modify the workspace, so end-to-end runs exercise the pipeline rather than agent behavior;
- add to the **Development Record**: Stage 2B used the isolated worktree named in this stage's worktree setup.

- [ ] **Step 5: Run the complete verification gate**

Run:

```bash
npm run check
npm run build
node dist/src/cli.js validate --project . --public-only
```

Expected: checks pass, build succeeds, and validation reports `Validated 0 cases and 0 variants.` with exit code `0`.

- [ ] **Step 6: Inspect the final diff for scope and private data**

Run:

```bash
git status --porcelain -uall
git diff main --stat
```

Expected: no files under `.private/`, `runs/`, `dist/`, `node_modules/`, or `.worktrees/` are staged or untracked-and-intended. Only the files named in this plan changed.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: record stage 2b delivery"
```

---

## Verification Summary

After Task 12 the repository must satisfy all of the following:

- `npm run check` passes with no lint, type, or test failures.
- `npm run build` produces `dist/src/cli.js`.
- `node dist/src/cli.js validate --project . --public-only` exits `0`.
- `node dist/src/cli.js compare` and `node dist/src/cli.js report` exit `2`.
- No public case, fixture, variant, or private oracle content was added to the repository.
- `AGENTS.md` and `README.md` describe only behavior the CLI actually shows.
