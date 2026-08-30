# SkillBench Stage 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first testable SkillBench CLI increment: typed case and variant schemas, safe project paths, deterministic hashes, immutable manifests, catalog validation, and a deterministic fake runtime adapter.

**Architecture:** Build a small ESM TypeScript application whose domain types do not import CLI or runtime-specific code. Boundary modules load JSON, validate it with published JSON Schemas, resolve every referenced path beneath an explicit project root, and freeze normalized inputs into content-addressed records. A fake adapter implements the same runtime contract later used by Codex, allowing pipeline tests to stay offline and deterministic.

**Tech Stack:** Node.js 22, TypeScript 5, ESM, npm, Commander, Ajv 8, Node's built-in `node:test`, `tsx`, ESLint 9.

**Spec:** `docs/superpowers/specs/2026-08-30-skillbench-design.md`

## Global Constraints

- The CLI requires Node.js 22 or newer and uses concise international English for prompts, documentation, schemas, fixture copy, reports, and CLI messages.
- Skills are data: core code must not branch on `control`, `openspec`, `superpowers`, `lexforge`, or any other variant ID.
- Cases and variants remain runtime-neutral; runtime command construction and transcript parsing stay behind `RuntimeAdapter`.
- All project and workspace paths must reject traversal and symlink escapes.
- Public manifests must not contain arbitrary shell strings; commands use typed executors plus argument arrays.
- Private oracle files must never be copied into an active agent workspace.
- `.private/` and `runs/` are ignored by Git; source fixtures and public inputs remain immutable during runs.
- Undefined metric denominators become `not_applicable`, never zero; scoring is outside this stage.
- Development follows TDD: observe each new test fail before adding its minimal implementation.

## File Structure

```text
SkillBench/
├── package.json                         # npm scripts, runtime floor, dependencies, CLI bin
├── package-lock.json                    # reproducible dependency graph
├── tsconfig.json                        # strict NodeNext TypeScript build
├── eslint.config.js                     # source and test lint rules
├── .gitignore                           # private oracle, run, coverage, build exclusions
├── src/
│   ├── cli.ts                           # process entry point and exit-code mapping
│   ├── cli/create-program.ts            # Commander command registration
│   ├── domain/model.ts                   # runtime-neutral public domain types
│   ├── domain/errors.ts                  # typed invocation, validation, and dependency errors
│   ├── integrity/canonical-json.ts       # stable JSON serialization
│   ├── integrity/content-hash.ts         # SHA-256 helpers for values, files, and trees
│   ├── paths/project-paths.ts            # containment and symlink-safe path resolution
│   ├── schemas/validator.ts              # Ajv loading and typed validation facade
│   ├── catalog/load-catalog.ts           # case/variant discovery and cross-reference checks
│   ├── storage/immutable-json-store.ts   # atomic, write-once JSON evidence records
│   ├── runtime/runtime-adapter.ts        # adapter interface and normalized events
│   ├── runtime/fake-adapter.ts           # deterministic offline implementation
│   └── commands/validate.ts              # `skillbench validate` use case
├── schemas/
│   ├── case.schema.json                  # published case contract
│   └── variant.schema.json               # published variant contract
└── tests/
    ├── cli/help.test.ts
    ├── integrity/content-hash.test.ts
    ├── paths/project-paths.test.ts
    ├── schemas/validator.test.ts
    ├── catalog/load-catalog.test.ts
    ├── storage/immutable-json-store.test.ts
    ├── runtime/fake-adapter.test.ts
    ├── commands/validate.test.ts
    └── helpers/temp-project.ts
```

---

