# SkillBench Stage 5A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the oracle toolkit and the first complete benchmark case, so that `run --case B01 --variant control` produces a graded result backed by a proven oracle.

**Architecture:** Two repositories. The public SkillBench repository gains a case manifest, a control variant, and `src/tools/prove-oracles.ts`, which proves oracle assertions by mounting and running them through SkillBench's own code. The private repository `shepaland/SkillBench-private`, cloned into `.private/`, holds oracle sources, a composition script that copies shared helpers into every composed oracle, and paired proof patches for each assertion.

**Tech Stack:** Node.js 22+, TypeScript with native ESM, `node --test`, `tsx`, no new dependencies in either repository.

**Spec:** `docs/superpowers/specs/2026-08-31-skillbench-stage-5-cases-and-oracles-design.md`

## Global Constraints

- Public prompts, manifests, code comments, CLI messages, and documentation use concise international English. `README.md` keeps its English section first and a complete Russian translation second.
- Case prompts never suggest that a defect was planted or that a measurement is running.
- Never hand-edit a composed fixture under `fixtures/queuedesk-*/`; regenerate with `npm run fixtures:build`.
- Never hand-edit a composed oracle under `.private/oracles/`; regenerate with `npm run build` in `.private`.
- Never write a public QueueDesk test that observes cross-tenant `claim` or `complete`, an interrupted write, a timestamp value, `orderJobs` directly, or job ordering through `list --json`.
- An oracle check never writes into the agent's workspace, never reads outside its grading directory and that workspace, and never uses the network.
- `.private/` stays ignored by the public repository's Git. Nothing from it is ever committed to `shepaland/SkillBench`.
- Public repository commits end with the line `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Case IDs, assertion IDs, and rule IDs match `^[A-Za-z][A-Za-z0-9_-]{1,63}$`.
- Content hashes are `sha256:` followed by 64 lowercase hex characters.
- Case category vocabulary is closed: `bug-fix`, `bounded-feature`, `ambiguous-feature`, `architectural-feature`, `compatibility`, `refactoring`, `security`, `scope-control`, `process`.
- Default case limits: `wallClockMs` 900000, `outputBytes` 4000000, `tokenLimit` 400000.

---

## Preparation (before Task 1)

- [ ] **Create the isolated worktree** using the `superpowers:using-git-worktrees` skill: branch `stage5a-oracle-toolkit`, worktree `.worktrees/stage5a-oracle-toolkit`.

- [ ] **Commit the approved spec on the branch**

```bash
git add -f docs/superpowers/specs/2026-08-31-skillbench-stage-5-cases-and-oracles-design.md
git add -f docs/superpowers/plans/2026-08-31-skillbench-stage-5a-oracle-toolkit-and-first-case.md
git commit -m "docs: approve the stage 5 cases and oracles design"
```

- [ ] **Clone the private repository into the worktree**

```bash
git clone git@github.com:shepaland/SkillBench-private.git .private
```

`.private/` is ignored by the public repository, so it never appears in `git status`. Verify with `git check-ignore -v .private` and `git status --short`, which must stay clean.

---

## Task 1: Private repository skeleton and oracle composition

**Repository:** `.private` (`shepaland/SkillBench-private`). Commits here are separate from the public repository and carry no `Co-Authored-By` requirement.

**Files:**
- Create: `.private/package.json`
- Create: `.private/scripts/build-oracles.mjs`
- Create: `.private/sources/_shared/queuedesk.mjs`
- Create: `.private/sources/B01/oracle.json` (placeholder with one check, replaced in Task 5)
- Create: `.private/sources/B01/checks/scope-untouched-files.mjs` (placeholder, replaced in Task 5)
- Test: `.private/tests/build-oracles.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run build` composes `.private/oracles/<case-id>/` from `.private/sources/`; `npm run check` verifies the composed tree and runs the tests. Composed oracles contain the case's own files plus `shared/` copied from `sources/_shared/`.

- [ ] **Step 1: Write `.private/package.json`**

```json
{
  "name": "skillbench-private",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "node scripts/build-oracles.mjs",
    "test": "node --test 'tests/**/*.test.mjs'",
    "check": "node scripts/build-oracles.mjs --check && npm test"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `.private/tests/build-oracles.test.mjs`. It builds a throwaway private-repository layout in a temporary directory, runs the script against it with `--root`, and checks composition and drift detection.

```javascript
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const scriptPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts/build-oracles.mjs");

async function layout() {
  const root = await mkdtemp(join(tmpdir(), "private-build-"));
  await mkdir(join(root, "sources/_shared"), { recursive: true });
  await mkdir(join(root, "sources/X01/checks"), { recursive: true });
  await writeFile(join(root, "sources/_shared/helper.mjs"), "export const helper = 1;\n");
  await writeFile(join(root, "sources/X01/oracle.json"), '{"schemaVersion":1,"caseId":"X01","checks":[]}\n');
  await writeFile(join(root, "sources/X01/checks/a.mjs"), "process.exit(0);\n");
  return root;
}

async function build(root, ...args) {
  return run(process.execPath, [scriptPath, "--root", root, ...args]);
}

test("build copies shared helpers into every composed oracle", async () => {
  const root = await layout();
  await build(root);
  assert.equal(await readFile(join(root, "oracles/X01/shared/helper.mjs"), "utf8"), "export const helper = 1;\n");
  assert.equal(await readFile(join(root, "oracles/X01/checks/a.mjs"), "utf8"), "process.exit(0);\n");
});

test("check accepts a freshly built tree", async () => {
  const root = await layout();
  await build(root);
  const { stdout } = await build(root, "--check");
  assert.match(stdout, /verified 1 composed oracle/);
});

test("check rejects a hand-edited composed oracle", async () => {
  const root = await layout();
  await build(root);
  await writeFile(join(root, "oracles/X01/checks/a.mjs"), "process.exit(1);\n");
  await assert.rejects(build(root, "--check"), (error) => {
    assert.match(String(error.stderr), /checks\/a\.mjs differs/);
    return true;
  });
});

test("check rejects a composed oracle that no source produces", async () => {
  const root = await layout();
  await build(root);
  await mkdir(join(root, "oracles/X99"), { recursive: true });
  await writeFile(join(root, "oracles/X99/oracle.json"), "{}\n");
  await assert.rejects(build(root, "--check"), (error) => {
    assert.match(String(error.stderr), /X99 has no source/);
    return true;
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd .private && npm test`
Expected: FAIL, because `scripts/build-oracles.mjs` does not exist.

- [ ] **Step 4: Write `.private/scripts/build-oracles.mjs`**

Mirror `scripts/build-fixtures.mjs` in the public repository: same option parsing (`--root`, `--check`), the same `listFiles`, `assertNoSymbolicLinks`, `isDirectory` helpers, and the same "run the build command" wording in error messages. The differences are:

- sources are the directories under `sources/` other than `_shared`;
- composition is: create staging, copy `sources/<case>/` into it, then copy `sources/_shared/` into `<staging>/shared/`;
- `--check` also fails when a directory under `oracles/` has no matching source, with the message `oracles/<name> has no source; remove it or add sources/<name>`;
- the success line is `verified <n> composed oracles`;
- failure messages end with `run npm run build`.

Composition must reject a symbolic link anywhere in `sources/`, and `--check` must compare content and file mode exactly, as the fixture script does.

- [ ] **Step 5: Add placeholder B01 sources so the script has real input**

`.private/sources/B01/oracle.json`:

```json
{
  "schemaVersion": 1,
  "caseId": "B01",
  "checks": [
    {
      "assertionId": "scope-untouched-files",
      "command": { "executor": "node", "args": ["checks/scope-untouched-files.mjs"] },
      "workingDirectory": ".",
      "timeoutMs": 120000
    }
  ]
}
```

`.private/sources/B01/checks/scope-untouched-files.mjs`:

```javascript
// Replaced in Task 5. Fails loudly so an unfinished oracle cannot look green.
process.stderr.write("scope-untouched-files is not implemented yet\n");
process.exit(1);
```

- [ ] **Step 6: Write `.private/sources/_shared/queuedesk.mjs`**

The helper every check uses. It never writes into the workspace.

```javascript
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function workspacePath() {
  const workspace = process.env.SKILLBENCH_WORKSPACE;
  if (workspace === undefined || workspace === "") {
    throw new Error("SKILLBENCH_WORKSPACE is not set");
  }
  return workspace;
}

export function oraclePath() {
  const oracle = process.env.SKILLBENCH_ORACLE;
  if (oracle === undefined || oracle === "") {
    throw new Error("SKILLBENCH_ORACLE is not set");
  }
  return oracle;
}

/** Runs `body` with a private scratch directory that is always removed. */
export async function withScratch(body) {
  const scratch = await mkdtemp(join(tmpdir(), "queuedesk-check-"));
  try {
    return await body(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Copies the agent's project into `scratch/project` so a check never writes into the workspace. */
export async function copyProject(scratch) {
  const project = join(scratch, "project");
  await cp(workspacePath(), project, { recursive: true, dereference: false, verbatimSymlinks: true });
  return project;
}

export function sampleState(jobs, nextId = 9) {
  return {
    version: 1,
    tenants: {
      acme: { token: "acme-token", role: "admin" },
      globex: { token: "globex-token", role: "worker" },
    },
    jobs,
    nextId,
  };
}

export function job(overrides) {
  return {
    id: "job-0001",
    tenant: "acme",
    title: "Ship the release notes",
    priority: "normal",
    state: "queued",
    createdAt: "2026-01-01T09:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
    note: null,
    ...overrides,
  };
}

export async function writeState(scratch, state) {
  const dataPath = join(scratch, "queuedesk.json");
  await writeFile(dataPath, `${JSON.stringify(state, null, 2)}\n`);
  return dataPath;
}

export async function readState(dataPath) {
  return JSON.parse(await readFile(dataPath, "utf8"));
}

/** Runs the agent's CLI as a child process and never throws on a non-zero exit. */
export async function queuedesk(project, args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [join(project, "src/cli.js"), ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? null, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

export function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
```

- [ ] **Step 7: Run the test and the build**

```bash
cd .private && npm test && npm run build && npm run check
```

Expected: tests pass, `oracles/B01/` appears with `shared/queuedesk.mjs`, `npm run check` prints `verified 1 composed oracles`.

- [ ] **Step 8: Commit in the private repository**

```bash
cd .private
git add package.json scripts sources tests oracles
git commit -m "feat: compose oracles from shared and per-case sources"
```

---

## Task 2: Control variant and a catalog test over the real repository

**Repository:** public.

**Files:**
- Create: `variants/control/variant.json`
- Test: `tests/catalog/repository-catalog.test.ts`

**Interfaces:**
- Consumes: `loadCatalog(root, { requirePrivateOracles })` from `src/catalog/load-catalog.ts`, returning `{ cases, variants, issues }`.
- Produces: variant ID `control`, compatible with runtimes `codex` and `fake`, claiming every category in the closed vocabulary.

- [ ] **Step 1: Write the failing test**

Create `tests/catalog/repository-catalog.test.ts`. It loads this repository's own catalog with private oracles not required, so it passes in CI where `.private/` is absent.

```typescript
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadCatalog } from "../../src/catalog/load-catalog.js";

const repositoryRoot = join(import.meta.dirname, "../..");

test("the repository catalog loads without issues", async () => {
  const catalog = await loadCatalog(repositoryRoot, { requirePrivateOracles: false });
  assert.deepEqual(catalog.issues, []);
});

test("the repository ships the control variant", async () => {
  const catalog = await loadCatalog(repositoryRoot, { requirePrivateOracles: false });
  const control = catalog.variants.find((variant) => variant.manifest.id === "control");
  assert.ok(control, "control variant is missing");
  assert.deepEqual(control.manifest.installs, []);
  assert.ok(control.manifest.compatibleRuntimes.includes("codex"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern "control variant"`
Expected: FAIL with "control variant is missing".

- [ ] **Step 3: Write `variants/control/variant.json`**

The content hash of an empty install list is `hashValue([])`, already computed for this repository.

```json
{
  "schemaVersion": 1,
  "id": "control",
  "displayName": "Control",
  "compatibleRuntimes": ["codex", "fake"],
  "installs": [],
  "claimedCategories": [
    "ambiguous-feature",
    "architectural-feature",
    "bounded-feature",
    "bug-fix",
    "compatibility",
    "process",
    "refactoring",
    "scope-control",
    "security"
  ],
  "environment": {},
  "contentHash": "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "repository"`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add variants/control/variant.json tests/catalog/repository-catalog.test.ts
git commit -m "feat: add the control variant and a catalog test over the repository"
```

---

## Task 3: Case B01 manifest

**Repository:** public.

**Files:**
- Create: `cases/B01/case.json`
- Modify: `tests/catalog/repository-catalog.test.ts`

**Interfaces:**
- Consumes: the composed fixture `fixtures/queuedesk-claim-order`, content hash `sha256:889e14bf26e6cd2a819ec5824ca6a2d5135f960fab784c50c2f941dd8c3eac3a`.
- Produces: case ID `B01` with assertion IDs `functional-claim-priority`, `functional-json-order`, `regression-public-suite`, `functional-renderer-neutral`, `scope-untouched-files`, all oracle-graded (no `transcriptRuleId`).

- [ ] **Step 1: Write the failing test addition**

Append to `tests/catalog/repository-catalog.test.ts`:

```typescript
test("case B01 declares five oracle-graded assertions", async () => {
  const catalog = await loadCatalog(repositoryRoot, { requirePrivateOracles: false });
  const found = catalog.cases.find((entry) => entry.manifest.id === "B01");
  assert.ok(found, "case B01 is missing");
  assert.deepEqual(
    found.manifest.assertions.map((assertion) => assertion.id).toSorted(),
    [
      "functional-claim-priority",
      "functional-json-order",
      "functional-renderer-neutral",
      "regression-public-suite",
      "scope-untouched-files",
    ],
  );
  assert.ok(found.manifest.assertions.every((assertion) => assertion.transcriptRuleId === undefined));
  assert.equal(found.manifest.categories.length, 1);
  assert.equal(found.manifest.categories[0], "bug-fix");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern "case B01"`
Expected: FAIL with "case B01 is missing".

- [ ] **Step 3: Write `cases/B01/case.json`**

```json
{
  "schemaVersion": 1,
  "id": "B01",
  "title": "Claim hands out the wrong job",
  "categories": ["bug-fix"],
  "fixture": {
    "path": "fixtures/queuedesk-claim-order",
    "contentHash": "sha256:889e14bf26e6cd2a819ec5824ca6a2d5135f960fab784c50c2f941dd8c3eac3a"
  },
  "promptSteps": [
    {
      "id": "report",
      "prompt": "Workers are getting the wrong job out of QueueDesk. `queuedesk claim` is supposed to hand back the highest-priority queued job the caller can see, and instead it hands back the oldest one. One test in the public suite already fails because of this. Please fix the cause rather than the failing test. The design decisions recorded in DECISIONS.md still stand, so keep the code consistent with them, and leave the rest of the suite green. Run `npm test` in the project root to check your work."
    }
  ],
  "publicVerification": [{ "executor": "npm", "args": ["test"] }],
  "limits": { "wallClockMs": 900000, "outputBytes": 4000000, "tokenLimit": 400000 },
  "allowedChangePaths": ["src", "tests"],
  "forbiddenChangePaths": ["DECISIONS.md", "README.md", "examples", "package.json"],
  "assertions": [
    { "id": "functional-claim-priority", "dimension": "functional", "critical": true },
    { "id": "functional-json-order", "dimension": "functional", "critical": true },
    { "id": "regression-public-suite", "dimension": "regression", "critical": true },
    { "id": "functional-renderer-neutral", "dimension": "functional", "critical": false },
    { "id": "scope-untouched-files", "dimension": "scope", "critical": true }
  ]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "repository"`
Expected: PASS. If the fixture hash is reported as mismatched, recompute it and correct the manifest:

```bash
node --import tsx -e "import { hashTree } from './src/integrity/content-hash.ts'; console.log(await hashTree('fixtures/queuedesk-claim-order'));"
```

- [ ] **Step 5: Commit**

```bash
git add cases/B01/case.json tests/catalog/repository-catalog.test.ts
git commit -m "feat: add the B01 claim ordering case"
```

---

## Task 4: The oracle prover and its own proof

**Repository:** public.

**Files:**
- Create: `src/tools/prove-oracles.ts`
- Create: `tests/helpers/temp-proof-project.ts`
- Test: `tests/tools/prove-oracles.test.ts`
- Modify: `package.json` (add the `oracles:proof` script)

**Interfaces:**
- Consumes: `loadCatalog`, `ProjectPaths.create`, `ManifestValidator.create`, `OracleLifecycle.create`, `loadOracleManifest`, `runOracle`, `hashTree`, `hashFile`.
- Produces: `proveOracles(input: ProveOraclesInput): Promise<ProofReport>` where

```typescript
export interface ProveOraclesInput {
  readonly root: string;
  readonly caseIds?: readonly string[];
}

export interface ProofFailure {
  readonly caseId: string;
  readonly assertionId: string;
  readonly patch: "pass" | "fail";
  readonly message: string;
}

export interface ProofReport {
  readonly provenAssertions: number;
  readonly failures: readonly ProofFailure[];
}
```

The module also exports a `main()` that resolves the repository root, prints a line per proven assertion, prints each failure, and sets `process.exitCode` to `1` when any failure is present or `2` when `.private/oracles` is absent.

- [ ] **Step 1: Write the proof-project helper**

Create `tests/helpers/temp-proof-project.ts`. It builds a minimal project with one fixture, one case with two assertions, an oracle with an honest check and a check that always exits `0`, and the four patch directories.

```typescript
import { mkdir, mkdtemp, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashTree } from "../../src/integrity/content-hash.js";

export interface TempProofProject {
  readonly root: string;
  readonly caseId: string;
}

const honestCheck = `import { readFile } from "node:fs/promises";
import { join } from "node:path";
const workspace = process.env.SKILLBENCH_WORKSPACE;
const text = await readFile(join(workspace, "value.txt"), "utf8");
process.exit(text.trim() === "correct" ? 0 : 1);
`;

const alwaysGreenCheck = `process.exit(0);\n`;

export async function createTempProofProject(): Promise<TempProofProject> {
  const root = await mkdtemp(join(tmpdir(), "skillbench-proof-"));
  const fixture = join(root, "fixtures/tiny");
  const oracle = join(root, ".private/oracles/T01/checks");
  await mkdir(fixture, { recursive: true });
  await mkdir(oracle, { recursive: true });
  await mkdir(join(root, "cases/T01"), { recursive: true });
  await mkdir(join(root, "schemas"), { recursive: true });

  const published = join(import.meta.dirname, "../../schemas");
  for (const name of ["case.schema.json", "variant.schema.json", "oracle.schema.json"]) {
    await copyFile(join(published, name), join(root, "schemas", name));
  }

  await writeFile(join(fixture, "value.txt"), "wrong\n");
  await writeFile(join(oracle, "honest.mjs"), honestCheck);
  await writeFile(join(oracle, "always-green.mjs"), alwaysGreenCheck);
  await writeFile(
    join(root, ".private/oracles/T01/oracle.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      caseId: "T01",
      checks: [
        { assertionId: "honest", command: { executor: "node", args: ["checks/honest.mjs"] }, workingDirectory: ".", timeoutMs: 30_000 },
        { assertionId: "always-green", command: { executor: "node", args: ["checks/always-green.mjs"] }, workingDirectory: ".", timeoutMs: 30_000 },
      ],
    }, null, 2)}\n`,
  );

  await writeFile(
    join(root, "cases/T01/case.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "T01",
      title: "Tiny proof case",
      categories: ["bug-fix"],
      fixture: { path: "fixtures/tiny", contentHash: await hashTree(fixture) },
      promptSteps: [{ id: "only", prompt: "Set the value to correct." }],
      publicVerification: [{ executor: "npm", args: ["test"] }],
      limits: { wallClockMs: 900_000, outputBytes: 4_000_000, tokenLimit: 400_000 },
      allowedChangePaths: ["value.txt"],
      forbiddenChangePaths: ["README.md"],
      assertions: [
        { id: "honest", dimension: "functional", critical: true },
        { id: "always-green", dimension: "functional", critical: false },
      ],
    }, null, 2)}\n`,
  );

  for (const assertionId of ["honest", "always-green"]) {
    for (const [patch, value] of [["pass", "correct\n"], ["fail", "wrong\n"]] as const) {
      const directory = join(root, ".private/proofs/T01", assertionId, patch);
      await mkdir(join(directory, "files"), { recursive: true });
      await writeFile(join(directory, "overlay.json"), `${JSON.stringify({ description: `${assertionId} ${patch}`, removals: [] }, null, 2)}\n`);
      await writeFile(join(directory, "files/value.txt"), value);
    }
  }

  return { root, caseId: "T01" };
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/tools/prove-oracles.test.ts`.

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTempProofProject } from "../helpers/temp-proof-project.js";
import { proveOracles } from "../../src/tools/prove-oracles.js";

test("an honest assertion is proven and an always-green one is rejected", async () => {
  const project = await createTempProofProject();
  const report = await proveOracles({ root: project.root });

  assert.equal(report.provenAssertions, 1);
  assert.equal(report.failures.length, 1);
  const [failure] = report.failures;
  assert.equal(failure?.caseId, "T01");
  assert.equal(failure?.assertionId, "always-green");
  assert.equal(failure?.patch, "fail");
  assert.match(failure?.message ?? "", /expected the assertion to fail/);
});

test("a missing patch is reported rather than skipped", async () => {
  const project = await createTempProofProject();
  await rm(join(project.root, ".private/proofs/T01/honest/fail"), { recursive: true });
  const report = await proveOracles({ root: project.root });
  assert.ok(report.failures.some((failure) => /has no fail patch/.test(failure.message)));
});

test("a stale baseline is reported", async () => {
  const project = await createTempProofProject();
  await writeFile(join(project.root, ".private/oracles/T01/baseline.json"), '{"files":{"value.txt":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}}\n');
  const report = await proveOracles({ root: project.root });
  assert.ok(report.failures.some((failure) => /baseline/.test(failure.message)));
});
```

Add the imports the last two tests need at the top of the file: `import { rm, writeFile } from "node:fs/promises";` and `import { join } from "node:path";`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern "always-green"`
Expected: FAIL, because `src/tools/prove-oracles.ts` does not exist.

- [ ] **Step 4: Write `src/tools/prove-oracles.ts`**

Structure, in order:

1. `proveOracles` loads the catalog with `loadCatalog(root, { requirePrivateOracles: false })` and stops with a single failure if `.private/oracles` is missing.
2. For each selected case: read `.private/oracles/<id>/baseline.json` when present and compare each recorded hash against `hashFile` of the fixture file at the same relative path; a missing, extra, or differing entry is a failure whose message contains the word `baseline`. Also compare every file the oracle carries under `tests/` against the baseline entry for the same path.
3. Collect the oracle-graded assertions — those without a `transcriptRuleId`. For each, require exactly one `pass` and one `fail` patch directory under `.private/proofs/<id>/<assertion-id>/`; report `case <id> assertion <assertion-id> has no fail patch` when one is absent, and report a patch directory naming an unknown assertion.
4. For each patch, in order: `composePatched(fixturePath, patchDirectory, target)` copies the fixture, applies each `include` from `.private/proofs/<id>/_patches/<name>/` in listed order, applies the patch's own `removals` and `files/`, and rejects any path that escapes the target.
5. Mount and run through the real code:

```typescript
const lifecycle = await OracleLifecycle.create({ paths, caseId, workspacePath });
lifecycle.markAgentClosed();
const mounted = await lifecycle.mountOracle();
try {
  const manifest = await loadOracleManifest(mounted.gradingPath, validator);
  const [result] = await runOracle({
    manifest,
    assertions: [assertion],
    gradingPath: mounted.gradingPath,
    workspacePath,
  });
  ...
} finally {
  await lifecycle.cleanup();
}
```

`runOracle` calls `assertOracleCoversAssertions`, which rejects an assertion list narrower than the manifest, so pass the full assertion list and select the result by ID rather than passing one assertion.

6. Judge the outcome: `pass` expects `passed`, `fail` expects `failed`. Any other outcome produces a failure whose message is `expected the assertion to pass but it <outcome>` or `expected the assertion to fail but it <outcome>`. An `error` outcome includes the result's `detail`.
7. Always remove the temporary workspace, including on failure.
8. `main()` resolves the repository root from `import.meta.dirname`, accepts optional case IDs as positional arguments, prints `proved <case> <assertion>` per success and `FAILED <case> <assertion> (<patch>): <message>` per failure, prints a final count, and sets `process.exitCode`.

- [ ] **Step 5: Add the npm script**

In `package.json`, inside `scripts`:

```json
"oracles:proof": "node --import tsx src/tools/prove-oracles.ts"
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern "prove"`
Expected: PASS, all three tests.

- [ ] **Step 7: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tools/prove-oracles.ts tests/tools/prove-oracles.test.ts tests/helpers/temp-proof-project.ts package.json
git commit -m "feat: prove oracle assertions can both pass and fail"
```

---

## Task 5: Baseline generation and the scope assertion

**Repository:** `.private`, except the verification commands.

**Files:**
- Create: `.private/scripts/build-baseline.mjs`
- Create: `.private/sources/B01/baseline.json` (generated)
- Modify: `.private/sources/B01/checks/scope-untouched-files.mjs`
- Create: `.private/proofs/B01/_patches/reference-fix/{overlay.json,files/src/core/jobs.js,files/src/format/output.js}`
- Create: `.private/proofs/B01/scope-untouched-files/{pass,fail}/overlay.json` and their `files/`

**Interfaces:**
- Consumes: `shared/queuedesk.mjs` from Task 1.
- Produces: `baseline.json` with the shape `{ "fixture": "fixtures/queuedesk-claim-order", "files": { "<relative path>": "sha256:<hex>" } }`, which `prove-oracles.ts` reads.

- [ ] **Step 1: Write `.private/scripts/build-baseline.mjs`**

It takes a case ID and a fixture path relative to the repository root above `.private`, walks the fixture, rejects symbolic links, and writes `sources/<case-id>/baseline.json` with sorted keys and a trailing newline. Hashing matches `src/integrity/content-hash.ts` per file: `sha256` of the file bytes, printed as `sha256:<hex>`.

- [ ] **Step 2: Generate the baseline**

```bash
cd .private && node scripts/build-baseline.mjs B01 ../fixtures/queuedesk-claim-order
```

Expected: `sources/B01/baseline.json` exists and lists 22 files, including `tests/cli.test.js` and `DECISIONS.md`.

- [ ] **Step 3: Write the reference-fix shared patch**

`.private/proofs/B01/_patches/reference-fix/overlay.json`:

```json
{
  "description": "Ordering moved back into the job rules, matching the base fixture.",
  "removals": []
}
```

Its `files/src/core/jobs.js` and `files/src/format/output.js` are byte-for-byte copies of those two files from `fixtures/queuedesk/`, which is the correct version:

```bash
cd .private && mkdir -p proofs/B01/_patches/reference-fix/files/src/core proofs/B01/_patches/reference-fix/files/src/format
cp ../fixtures/queuedesk/src/core/jobs.js proofs/B01/_patches/reference-fix/files/src/core/jobs.js
cp ../fixtures/queuedesk/src/format/output.js proofs/B01/_patches/reference-fix/files/src/format/output.js
```

- [ ] **Step 4: Write the scope check**

`.private/sources/B01/checks/scope-untouched-files.mjs`:

```javascript
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readdir, lstat } from "node:fs/promises";
import { fail, oraclePath, workspacePath } from "../shared/queuedesk.mjs";

const ALLOWED_PREFIXES = ["src/", "tests/"];

async function listFiles(root, prefix = "", collected = []) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const status = await lstat(join(root, relativePath));
    if (status.isSymbolicLink()) {
      collected.push({ path: relativePath, hash: "symlink" });
      continue;
    }
    if (status.isDirectory()) {
      await listFiles(root, relativePath, collected);
      continue;
    }
    const bytes = await readFile(join(root, relativePath));
    collected.push({ path: relativePath, hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
  }
  return collected;
}

function allowed(path) {
  return ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

const baseline = JSON.parse(await readFile(join(oraclePath(), "baseline.json"), "utf8"));
const actual = await listFiles(workspacePath());
const seen = new Set();
const offenders = [];

for (const entry of actual) {
  seen.add(entry.path);
  if (allowed(entry.path)) continue;
  const expected = baseline.files[entry.path];
  if (expected === undefined) offenders.push(`added ${entry.path}`);
  else if (expected !== entry.hash) offenders.push(`modified ${entry.path}`);
}
for (const path of Object.keys(baseline.files)) {
  if (!allowed(path) && !seen.has(path)) offenders.push(`removed ${path}`);
}

if (offenders.length > 0) {
  fail(`changes outside src/ and tests/: ${offenders.sort().join(", ")}`);
}
```

- [ ] **Step 5: Write the two scope patches**

`proofs/B01/scope-untouched-files/pass/overlay.json`:

```json
{
  "description": "Only source files change, which is inside the allowed paths.",
  "include": ["reference-fix"],
  "removals": []
}
```

`proofs/B01/scope-untouched-files/fail/overlay.json`:

```json
{
  "description": "A correct fix that also rewrites a forbidden document.",
  "include": ["reference-fix"],
  "removals": []
}
```

The failing patch adds `files/DECISIONS.md`: copy `fixtures/queuedesk/DECISIONS.md` and append one line, for example `\nOrdering was moved to the renderer for speed.\n`.

- [ ] **Step 6: Build and prove**

```bash
cd .private && npm run build && cd .. && npm run oracles:proof
```

Expected: `proved B01 scope-untouched-files`, and failures reported for the four assertions that still have no patches. That is correct at this point; the remaining tasks add them.

- [ ] **Step 7: Commit in the private repository**

```bash
cd .private
git add scripts sources proofs oracles
git commit -m "feat: prove the B01 scope assertion against a generated baseline"
```

---

## Task 6: The two behavioral functional assertions

**Repository:** `.private`.

**Files:**
- Create: `.private/sources/B01/checks/functional-claim-priority.mjs`
- Create: `.private/sources/B01/checks/functional-json-order.mjs`
- Modify: `.private/sources/B01/oracle.json`
- Create: `.private/proofs/B01/functional-claim-priority/{pass,fail}/overlay.json`
- Create: `.private/proofs/B01/functional-json-order/{pass,fail}/overlay.json`

**Interfaces:**
- Consumes: `shared/queuedesk.mjs` helpers `withScratch`, `copyProject`, `sampleState`, `job`, `writeState`, `queuedesk`, `fail`.
- Produces: oracle checks for `functional-claim-priority` and `functional-json-order`.

- [ ] **Step 1: Write `functional-claim-priority.mjs`**

```javascript
import { copyProject, fail, job, queuedesk, sampleState, withScratch, writeState } from "../shared/queuedesk.mjs";

await withScratch(async (scratch) => {
  const project = await copyProject(scratch);
  const dataPath = await writeState(scratch, sampleState([
    job({ id: "job-0001", priority: "low", createdAt: "2026-01-01T09:00:00.000Z" }),
    job({ id: "job-0002", priority: "high", createdAt: "2026-01-01T09:05:00.000Z" }),
    job({ id: "job-0003", priority: "normal", createdAt: "2026-01-01T09:10:00.000Z" }),
  ]));

  const result = await queuedesk(project, ["claim", "--tenant", "acme", "--token", "acme-token", "--data", dataPath, "--json"]);
  if (result.code !== 0) {
    fail(`claim exited with ${String(result.code)}: ${result.stderr}`);
  }
  const claimed = JSON.parse(result.stdout);
  if (claimed.id !== "job-0002") {
    fail(`claim returned ${String(claimed.id)}; the highest-priority queued job is job-0002`);
  }
});
```

- [ ] **Step 2: Write `functional-json-order.mjs`**

```javascript
import { copyProject, fail, job, queuedesk, sampleState, withScratch, writeState } from "../shared/queuedesk.mjs";

await withScratch(async (scratch) => {
  const project = await copyProject(scratch);
  const dataPath = await writeState(scratch, sampleState([
    job({ id: "job-0001", priority: "low", createdAt: "2026-01-01T09:00:00.000Z" }),
    job({ id: "job-0002", priority: "high", createdAt: "2026-01-01T09:05:00.000Z" }),
    job({ id: "job-0003", priority: "normal", createdAt: "2026-01-01T09:10:00.000Z" }),
  ]));

  const result = await queuedesk(project, ["list", "--tenant", "acme", "--token", "acme-token", "--data", dataPath, "--json"]);
  if (result.code !== 0) {
    fail(`list --json exited with ${String(result.code)}: ${result.stderr}`);
  }
  const ids = JSON.parse(result.stdout).map((entry) => entry.id);
  const expected = ["job-0002", "job-0003", "job-0001"];
  if (ids.join(",") !== expected.join(",")) {
    fail(`list --json returned ${ids.join(",")}; expected ${expected.join(",")}`);
  }
});
```

- [ ] **Step 3: Register both checks in `sources/B01/oracle.json`**

Add two entries alongside the scope check, each with `workingDirectory` `"."` and `timeoutMs` `120000`.

- [ ] **Step 4: Write the four patches**

Both `pass` patches carry `{"description": "...", "include": ["reference-fix"], "removals": []}` and no files of their own. Both `fail` patches carry `{"description": "The untouched fixture still hands out the oldest job.", "removals": []}` with no includes and no files, which composes the fixture unchanged.

- [ ] **Step 5: Build and prove**

```bash
cd .private && npm run build && cd .. && npm run oracles:proof
```

Expected: `proved B01 functional-claim-priority`, `proved B01 functional-json-order`, `proved B01 scope-untouched-files`; only the two remaining assertions are reported as unproven.

- [ ] **Step 6: Commit in the private repository**

```bash
cd .private
git add sources proofs oracles
git commit -m "feat: prove the B01 claim and listing order assertions"
```

---

## Task 7: The regression assertion

**Repository:** `.private`.

**Files:**
- Create: `.private/sources/B01/tests/` (a copy of the fixture's public suite)
- Create: `.private/sources/B01/checks/regression-public-suite.mjs`
- Modify: `.private/sources/B01/oracle.json`
- Create: `.private/proofs/B01/regression-public-suite/{pass,fail}/…`

**Interfaces:**
- Consumes: `baseline.json` from Task 5, `shared/queuedesk.mjs`.
- Produces: the `regression-public-suite` check, which runs the oracle's own copy of the public suite against the agent's source.

- [ ] **Step 1: Copy the public suite into the oracle sources**

```bash
cd .private && mkdir -p sources/B01/tests
cp -R ../fixtures/queuedesk-claim-order/tests/. sources/B01/tests/
```

- [ ] **Step 2: Write `regression-public-suite.mjs`**

```javascript
import { execFile } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { copyProject, fail, oraclePath, withScratch } from "../shared/queuedesk.mjs";

const exec = promisify(execFile);

await withScratch(async (scratch) => {
  const project = await copyProject(scratch);
  // The agent may edit tests/. Grade against the suite the oracle carries.
  await rm(join(project, "tests"), { recursive: true, force: true });
  await cp(join(oraclePath(), "tests"), join(project, "tests"), { recursive: true, dereference: false, verbatimSymlinks: true });

  try {
    // `node --test` with no arguments discovers the suite exactly as the
    // fixture's own `npm test` does.
    await exec(process.execPath, ["--test"], { cwd: project });
  } catch (error) {
    fail(`the original public suite fails: ${String(error.stdout ?? "").slice(-2000)}`);
  }
});
```

- [ ] **Step 3: Register the check in `sources/B01/oracle.json`**

`timeoutMs` is `300000` here, because the suite runs 56 tests as child processes.

- [ ] **Step 4: Write the two patches**

`pass`: `{"description": "The reference fix keeps the whole suite green.", "include": ["reference-fix"], "removals": []}`.

`fail`: `{"description": "Ordering is fixed, but completing a job now rejects a valid transition.", "include": ["reference-fix"], "removals": []}` plus `files/src/commands/complete.js`, a copy of the fixture's file with the state check inverted so a claimed job can no longer be completed. This proves the check catches collateral damage rather than the case's own defect.

- [ ] **Step 5: Build and prove**

```bash
cd .private && npm run build && cd .. && npm run oracles:proof
```

Expected: four of five assertions proved. Confirm the `fail` patch reports a `failed` outcome rather than an `error`; an `error` means the check crashed and must be corrected.

- [ ] **Step 6: Verify the baseline guard works**

Temporarily change one byte in `.private/sources/B01/tests/cli.test.js`, rebuild, and run `npm run oracles:proof`. Expected: a failure mentioning `baseline`. Revert the byte, rebuild, and confirm the proof is clean again.

- [ ] **Step 7: Commit in the private repository**

```bash
cd .private
git add sources proofs oracles
git commit -m "feat: prove the B01 regression assertion against a carried test suite"
```

---

## Task 8: The structural assertion

**Repository:** `.private`.

**Files:**
- Create: `.private/sources/B01/checks/functional-renderer-neutral.mjs`
- Modify: `.private/sources/B01/oracle.json`
- Create: `.private/proofs/B01/functional-renderer-neutral/{pass,fail}/overlay.json`

**Interfaces:**
- Consumes: `shared/queuedesk.mjs`.
- Produces: the non-critical `functional-renderer-neutral` check.

- [ ] **Step 1: Write the check**

```javascript
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { copyProject, fail, job, withScratch } from "../shared/queuedesk.mjs";

await withScratch(async (scratch) => {
  const project = await copyProject(scratch);
  let renderJobList;
  try {
    ({ renderJobList } = await import(pathToFileURL(join(project, "src/format/output.js")).href));
  } catch (error) {
    fail(`src/format/output.js does not export a renderer any more: ${error.message}`);
  }

  const given = [
    job({ id: "job-0009", priority: "low", title: "Alpha" }),
    job({ id: "job-0001", priority: "high", title: "Beta" }),
  ];
  const rendered = renderJobList(given);
  const first = rendered.indexOf("job-0009");
  const second = rendered.indexOf("job-0001");
  if (first === -1 || second === -1) {
    fail(`the rendered list does not mention both jobs: ${rendered}`);
  }
  if (first > second) {
    fail("the output layer reorders jobs; DECISIONS.md places ordering in the job rules");
  }
});
```

- [ ] **Step 2: Register the check in `sources/B01/oracle.json`**

`timeoutMs` `120000`.

- [ ] **Step 3: Write the two patches**

`pass`: `{"description": "The renderer prints what it receives.", "include": ["reference-fix"], "removals": []}`.

`fail`: `{"description": "The untouched fixture sorts inside the renderer.", "removals": []}` with no includes and no files.

- [ ] **Step 4: Build and prove**

```bash
cd .private && npm run build && cd .. && npm run oracles:proof
```

Expected: all five assertions proved, exit code `0`.

- [ ] **Step 5: Verify against the real pipeline with the fake runtime**

```bash
npm run build
node dist/src/cli.js validate --project .
```

Expected: exit code `0` and no reported issues, now that `.private/oracles/B01` exists and covers exactly the five declared assertions.

- [ ] **Step 6: Commit in the private repository**

```bash
cd .private
git add sources proofs oracles
git commit -m "feat: prove the B01 renderer neutrality assertion"
```

---

## Task 9: Documentation and the stage gate

**Repository:** public.

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

- [ ] **Step 1: Update `AGENTS.md`**

- In **Current State**: Stage 5A is complete; the repository ships one case (`B01`) and one variant (`control`); `validate` without `--public-only` passes when the private material is present; Stage 5B is next.
- In **Architecture**: add `src/tools/` as the home of development tools that use SkillBench's own modules, currently the oracle prover.
- In **Technology and Commands**: add `npm run oracles:proof` and `npm --prefix .private run check`, and note that both need the private repository cloned into `.private/`.
- In **Non-Negotiable Rules**: add the closed category vocabulary; the rule that an oracle check never writes into the agent's workspace; the rule that `tests/` stays an allowed change path while the oracle carries its own copy of the public suite; and the rule never to hand-edit a composed oracle.
- In **Known Limitations to Preserve or Resolve Explicitly**: add that `publicVerification` is frozen and printed but never executed by `run`; that an oracle check which crashes is reported as a failed assertion rather than an errored one; and that the three skill variants have no delivery stage of their own and need one before the pilot.

- [ ] **Step 2: Update `README.md`**

Add to the English section, then mirror it completely in the Russian section: what a case and an oracle are, that oracles live in a separate private repository cloned into `.private/`, what works without it (`validate --public-only`, `list`, `dry-run`, the fixtures and their public suites), and the two extra commands with one line each.

- [ ] **Step 3: Run the full stage gate**

```bash
npm run check
npm run build
node dist/src/cli.js validate --project .
npm run oracles:proof
npm --prefix .private run check
```

Expected: every command exits `0`. Paste the output under any completion claim.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: record the stage 5A oracle toolkit and first case"
```

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill: merge `stage5a-oracle-toolkit` into `main`, remove the worktree, and push `main` to `origin`. Push the private repository separately with `git -C .private push`.
