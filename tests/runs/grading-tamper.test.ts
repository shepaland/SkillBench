import assert from "node:assert/strict";
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
  // The baseline hash of the untouched file, which the agent's edit no longer matches.
  process.env.EXPECTED_HASH = "0".repeat(64);

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