### Task 1: Bootstrap the strict Node.js CLI

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `.gitignore`
- Create: `src/cli.ts`
- Create: `src/cli/create-program.ts`
- Create: `src/domain/errors.ts`
- Create: `tests/cli/help.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `createProgram(): Command`, `main(argv: readonly string[]): Promise<number>`, and the error classes `FindingError`, `ValidationError`, `InvocationError`, and `DependencyError` with exit codes `1`, `2`, `2`, and `2`.

- [ ] **Step 1: Add package metadata and test scripts**

Create `package.json` with this exact public toolchain and command surface:

```json
{
  "name": "skillbench",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "bin": { "skillbench": "dist/src/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "npm run lint && npm run typecheck && npm test",
    "lint": "eslint src tests",
    "test": "node --import tsx --test tests/**/*.test.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "ajv": "8.17.1",
    "commander": "14.0.0"
  },
  "devDependencies": {
    "@eslint/js": "9.34.0",
    "@types/node": "22.17.2",
    "eslint": "9.34.0",
    "tsx": "4.20.5",
    "typescript": "5.9.2",
    "typescript-eslint": "8.41.0"
  }
}
```

Create `tsconfig.json` with `target: "ES2023"`, `module` and `moduleResolution` set to `"NodeNext"`, `rootDir: "."`, `outDir: "dist"`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, and `include: ["src/**/*.ts", "tests/**/*.ts"]`.

Create `eslint.config.js` by combining `@eslint/js` recommended rules with `typescript-eslint` strict type-checked configs and ignoring `dist/`, `coverage/`, `.private/`, and `runs/`.

Create `.gitignore` with:

```gitignore
node_modules/
dist/
coverage/
.private/
runs/
*.log
.DS_Store
```

Run `npm install` to generate `package-lock.json` after the files exist.

- [ ] **Step 2: Write the failing CLI help and exit-code tests**

Create `tests/cli/help.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createProgram } from "../../src/cli/create-program.js";
import { main } from "../../src/cli.js";

test("help publishes the version 1 commands", () => {
  const output: string[] = [];
  const program = createProgram().configureOutput({
    writeOut: (value) => output.push(value),
    writeErr: (value) => output.push(value),
  });
  program.exitOverride();
  assert.throws(() => program.parse(["node", "skillbench", "--help"]));
  const help = output.join("");
  for (const command of ["validate", "list", "dry-run", "run", "compare", "report"]) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }
});

test("an invalid invocation returns exit code 2", async () => {
  assert.equal(await main(["node", "skillbench", "unknown-command"]), 2);
});
```

- [ ] **Step 3: Run the CLI test and observe the missing-module failure**

Run: `npm test -- tests/cli/help.test.ts`

Expected: FAIL because `src/cli/create-program.ts` and `src/cli.ts` do not exist.

- [ ] **Step 4: Implement the command skeleton and exit mapping**

In `src/domain/errors.ts`, define a base `SkillBenchError` carrying `exitCode: 1 | 2`, plus `FindingError`, `ValidationError`, `InvocationError`, and `DependencyError` subclasses. `FindingError` uses `1`; the other three use `2`. In `src/cli/create-program.ts`, register all six commands, but make commands outside Stage 1 throw `InvocationError("<name> is not available in this build")`; register `validate` for wiring in Task 8. Set `showHelpAfterError()` and use Commander's `exitOverride()` only inside `main`.

Implement `main` so it accepts an injectable argument list, returns `0` after a successful parse, converts `SkillBenchError.exitCode` directly, converts Commander usage errors to `2`, writes one concise error line to stderr, and never calls `process.exit()` itself. The top-level module sets `process.exitCode = await main(process.argv)` only when launched as the entry point.

- [ ] **Step 5: Run focused and static checks**

Run: `npm test -- tests/cli/help.test.ts && npm run typecheck && npm run lint`

Expected: all commands exit `0` and both CLI tests pass.

- [ ] **Step 6: Commit the bootstrap**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.js .gitignore src/cli.ts src/cli/create-program.ts src/domain/errors.ts tests/cli/help.test.ts
git commit -m "chore: bootstrap SkillBench CLI"
```

---

### Task 2: Define runtime-neutral domain contracts and deterministic hashes

**Files:**
- Create: `src/domain/model.ts`
- Create: `src/integrity/canonical-json.ts`
- Create: `src/integrity/content-hash.ts`
- Create: `tests/integrity/content-hash.test.ts`

