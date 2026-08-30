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
  assert.equal(result.assertions[0].exitCode, 7);
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
    execute: () => Promise.resolve({
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
    execute: () => {
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
    execute: (input: { workspace: string }) => {
      observed.push(input.workspace);
      return Promise.resolve({
        events: [{ type: "session_started" as const, atMs: 0 }, { type: "session_closed" as const, atMs: 1 }],
        process: { exitCode: 0, signal: null, timedOut: false },
        usage: null,
        elapsedMs: 1,
        metadata: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
      });
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
