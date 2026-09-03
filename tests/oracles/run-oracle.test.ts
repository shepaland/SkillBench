import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ValidationError } from "../../src/domain/errors.js";
import { FileLifecycleError } from "../../src/domain/file-lifecycle-error.js";
import type { AssertionDeclaration, OracleManifest } from "../../src/domain/model.js";
import { createGradingArea } from "../../src/oracles/grading-area.js";
import { runOracle } from "../../src/oracles/run-oracle.js";
import { snapshotTree } from "../../src/runs/snapshot.js";

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

async function createOracleFixture(): Promise<{ gradingPath: string }> {
  const gradingPath = await mkdtemp(join(tmpdir(), "skillbench-grading-"));
  await mkdir(join(gradingPath, "checks"), { recursive: true });
  await writeFile(
    join(gradingPath, "checks/pass.js"),
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "const workspace = process.env.SKILLBENCH_WORKSPACE ?? '';\n" +
      "process.exit(readFileSync(join(workspace, 'marker.txt'), 'utf8') === 'present\\n' ? 0 : 3);\n",
  );
  await writeFile(
    join(gradingPath, "checks/fail.js"),
    "process.stderr.write('expected queued to contain 42\\n');\nprocess.exit(4);\n",
  );
  await writeFile(join(gradingPath, "checks/hang.js"), "setTimeout(() => {}, 60_000);\n");
  await writeFile(join(gradingPath, "package.json"), '{ "type": "module" }\n');
  return { gradingPath };
}

/** A real grading area over a one-file workspace, plus the workspace path. */
async function createArea(): Promise<{ area: Awaited<ReturnType<typeof createGradingArea>>; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "skillbench-graded-workspace-"));
  await writeFile(join(workspace, "marker.txt"), "present\n");
  const area = await createGradingArea({ workspacePath: workspace, snapshot: await snapshotTree(workspace) });
  return { area, workspace };
}

test("maps exit codes to passed and failed and reads the workspace through the environment", async () => {
  const { gradingPath } = await createOracleFixture();
  const { area } = await createArea();
  const manifest: OracleManifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [check("pass-check", "pass.js"), check("fail-check", "fail.js")],
  };

  try {
    const results = await runOracle({ manifest, assertions, gradingPath, gradingArea: area });

    assert.deepEqual(results.map((result) => [result.assertionId, result.outcome, result.exitCode]), [
      ["pass-check", "passed", 0],
      ["fail-check", "failed", 4],
    ]);
    assert.equal(results[0]?.dimension, "functional");
    assert.equal(results[0].critical, true);
    assert.equal(results[1]?.critical, false);
    // A failing check names private expected values on its own streams, so no
    // captured output may reach the persisted result.
    assert.equal(results[0].detail, "");
    assert.equal(results[1].detail, "");
  } finally {
    await area.cleanup();
  }
});

test("a timeout produces error for that assertion only", async () => {
  const { gradingPath } = await createOracleFixture();
  const { area } = await createArea();
  const manifest: OracleManifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [
      { ...check("pass-check", "hang.js"), timeoutMs: 200 },
      check("fail-check", "fail.js"),
    ],
  };

  try {
    const results = await runOracle({ manifest, assertions, gradingPath, gradingArea: area });

    assert.equal(results[0]?.outcome, "error");
    assert.match(results[0].detail, /timed out/u);
    assert.equal(results[1]?.outcome, "failed");
  } finally {
    await area.cleanup();
  }
});

test("a check that cannot be spawned produces error and the other checks still run", async () => {
  const { gradingPath } = await createOracleFixture();
  const { area } = await createArea();
  const manifest: OracleManifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [check("pass-check", "pass.js"), check("fail-check", "fail.js")],
  };
  let call = 0;

  try {
    const results = await runOracle({
      manifest,
      assertions,
      gradingPath,
      gradingArea: area,
      spawn: () => {
        call += 1;
        if (call === 1) {
          throw new Error("spawn ENOENT");
        }
        return Promise.resolve({ exitCode: 0, timedOut: false, detail: "" });
      },
    });

    assert.equal(results[0]?.outcome, "error");
    assert.match(results[0].detail, /spawn ENOENT/u);
    assert.equal(results[1]?.outcome, "passed");
  } finally {
    await area.cleanup();
  }
});