**Interfaces:**
- Consumes: Node `crypto`, `fs/promises`, and `path` only.
- Produces: `CaseManifest`, `VariantManifest`, `TypedCommand`, `RuntimeLimits`, `RunManifest`, `canonicalJson(value): string`, `hashValue(value): ContentHash`, `hashFile(path): Promise<ContentHash>`, and `hashTree(root): Promise<ContentHash>`.

- [ ] **Step 1: Write hash behavior tests**

Create `tests/integrity/content-hash.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../../src/integrity/canonical-json.js";
import { hashTree, hashValue } from "../../src/integrity/content-hash.js";

test("canonical JSON ignores object insertion order but preserves array order", () => {
  assert.equal(canonicalJson({ b: 2, a: [2, 1] }), '{"a":[2,1],"b":2}');
  assert.equal(hashValue({ b: 2, a: 1 }), hashValue({ a: 1, b: 2 }));
  assert.notEqual(hashValue([1, 2]), hashValue([2, 1]));
});

test("tree hashes include normalized relative paths and bytes", async () => {
  const first = await mkdtemp(join(tmpdir(), "skillbench-hash-a-"));
  const second = await mkdtemp(join(tmpdir(), "skillbench-hash-b-"));
  await mkdir(join(first, "nested"));
  await mkdir(join(second, "nested"));
  await writeFile(join(first, "nested/a.txt"), "same");
  await writeFile(join(second, "nested/a.txt"), "same");
  assert.equal(await hashTree(first), await hashTree(second));
  await writeFile(join(second, "nested/a.txt"), "changed");
  assert.notEqual(await hashTree(first), await hashTree(second));
});
```

- [ ] **Step 2: Run the tests and observe the missing exports**

Run: `npm test -- tests/integrity/content-hash.test.ts`

Expected: FAIL because the integrity modules do not exist.

- [ ] **Step 3: Add exact domain types**

Define branded `ContentHash = string & { readonly __contentHash: unique symbol }` and these core shapes in `src/domain/model.ts`:

```ts
export type CommandExecutor = "node" | "npm" | "git";
export interface TypedCommand { readonly executor: CommandExecutor; readonly args: readonly string[]; }
export interface RuntimeLimits { readonly wallClockMs: number; readonly outputBytes: number; readonly tokenLimit: number; }
export interface PromptStep { readonly id: string; readonly prompt: string; readonly continuation?: { readonly eventRuleIds: readonly string[]; }; }
export interface AssertionDeclaration { readonly id: string; readonly dimension: "functional" | "regression" | "security" | "scope" | "process"; readonly critical: boolean; }
export interface CaseManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly categories: readonly string[];
  readonly fixture: { readonly path: string; readonly contentHash: ContentHash };
  readonly promptSteps: readonly PromptStep[];
  readonly publicVerification: readonly TypedCommand[];
  readonly limits: RuntimeLimits;
  readonly allowedChangePaths: readonly string[];
  readonly forbiddenChangePaths: readonly string[];
  readonly assertions: readonly AssertionDeclaration[];
  readonly transcriptRules?: readonly { readonly id: string; readonly event: string; readonly beforeStepId?: string }[];
}
export interface VariantManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly compatibleRuntimes: readonly string[];
  readonly installs: readonly { readonly source: string; readonly destinations: Readonly<Record<string, string>> }[];
  readonly claimedCategories: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly contentHash: ContentHash;
}
```

Also define `RunManifest` with frozen `caseHash`, `variantHash`, `fixtureHash`, `oracleHash`, `model`, `reasoningEffort`, `sandbox`, `runtimeVersion`, `adapterVersion`, `limits`, and `repetitionIndex`; do not add scores or results to this input record.

- [ ] **Step 4: Implement canonical serialization and SHA-256 hashing**

