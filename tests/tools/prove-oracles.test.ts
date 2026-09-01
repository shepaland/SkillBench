import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createTempProofProject, type TempProofProject } from "../helpers/temp-proof-project.js";
import { proveOracles } from "../../src/tools/prove-oracles.js";

async function proofProject(t: TestContext): Promise<TempProofProject> {
  const project = await createTempProofProject();
  t.after(() => rm(project.root, { recursive: true, force: true }));
  return project;
}

test("an honest assertion is proven and an always-green one is rejected", async (t) => {
  const project = await proofProject(t);
  const report = await proveOracles({ root: project.root });

  assert.equal(report.provenAssertions, 1);
  assert.equal(report.failures.length, 1);
  const failure = report.failures[0];
  assert.ok(failure);
  assert.equal(failure.caseId, "T01");
  assert.equal(failure.assertionId, "always-green");
  assert.equal(failure.patch, "fail");
  assert.match(failure.message, /expected the assertion to fail/);
});

test("a missing patch is reported rather than skipped", async (t) => {
  const project = await proofProject(t);
  await rm(join(project.root, ".private/proofs/T01/honest/fail"), { recursive: true });
  const report = await proveOracles({ root: project.root });
  assert.ok(report.failures.some((failure) => /has no fail patch/.test(failure.message)));
  assert.equal(report.provenAssertions, 0);
});

test("a stale baseline is reported", async (t) => {
  const project = await proofProject(t);
  await writeFile(join(project.root, ".private/oracles/T01/baseline.json"), '{"files":{"value.txt":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}}\n');
  const report = await proveOracles({ root: project.root });
  assert.ok(report.failures.some((failure) => /baseline/.test(failure.message)));
});

test("a baseline hash that no longer matches the fixture is reported", async (t) => {
  const project = await proofProject(t);
  const baselinePath = join(project.root, ".private/oracles/T01/baseline.json");
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
    fixture: string;
    files: Record<string, string>;
  };
  baseline.files["value.txt"] = `sha256:${"1".repeat(64)}`;
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

  const report = await proveOracles({ root: project.root });
  assert.ok(report.failures.some((failure) => /baseline.*value\.txt/.test(failure.message)));
});

test("an oracle with no baseline.json at all is reported", async (t) => {
  const project = await proofProject(t);
  await rm(join(project.root, ".private/oracles/T01/baseline.json"));
  // The carried tests drift too: without the baseline neither comparison can run, so
  // an absent baseline must be a failure rather than a silent skip.
  await writeFile(
    join(project.root, ".private/oracles/T01", project.carriedTestPath),
    "// drifted away from the fixture\n",
  );

  const report = await proveOracles({ root: project.root });

  assert.ok(report.failures.some((failure) => /no readable baseline\.json/.test(failure.message)));
});

test("a carried test file that drifts from the fixture is reported", async (t) => {
  const project = await proofProject(t);
  await writeFile(
    join(project.root, ".private/oracles/T01", project.carriedTestPath),
    "// drifted away from the fixture\n",
  );

  const report = await proveOracles({ root: project.root });
  assert.ok(report.failures.some((failure) =>
    /baseline/.test(failure.message) && failure.message.includes(project.carriedTestPath)));
});

test("a public test file the oracle no longer carries is reported", async (t) => {
  const project = await proofProject(t);
  await rm(join(project.root, ".private/oracles/T01", project.carriedTestPath));

  const report = await proveOracles({ root: project.root });
  assert.ok(report.failures.some((failure) =>
    /carr/.test(failure.message) && failure.message.includes(project.carriedTestPath)));
});

test("an oracle-graded assertion with no check yet is reported, not skipped", async (t) => {
  const project = await proofProject(t);
  const manifestPath = join(project.root, ".private/oracles/T01/oracle.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    checks: { assertionId: string }[];
  };
  manifest.checks = manifest.checks.filter((check) => check.assertionId === "honest");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const report = await proveOracles({ root: project.root });

  assert.equal(report.provenAssertions, 1);
  assert.equal(report.failures.length, 1);
  const failure = report.failures[0];
  assert.ok(failure);
  assert.equal(failure.assertionId, "always-green");
  assert.match(failure.message, /no oracle check yet/);
});