test("results are ordered by the case assertion order, not the oracle order", async () => {
  const { gradingPath } = await createOracleFixture();
  const { area } = await createArea();
  const manifest: OracleManifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [check("fail-check", "fail.js"), check("pass-check", "pass.js")],
  };

  try {
    const results = await runOracle({ manifest, assertions, gradingPath, gradingArea: area });

    assert.deepEqual(results.map((result) => result.assertionId), ["pass-check", "fail-check"]);
  } finally {
    await area.cleanup();
  }
});

test("refuses to execute when the oracle does not cover every declared assertion", async () => {
  const { gradingPath } = await createOracleFixture();
  const { area } = await createArea();
  const manifest: OracleManifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [check("pass-check", "pass.js")],
  };
  let spawned = false;

  try {
    await assert.rejects(
      runOracle({
        manifest,
        assertions,
        gradingPath,
        gradingArea: area,
        spawn: () => {
          spawned = true;
          return Promise.resolve({ exitCode: 0, timedOut: false, detail: "" });
        },
      }),
      (error: unknown) => error instanceof ValidationError,
    );
    assert.equal(spawned, false);
  } finally {
    await area.cleanup();
  }
});

test("rejects a working directory that escapes the grading area", async () => {
  const { gradingPath } = await createOracleFixture();
  const { area } = await createArea();
  const manifest = {
    schemaVersion: 1,
    caseId: "F01",
    checks: [
      { ...check("pass-check", "pass.js"), workingDirectory: "checks/../../escape" },
      check("fail-check", "fail.js"),
    ],
  } as OracleManifest;

  try {
    const results = await runOracle({ manifest, assertions, gradingPath, gradingArea: area });

    assert.equal(results[0]?.outcome, "error");
    assert.match(results[0].detail, /escapes/u);
  } finally {
    await area.cleanup();
  }
});

test("hands each check its own copy and never the reference tree", async () => {
  const { gradingPath } = await createOracleFixture();
  const { area } = await createArea();
  await writeFile(
    join(gradingPath, "checks/record.js"),
    "import { appendFileSync } from 'node:fs';\n" +
      "import { writeFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "const workspace = process.env.SKILLBENCH_WORKSPACE ?? '';\n" +
      "appendFileSync(process.env.RECORD_PATH, `${workspace}\\n`);\n" +
      "writeFileSync(join(workspace, 'marker.txt'), 'tampered\\n');\n" +
      "process.exit(0);\n",
  );
  // Kept outside the grading directory: a check that wrote here instead would trip the
  // new "the mounted oracle changed while the checks ran" guard between the first check
  // and the second, which this test is not exercising.
  const recordScratch = await mkdtemp(join(tmpdir(), "skillbench-run-oracle-record-"));
  const recordPath = join(recordScratch, "seen.txt");
  process.env.RECORD_PATH = recordPath;

  try {
    const results = await runOracle({
      manifest: {
        schemaVersion: 1,
        caseId: "T01",
        checks: [check("pass-check", "record.js"), check("fail-check", "record.js")],
      } satisfies OracleManifest,
      assertions,
      gradingPath,
      gradingArea: area,
    });

    assert.deepEqual(results.map(({ outcome }) => outcome), ["passed", "passed"]);
    const seen = (await readFile(recordPath, "utf8")).trim().split("\n");
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1], "each check must receive its own copy");
    assert.notEqual(seen[0], area.referencePath);
    // The first check overwrote its own copy; the reference is untouched, which is what
    // the second check was built from and what the run is graded against.
    await area.verifyMaterial();
  } finally {
    delete process.env.RECORD_PATH;
    await rm(recordScratch, { recursive: true, force: true });
    await area.cleanup();
  }
});

test("names the workspace copy, the oracle, and the evidence directory in the environment", async () => {
  const { gradingPath } = await createOracleFixture();
  const { area } = await createArea();
  await writeFile(
    join(gradingPath, "checks/environment.js"),
    "import { existsSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "const workspace = process.env.SKILLBENCH_WORKSPACE ?? '';\n" +
      "const oracle = process.env.SKILLBENCH_ORACLE ?? '';\n" +
      "const evidence = process.env.SKILLBENCH_EVIDENCE ?? '';\n" +
      "const ok = existsSync(join(workspace, 'marker.txt')) && existsSync(join(oracle, 'checks')) " +
      "&& existsSync(join(evidence, 'workspace.json'));\n" +
      "process.exit(ok ? 0 : 5);\n",
  );

  try {
    const results = await runOracle({
      manifest: { schemaVersion: 1, caseId: "T01", checks: [check("pass-check", "environment.js")] } satisfies OracleManifest,
      assertions: assertions.slice(0, 1),
      gradingPath,
      gradingArea: area,
    });
    assert.equal(results[0]?.outcome, "passed");
  } finally {
    await area.cleanup();
  }
});