`canonicalJson` must reject `undefined`, non-finite numbers, bigint, functions, symbols, cycles, and non-plain objects with a `ValidationError`; recursively sort object keys and preserve array order. `hashValue` hashes UTF-8 canonical JSON as lowercase `sha256:<64 hex>`.

`hashTree` must recursively walk with `lstat`, reject symbolic links and non-file/non-directory entries, sort POSIX-style relative paths by UTF-8 byte order, and update one SHA-256 stream per file with `relativePath`, a zero byte, decimal byte length, a zero byte, and raw file bytes. An empty tree has a stable digest.

- [ ] **Step 5: Run integrity checks**

Run: `npm test -- tests/integrity/content-hash.test.ts && npm run typecheck && npm run lint`

Expected: all checks pass.

- [ ] **Step 6: Commit the domain and integrity boundary**

```bash
git add src/domain/model.ts src/integrity/canonical-json.ts src/integrity/content-hash.ts tests/integrity/content-hash.test.ts
git commit -m "feat: add deterministic input hashing"
```

---

### Task 3: Enforce project path containment and symlink safety

**Files:**
- Create: `src/paths/project-paths.ts`
- Create: `tests/paths/project-paths.test.ts`

**Interfaces:**
- Consumes: an absolute, existing project root and manifest-supplied relative paths.
- Produces: `ProjectPaths.create(root): Promise<ProjectPaths>`, `resolveExisting(relative, expected): Promise<string>`, and `resolveOutput(relative): Promise<string>` where `expected` is `"file" | "directory"`.

- [ ] **Step 1: Write traversal and symlink-escape tests**

Create tests that build a temporary project plus an outside directory and assert:

```ts
await assert.rejects(() => paths.resolveExisting("../outside", "file"), /escapes project root/);
await assert.rejects(() => paths.resolveExisting("/etc/passwd", "file"), /must be relative/);
await assert.rejects(() => paths.resolveExisting("linked/secret.txt", "file"), /symbolic link/);
assert.equal(await paths.resolveExisting("fixtures/base", "directory"), join(root, "fixtures/base"));
assert.equal(await paths.resolveOutput("runs/run-1/result.json"), join(root, "runs/run-1/result.json"));
```

The test must create `linked` as a symlink to the outside directory and skip only that assertion when the host explicitly rejects symlink creation.

- [ ] **Step 2: Run the focused test and observe the missing module**

Run: `npm test -- tests/paths/project-paths.test.ts`

Expected: FAIL because `ProjectPaths` is undefined.

- [ ] **Step 3: Implement segment-by-segment resolution**

Normalize separators to POSIX syntax, reject absolute paths, empty segments, `.` and `..`, NUL bytes, and Windows drive prefixes. Resolve the root with `realpath`. For existing inputs, `lstat` every segment before `realpath` and reject any symbolic link. For outputs, require each existing ancestor to remain beneath the real root and allow only the final missing suffix. Compare containment with `relative(realRoot, candidate)` rather than string prefixes.

Return absolute normalized paths but never expose a method that accepts an arbitrary absolute child path.

- [ ] **Step 4: Run path and static checks**

Run: `npm test -- tests/paths/project-paths.test.ts && npm run typecheck && npm run lint`

Expected: traversal, absolute-path, and symlink-escape tests pass.

- [ ] **Step 5: Commit the path boundary**

```bash
git add src/paths/project-paths.ts tests/paths/project-paths.test.ts
git commit -m "feat: enforce safe project paths"
```

---

### Task 4: Publish and enforce case and variant JSON Schemas

**Files:**
- Create: `schemas/case.schema.json`
- Create: `schemas/variant.schema.json`
- Create: `src/schemas/validator.ts`
- Create: `tests/schemas/validator.test.ts`

**Interfaces:**
- Consumes: unknown parsed JSON.
- Produces: `ManifestValidator.create(schemaDirectory): Promise<ManifestValidator>`, `validateCase(value): CaseManifest`, and `validateVariant(value): VariantManifest`.

