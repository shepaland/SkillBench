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
  assert.equal(results[0].critical, true);
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
  assert.match(results[0].detail, /timed out/u);
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
      spawn: () => {
        spawned = true;
        return Promise.resolve({ exitCode: 0, timedOut: false, detail: "" });
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
  assert.match(results[0].detail, /escapes/u);
});
