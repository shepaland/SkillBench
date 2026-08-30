import assert from "node:assert/strict";
import test from "node:test";
import { loadCatalog } from "../../src/catalog/load-catalog.js";
import { DependencyError } from "../../src/domain/errors.js";
import {
  createRunId,
  freezeRunInputs,
  runDirectory,
  type RunConfiguration,
} from "../../src/runs/freeze-inputs.js";
import { createTempProject } from "../helpers/temp-project.js";

const configuration: RunConfiguration = {
  runtime: "fake",
  model: "fake-model",
  reasoningEffort: "medium",
  sandbox: "workspace-write",
  runtimeVersion: "1.0.0",
  adapterVersion: "1.0.0",
};

test("builds a run identifier from a UTC instant and a suffix", () => {
  assert.equal(createRunId(new Date("2026-08-30T17:53:02.000Z"), "a1b2c3"), "20260830T175302Z-a1b2c3");
});

test("rejects a suffix that is not six lowercase alphanumerics", () => {
  assert.throws(() => createRunId(new Date("2026-08-30T17:53:02.000Z"), "AB!"), DependencyError);
});

test("freezes every input and stays stable across repeated freezes", async () => {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root);
  const catalogCase = catalog.cases[0];
  const variant = catalog.variants.find((candidate) => candidate.manifest.id === "example");
  assert.ok(catalogCase !== undefined && variant !== undefined);

  const first = freezeRunInputs({
    catalogCase,
    variant,
    configuration,
    repetitionIndex: 0,
    runId: "20260830T175302Z-a1b2c3",
  });
  const second = freezeRunInputs({
    catalogCase,
    variant,
    configuration,
    repetitionIndex: 0,
    runId: "20260830T175302Z-a1b2c3",
  });

  assert.deepEqual(first, second);
  assert.equal(first.caseId, "F01");
  assert.equal(first.variantId, "example");
  assert.equal(first.runtime, "fake");
  assert.equal(first.repetitionIndex, 0);
  assert.equal(first.fixtureHash, catalogCase.fixtureHash);
  assert.equal(first.oracleHash, catalogCase.oracleHash);
  assert.equal(first.variantHash, variant.manifest.contentHash);
  assert.deepEqual(first.limits, catalogCase.manifest.limits);
  assert.equal(runDirectory(first), "runs/F01/example/20260830T175302Z-a1b2c3");
});

test("refuses to freeze when the private oracle hash is unavailable", async () => {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root, { requirePrivateOracles: false });
  const catalogCase = catalog.cases[0];
  const variant = catalog.variants.find((candidate) => candidate.manifest.id === "example");
  assert.ok(catalogCase !== undefined && variant !== undefined);

  assert.throws(
    () => freezeRunInputs({
      catalogCase,
      variant,
      configuration,
      repetitionIndex: 0,
      runId: "20260830T175302Z-a1b2c3",
    }),
    (error: unknown) => error instanceof DependencyError && /oracle/u.test(error.message),
  );
});

test("refuses to freeze when the fixture hash is unavailable", async () => {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root);
  const catalogCase = catalog.cases[0];
  const variant = catalog.variants.find((candidate) => candidate.manifest.id === "example");
  assert.ok(catalogCase !== undefined && variant !== undefined);
  const { fixtureHash: _fixtureHash, ...caseWithoutFixtureHash } = catalogCase;
  void _fixtureHash;

  assert.throws(
    () => freezeRunInputs({
      catalogCase: caseWithoutFixtureHash,
      variant,
      configuration,
      repetitionIndex: 0,
      runId: "20260830T175302Z-a1b2c3",
    }),
    (error: unknown) => error instanceof DependencyError && /fixture/u.test(error.message),
  );
});

test("refuses to freeze when the variant material hash is unavailable", async () => {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root);
  const catalogCase = catalog.cases[0];
  const variant = catalog.variants.find((candidate) => candidate.manifest.id === "example");
  assert.ok(catalogCase !== undefined && variant !== undefined);
  const { materialHash: _materialHash, ...variantWithoutMaterialHash } = variant;
  void _materialHash;

  assert.throws(
    () => freezeRunInputs({
      catalogCase,
      variant: variantWithoutMaterialHash,
      configuration,
      repetitionIndex: 0,
      runId: "20260830T175302Z-a1b2c3",
    }),
    (error: unknown) => error instanceof DependencyError && /variant material/u.test(error.message),
  );
});

test("refuses a variant that is incompatible with the selected runtime", async () => {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root);
  const catalogCase = catalog.cases[0];
  const variant = catalog.variants.find((candidate) => candidate.manifest.id === "example");
  assert.ok(catalogCase !== undefined && variant !== undefined);

  assert.throws(
    () => freezeRunInputs({
      catalogCase,
      variant,
      configuration: { ...configuration, runtime: "unknown-runtime" },
      repetitionIndex: 0,
      runId: "20260830T175302Z-a1b2c3",
    }),
    (error: unknown) => error instanceof DependencyError && /runtime/u.test(error.message),
  );
});