- [ ] **Step 1: Write positive and negative schema tests**

Use minimal valid factories in the test and prove these failures independently:

```ts
assert.throws(() => validator.validateCase({ ...validCase, extra: true }), /additional properties/);
assert.throws(() => validator.validateCase({ ...validCase, id: "../F01" }), /must match pattern/);
assert.throws(() => validator.validateCase({ ...validCase, assertions: [{ id: "x", dimension: "unknown", critical: true }] }), /dimension/);
assert.throws(() => validator.validateCase({ ...validCase, publicVerification: [{ executor: "sh", args: ["-c", "echo unsafe"] }] }), /executor/);
assert.throws(() => validator.validateVariant({ ...validVariant, environment: { PATH: "/tmp/bin" } }), /property name/);
```

Also assert the returned valid objects deeply equal the inputs and that `validateCase` never mutates its argument.

- [ ] **Step 2: Run schema tests and observe failure**

Run: `npm test -- tests/schemas/validator.test.ts`

Expected: FAIL because schemas and validator are absent.

- [ ] **Step 3: Define strict published schemas**

Both schemas use draft 2020-12, `additionalProperties: false` at every object, `schemaVersion: { "const": 1 }`, IDs matching `^[A-Za-z][A-Za-z0-9_-]{1,63}$`, non-empty unique arrays where duplicates are meaningless, and relative paths matching `^(?![A-Za-z]:)(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\0]+$`.

The case schema must require every `CaseManifest` field shown in Task 2, limit executors to `node`, `npm`, and `git`, require positive integer limits, and constrain assertion dimensions to the five named values. The variant schema must require all `VariantManifest` fields, allow any variant to declare an empty install list without inspecting its ID, and restrict environment keys to `^SKILLBENCH_[A-Z0-9_]+$` so manifests cannot replace `PATH`, credentials, or runtime control variables.

- [ ] **Step 4: Implement the typed Ajv facade**

Load schema files from the explicit directory rather than `cwd`, import the draft-specific `Ajv2020` constructor from `ajv/dist/2020.js`, instantiate it with `allErrors: true` and `strict: true`, compile each schema once, and deep-clone a valid value with `structuredClone` before returning it. Sort validation errors by `instancePath` then `keyword`, and render messages as `case /path keyword: message` so validation output is deterministic. The facade performs the single audited type assertion from schema-validated JSON to `CaseManifest` or `VariantManifest`, including the branded hashes.

- [ ] **Step 5: Run schema, type, and lint checks**

Run: `npm test -- tests/schemas/validator.test.ts && npm run typecheck && npm run lint`

Expected: all positive and negative cases pass.

- [ ] **Step 6: Commit schemas and validation**

```bash
git add schemas/case.schema.json schemas/variant.schema.json src/schemas/validator.ts tests/schemas/validator.test.ts
git commit -m "feat: publish benchmark manifest schemas"
```

---

### Task 5: Add atomic immutable JSON evidence storage

**Files:**
- Create: `src/storage/immutable-json-store.ts`
- Create: `tests/storage/immutable-json-store.test.ts`

**Interfaces:**
- Consumes: `ProjectPaths`, `canonicalJson`, a project-relative output path, and a JSON value.
- Produces: `ImmutableJsonStore.write(relativePath, value): Promise<{ path: string; contentHash: ContentHash }>` and `read<T>(relativePath): Promise<T>`.

- [ ] **Step 1: Write immutability and partial-write tests**

Create tests proving that the first write creates canonical JSON with a trailing newline, a byte-identical second write succeeds idempotently, a different second value rejects with `immutable record already exists`, and a forced rename failure leaves neither the target nor a `.tmp-` sibling behind.

Inject this narrow filesystem seam into the constructor:

```ts
export interface StoreFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { flag: "wx"; mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
```

- [ ] **Step 2: Run the test and observe the missing store**

Run: `npm test -- tests/storage/immutable-json-store.test.ts`

Expected: FAIL because `ImmutableJsonStore` does not exist.

