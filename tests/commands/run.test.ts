import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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
  // Catalog resolution (and its oracle coverage checks) happens once before the
  // repetition loop, so the oracle manifest must still be valid at that point.
  // Corrupt it on the first clock() call, which fires inside the loop, so each
  // repetition's grade step fails independently instead of the run being
  // rejected before any repetition executes.
  let oracleCorrupted = false;
  const clock = () => {
    if (!oracleCorrupted) {
      oracleCorrupted = true;
      writeFileSync(join(project.oracleDirectory, "oracle.json"), "{ not json\n");
    }
    return new Date("2026-08-30T17:53:02.000Z");
  };

  await assert.rejects(
    runRun(options(project.root, { runs: "2" }), io, clock, sequentialSuffixes()),
    (error: unknown) => error instanceof DependencyError && error.exitCode === 2,
  );

  const directories = await readdir(join(project.root, "runs/F01/example"));
  assert.equal(directories.length, 2);
});