test("only the check for the assertion under proof runs", async (t) => {
  const project = await proofProject(t);
  const log = join(project.root, "checks.log");
  process.env["SKILLBENCH_PROOF_LOG"] = log;
  t.after(() => {
    delete process.env["SKILLBENCH_PROOF_LOG"];
  });

  await proveOracles({ root: project.root });

  const runs = (await readFile(log, "utf8")).trim().split("\n");
  assert.deepEqual(runs.filter((name) => name === "honest").length, 2);
  assert.deepEqual(runs.filter((name) => name === "always-green").length, 2);
});

test("a patch directory naming an unknown assertion is reported", async (t) => {
  const project = await proofProject(t);
  await mkdir(join(project.root, ".private/proofs/T01/ghost/pass"), { recursive: true });

  const report = await proveOracles({ root: project.root });
  assert.ok(report.failures.some((failure) =>
    failure.assertionId === "ghost" && /unknown assertion/.test(failure.message)));
});

test("a shared patch named by include is applied before the patch's own files", async (t) => {
  const project = await proofProject(t);
  const shared = join(project.root, ".private/proofs/T01/_patches/set-correct");
  await mkdir(join(shared, "files"), { recursive: true });
  await writeFile(
    join(shared, "overlay.json"),
    `${JSON.stringify({ description: "Set the value to correct.", removals: [] }, null, 2)}\n`,
  );
  await writeFile(join(shared, "files/value.txt"), "correct\n");

  const passPatch = join(project.root, ".private/proofs/T01/honest/pass");
  await rm(join(passPatch, "files"), { recursive: true });
  await writeFile(
    join(passPatch, "overlay.json"),
    `${JSON.stringify({ description: "Reuse the shared fix.", include: ["set-correct"], removals: [] }, null, 2)}\n`,
  );

  const report = await proveOracles({ root: project.root });

  assert.equal(report.provenAssertions, 1);
  assert.ok(!report.failures.some((failure) => failure.assertionId === "honest"));
});

test("a removal that escapes the composed copy is reported", async (t) => {
  const project = await proofProject(t);
  const passPatch = join(project.root, ".private/proofs/T01/honest/pass");
  await writeFile(
    join(passPatch, "overlay.json"),
    `${JSON.stringify({ description: "Escape attempt.", removals: ["../value.txt"] }, null, 2)}\n`,
  );

  const report = await proveOracles({ root: project.root });

  assert.ok(report.failures.some((failure) =>
    failure.assertionId === "honest" && failure.patch === "pass" &&
    /escapes the composed copy/.test(failure.message)));
  assert.equal(report.provenAssertions, 0);
});

test("an absent private oracle directory stops the run with one failure", async (t) => {
  const project = await proofProject(t);
  await rm(join(project.root, ".private/oracles"), { recursive: true });

  const report = await proveOracles({ root: project.root });

  assert.equal(report.provenAssertions, 0);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0]?.message ?? "", /\.private\/oracles is absent/);
});

test("a case manifest that does not load is reported rather than dropped", async (t) => {
  const project = await proofProject(t);
  await writeFile(join(project.root, "cases/T01/case.json"), "{ broken\n");

  const report = await proveOracles({ root: project.root });

  assert.equal(report.provenAssertions, 0);
  assert.ok(report.failures.some((failure) => /catalog issue JSON_PARSE/.test(failure.message)));
});

test("a project with no case at all fails instead of reporting success", async (t) => {
  const project = await proofProject(t);
  await rm(join(project.root, "cases/T01"), { recursive: true });

  const report = await proveOracles({ root: project.root });

  assert.equal(report.provenAssertions, 0);
  assert.ok(report.failures.some((failure) => /nothing was proven/.test(failure.message)));
});

test("an empty case selection fails instead of reporting success", async (t) => {
  const project = await proofProject(t);

  const report = await proveOracles({ root: project.root, caseIds: [] });

  assert.equal(report.provenAssertions, 0);
  assert.ok(report.failures.some((failure) => /no case was selected/.test(failure.message)));
});

test("an unknown case ID is reported", async (t) => {
  const project = await proofProject(t);
  const report = await proveOracles({ root: project.root, caseIds: ["Z99"] });

  assert.equal(report.provenAssertions, 0);
  assert.ok(report.failures.some((failure) => /unknown case/.test(failure.message)));
});
