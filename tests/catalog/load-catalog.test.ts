import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadCatalog, type CatalogIssue } from "../../src/catalog/load-catalog.js";
import { createTempProject, writeJson } from "../helpers/temp-project.js";

test("loads a valid catalog and treats every empty-install variant uniformly", async () => {
  const project = await createTempProject();
  await writeJson(project.controlManifestPath, {
    ...project.controlManifest,
    id: "future-empty",
  });

  const catalog = await loadCatalog(project.root);

  assert.deepEqual(catalog.issues, []);
  assert.deepEqual(catalog.cases.map(({ manifest }) => manifest.id), ["F01"]);
  assert.deepEqual(catalog.variants.map(({ manifest }) => manifest.id), ["future-empty", "example"]);
  const catalogCase = catalog.cases[0];
  assert.ok(catalogCase);
  assert.equal(catalogCase.fixtureHash, project.caseManifest.fixture.contentHash);
  assert.match(catalogCase.oracleHash ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(catalog.variants[0]?.materialHash, project.controlManifest.contentHash);
});

test("reports duplicate case identifiers across distinct manifest files", async () => {
  const project = await createTempProject();
  const duplicateDirectory = join(project.root, "cases/Z99");
  await mkdir(duplicateDirectory, { recursive: true });
  await writeJson(join(duplicateDirectory, "case.json"), project.caseManifest);

  const catalog = await loadCatalog(project.root);

  assert.deepEqual(issueCodes(catalog.issues), ["DUPLICATE_CASE_ID"]);
  assert.equal(catalog.issues[0]?.source, "cases/Z99/case.json");
});

test("reports a fixture that cannot be resolved", async () => {
  const project = await createTempProject();
  await writeJson(project.caseManifestPath, {
    ...project.caseManifest,
    fixture: { ...project.caseManifest.fixture, path: "fixtures/missing" },
  });

  assert.deepEqual(issueCodes((await loadCatalog(project.root)).issues), ["FIXTURE_UNAVAILABLE"]);
});

test("reports a fixture path that does not name a directory inside fixtures/", async () => {
  // Each of these resolves to a real directory that is not a fixture. Reporting them
  // before resolution matters: hashing "." would walk the whole project root, private
  // oracles included, only to end in a hash mismatch.
  for (const path of [".", "fixtures", "fixtures/."]) {
    const project = await createTempProject();
    await writeJson(project.caseManifestPath, {
      ...project.caseManifest,
      fixture: { ...project.caseManifest.fixture, path },
    });

    const catalog = await loadCatalog(project.root);

    assert.deepEqual(issueCodes(catalog.issues), ["FIXTURE_UNAVAILABLE"], `for fixture path ${path}`);
    assert.match(catalog.issues[0]?.message ?? "", /must name a directory inside fixtures\//u);
    assert.equal(catalog.cases[0]?.fixturePath, undefined);
    assert.equal(catalog.cases[0]?.fixtureHash, undefined);
  }
});

test("reports a fixture whose tree no longer matches its declared hash", async () => {
  const project = await createTempProject();
  await writeFile(join(project.fixtureDirectory, "unexpected.js"), "export const changed = true;\n");

  assert.deepEqual(issueCodes((await loadCatalog(project.root)).issues), ["FIXTURE_HASH_MISMATCH"]);
});

test("reports assertion identifiers duplicated with different declarations", async () => {
  const project = await createTempProject();
  const assertion = project.caseManifest.assertions[0];
  assert.ok(assertion);
  await writeJson(project.caseManifestPath, {
    ...project.caseManifest,
    assertions: [assertion, { ...assertion, dimension: "security" }],
  });

  assert.deepEqual(issueCodes((await loadCatalog(project.root)).issues), ["DUPLICATE_ASSERTION_ID"]);
});

test("reports continuation references to absent transcript rules", async () => {
  const project = await createTempProject();
  const promptStep = project.caseManifest.promptSteps[0];
  assert.ok(promptStep);
  await writeJson(project.caseManifestPath, {
    ...project.caseManifest,
    promptSteps: [
      { ...promptStep, continuation: { eventRuleIds: ["missing-rule"] } },
    ],
  });

  assert.deepEqual(issueCodes((await loadCatalog(project.root)).issues), [
    "CONTINUATION_RULE_NOT_FOUND",
  ]);
});

test("reports an assertion referencing an absent transcript rule", async () => {
  const project = await createTempProject();
  const assertion = project.caseManifest.assertions[0];
  assert.ok(assertion);
  await writeJson(project.caseManifestPath, {
    ...project.caseManifest,
    assertions: [
      assertion,
      { id: "assert-2", dimension: "process", critical: false, transcriptRuleId: "missing-rule" },
    ],
  });

  assert.deepEqual(issueCodes((await loadCatalog(project.root)).issues), [
    "TRANSCRIPT_RULE_NOT_FOUND",
  ]);
});

test("reports two assertions claiming the same transcript rule", async () => {
  const project = await createTempProject();
  const assertion = project.caseManifest.assertions[0];
  assert.ok(assertion);
  await writeJson(project.caseManifestPath, {
    ...project.caseManifest,
    transcriptRules: [
      ...(project.caseManifest.transcriptRules ?? []),
      { id: "rule-2", check: "assistant_message" },
    ],
    assertions: [
      assertion,
      { id: "assert-2", dimension: "process", critical: false, transcriptRuleId: "rule-2" },
      { id: "assert-3", dimension: "process", critical: false, transcriptRuleId: "rule-2" },
    ],
  });

  assert.deepEqual(issueCodes((await loadCatalog(project.root)).issues), [
    "TRANSCRIPT_RULE_REUSED",
  ]);
});

test("reports two prompt step continuations claiming the same transcript rule", async () => {
  const project = await createTempProject();
  const promptStep = project.caseManifest.promptSteps[0];
  assert.ok(promptStep);
  await writeJson(project.caseManifestPath, {
    ...project.caseManifest,
    promptSteps: [
      promptStep,
      { id: "step-2", prompt: "Continue.", continuation: { eventRuleIds: ["rule-1"] } },
    ],
  });

  assert.deepEqual(issueCodes((await loadCatalog(project.root)).issues), [
    "TRANSCRIPT_RULE_REUSED",
  ]);
});

test("a transcript rule referenced by neither a continuation nor an assertion produces no issue", async () => {
  const project = await createTempProject();
  await writeJson(project.caseManifestPath, {
    ...project.caseManifest,
    transcriptRules: [
      ...(project.caseManifest.transcriptRules ?? []),
      { id: "rule-unused", check: "assistant_message" },
    ],
  });

  assert.deepEqual((await loadCatalog(project.root)).issues, []);
});

test("requires a non-empty private oracle by default but permits public-only validation", async () => {
  const project = await createTempProject();
  await writeJson(project.caseManifestPath, { ...project.caseManifest, id: "F02" });

  assert.deepEqual(issueCodes((await loadCatalog(project.root)).issues), ["ORACLE_UNAVAILABLE"]);
  assert.deepEqual((await loadCatalog(project.root, { requirePrivateOracles: false })).issues, []);

  await mkdir(join(project.root, ".private/oracles/F02"), { recursive: true });
  assert.deepEqual(issueCodes((await loadCatalog(project.root)).issues), ["ORACLE_EMPTY"]);
});

test("reports a variant whose installed material no longer matches its declared hash", async () => {
  const project = await createTempProject();
  await writeFile(join(project.exampleInstallDirectory, "SKILL.md"), "# Changed skill\n");

  assert.deepEqual(issueCodes((await loadCatalog(project.root)).issues), ["VARIANT_HASH_MISMATCH"]);
});

test("requires every install to declare a destination for every compatible runtime", async () => {
  const project = await createTempProject();
  await writeJson(project.exampleManifestPath, {
    ...project.exampleManifest,
    compatibleRuntimes: ["codex", "future-runtime"],
  });

  assert.deepEqual(issueCodes((await loadCatalog(project.root)).issues), [
    "MISSING_RUNTIME_DESTINATION",
  ]);
});

test("reports equal, ancestor, and descendant allowed/forbidden path overlaps", async () => {
  const pathPairs = [
    ["src", "src"],
    ["src/", "src/server"],
    ["src/server", "src/"],
  ] as const;

  for (const [allowed, forbidden] of pathPairs) {
    const project = await createTempProject();
    await writeJson(project.caseManifestPath, {
      ...project.caseManifest,
      allowedChangePaths: [allowed],
      forbiddenChangePaths: [forbidden],
    });

    assert.deepEqual(
      issueCodes((await loadCatalog(project.root)).issues),
      ["CHANGE_PATH_OVERLAP"],
      `${allowed} must overlap ${forbidden}`,
    );
  }
});

test("skips unusable manifests, continues after recoverable errors, and sorts every issue", async () => {
  const project = await createTempProject();
  const malformedDirectory = join(project.root, "cases/A00");
  const invalidDirectory = join(project.root, "cases/B00");
  await Promise.all([
    mkdir(malformedDirectory, { recursive: true }),
    mkdir(invalidDirectory, { recursive: true }),
    writeFile(join(project.fixtureDirectory, "changed.js"), "changed\n"),
    writeFile(join(project.exampleInstallDirectory, "changed.txt"), "changed\n"),
  ]);
  await writeFile(join(malformedDirectory, "case.json"), "{not json\n");
  await writeJson(join(invalidDirectory, "case.json"), { schemaVersion: 1 });
  await writeJson(project.caseManifestPath, {
    ...project.caseManifest,
    allowedChangePaths: ["src"],
    forbiddenChangePaths: ["src/internal"],
  });
  await writeJson(project.exampleManifestPath, {
    ...project.exampleManifest,
    compatibleRuntimes: ["codex", "future-runtime"],
  });

  const catalog = await loadCatalog(project.root);
  const sorted = [...catalog.issues].sort(compareIssues);

  assert.deepEqual(catalog.issues, sorted);
  assert.deepEqual(issueCodes(catalog.issues), [
    "JSON_PARSE",
    "SCHEMA_VALIDATION",
    "CHANGE_PATH_OVERLAP",
    "FIXTURE_HASH_MISMATCH",
    "MISSING_RUNTIME_DESTINATION",
    "VARIANT_HASH_MISMATCH",
  ]);
  assert.equal(catalog.cases.length, 1);
  assert.equal(catalog.variants.length, 2);
});

test("discovers only manifests at the documented one-directory-deep paths", async () => {
  const project = await createTempProject();
  await Promise.all([
    writeFile(join(project.caseDirectory, "ignored.json"), "{not json"),
    writeFile(join(project.exampleVariantDirectory, "ignored.json"), "{not json"),
    writeFile(join(project.root, "cases/case.json"), "{not json"),
  ]);

  assert.deepEqual((await loadCatalog(project.root)).issues, []);
});

function issueCodes(issues: readonly CatalogIssue[]): string[] {
  return issues.map(({ code }) => code);
}

function compareIssues(left: CatalogIssue, right: CatalogIssue): number {
  return compareText(left.source, right.source) ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
