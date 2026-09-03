import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadCatalog, type CatalogCase, type CatalogVariant } from "../../src/catalog/load-catalog.js";
import type { AssertionDeclaration, CaseManifest, PromptStep, TranscriptRule } from "../../src/domain/model.js";
import { oracleFileSystem } from "../../src/oracles/oracle-lifecycle.js";
import { ProjectPaths } from "../../src/paths/project-paths.js";
import { executeRun, type ExecuteRunInput } from "../../src/runs/execute-run.js";
import { createRunId, defaultRunIdSuffix, runDirectory, type RunConfiguration } from "../../src/runs/freeze-inputs.js";
import type { RunResult } from "../../src/runs/result.js";
import { ManifestValidator } from "../../src/schemas/validator.js";
import { FakeAdapter, type FakeScript, type FakeScriptStep } from "../../src/runtime/fake-adapter.js";
import type { ExhaustionCause, RuntimeAdapter, RuntimeExecution, TranscriptEvent } from "../../src/runtime/runtime-adapter.js";
import { selectAdapter } from "../../src/runtime/select-adapter.js";
import { ImmutableJsonStore } from "../../src/storage/immutable-json-store.js";
import { createTempProject, writeJson, type TempProject } from "../helpers/temp-project.js";

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
  exhaustion: null,
  unparsedLines: 0,
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
  options: { readonly allowIssues?: boolean } = {},
): Promise<Harness> {
  const project = await createTempProject();
  await prepare(project);
  const catalog = await loadCatalog(project.root);
  if (options.allowIssues !== true) {
    assert.deepEqual(catalog.issues, []);
  }
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

async function runInput(harness: Harness, runId: string, overrides: RunOverrides = {}): Promise<ExecuteRunInput> {
  return {
    paths: harness.paths,
    store: harness.store,
    validator: harness.validator,
    catalogCase: harness.catalogCase,
    variant: harness.variant,
    configuration,
    adapter: overrides.adapter ?? (await selectAdapter("fake", harness.catalogCase.manifest)).adapter,
    runId,
    repetitionIndex: 0,
    ...(overrides.keepWorkspace === undefined ? {} : { keepWorkspace: overrides.keepWorkspace }),
    ...(overrides.tempParent === undefined ? {} : { tempParent: overrides.tempParent }),
  };
}

test("a successful run writes every evidence file and reports completed", async () => {
  const harness = await createHarness();

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2c3"));

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

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2c4"));

  assert.equal(result.status, "completed");
  assert.equal(result.assertions[0]?.outcome, "failed");
  assert.equal(result.assertions[0].exitCode, 7);
});

test("a missing private oracle reports errored at the grade step and keeps earlier evidence", async () => {
  const harness = await createHarness();
  await rm(harness.project.oracleDirectory, { recursive: true, force: true });

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2c5"));

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

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2db"));

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "grade");
  assert.match(result.failureMessage, /private oracle changed after freezing/u);
  assert.match(result.failureMessage, /mounted sha256:[0-9a-f]{64}/u);
  assert.match(result.failureMessage, /frozen sha256:[0-9a-f]{64}/u);
  assert.equal(result.assertions.length, 0);
});

test("a private oracle changed while the checks ran reports errored at the grade step", async () => {
  // A check runs code the measured agent wrote, so the grading directory can be
  // rewritten between the pre-run hash and the last assertion. The assertions of such
  // a run cannot be trusted, whatever they say.
  const harness = await createHarness(async (project) => {
    await writeFile(
      join(project.oracleDirectory, "checks/assert-1.js"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'writeFileSync(join(process.env.SKILLBENCH_ORACLE, "planted.txt"), "tampered\\n");',
        "process.exit(0);",
        "",
      ].join("\n"),
    );
  });

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2dc"));

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "grade");
  assert.match(result.failureMessage, /private oracle changed while the checks ran/u);
  assert.match(result.failureMessage, /mounted sha256:[0-9a-f]{64}/u);
  assert.match(result.failureMessage, /frozen sha256:[0-9a-f]{64}/u);
  assert.equal(result.assertions.length, 0);
});