- [ ] **Step 3: Implement write-once atomic records**

Serialize as `${canonicalJson(value)}\n`, resolve the target through `ProjectPaths.resolveOutput`, create its parent with mode-safe defaults, and write an exclusive temp file named `<target>.tmp-<randomUUID()>` with mode `0o600`. Rename only after the complete write. On any error, attempt to unlink only the exact generated temp path. If the target already exists, read and compare exact bytes; return the existing hash only when identical, otherwise throw `ValidationError`.

Never overwrite with `writeFile` flags other than `wx`, and never delete the destination during cleanup.

- [ ] **Step 4: Run storage and static checks**

Run: `npm test -- tests/storage/immutable-json-store.test.ts && npm run typecheck && npm run lint`

Expected: all immutability and cleanup checks pass.

- [ ] **Step 5: Commit immutable storage**

```bash
git add src/storage/immutable-json-store.ts tests/storage/immutable-json-store.test.ts
git commit -m "feat: add immutable evidence storage"
```

---

### Task 6: Establish the runtime adapter contract with an offline fake

**Files:**
- Create: `src/runtime/runtime-adapter.ts`
- Create: `src/runtime/fake-adapter.ts`
- Create: `tests/runtime/fake-adapter.test.ts`

**Interfaces:**
- Consumes: a materialized workspace, ordered prompt steps, runtime configuration, and a transcript sink.
- Produces: `RuntimeAdapter.execute(input): Promise<RuntimeExecution>`; `FakeAdapter` additionally consumes a deterministic `FakeScript` supplied by tests.

- [ ] **Step 1: Write a complete fake-adapter interaction test**

Define and test the exact normalized contract:

```ts
export type TranscriptEvent =
  | { readonly type: "session_started"; readonly atMs: number }
  | { readonly type: "prompt_sent"; readonly atMs: number; readonly stepId: string; readonly text: string }
  | { readonly type: "assistant_message"; readonly atMs: number; readonly text: string }
  | { readonly type: "command"; readonly atMs: number; readonly executor: string; readonly args: readonly string[]; readonly exitCode: number }
  | { readonly type: "completion_claim"; readonly atMs: number; readonly text: string }
  | { readonly type: "session_closed"; readonly atMs: number };
```

The test supplies two prompt steps and a script with one assistant message and command per step. Assert event ordering, monotonic fake timestamps, exact usage totals, elapsed time, process exit information, adapter metadata, and that the continuation callback is invoked after step 1 events but before step 2 is sent.

- [ ] **Step 2: Run the test and observe missing adapter modules**

Run: `npm test -- tests/runtime/fake-adapter.test.ts`

Expected: FAIL because the runtime contract is absent.

- [ ] **Step 3: Implement the adapter boundary**

Define:

```ts
export interface RuntimeInput {
  readonly workspace: string;
  readonly promptSteps: readonly PromptStep[];
  readonly config: { readonly model: string; readonly reasoningEffort: string; readonly sandbox: string; readonly limits: RuntimeLimits };
  readonly onContinuation: (step: PromptStep, events: readonly TranscriptEvent[]) => Promise<void>;
}
export interface RuntimeExecution {
  readonly events: readonly TranscriptEvent[];
  readonly process: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null; readonly timedOut: boolean };
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly elapsedMs: number;
  readonly metadata: { readonly runtime: string; readonly runtimeVersion: string; readonly adapterVersion: string };
}
export interface RuntimeAdapter { execute(input: RuntimeInput): Promise<RuntimeExecution>; }
```

`FakeAdapter` must never execute a process or read the workspace. It walks the supplied `FakeScript` synchronously, advances an integer fake clock by scripted durations, freezes copies of all emitted events, and calls `onContinuation` exactly at declared continuation points. Reject scripts with missing or extra step IDs.

- [ ] **Step 4: Run adapter and static checks**

Run: `npm test -- tests/runtime/fake-adapter.test.ts && npm run typecheck && npm run lint`