test("stops the run when the reference tree changed between two checks", async () => {
  const { gradingPath } = await createOracleFixture();
  const { area } = await createArea();
  await writeFile(
    join(gradingPath, "checks/tamper.js"),
    "import { writeFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      // A check cannot normally learn this path; the test supplies it to prove the guard
      // fires even against an attacker who has found it.
      "writeFileSync(join(process.env.REFERENCE_PATH, 'marker.txt'), 'repaired\\n');\n" +
      "process.exit(0);\n",
  );
  process.env.REFERENCE_PATH = area.referencePath;

  try {
    await assert.rejects(
      () =>
        runOracle({
          manifest: {
            schemaVersion: 1,
            caseId: "T01",
            checks: [check("pass-check", "tamper.js"), check("fail-check", "fail.js")],
          } satisfies OracleManifest,
          assertions,
          gradingPath,
          gradingArea: area,
        }),
      (error: unknown) => error instanceof FileLifecycleError && error.code === "CONTENT_HASH_MISMATCH",
    );
  } finally {
    delete process.env.REFERENCE_PATH;
    await area.cleanup();
  }
});

test("stops the run when the mounted oracle changes between two checks", async () => {
  const { gradingPath } = await createOracleFixture();
  const { area } = await createArea();
  await writeFile(
    join(gradingPath, "checks/tamper-oracle.js"),
    "import { writeFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      // A check legitimately receives SKILLBENCH_ORACLE; this check simply misuses it.
      "writeFileSync(join(process.env.SKILLBENCH_ORACLE, 'planted.txt'), 'tampered\\n');\n" +
      "process.exit(0);\n",
  );
  // Kept outside the grading directory, like the record path above: this check proves
  // the run never reaches the second check, so it must not itself trip the guard it is
  // used to observe.
  const recordScratch = await mkdtemp(join(tmpdir(), "skillbench-run-oracle-record-"));
  const recordPath = join(recordScratch, "second-check-ran.txt");
  await writeFile(
    join(gradingPath, "checks/record-ran.js"),
    "import { writeFileSync } from 'node:fs';\n" +
      "writeFileSync(process.env.RECORD_PATH, 'ran\\n');\n" +
      "process.exit(0);\n",
  );
  process.env.RECORD_PATH = recordPath;

  try {
    await assert.rejects(
      () =>
        runOracle({
          manifest: {
            schemaVersion: 1,
            caseId: "T01",
            checks: [check("pass-check", "tamper-oracle.js"), check("fail-check", "record-ran.js")],
          } satisfies OracleManifest,
          assertions,
          gradingPath,
          gradingArea: area,
        }),
      (error: unknown) =>
        error instanceof FileLifecycleError &&
        error.code === "CONTENT_HASH_MISMATCH" &&
        error.message.includes("the mounted oracle changed while the checks ran") &&
        error.message.includes(gradingPath),
    );
    // The second check would have written `recordPath` if it ran; its absence is what
    // confirms the guard fired before it, not after both checks completed.
    await assert.rejects(() => stat(recordPath));
  } finally {
    delete process.env.RECORD_PATH;
    await rm(recordScratch, { recursive: true, force: true });
    await area.cleanup();
  }
});

test("stops the run when the mounted oracle changes during the final check", async () => {
  const { gradingPath } = await createOracleFixture();
  const { area } = await createArea();
  await writeFile(
    join(gradingPath, "checks/tamper-oracle.js"),
    "import { writeFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "writeFileSync(join(process.env.SKILLBENCH_ORACLE, 'planted.txt'), 'tampered\\n');\n" +
      "process.exit(0);\n",
  );

  try {
    await assert.rejects(
      () =>
        runOracle({
          manifest: {
            schemaVersion: 1,
            caseId: "T01",
            checks: [check("pass-check", "tamper-oracle.js")],
          } satisfies OracleManifest,
          // A single check: the only place left for the guard to catch this tamper is
          // the verification after the loop, since none of it happened before the check
          // (the pre-check hash still matched) and there is no later check to catch it.
          assertions: assertions.slice(0, 1),
          gradingPath,
          gradingArea: area,
        }),
      (error: unknown) =>
        error instanceof FileLifecycleError &&
        error.code === "CONTENT_HASH_MISMATCH" &&
        error.message.includes("the mounted oracle changed while the checks ran"),
    );
  } finally {
    await area.cleanup();
  }
});
