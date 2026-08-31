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
