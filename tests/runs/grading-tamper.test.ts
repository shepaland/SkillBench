import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGradingArea } from "../../src/oracles/grading-area.js";
import { runOracle } from "../../src/oracles/run-oracle.js";
import type { AssertionDeclaration, OracleManifest } from "../../src/domain/model.js";
import { snapshotTree } from "../../src/runs/snapshot.js";

const assertions: readonly AssertionDeclaration[] = [
  { id: "repair", dimension: "functional", critical: false },
  { id: "scope", dimension: "scope", critical: true },
];

// The hash of the value the repair check fakes forbidden.txt back to. It is reachable only
// if the evidence pipeline is broken and workspace.json ends up describing a repaired tree
// instead of the one recorded before any check ran — which is exactly what these tests must
// be able to tell apart from "the isolation held".
const repairedHash = createHash("sha256").update("original\n").digest("hex");

/**
 * The Stage 5A attack: agent-authored code running inside a check repairs the tree so a
 * later check sees a tidy one. Under the current design the repair reaches only the
 * repairing check's own copy, and the scope check reads a description recorded before
 * any check ran.
 */
test("a check that repairs its workspace cannot turn the scope assertion green", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "skillbench-tamper-workspace-"));
  await writeFile(join(workspace, "forbidden.txt"), "edited by the agent\n");

  const gradingPath = await mkdtemp(join(tmpdir(), "skillbench-tamper-oracle-"));
  await mkdir(join(gradingPath, "checks"), { recursive: true });
  await writeFile(join(gradingPath, "package.json"), '{ "type": "module" }\n');
  await writeFile(
    join(gradingPath, "checks/repair.js"),
    "import { writeFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "writeFileSync(join(process.env.SKILLBENCH_WORKSPACE, 'forbidden.txt'), 'original\\n');\n" +
      "process.exit(0);\n",
  );
  await writeFile(
    join(gradingPath, "checks/scope.js"),
    "import { readFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "const evidence = JSON.parse(readFileSync(join(process.env.SKILLBENCH_EVIDENCE, 'workspace.json'), 'utf8'));\n" +
      "const expected = 'sha256:' + process.env.EXPECTED_HASH;\n" +
      "process.exit(evidence.files['forbidden.txt'] === expected ? 0 : 1);\n",
  );

  const snapshot = await snapshotTree(workspace);
  const area = await createGradingArea({ workspacePath: workspace, snapshot });
  // The value the repair check fakes the file back to. If the evidence pipeline regenerated
  // workspace.json from the repaired tree instead of the untouched one, this is exactly the
  // hash that would wrongly match — which is what makes this assertion worth making.
  process.env.EXPECTED_HASH = repairedHash;

  try {
    const results = await runOracle({
      manifest: {
        schemaVersion: 1,
        caseId: "T01",
        checks: [
          { assertionId: "repair", command: { executor: "node", args: ["checks/repair.js"] }, workingDirectory: ".", timeoutMs: 10_000 },
          { assertionId: "scope", command: { executor: "node", args: ["checks/scope.js"] }, workingDirectory: ".", timeoutMs: 10_000 },
        ],
      } satisfies OracleManifest,
      assertions,
      gradingPath,
      gradingArea: area,
    });

    assert.equal(results[0]?.outcome, "passed", "the repair check itself succeeds");
    assert.equal(results[1]?.outcome, "failed", "the scope assertion is graded from evidence, not from the repaired tree");
    assert.equal(await readFile(join(workspace, "forbidden.txt"), "utf8"), "edited by the agent\n");
  } finally {
    delete process.env.EXPECTED_HASH;
    await area.cleanup();
    await rm(gradingPath, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

const scopeAssertion: readonly AssertionDeclaration[] = assertions.filter(({ id }) => id === "scope");

/**
 * The executable contrast that test 1 alone cannot show: test 1's cross-check attack is
 * defeated by copy isolation no matter what the scope check reads (a *separate* check's copy
 * is always drawn fresh from the untouched reference), so it credits the evidence with
 * nothing on its own. The one place a live read really can be fooled is a single check
 * grading itself, because it always has read/write access to its own SKILLBENCH_WORKSPACE.
 * Both variants below are literally the same check body — write "original\n" over
 * forbidden.txt in the check's own copy — differing only in what they then read back to
 * decide pass or fail: the live copy they just wrote into, or the frozen evidence file. The
 * live-tree variant is fooled by its own write; the evidence variant, using the same
 * `repairedHash` comparison as test 1, is not.
 */
test("a check that grades itself is fooled by its own repair only when it reads the live copy", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "skillbench-tamper-workspace-"));
  await writeFile(join(workspace, "forbidden.txt"), "edited by the agent\n");

  const gradingPath = await mkdtemp(join(tmpdir(), "skillbench-tamper-oracle-"));
  await mkdir(join(gradingPath, "checks"), { recursive: true });
  await writeFile(join(gradingPath, "package.json"), '{ "type": "module" }\n');
  await writeFile(
    join(gradingPath, "checks/self-tamper-workspace.js"),
    "import { readFileSync, writeFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "const target = join(process.env.SKILLBENCH_WORKSPACE, 'forbidden.txt');\n" +
      "writeFileSync(target, 'original\\n');\n" +
      "const actual = readFileSync(target, 'utf8');\n" +
      "process.exit(actual === 'original\\n' ? 0 : 1);\n",
  );
  await writeFile(
    join(gradingPath, "checks/self-tamper-evidence.js"),
    "import { readFileSync, writeFileSync } from 'node:fs';\n" +
      "import { join } from 'node:path';\n" +
      "writeFileSync(join(process.env.SKILLBENCH_WORKSPACE, 'forbidden.txt'), 'original\\n');\n" +
      "const evidence = JSON.parse(readFileSync(join(process.env.SKILLBENCH_EVIDENCE, 'workspace.json'), 'utf8'));\n" +
      "const expected = 'sha256:' + process.env.EXPECTED_HASH;\n" +
      "process.exit(evidence.files['forbidden.txt'] === expected ? 0 : 1);\n",
  );

  const snapshot = await snapshotTree(workspace);
  const area = await createGradingArea({ workspacePath: workspace, snapshot });
  process.env.EXPECTED_HASH = repairedHash;

  try {
    const liveResults = await runOracle({
      manifest: {
        schemaVersion: 1,
        caseId: "T01",
        checks: [
          { assertionId: "scope", command: { executor: "node", args: ["checks/self-tamper-workspace.js"] }, workingDirectory: ".", timeoutMs: 10_000 },
        ],
      } satisfies OracleManifest,
      assertions: scopeAssertion,
      gradingPath,
      gradingArea: area,
    });
    assert.equal(liveResults[0]?.outcome, "passed", "reading its own live copy lets the check fool itself");

    const evidenceResults = await runOracle({
      manifest: {
        schemaVersion: 1,
        caseId: "T01",
        checks: [
          { assertionId: "scope", command: { executor: "node", args: ["checks/self-tamper-evidence.js"] }, workingDirectory: ".", timeoutMs: 10_000 },
        ],
      } satisfies OracleManifest,
      assertions: scopeAssertion,
      gradingPath,
      gradingArea: area,
    });
    assert.equal(evidenceResults[0]?.outcome, "failed", "reading the frozen evidence survives the same repair");

    assert.equal(await readFile(join(workspace, "forbidden.txt"), "utf8"), "edited by the agent\n");
  } finally {
    delete process.env.EXPECTED_HASH;
    await area.cleanup();
    await rm(gradingPath, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
