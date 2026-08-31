import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile, hashTree } from "../../src/integrity/content-hash.js";

export interface TempProofProject {
  readonly root: string;
  readonly caseId: string;
  /** Relative path of the test file the fixture and the oracle both carry. */
  readonly carriedTestPath: string;
}

/**
 * Both checks note that they ran in the file named by SKILLBENCH_PROOF_LOG, when the
 * caller sets it, so a test can prove that only the check under proof is executed.
 */
const noteRun = `import { appendFile } from "node:fs/promises";
const log = process.env.SKILLBENCH_PROOF_LOG;
`;

const honestCheck = `${noteRun}import { readFile } from "node:fs/promises";
import { join } from "node:path";
if (log !== undefined) await appendFile(log, "honest\\n");
const workspace = process.env.SKILLBENCH_WORKSPACE;
const text = await readFile(join(workspace, "value.txt"), "utf8");
process.exit(text.trim() === "correct" ? 0 : 1);
`;

const alwaysGreenCheck = `${noteRun}if (log !== undefined) await appendFile(log, "always-green\\n");
process.exit(0);
`;

const carriedTest = `// The public suite the oracle also carries.\n`;

const carriedTestPath = "tests/smoke.test.js";

/**
 * A whole project the prover can run against: one fixture, one case with two
 * oracle-graded assertions, an oracle whose first check is honest and whose second
 * always exits 0, a baseline that agrees with the fixture, and the four patches.
 */
export async function createTempProofProject(): Promise<TempProofProject> {
  const root = await mkdtemp(join(tmpdir(), "skillbench-proof-"));
  const fixture = join(root, "fixtures/tiny");
  const oracleRoot = join(root, ".private/oracles/T01");
  await mkdir(join(fixture, "tests"), { recursive: true });
  await mkdir(join(oracleRoot, "checks"), { recursive: true });
  await mkdir(join(oracleRoot, "tests"), { recursive: true });
  await mkdir(join(root, "cases/T01"), { recursive: true });
  await mkdir(join(root, "schemas"), { recursive: true });

  const published = join(import.meta.dirname, "../../schemas");
  for (const name of ["case.schema.json", "variant.schema.json", "oracle.schema.json"]) {
    await copyFile(join(published, name), join(root, "schemas", name));
  }

  await writeFile(join(fixture, "value.txt"), "wrong\n");
  await writeFile(join(fixture, carriedTestPath), carriedTest);
  await writeFile(join(oracleRoot, "checks/honest.mjs"), honestCheck);
  await writeFile(join(oracleRoot, "checks/always-green.mjs"), alwaysGreenCheck);
  await writeFile(join(oracleRoot, carriedTestPath), carriedTest);
  await writeFile(
    join(oracleRoot, "baseline.json"),
    `${JSON.stringify({
      fixture: "fixtures/tiny",
      files: {
        [carriedTestPath]: await hashFile(join(fixture, carriedTestPath)),
        "value.txt": await hashFile(join(fixture, "value.txt")),
      },
    }, null, 2)}\n`,
  );
  await writeFile(
    join(oracleRoot, "oracle.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      caseId: "T01",
      checks: [
        { assertionId: "honest", command: { executor: "node", args: ["checks/honest.mjs"] }, workingDirectory: ".", timeoutMs: 30_000 },
        { assertionId: "always-green", command: { executor: "node", args: ["checks/always-green.mjs"] }, workingDirectory: ".", timeoutMs: 30_000 },
      ],
    }, null, 2)}\n`,
  );

  await writeFile(
    join(root, "cases/T01/case.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "T01",
      title: "Tiny proof case",
      categories: ["bug-fix"],
      fixture: { path: "fixtures/tiny", contentHash: await hashTree(fixture) },
      promptSteps: [{ id: "only", prompt: "Set the value to correct." }],
      publicVerification: [{ executor: "npm", args: ["test"] }],
      limits: { wallClockMs: 900_000, outputBytes: 4_000_000, tokenLimit: 400_000 },
      allowedChangePaths: ["value.txt"],
      forbiddenChangePaths: ["README.md"],
      assertions: [
        { id: "honest", dimension: "functional", critical: true },
        { id: "always-green", dimension: "functional", critical: false },
      ],
    }, null, 2)}\n`,
  );

  for (const assertionId of ["honest", "always-green"]) {
    for (const [patch, value] of [["pass", "correct\n"], ["fail", "wrong\n"]] as const) {
      const directory = join(root, ".private/proofs/T01", assertionId, patch);
      await mkdir(join(directory, "files"), { recursive: true });
      await writeFile(
        join(directory, "overlay.json"),
        `${JSON.stringify({ description: `${assertionId} ${patch}`, removals: [] }, null, 2)}\n`,
      );
      await writeFile(join(directory, "files/value.txt"), value);
    }
  }

  return { root, caseId: "T01", carriedTestPath };
}
