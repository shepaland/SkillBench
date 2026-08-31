import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadCatalog } from "../../src/catalog/load-catalog.js";

const repositoryRoot = join(import.meta.dirname, "../..");

test("the repository catalog loads without issues", async () => {
  const catalog = await loadCatalog(repositoryRoot, { requirePrivateOracles: false });
  assert.deepEqual(catalog.issues, []);
});

test("the repository ships the control variant", async () => {
  const catalog = await loadCatalog(repositoryRoot, { requirePrivateOracles: false });
  const control = catalog.variants.find((variant) => variant.manifest.id === "control");
  assert.ok(control, "control variant is missing");
  assert.deepEqual(control.manifest.installs, []);
  assert.ok(control.manifest.compatibleRuntimes.includes("codex"));
});

test("case B01 declares five oracle-graded assertions", async () => {
  const catalog = await loadCatalog(repositoryRoot, { requirePrivateOracles: false });
  const found = catalog.cases.find((entry) => entry.manifest.id === "B01");
  assert.ok(found, "case B01 is missing");
  assert.deepEqual(
    found.manifest.assertions.map((assertion) => assertion.id).toSorted(),
    [
      "functional-claim-priority",
      "functional-json-order",
      "functional-renderer-neutral",
      "regression-public-suite",
      "scope-untouched-files",
    ],
  );
  assert.ok(found.manifest.assertions.every((assertion) => assertion.transcriptRuleId === undefined));
  assert.equal(found.manifest.categories.length, 1);
  assert.equal(found.manifest.categories[0], "bug-fix");
});