/**
 * A check no longer receives the real materialized workspace directly — SKILLBENCH_WORKSPACE
 * now names a disposable copy. To reach the tree these two guard tests care about, the check
 * has to search for it, the same way the reference-tree guard assumes an attacker might: by
 * the "skillbench-workspace-" prefix materializeWorkspace uses, under a temp parent private to
 * this test so the search cannot collide with any other test's workspace.
 */
function findWorkspaceScript(tempParent: string, body: readonly string[]): string {
  return [
    'import { readdirSync, rmSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `const root = ${JSON.stringify(tempParent)};`,
    'const entry = readdirSync(root).find((name) => name.startsWith("skillbench-workspace-"));',
    'const workspace = join(root, entry, "workspace");',
    ...body,
    "process.exit(0);",
    "",
  ].join("\n");
}

test("a workspace changed while the checks ran reports errored at the grade step", async () => {
  // A check runs code the measured agent wrote, so that code can repair the workspace
  // between the final snapshot and the last assertion. The assertions then describe a
  // tree that no longer exists, so they cannot be trusted, whatever they say.
  const tempParent = await mkdtemp(join(tmpdir(), "skillbench-workspace-guard-"));
  const harness = await createHarness(async (project) => {
    await writeFile(
      join(project.oracleDirectory, "checks/assert-1.js"),
      findWorkspaceScript(tempParent, [
        'writeFileSync(join(workspace, "planted.txt"), "restored\\n");',
        'writeFileSync(join(workspace, "index.js"), "export const queued = [1];\\n");',
        'rmSync(join(workspace, ".agent/skills/example/SKILL.md"));',
      ]),
    );
  });

  try {
    const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2dd", { tempParent }));

    assert.equal(result.status, "errored");
    assert.equal(result.failedStep, "grade");
    assert.match(result.failureMessage, /the workspace changed while the checks ran/u);
    assert.match(result.failureMessage, /added planted\.txt/u);
    assert.match(result.failureMessage, /modified index\.js/u);
    assert.match(result.failureMessage, /removed \.agent\/skills\/example\/SKILL\.md/u);
    assert.equal(result.assertions.length, 0);
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
});

test("a large change set produces a bounded failure message that names the omitted count", async () => {
  // A check can plant thousands of paths in one pass. failureMessage is written verbatim
  // into result.json, a shared durable artifact, so the path list must stay bounded like
  // run-oracle's truncated `detail`, not grow without limit.
  const tempParent = await mkdtemp(join(tmpdir(), "skillbench-workspace-guard-"));
  const harness = await createHarness(async (project) => {
    await writeFile(
      join(project.oracleDirectory, "checks/assert-1.js"),
      findWorkspaceScript(tempParent, [
        "for (let i = 0; i < 2000; i += 1) {",
        '  writeFileSync(join(workspace, `planted-${String(i).padStart(4, "0")}.txt`), "tampered\\n");',
        "}",
      ]),
    );
  });

  try {
    const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2df", { tempParent }));

    assert.equal(result.status, "errored");
    assert.equal(result.failedStep, "grade");
    assert.match(result.failureMessage, /the workspace changed while the checks ran/u);
    assert.ok(
      result.failureMessage.length < 1000,
      `expected a bounded message, got ${String(result.failureMessage.length)} chars`,
    );
    assert.match(result.failureMessage, /and \d+ more paths? omitted/u);
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
});

test("reports a run whose graded copy changed while the checks ran", async () => {
  // A check cannot normally learn the reference tree's path either, but it can find it as
  // the parent of its own disposable copy: that is exactly the "search for it" attack, and
  // the guard inside runOracle has to catch it even though it fires mid-oracle, not after.
  const assertions: readonly AssertionDeclaration[] = [
    { id: "tamper", dimension: "functional", critical: false },
    { id: "after", dimension: "functional", critical: false },
  ];
  const harness = await createHarness(async (project) => {
    await writeOracleForAssertions(project, assertions);
    await writeFile(
      join(project.oracleDirectory, "checks/tamper.js"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const workspace = process.env.SKILLBENCH_WORKSPACE;",
        'writeFileSync(join(workspace, "../../reference", "index.js"), "export const queued = [1];\\n");',
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    await writeJson(project.caseManifestPath, { ...project.caseManifest, assertions });
  });

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2e0"));

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "grade");
  assert.match(result.failureMessage, /changed while the checks ran/u);
});

test("an exhausted adapter reports exhausted and still grades", async () => {
  const harness = await createHarness();
  const exhaustedAdapter: RuntimeAdapter = {
    execute: () => Promise.resolve({
      ...closedSession,
      process: { exitCode: null, signal: "SIGKILL", timedOut: true },
      usage: { inputTokens: 1, outputTokens: 1 },
      exhaustion: "wall_clock",
    }),
  };

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2c6", { adapter: exhaustedAdapter }));

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
      exhaustion: "signal",
    }),
  };

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2ca", { adapter: killedAdapter }));

  assert.equal(result.status, "exhausted");
});

