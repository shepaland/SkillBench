import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ValidationError } from "../../src/domain/errors.js";
import { assertOracleCoversAssertions, loadOracleManifest } from "../../src/oracles/oracle-manifest.js";
import { ManifestValidator } from "../../src/schemas/validator.js";

const publishedSchemas = join(import.meta.dirname, "../../schemas");

const validManifest = {
  schemaVersion: 1,
  caseId: "F01",
  checks: [
    {
      assertionId: "assert-1",
      command: { executor: "node", args: ["checks/functional.js"] },
      workingDirectory: "checks",
      timeoutMs: 5_000,
    },
  ],
};

async function writeOracle(value: unknown): Promise<string> {
  const gradingPath = await mkdtemp(join(tmpdir(), "skillbench-oracle-manifest-"));
  await writeFile(join(gradingPath, "oracle.json"), `${JSON.stringify(value)}\n`);
  return gradingPath;
}

test("loads a valid oracle manifest", async () => {
  const validator = await ManifestValidator.create(publishedSchemas);
  const gradingPath = await writeOracle(validManifest);

  const manifest = await loadOracleManifest(gradingPath, validator);

  assert.equal(manifest.caseId, "F01");
  assert.equal(manifest.checks[0]?.command.executor, "node");
});

test("rejects a shell executor, an absolute working directory, and a non-positive timeout", async () => {
  const validator = await ManifestValidator.create(publishedSchemas);

  for (const invalid of [
    { ...validManifest, checks: [{ ...validManifest.checks[0], command: { executor: "bash", args: ["-c", "ls"] } }] },
    { ...validManifest, checks: [{ ...validManifest.checks[0], workingDirectory: "/etc" }] },
    { ...validManifest, checks: [{ ...validManifest.checks[0], workingDirectory: "../escape" }] },
    { ...validManifest, checks: [{ ...validManifest.checks[0], timeoutMs: 0 }] },
    { ...validManifest, checks: [] },
  ]) {
    const gradingPath = await writeOracle(invalid);
    await assert.rejects(
      loadOracleManifest(gradingPath, validator),
      (error: unknown) => error instanceof ValidationError,
    );
  }
});

test("rejects a missing oracle manifest with a ValidationError", async () => {
  const validator = await ManifestValidator.create(publishedSchemas);
  const gradingPath = await mkdtemp(join(tmpdir(), "skillbench-oracle-manifest-"));

  await assert.rejects(
    loadOracleManifest(gradingPath, validator),
    (error: unknown) => error instanceof ValidationError && /oracle\.json/u.test(error.message),
  );
});

test("requires a one-to-one correspondence between case assertions and oracle checks", () => {
  const manifest = {
    schemaVersion: 1 as const,
    caseId: "F01",
    checks: [
      { assertionId: "assert-1", command: { executor: "node" as const, args: ["a.js"] }, workingDirectory: "checks", timeoutMs: 1_000 },
    ],
  };

  assert.doesNotThrow(() => {
    assertOracleCoversAssertions(manifest, [{ id: "assert-1", dimension: "functional", critical: true }]);
  });

  assert.throws(
    () => {
      assertOracleCoversAssertions(manifest, [
        { id: "assert-1", dimension: "functional", critical: true },
        { id: "assert-2", dimension: "regression", critical: false },
      ]);
    },
    (error: unknown) => error instanceof ValidationError && /assert-2/u.test(error.message),
  );

  assert.throws(
    () => {
      assertOracleCoversAssertions(manifest, [{ id: "assert-9", dimension: "functional", critical: true }]);
    },
    (error: unknown) => error instanceof ValidationError && /assert-1/u.test(error.message),
  );
});

test("rejects a duplicated assertion identifier in the oracle", () => {
  const manifest = {
    schemaVersion: 1 as const,
    caseId: "F01",
    checks: [
      { assertionId: "assert-1", command: { executor: "node" as const, args: ["a.js"] }, workingDirectory: "checks", timeoutMs: 1_000 },
      { assertionId: "assert-1", command: { executor: "node" as const, args: ["b.js"] }, workingDirectory: "checks", timeoutMs: 1_000 },
    ],
  };

  assert.throws(
    () => {
      assertOracleCoversAssertions(manifest, [{ id: "assert-1", dimension: "functional", critical: true }]);
    },
    (error: unknown) => error instanceof ValidationError && /duplicated/u.test(error.message),
  );
});
