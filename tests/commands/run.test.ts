import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runRun } from "../../src/commands/run.js";
import { DependencyError, FindingError, InvocationError } from "../../src/domain/errors.js";
import { hashTree } from "../../src/integrity/content-hash.js";
import { createTempProject, writeJson } from "../helpers/temp-project.js";

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

test("a run against the fake runtime writes no raw/ directory", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  await runRun(options(project.root), io, () => new Date("2026-08-30T17:53:02.000Z"), sequentialSuffixes());

  const runDirectories = await readdir(join(project.root, "runs/F01/example"));
  const runDirectory = join(project.root, "runs/F01/example", runDirectories[0] ?? "");
  const entries = await readdir(runDirectory);
  assert.ok(!entries.includes("raw"));
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

test("a later run still executes after an earlier run fails", async () => {
  const project = await createTempProject();
  await writeFile(join(project.oracleDirectory, "checks/assert-1.js"), "process.exit(9);\n");
  const { io } = createIo();

  await assert.rejects(
    runRun(options(project.root, { runs: "2" }), io, () => new Date("2026-08-30T17:53:02.000Z"), sequentialSuffixes()),
    (error: unknown) => error instanceof FindingError && error.exitCode === 1,
  );

  const directories = await readdir(join(project.root, "runs/F01/example"));
  assert.equal(directories.length, 2);
});

test("a later run still executes after an earlier run errors", async () => {
  const project = await createTempProject();
  // The example variant installs into .agent/skills/example for the fake
  // runtime. Pre-existing that path inside the fixture means every
  // materialized workspace already has that destination occupied, so the
  // install step fails independently on every repetition without needing
  // any mutation during the run.
  const conflictDirectory = join(project.fixtureDirectory, ".agent/skills/example");
  await mkdir(conflictDirectory, { recursive: true });
  await writeFile(join(conflictDirectory, "marker.txt"), "conflict\n");

  const fixtureHash = await hashTree(project.fixtureDirectory);
  await writeJson(project.caseManifestPath, {
    ...project.caseManifest,
    fixture: { ...project.caseManifest.fixture, contentHash: fixtureHash },
  });

  const { io } = createIo();

  await assert.rejects(
    runRun(options(project.root, { runs: "2" }), io, () => new Date("2026-08-30T17:53:02.000Z"), sequentialSuffixes()),
    (error: unknown) => error instanceof DependencyError && error.exitCode === 2,
  );

  const directories = await readdir(join(project.root, "runs/F01/example"));
  assert.equal(directories.length, 2);
});

test("--keep-workspace preserves the workspace and prints its path", async () => {
  const project = await createTempProject();
  const json = createIo();

  await runRun(
    options(project.root, { keepWorkspace: true, json: true }),
    json.io,
    () => new Date("2026-08-30T17:53:02.000Z"),
    sequentialSuffixes(),
  );

  const parsed = JSON.parse(json.stdout()) as { runs: { preservedWorkspacePath: string | null }[] };
  const preserved = parsed.runs[0]?.preservedWorkspacePath ?? null;
  assert.notEqual(preserved, null);
  await access(preserved ?? "");

  const text = createIo();
  await runRun(
    options(project.root, { keepWorkspace: true }),
    text.io,
    () => new Date("2026-08-30T17:53:03.000Z"),
    sequentialSuffixes(),
  );
  assert.match(text.stdout(), /workspace preserved at \//u);

  await rm(dirname(preserved ?? ""), { recursive: true, force: true });
  const printed = /workspace preserved at (?<path>.+)\n/u.exec(text.stdout())?.groups?.["path"] ?? "";
  await rm(dirname(printed), { recursive: true, force: true });
});

test(
  "a run that cannot remove its grading area raises a dependency error",
  {
    skip: process.platform === "win32" || process.getuid?.() === 0
      ? "POSIX directory permissions enforced for a non-root user are required"
      : false,
  },
  async () => {
    const project = await createTempProject();
    const tempParent = await mkdtemp(join(tmpdir(), "skillbench-run-cleanup-"));
    // The check locks the grading root it runs inside, so removing that root
    // afterwards fails and the run leaves private material on disk.
    await writeFile(
      join(project.oracleDirectory, "checks/lock.cjs"),
      "const { chmodSync } = require('node:fs');\n" +
        "const { dirname } = require('node:path');\n" +
        "chmodSync(dirname(process.env.SKILLBENCH_ORACLE), 0o500);\n" +
        "process.exit(0);\n",
    );
    await writeJson(join(project.oracleDirectory, "oracle.json"), {
      schemaVersion: 1,
      caseId: "F01",
      checks: [
        {
          assertionId: "assert-1",
          command: { executor: "node", args: ["lock.cjs"] },
          workingDirectory: "checks",
          timeoutMs: 10_000,
        },
      ],
    });
    const { io, stdout, stderr } = createIo();

    try {
      await assert.rejects(
        runRun(
          options(project.root, { tempParent }),
          io,
          () => new Date("2026-08-30T17:53:02.000Z"),
          sequentialSuffixes(),
        ),
        (error: unknown) => error instanceof DependencyError && error.exitCode === 2,
      );
      // The run itself stays truthful: only the leftover material is an error.
      assert.match(stdout(), /completed/u);
      assert.match(stderr(), /cleanup failures/u);
    } finally {
      for (const entry of await readdir(tempParent)) {
        await chmod(join(tempParent, entry), 0o700);
      }
      await rm(tempParent, { recursive: true, force: true });
    }
  },
);