Expected: the complete two-step fake execution passes without network or child processes.

- [ ] **Step 5: Commit the adapter contract**

```bash
git add src/runtime/runtime-adapter.ts src/runtime/fake-adapter.ts tests/runtime/fake-adapter.test.ts
git commit -m "feat: add deterministic fake runtime adapter"
```

---

### Task 7: Load and cross-validate the benchmark catalog

**Files:**
- Create: `src/catalog/load-catalog.ts`
- Create: `tests/helpers/temp-project.ts`
- Create: `tests/catalog/load-catalog.test.ts`

**Interfaces:**
- Consumes: `ProjectPaths`, `ManifestValidator`, `hashTree`, `cases/*/case.json`, `variants/*/variant.json`, fixture trees, install sources, and `.private/oracles/<case-id>/`.
- Produces: `loadCatalog(root, options): Promise<Catalog>` and sorted `CatalogIssue[]`; `options.requirePrivateOracles` defaults to `true`.

- [ ] **Step 1: Build a reusable valid temporary project fixture**

Implement `createTempProject()` so each test receives directories for `cases/F01`, `fixtures/queuedesk`, `variants/control`, `variants/example`, `schemas`, and `.private/oracles/F01`; copies the published schemas; writes a valid case and both valid variants; and computes fixture/install hashes with the production `hashTree` helper before writing manifests.

The control manifest uses empty `installs`, empty `environment`, and `hashValue([])` as the content hash of its empty installed material; `loadCatalog` must infer no special behavior from its ID.

- [ ] **Step 2: Write independent cross-reference failures**

Add tests for duplicate case IDs across files, missing fixture, fixture hash mismatch, duplicate assertion IDs inside one case, a continuation rule referencing a missing transcript rule or prompt step, absent private oracle, variant source hash mismatch, destination missing for a declared compatible runtime, and any allowed/forbidden path overlap.

Assert issues are sorted by `source`, then `code`, then `message`, and that collecting one issue does not suppress unrelated issues.

- [ ] **Step 3: Run catalog tests and observe failure**

Run: `npm test -- tests/catalog/load-catalog.test.ts`

Expected: FAIL because the catalog loader does not exist.

- [ ] **Step 4: Implement discovery and semantic validation**

Discover only `cases/*/case.json` and `variants/*/variant.json`, sort paths before reading, parse JSON with a source-aware error, and pass it through `ManifestValidator`. Continue collecting issues after recoverable file errors.

Resolve and hash fixtures, variant install sources, and oracle directories through `ProjectPaths`. Compare fixture hashes directly. Compute a variant material hash as `hashValue(installs.map(({ source }) => ({ source, contentHash: await hashTree(source) })))` in manifest order; an empty install list therefore hashes as `hashValue([])`. Validate uniqueness, references, path intersections after normalized trailing-slash removal, compatible-runtime destinations, assertion IDs, and transcript continuation references. Return no usable manifest for a file with schema errors. Never parse or expose oracle contents; availability is satisfied by safely resolving the non-empty directory and hashing it for later run-manifest use.

- [ ] **Step 5: Run catalog and full test suites**

Run: `npm test -- tests/catalog/load-catalog.test.ts && npm test && npm run typecheck && npm run lint`

Expected: all catalog failures are deterministic and the complete suite passes.

- [ ] **Step 6: Commit catalog validation**

```bash
git add src/catalog/load-catalog.ts tests/helpers/temp-project.ts tests/catalog/load-catalog.test.ts
git commit -m "feat: validate benchmark catalog references"
```

---

### Task 8: Deliver `skillbench validate` as the Stage 1 CLI increment