test("a non-zero exit code without exhaustion reports errored at the execute step", async () => {
  const harness = await createHarness();
  const failingAdapter: RuntimeAdapter = {
    execute: () => Promise.resolve({
      ...closedSession,
      process: { exitCode: 1, signal: null, timedOut: false },
    }),
  };

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2cb", { adapter: failingAdapter }));

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "execute");
  assert.match(result.failureMessage, /exited with code 1/u);
});

test("a signal without exhaustion reports errored at the execute step", async () => {
  const harness = await createHarness();
  const signalledAdapter: RuntimeAdapter = {
    execute: () => Promise.resolve({
      ...closedSession,
      process: { exitCode: null, signal: "SIGSEGV", timedOut: false },
    }),
  };

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2cc", { adapter: signalledAdapter }));

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "execute");
  assert.match(result.failureMessage, /SIGSEGV/u);
});

test("exhaustion takes precedence over a non-zero exit code", async () => {
  const harness = await createHarness();
  const exhaustedFailingAdapter: RuntimeAdapter = {
    execute: () => Promise.resolve({
      ...closedSession,
      process: { exitCode: 1, signal: null, timedOut: true },
      exhaustion: "wall_clock",
    }),
  };

  const result = await executeRun(
    await runInput(harness, "20260830T175302Z-a1b2cd", { adapter: exhaustedFailingAdapter }),
  );

  assert.equal(result.status, "exhausted");
});

test("a raw line delivered through onRawLine reaches its evidence file", async () => {
  const harness = await createHarness();
  const rawLineAdapter: RuntimeAdapter = {
    execute: (input) => {
      input.onRawLine?.("s1", '{"event":"raw"}', "stdout");
      return Promise.resolve(closedSession);
    },
  };

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2ce", { adapter: rawLineAdapter }));

  assert.equal(result.status, "completed");
  const directory = join(harness.project.root, "runs/F01/example/20260830T175302Z-a1b2ce");
  const written = await readFile(join(directory, "raw/step-s1.jsonl"), "utf8");
  assert.equal(written, '{"event":"raw"}\n');
});

test("a stderr line reaches its own evidence file, distinct from the JSON stream", async () => {
  const harness = await createHarness();
  const noisyAdapter: RuntimeAdapter = {
    execute: (input) => {
      input.onRawLine?.("s1", '{"event":"raw"}', "stdout");
      input.onRawLine?.("s1", "error: unsupported model", "stderr");
      return Promise.resolve(closedSession);
    },
  };

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2e1", { adapter: noisyAdapter }));

  assert.equal(result.status, "completed");
  const directory = join(harness.project.root, "runs/F01/example/20260830T175302Z-a1b2e1");
  // The plain-text diagnostic is kept out of the JSON Lines file, which would no
  // longer parse if the two streams shared one file.
  assert.equal(await readFile(join(directory, "raw/step-s1.jsonl"), "utf8"), '{"event":"raw"}\n');
  assert.equal(await readFile(join(directory, "raw/step-s1.err.log"), "utf8"), "error: unsupported model\n");
});

test("a raw write failure is recorded in cleanupFailures without changing the run outcome", async () => {
  const harness = await createHarness();
  // A NUL byte makes ProjectPaths#resolveOutput reject the path inside appendRawLine's
  // queued write, without touching filesystem permissions.
  const badRawLineAdapter: RuntimeAdapter = {
    execute: (input) => {
      input.onRawLine?.("s1\0bad", '{"event":"raw"}', "stdout");
      return Promise.resolve(closedSession);
    },
  };

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2cf", { adapter: badRawLineAdapter }));

  assert.equal(result.status, "completed");
  assert.deepEqual(result.assertions.map((assertion) => assertion.outcome), ["passed"]);
  assert.ok(result.cleanupFailures.some((failure) => failure.startsWith("raw evidence:")));
});

