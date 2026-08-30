import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadCatalog, type CatalogCase, type CatalogVariant } from "../../src/catalog/load-catalog.js";
import { ProjectPaths } from "../../src/paths/project-paths.js";
import { executeRun, type ExecuteRunInput } from "../../src/runs/execute-run.js";
import type { RunConfiguration } from "../../src/runs/freeze-inputs.js";
import { ManifestValidator } from "../../src/schemas/validator.js";
import type { RuntimeAdapter, RuntimeExecution } from "../../src/runtime/runtime-adapter.js";
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

const closedSession: RuntimeExecution = {
  events: [{ type: "session_started", atMs: 0 }, { type: "session_closed", atMs: 1 }],
  process: { exitCode: 0, signal: null, timedOut: false },
  usage: null,
  elapsedMs: 1,
  metadata: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
};

interface Harness {
  readonly project: TempProject;
  readonly catalogCase: CatalogCase;
  readonly variant: CatalogVariant;
  readonly paths: ProjectPaths;
  readonly store: ImmutableJsonStore;
  readonly validator: ManifestValidator;
}

interface RunOverrides {
  readonly adapter?: RuntimeAdapter;
  readonly keepWorkspace?: boolean;
  readonly tempParent?: string;
}

async function createHarness(
  prepare: (project: TempProject) => Promise<void> = () => Promise.resolve(),
): Promise<Harness> {
  const project = await createTempProject();
  await prepare(project);
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

function runInput(harness: Harness, runId: string, overrides: RunOverrides = {}): ExecuteRunInput {
  return {
    paths: harness.paths,
    store: harness.store,
    validator: harness.validator,
    catalogCase: harness.catalogCase,
    variant: harness.variant,
    configuration,
    adapter: overrides.adapter ?? selectAdapter("fake", harness.catalogCase.manifest).adapter,
    runId,
    repetitionIndex: 0,
    ...(overrides.keepWorkspace === undefined ? {} : { keepWorkspace: overrides.keepWorkspace }),
    ...(overrides.tempParent === undefined ? {} : { tempParent: overrides.tempParent }),
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
  assert.equal(result.preservedWorkspacePath, null);
  assert.deepEqual(result.cleanupFailures, []);

  const directory = join(harness.project.root, "runs/F01/example/20260830T175302Z-a1b2c3");
  for (const filename of ["manifest.json", "transcript.json", "changes.json", "result.json"]) {
    await access(join(directory, filename));
  }
  const stored = JSON.parse(await readFile(join(directory, "result.json"), "utf8")) as { status: string };
  assert.equal(stored.status, "completed");
});

test("a failing oracle check reports completed with a failed assertion", async () => {
  const harness = await createHarness(async (project) => {
    await writeFile(join(project.oracleDirectory, "checks/assert-1.js"), "process.exit(7);\n");
  });

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

test("a private oracle changed after freezing reports errored at the grade step", async () => {
  const harness = await createHarness();
  await writeFile(join(harness.project.oracleDirectory, "checks/assert-1.js"), "process.exit(0); // edited\n");

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2db"));

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "grade");
  assert.match(result.failureMessage, /private oracle changed after freezing/u);
  assert.match(result.failureMessage, /mounted sha256:[0-9a-f]{64}/u);
  assert.match(result.failureMessage, /frozen sha256:[0-9a-f]{64}/u);
  assert.equal(result.assertions.length, 0);
});

test("an exhausted adapter reports exhausted and still grades", async () => {
  const harness = await createHarness();
  const exhaustedAdapter: RuntimeAdapter = {
    execute: () => Promise.resolve({
      ...closedSession,
      process: { exitCode: null, signal: "SIGKILL", timedOut: true },
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2c6", { adapter: exhaustedAdapter }));

  assert.equal(result.status, "exhausted");
  assert.equal(result.assertions.length, 1);
});

test("a process killed by a signal reports exhausted even without a timeout flag", async () => {
  const harness = await createHarness();
  const killedAdapter: RuntimeAdapter = {
    execute: () => Promise.resolve({
      ...closedSession,
      process: { exitCode: null, signal: "SIGKILL", timedOut: false },
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2ca", { adapter: killedAdapter }));

  assert.equal(result.status, "exhausted");
});

test("an adapter failure reports errored at the execute step", async () => {
  const harness = await createHarness();
  const brokenAdapter: RuntimeAdapter = {
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
  const mutatingAdapter = fixtureMutatingAdapter(harness);

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2c8", { adapter: mutatingAdapter }));

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "verify_fixture");
});

test("agent changes appear in the change set with allowed and forbidden observations", async () => {
  const harness = await createHarness();
  let workspacePath = "";
  const editingAdapter: RuntimeAdapter = {
    execute: async (input) => {
      workspacePath = input.workspace;
      await writeFile(join(input.workspace, "index.js"), "export const queued = [1];\n");
      return closedSession;
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
  const observingAdapter: RuntimeAdapter = {
    execute: (input) => {
      observed.push(input.workspace);
      return Promise.resolve(closedSession);
    },
  };

  const removed = await executeRun(runInput(harness, "20260830T175302Z-a1b2d0", { adapter: observingAdapter }));
  const preserved = await executeRun(
    runInput(harness, "20260830T175302Z-a1b2d1", { adapter: observingAdapter, keepWorkspace: true }),
  );

  assert.equal(observed.length, 2);
  await assert.rejects(access(observed[0] ?? ""), { code: "ENOENT" });
  await access(observed[1] ?? "");
  assert.equal(removed.preservedWorkspacePath, null);
  assert.equal(preserved.preservedWorkspacePath, observed[1]);

  await rm(dirname(observed[1] ?? ""), { recursive: true, force: true });
});

test("the variant material is installed before the baseline snapshot", async () => {
  const harness = await createHarness();
  let installedDuringSession = false;
  const inspectingAdapter: RuntimeAdapter = {
    execute: async (input) => {
      installedDuringSession = await access(join(input.workspace, ".agent/skills/example/SKILL.md"))
        .then(() => true)
        .catch(() => false);
      return closedSession;
    },
  };

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2d2", { adapter: inspectingAdapter }));

  assert.equal(installedDuringSession, true);
  assert.deepEqual(result.changes.added, []);
});

test("the mounted grading area is gone after a successful run", async () => {
  const harness = await createHarness();
  const tempParent = await mkdtemp(join(tmpdir(), "skillbench-execute-run-test-"));

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2d3", { tempParent }));

  assert.equal(result.status, "completed");
  assert.deepEqual(await oracleLeftovers(tempParent), []);

  await rm(tempParent, { recursive: true, force: true });
});

test("the mounted grading area is gone after a run with a failed critical assertion", async () => {
  const harness = await createHarness(async (project) => {
    await writeFile(join(project.oracleDirectory, "checks/assert-1.js"), "process.exit(9);\n");
  });
  const tempParent = await mkdtemp(join(tmpdir(), "skillbench-execute-run-test-"));

  const result = await executeRun(runInput(harness, "20260830T175302Z-a1b2d5", { tempParent }));

  assert.equal(result.status, "completed");
  assert.equal(result.assertions[0]?.outcome, "failed");
  assert.deepEqual(await oracleLeftovers(tempParent), []);

  await rm(tempParent, { recursive: true, force: true });
});

test("the mounted grading area is gone after a run that errored once the oracle was mounted", async () => {
  const harness = await createHarness();
  const tempParent = await mkdtemp(join(tmpdir(), "skillbench-execute-run-test-"));

  const result = await executeRun(
    runInput(harness, "20260830T175302Z-a1b2d6", { adapter: fixtureMutatingAdapter(harness), tempParent }),
  );

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "verify_fixture");
  assert.deepEqual(await oracleLeftovers(tempParent), []);

  await rm(tempParent, { recursive: true, force: true });
});

test("a workspace preserved by keepWorkspace carries no private oracle content", async () => {
  const harness = await createHarness();
  let workspacePath = "";
  const capturingAdapter: RuntimeAdapter = {
    execute: (input) => {
      workspacePath = input.workspace;
      return Promise.resolve(closedSession);
    },
  };

  const result = await executeRun(
    runInput(harness, "20260830T175302Z-a1b2d4", { adapter: capturingAdapter, keepWorkspace: true }),
  );

  assert.notEqual(workspacePath, "");
  assert.equal(result.preservedWorkspacePath, workspacePath);

  const privateNames = await walkTree(harness.project.oracleDirectory);
  const workspaceEntries = await walkTree(workspacePath);
  assert.ok(privateNames.files.length > 0, "the private oracle directory must contain files to compare against");
  assert.ok(workspaceEntries.files.length > 0, "the preserved workspace walk must visit files");
  for (const name of privateNames.names) {
    assert.ok(
      !workspaceEntries.names.includes(name),
      `private oracle entry ${name} appears inside the preserved workspace`,
    );
  }

  await rm(dirname(workspacePath), { recursive: true, force: true });
});

function fixtureMutatingAdapter(harness: Harness): RuntimeAdapter {
  return {
    execute: async () => {
      await writeFile(join(harness.project.fixtureDirectory, "injected.txt"), "changed\n");
      return closedSession;
    },
  };
}

async function oracleLeftovers(tempParent: string): Promise<string[]> {
  return (await readdir(tempParent)).filter((entry) => entry.startsWith("skillbench-oracle-"));
}

interface WalkedTree {
  readonly names: readonly string[];
  readonly files: readonly string[];
}

async function walkTree(root: string): Promise<WalkedTree> {
  const names: string[] = [];
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    names.push(entry.name);
    if (entry.isDirectory()) {
      const nested = await walkTree(join(root, entry.name));
      names.push(...nested.names);
      files.push(...nested.files);
      continue;
    }
    files.push(join(root, entry.name));
  }
  return { names, files };
}