**Files:**
- Create: `src/commands/validate.ts`
- Create: `tests/commands/validate.test.ts`
- Modify: `src/cli/create-program.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `loadCatalog(projectRoot, { requirePrivateOracles })`.
- Produces: `runValidate(options, io): Promise<void>` and CLI syntax `skillbench validate [--project <path>] [--public-only]`.

- [ ] **Step 1: Write end-to-end command tests**

Test `runValidate` through an injected `io` object `{ stdout(text), stderr(text) }`. A valid temp project must emit `Validated 1 case and 2 variants.\n`. A project with a fixture hash mismatch must throw `FindingError`, print a stable line containing the source and issue code, and map to exit code `1` through `main`. A malformed option must return `2`. With `--public-only`, missing `.private/oracles/F01` must not fail; without it, the same project must fail.

- [ ] **Step 2: Run the command tests and observe failure**

Run: `npm test -- tests/commands/validate.test.ts`

Expected: FAIL because `runValidate` is missing and `validate` is still a command stub.

- [ ] **Step 3: Implement and register the validate command**

Resolve `--project` once to an absolute root, create `ProjectPaths` and `ManifestValidator` using `<project>/schemas`, then call `loadCatalog`. Print every issue as `<source>: <code>: <message>` in catalog order. Throw one `FindingError` after printing if issues exist; otherwise print singular/plural counts exactly.

Register:

```ts
program.command("validate")
  .description("Validate schemas, references, hashes, paths, and oracle availability")
  .option("--project <path>", "SkillBench project root", ".")
  .option("--public-only", "do not require private oracle availability", false)
  .action(async (options) => runValidate(options, io));
```

Keep dependency/unavailable errors at exit `2` and findings at exit `1`.

- [ ] **Step 4: Replace the placeholder README with exact Stage 1 usage**

Document Node 22+, `npm ci`, `npm run check`, `npm run build`, `npm exec skillbench -- validate`, the meaning of exit codes `0/1/2`, and that `--public-only` validates a public checkout without weakening normal benchmark validation. State that the remaining commands are reserved by the v1 interface and intentionally return exit `2` until their delivery stages land.

- [ ] **Step 5: Run final verification from a clean dependency install**

Run:

```bash
npm ci
npm run check
npm run build
node dist/src/cli.js validate --project . --public-only
git diff --check
```

Expected: install, lint, typecheck, tests, and build pass; validation either reports the current catalog counts or `Validated 0 cases and 0 variants.` for the pre-case Stage 1 repository; `git diff --check` emits no output.

- [ ] **Step 6: Commit the completed Stage 1 increment**

```bash
git add src/commands/validate.ts src/cli/create-program.ts tests/commands/validate.test.ts README.md
git commit -m "feat: deliver catalog validation command"
```

## Stage 1 Acceptance Gate

- [ ] Run `npm run check` and confirm lint, typecheck, and every unit/integration test pass.
- [ ] Run `npm run build` and execute the built `validate` command, not the TypeScript source.
- [ ] Confirm `git status --short` contains no generated `dist/`, `runs/`, `.private/`, coverage, or log files.
- [ ] Confirm `rg -n "\\b(control|openspec|superpowers|lexforge)\\b" src` returns no matches.
- [ ] Confirm the path tests demonstrate traversal and symlink rejection.
- [ ] Confirm the storage test demonstrates failed writes preserve no partial target.
- [ ] Confirm the fake adapter integration test performs no network or child-process activity.
- [ ] Request code review with `superpowers:requesting-code-review` before merging or starting Stage 2.

## Follow-on Plan Boundaries

Create separate plans only after this acceptance gate passes:

1. Stage 2 — workspace materialization, data-driven variant installation, oracle lifecycle, and normalized run results.
2. Stage 3 — Codex adapter, JSONL transcript normalization, limits, and multi-step continuation.
3. Stage 4 — offline QueueDesk fixture and its public Node test suite.
4. Stage 5 — twelve public cases plus positive and negative mutation-tested private oracles.
5. Stage 6 — compatibility checks, bootstrap statistics, comparison records, and Markdown/JSON reports.
6. Stage 7 — two-repetition pilot, case-pack revision and freeze, then the five-repetition main study.

Each follow-on plan must retain the frozen interfaces produced here or include an explicit compatibility migration with tests.