test("an adapter cleanup failure is recorded without changing the run outcome", async () => {
  const harness = await createHarness();
  const untidyAdapter: RuntimeAdapter = {
    execute: () => Promise.resolve({
      ...closedSession,
      cleanupFailures: ["codex home /tmp/skillbench-codex-home-x: home is busy"],
    }),
  };

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2e0", { adapter: untidyAdapter }));

  assert.equal(result.status, "completed");
  assert.deepEqual(result.assertions.map((assertion) => assertion.outcome), ["passed"]);
  assert.deepEqual(result.cleanupFailures, ["codex home /tmp/skillbench-codex-home-x: home is busy"]);
});

test("an adapter failure reports errored at the execute step", async () => {
  const harness = await createHarness();
  const brokenAdapter: RuntimeAdapter = {
    execute: () => {
      throw new Error("adapter crashed");
    },
  };

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2c7", { adapter: brokenAdapter }));

  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "execute");
  assert.match(result.failureMessage, /adapter crashed/u);
});

test("a source fixture change during the run reports errored at the fixture verification step", async () => {
  const harness = await createHarness();
  const mutatingAdapter = fixtureMutatingAdapter(harness);

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2c8", { adapter: mutatingAdapter }));

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

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2c9", { adapter: editingAdapter }));

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

  const removed = await executeRun(await runInput(harness, "20260830T175302Z-a1b2d0", { adapter: observingAdapter }));
  const preserved = await executeRun(
    await runInput(harness, "20260830T175302Z-a1b2d1", { adapter: observingAdapter, keepWorkspace: true }),
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

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2d2", { adapter: inspectingAdapter }));

  assert.equal(installedDuringSession, true);
  assert.deepEqual(result.changes.added, []);
});

test("the mounted grading area is gone after a successful run", async () => {
  const harness = await createHarness();
  const tempParent = await mkdtemp(join(tmpdir(), "skillbench-execute-run-test-"));

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2d3", { tempParent }));

  assert.equal(result.status, "completed");
  assert.deepEqual(await oracleLeftovers(tempParent), []);

  await rm(tempParent, { recursive: true, force: true });
});

test("the mounted grading area is gone after a run with a failed critical assertion", async () => {
  const harness = await createHarness(async (project) => {
    await writeFile(join(project.oracleDirectory, "checks/assert-1.js"), "process.exit(9);\n");
  });
  const tempParent = await mkdtemp(join(tmpdir(), "skillbench-execute-run-test-"));

  const result = await executeRun(await runInput(harness, "20260830T175302Z-a1b2d5", { tempParent }));

  assert.equal(result.status, "completed");
  assert.equal(result.assertions[0]?.outcome, "failed");
  assert.deepEqual(await oracleLeftovers(tempParent), []);

  await rm(tempParent, { recursive: true, force: true });
});

test("the mounted grading area is gone after a run that errored once the oracle was mounted", async () => {
  const harness = await createHarness();
  const tempParent = await mkdtemp(join(tmpdir(), "skillbench-execute-run-test-"));

  const result = await executeRun(
    await runInput(harness, "20260830T175302Z-a1b2d6", { adapter: fixtureMutatingAdapter(harness), tempParent }),
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
    await runInput(harness, "20260830T175302Z-a1b2d4", { adapter: capturingAdapter, keepWorkspace: true }),
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

test("grades a transcript assertion at the continuation point, not over the whole transcript", async () => {
  // Case: step s1 declares continuation rule "stopped" (no_file_change); assertion A2
  // is graded from it. The file change happens during s2, AFTER s1's continuation
  // point. A correct implementation evaluates the gated rule only against the events
  // recorded up to the continuation, so it sees no file change and the rule holds; an
  // "evaluate everything at session end" implementation would instead see the later
  // file change and wrongly flip the assertion to failed. transcriptRuleOutcomes.length
  // alone can't distinguish the two (both produce exactly one outcome), so this test
  // asserts on the outcome's value, not just its presence.
  const result = await runWithScript({
    transcriptRules: [{ id: "stopped", check: "no_file_change" }],
    assertions: [
      { id: "A1", dimension: "functional", critical: true },
      { id: "A2", dimension: "process", critical: false, transcriptRuleId: "stopped" },
    ],
    promptSteps: [
      { id: "s1", prompt: "ask first", continuation: { eventRuleIds: ["stopped"] } },
      { id: "s2", prompt: "now do it" },
    ],
    scriptSteps: [
      { stepId: "s1", events: [] },
      { stepId: "s2", events: [{ type: "file_change", afterMs: 1, paths: ["src/a.js"], outsidePaths: [] }] },
    ],
  });

  const graded = result.assertions.find((assertion) => assertion.assertionId === "A2");
  assert.equal(graded?.outcome, "passed");
  assert.equal(graded.source, "transcript");
  assert.equal(result.assertions.find((assertion) => assertion.assertionId === "A1")?.source, "oracle");
  assert.equal(result.transcriptRuleOutcomes.length, 1);
  assert.equal(result.transcriptRuleOutcomes[0]?.satisfied, true);
  assert.equal(result.events.filter((event) => event.type === "prompt_sent").length, 2);
});

test("records a failed continuation rule as a failed assertion and still sends every step", async () => {
  // Same wiring as above, but the file change happens during s1, before its own
  // continuation point, so the "no file change" rule is violated there.
  const result = await runWithScript({
    transcriptRules: [{ id: "stopped", check: "no_file_change" }],
    assertions: [
      { id: "A1", dimension: "functional", critical: true },
      { id: "A2", dimension: "process", critical: false, transcriptRuleId: "stopped" },
    ],
    promptSteps: [
      { id: "s1", prompt: "ask first", continuation: { eventRuleIds: ["stopped"] } },
      { id: "s2", prompt: "now do it" },
    ],
    scriptSteps: [
      { stepId: "s1", events: [{ type: "file_change", afterMs: 1, paths: ["src/a.js"], outsidePaths: [] }] },
      { stepId: "s2", events: [] },
    ],
  });

  const graded = result.assertions.find((assertion) => assertion.assertionId === "A2");
  assert.equal(graded?.outcome, "failed");
  assert.equal(graded.source, "transcript");
  // The violation does not stop the run: both declared steps were sent.
  assert.equal(result.events.filter((event) => event.type === "prompt_sent").length, 2);
});

test("evaluates an unreferenced rule after the session closes", async () => {
  const result = await runWithScript({
    transcriptRules: [{ id: "spoke", check: "assistant_message" }],
    assertions: [{ id: "A1", dimension: "functional", critical: true }],
    promptSteps: [{ id: "s1", prompt: "go" }],
    scriptSteps: [{ stepId: "s1", events: [{ type: "assistant_message", afterMs: 1, text: "hi" }] }],
  });

  assert.deepEqual(
    result.transcriptRuleOutcomes.map((outcome) => [outcome.ruleId, outcome.satisfied]),
    [["spoke", true]],
  );
});

test("grades a rule whose continuation is declared on the final step exactly once", async () => {
  // Nothing forbids a continuation on the last prompt step, and the after-session
  // sweep must not evaluate such a rule a second time over a wider window: the file
  // change here happens before the continuation point, so a single evaluation fails
  // the rule, while a second one would append a duplicate outcome.
  const result = await runWithScript({
    transcriptRules: [{ id: "stopped", check: "no_file_change" }],
    assertions: [
      { id: "A1", dimension: "functional", critical: true },
      { id: "A2", dimension: "process", critical: false, transcriptRuleId: "stopped" },
    ],
    promptSteps: [
      { id: "s1", prompt: "ask first" },
      { id: "s2", prompt: "now do it", continuation: { eventRuleIds: ["stopped"] } },
    ],
    scriptSteps: [
      { stepId: "s1", events: [] },
      { stepId: "s2", events: [{ type: "file_change", afterMs: 1, paths: ["src/a.js"], outsidePaths: [] }] },
    ],
  });

  assert.equal(result.transcriptRuleOutcomes.length, 1);
  const graded = result.assertions.find((assertion) => assertion.assertionId === "A2");
  assert.equal(graded?.outcome, "failed");
});

test("evaluates a gated rule whose continuation point was never reached", async () => {
  // The runtime ended the session after the first step, so no continuation ever fired.
  // The gated rule must still be evaluated over the full transcript at session close;
  // leaving it out reports a correct run as an error on the assertion it grades.
  const endedEarly: RuntimeAdapter = {
    execute: () => Promise.resolve({
      ...closedSession,
      events: [
        { type: "session_started", atMs: 0 },
        { type: "prompt_sent", atMs: 1, stepId: "s1", text: "ask first" },
        { type: "assistant_message", atMs: 2, text: "here is my plan" },
        { type: "session_closed", atMs: 3 },
      ],
    }),
  };

  const result = await runWithScript({
    adapter: endedEarly,
    transcriptRules: [{ id: "spoke", check: "assistant_message" }],
    assertions: [
      { id: "A1", dimension: "functional", critical: true },
      { id: "A2", dimension: "process", critical: false, transcriptRuleId: "spoke" },
    ],
    promptSteps: [
      { id: "s1", prompt: "ask first", continuation: { eventRuleIds: ["spoke"] } },
      { id: "s2", prompt: "now do it" },
    ],
  });

  assert.deepEqual(
    result.transcriptRuleOutcomes.map((outcome) => [outcome.ruleId, outcome.satisfied]),
    [["spoke", true]],
  );
  const graded = result.assertions.find((assertion) => assertion.assertionId === "A2");
  assert.equal(graded?.outcome, "passed");
  assert.equal(result.status, "completed");
});

test("reports a transcript assertion as an error when its rule was never evaluated", async () => {
  // Defensive path: catalog validation rejects an assertion naming an undeclared rule,
  // so only a bypassed validation can bring this shape here. Every declared rule is
  // covered by the after-session sweep, so a declared rule can no longer land here.
  const result = await runWithScript({
    allowCatalogIssues: true,
    transcriptRules: [{ id: "spoke", check: "assistant_message" }],
    assertions: [
      { id: "A1", dimension: "functional", critical: true },
      { id: "A2", dimension: "process", critical: false, transcriptRuleId: "ghost" },
    ],
    promptSteps: [{ id: "s1", prompt: "go" }],
    scriptSteps: [{ stepId: "s1", events: [] }],
  });

  const graded = result.assertions.find((assertion) => assertion.assertionId === "A2");
  assert.equal(graded?.outcome, "error");
  assert.equal(graded.source, "transcript");
  assert.match(graded.detail, /transcript rule ghost was never evaluated/u);
  assert.equal(result.status, "completed");
});

test("reads the exhaustion cause from the adapter instead of guessing", async () => {
  const result = await runWithScript({ exhaustion: "wall_clock" });
  assert.equal(result.status, "exhausted");

  const finished = await runWithScript({ exhaustion: null, usage: { inputTokens: 5000, outputTokens: 5000 } });
  assert.equal(finished.status, "completed");
});

test("attributes an oracle lifecycle fault to the oracle_setup step", async () => {
  // OracleLifecycle.create runs before the adapter is ever invoked; a failure there
  // must be attributed to oracle_setup, not execute.
  const result = await runWithFailingOracleLifecycle();
  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "oracle_setup");
});

function fixtureMutatingAdapter(harness: Harness): RuntimeAdapter {
  return {
    execute: async () => {
      await writeFile(join(harness.project.fixtureDirectory, "injected.txt"), "changed\n");
      return closedSession;
    },
  };
}

interface ScriptCase {
  readonly transcriptRules?: readonly TranscriptRule[];
  readonly assertions?: readonly AssertionDeclaration[];
  readonly promptSteps?: readonly PromptStep[];
  readonly scriptSteps?: readonly FakeScriptStep[];
  readonly exhaustion?: ExhaustionCause | null;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | null;
  /** Replaces the scripted fake adapter, for cases that need a runtime the fake cannot express. */
  readonly adapter?: RuntimeAdapter;
  /** Allows a deliberately invalid case manifest through catalog loading. */
  readonly allowCatalogIssues?: boolean;
}

/**
 * Assembles a temporary project whose case manifest is built from the given fields
 * (falling back to the default case's fixture, limits, and change paths), runs it
 * through a FakeAdapter driven by `scriptSteps`, and returns the written result
 * together with the events recorded in transcript.json.
 */
async function runWithScript(script: ScriptCase): Promise<RunResult & { readonly events: readonly TranscriptEvent[] }> {
  const harness = await createHarness(async (project) => {
    if (script.assertions !== undefined) {
      await writeOracleForAssertions(project, script.assertions);
    }
    if (script.promptSteps !== undefined || script.transcriptRules !== undefined || script.assertions !== undefined) {
      const manifest: CaseManifest = {
        ...project.caseManifest,
        ...(script.promptSteps === undefined ? {} : { promptSteps: script.promptSteps }),
        ...(script.transcriptRules === undefined ? {} : { transcriptRules: script.transcriptRules }),
        ...(script.assertions === undefined ? {} : { assertions: script.assertions }),
      };
      await writeJson(project.caseManifestPath, manifest);
    }
  }, script.allowCatalogIssues === true ? { allowIssues: true } : {});

  const scriptSteps = script.scriptSteps ??
    harness.catalogCase.manifest.promptSteps.map((step) => ({ stepId: step.id, events: [] }));
  const fakeScript: FakeScript = {
    steps: scriptSteps,
    closeAfterMs: 5,
    process: { exitCode: 0, signal: null, timedOut: false },
    usage: script.usage === undefined ? { inputTokens: 100, outputTokens: 100 } : script.usage,
    metadata: { runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
    exhaustion: script.exhaustion ?? null,
  };
  const adapter = script.adapter ?? new FakeAdapter(fakeScript);

  const runId = createRunId(new Date(), defaultRunIdSuffix());
  const result = await executeRun(await runInput(harness, runId, { adapter }));

  const transcript = JSON.parse(
    await readFile(join(harness.project.root, runDirectory(result.manifest), "transcript.json"), "utf8"),
  ) as { readonly events: readonly TranscriptEvent[] };

  return { ...result, events: transcript.events };
}

/**
 * Forces OracleLifecycle.create to fail by breaking the shared oracleFileSystem
 * testing seam it defaults to. materializeWorkspace never touches this object (it
 * has its own file system with no realpath), so materialize/install/baseline_snapshot
 * stay green and the failure surfaces only once the pipeline reaches oracle_setup.
 * OracleLifecycle.create resolves the workspace path first and its temp parent
 * second, so only the second call is made to fail.
 */
async function runWithFailingOracleLifecycle(): Promise<RunResult> {
  const harness = await createHarness();
  const originalRealpath = oracleFileSystem.realpath.bind(oracleFileSystem);
  let realpathCalls = 0;
  oracleFileSystem.realpath = async (path: string): Promise<string> => {
    realpathCalls += 1;
    if (realpathCalls === 2) {
      throw new Error("private oracle temporary parent is unavailable");
    }
    return originalRealpath(path);
  };
  try {
    const runId = createRunId(new Date(), defaultRunIdSuffix());
    return await executeRun(await runInput(harness, runId));
  } finally {
    oracleFileSystem.realpath = originalRealpath;
  }
}

async function writeOracleForAssertions(
  project: TempProject,
  assertions: readonly AssertionDeclaration[],
): Promise<void> {
  const oracleGraded = assertions.filter((assertion) => assertion.transcriptRuleId === undefined);
  const checksDirectory = join(project.oracleDirectory, "checks");
  await rm(checksDirectory, { recursive: true, force: true });
  await mkdir(checksDirectory, { recursive: true });
  for (const assertion of oracleGraded) {
    await writeFile(join(checksDirectory, `${assertion.id}.js`), "process.exit(0);\n");
  }
  await writeJson(project.oracleManifestPath, {
    schemaVersion: 1,
    caseId: "F01",
    checks: oracleGraded.map((assertion) => ({
      assertionId: assertion.id,
      command: { executor: "node", args: [`${assertion.id}.js`] },
      workingDirectory: "checks",
      timeoutMs: 10_000,
    })),
  });
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
