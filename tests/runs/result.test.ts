import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadCatalog } from "../../src/catalog/load-catalog.js";
import { ProjectPaths } from "../../src/paths/project-paths.js";
import { freezeRunInputs, type RunConfiguration } from "../../src/runs/freeze-inputs.js";
import { hasFailedCriticalAssertion, RunEvidenceWriter, type RunResult } from "../../src/runs/result.js";
import { ImmutableJsonStore } from "../../src/storage/immutable-json-store.js";
import { createTempProject } from "../helpers/temp-project.js";

const configuration: RunConfiguration = {
  runtime: "fake",
  model: "fake-model",
  reasoningEffort: "medium",
  sandbox: "workspace-write",
  runtimeVersion: "1.0.0",
  adapterVersion: "1.0.0",
};

async function createWriter() {
  const project = await createTempProject();
  const catalog = await loadCatalog(project.root);
  const catalogCase = catalog.cases[0];
  const variant = catalog.variants.find((candidate) => candidate.manifest.id === "example");
  assert.ok(catalogCase !== undefined && variant !== undefined);
  const manifest = freezeRunInputs({
    catalogCase,
    variant,
    configuration,
    repetitionIndex: 0,
    runId: "20260830T175302Z-a1b2c3",
  });
  const paths = await ProjectPaths.create(project.root);
  const writer = new RunEvidenceWriter(new ImmutableJsonStore(paths), manifest);
  return { project, manifest, writer };
}

test("writes the manifest into the run directory before anything else", async () => {
  const { project, writer } = await createWriter();

  await writer.writeManifest();

  assert.equal(writer.directory, "runs/F01/example/20260830T175302Z-a1b2c3");
  const written = await readFile(join(project.root, writer.directory, "manifest.json"), "utf8");
  assert.match(written, /"runId":"20260830T175302Z-a1b2c3"/u);
  assert.ok(written.endsWith("\n"));
});

test("writing the same manifest twice is idempotent", async () => {
  const { writer } = await createWriter();

  await writer.writeManifest();
  await writer.writeManifest();
});

test("writes transcript, changes, and result as separate records", async () => {
  const { project, manifest, writer } = await createWriter();
  const result: RunResult = {
    schemaVersion: 1,
    runId: manifest.runId,
    manifest,
    status: "completed",
    failedStep: null,
    failureMessage: "",
    assertions: [{
      assertionId: "assert-1",
      dimension: "functional",
      critical: true,
      outcome: "passed",
      exitCode: 0,
      durationMs: 5,
      detail: "",
    }],
    changes: { added: [], modified: ["src/index.js"], removed: [] },
    changePathObservations: { outsideAllowed: [], insideForbidden: [] },
    costs: { inputTokens: 10, outputTokens: 20, wallClockMs: 30, unplannedUserTurns: 0 },
    adapter: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
    preservedWorkspacePath: null,
    cleanupFailures: [],
  };

  await writer.writeTranscript({
    events: [{ type: "session_started", atMs: 0 }],
    process: { exitCode: 0, signal: null, timedOut: false },
    usage: { inputTokens: 10, outputTokens: 20 },
    elapsedMs: 30,
    metadata: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
    exhaustion: null,
    unparsedLines: 0,
  });
  await writer.writeChanges(result.changes, result.changePathObservations);
  await writer.writeResult(result);

  for (const filename of ["transcript.json", "changes.json", "result.json"]) {
    const written = await readFile(join(project.root, writer.directory, filename), "utf8");
    assert.ok(written.endsWith("\n"));
  }
  assert.equal(hasFailedCriticalAssertion(result), false);
});

test("detects a failed critical assertion and ignores a failed non-critical one", async () => {
  const { manifest } = await createWriter();
  const base = {
    schemaVersion: 1 as const,
    runId: manifest.runId,
    manifest,
    status: "completed" as const,
    failedStep: null,
    failureMessage: "",
    changes: { added: [], modified: [], removed: [] },
    changePathObservations: { outsideAllowed: [], insideForbidden: [] },
    costs: { inputTokens: null, outputTokens: null, wallClockMs: 0, unplannedUserTurns: 0 },
    adapter: { runtime: "fake", runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
    preservedWorkspacePath: null,
    cleanupFailures: [],
  };

  assert.equal(
    hasFailedCriticalAssertion({
      ...base,
      assertions: [{ assertionId: "a", dimension: "functional", critical: false, outcome: "failed", exitCode: 1, durationMs: 1, detail: "" }],
    }),
    false,
  );
  assert.equal(
    hasFailedCriticalAssertion({
      ...base,
      assertions: [{ assertionId: "a", dimension: "functional", critical: true, outcome: "error", exitCode: null, durationMs: 1, detail: "" }],
    }),
    true,
  );
});
