import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { loadCatalog } from "../../src/catalog/load-catalog.js";
import { createTempProject } from "../helpers/temp-project.js";

test("a valid project reports no oracle issues", async () => {
  const project = await createTempProject();

  const catalog = await loadCatalog(project.root);

  assert.deepEqual(catalog.issues, []);
});

test("an oracle that misses a declared assertion is reported", async () => {
  const project = await createTempProject();
  await writeFile(
    project.oracleManifestPath,
    `${JSON.stringify({ schemaVersion: 1, caseId: "F01", checks: [{ assertionId: "assert-9", command: { executor: "node", args: ["assert-1.js"] }, workingDirectory: "checks", timeoutMs: 1000 }] })}\n`,
  );

  const catalog = await loadCatalog(project.root);

  assert.deepEqual(
    catalog.issues.map((issue) => issue.code),
    ["ORACLE_ASSERTION_MISMATCH"],
  );
});

test("an unparseable oracle manifest is reported", async () => {
  const project = await createTempProject();
  await writeFile(project.oracleManifestPath, "{ not json\n");

  const catalog = await loadCatalog(project.root);

  assert.deepEqual(
    catalog.issues.map((issue) => issue.code),
    ["ORACLE_MANIFEST_INVALID"],
  );
});

test("a missing oracle manifest is reported", async () => {
  const project = await createTempProject();
  await rm(project.oracleManifestPath);

  const catalog = await loadCatalog(project.root);

  assert.deepEqual(
    catalog.issues.map((issue) => issue.code),
    ["ORACLE_MANIFEST_INVALID"],
  );
});

test("--public-only skips oracle manifest checks entirely", async () => {
  const project = await createTempProject();
  await writeFile(project.oracleManifestPath, "{ not json\n");

  const catalog = await loadCatalog(project.root, { requirePrivateOracles: false });

  assert.deepEqual(catalog.issues, []);
});
