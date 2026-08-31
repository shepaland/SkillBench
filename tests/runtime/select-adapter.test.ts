import assert from "node:assert/strict";
import test from "node:test";
import { DependencyError } from "../../src/domain/errors.js";
import type { CaseManifest } from "../../src/domain/model.js";
import { selectAdapter, supportedRuntimes } from "../../src/runtime/select-adapter.js";

const caseManifest = {
  schemaVersion: 1,
  id: "F01",
  title: "Example",
  categories: ["implementation"],
  fixture: { path: "fixtures/queuedesk", contentHash: "sha256:" + "0".repeat(64) },
  promptSteps: [
    { id: "step-1", prompt: "Do the work." },
    { id: "step-2", prompt: "Confirm the work." },
  ],
  publicVerification: [{ executor: "npm", args: ["test"] }],
  limits: { wallClockMs: 60_000, outputBytes: 100_000, tokenLimit: 100_000 },
  allowedChangePaths: ["src"],
  forbiddenChangePaths: ["secrets"],
  assertions: [{ id: "assert-1", dimension: "functional", critical: true }],
} as unknown as CaseManifest;

test("lists both supported runtimes", () => {
  assert.deepEqual([...supportedRuntimes], ["codex", "fake"]);
});

test("rejects an unknown runtime identifier", async () => {
  await assert.rejects(selectAdapter("cursor", caseManifest), DependencyError);
});

test("rejects an unknown runtime with the supported list", async () => {
  await assert.rejects(selectAdapter("cursor", caseManifest), /supported runtimes: codex, fake/);
});

test("the fake runtime produces a deterministic transcript for every prompt step", async () => {
  const first = await selectAdapter("fake", caseManifest);
  const second = await selectAdapter("fake", caseManifest);
  const input = {
    workspace: "/tmp/workspace",
    promptSteps: caseManifest.promptSteps,
    config: {
      model: "fake-model",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
      limits: caseManifest.limits,
      environment: {},
    },
    onContinuation: async () => {},
  };

  const firstExecution = await first.adapter.execute(input);
  const secondExecution = await second.adapter.execute(input);

  assert.deepEqual(firstExecution.events, secondExecution.events);
  assert.equal(firstExecution.process.timedOut, false);
  assert.equal(firstExecution.metadata.runtime, "fake");
  assert.equal(firstExecution.metadata.runtimeVersion, first.runtimeVersion);
  assert.equal(firstExecution.metadata.adapterVersion, first.adapterVersion);
  assert.deepEqual(
    firstExecution.events.filter((event) => event.type === "prompt_sent").map((event) => event.stepId),
    ["step-1", "step-2"],
  );
  assert.equal(firstExecution.events.filter((event) => event.type === "completion_claim").length, 2);
});
