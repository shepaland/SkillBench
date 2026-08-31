import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runDryRun } from "../../src/commands/dry-run.js";
import { DependencyError, InvocationError } from "../../src/domain/errors.js";
import { createTempProject } from "../helpers/temp-project.js";

function createIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

function options(root: string, overrides: Record<string, unknown> = {}) {
  return {
    project: root,
    case: "F01",
    variant: "example",
    runtime: "fake",
    model: "fake-model",
    reasoning: "medium",
    sandbox: "workspace-write",
    json: false,
    ...overrides,
  };
}

test("prints the frozen plan and writes nothing", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runDryRun(options(project.root), io, () => new Date("2026-08-30T17:53:02.000Z"), () => "a1b2c3");

  const printed = stdout();
  assert.match(printed, /20260830T175302Z-a1b2c3/u);
  assert.match(printed, /step-1/u);
  assert.match(printed, /assert-1/u);
  assert.match(printed, /functional/u);
  assert.match(printed, /npm test/u);
  await assert.rejects(readdir(join(project.root, "runs")), { code: "ENOENT" });
});

test("--json emits the same content as a parseable document", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runDryRun(options(project.root, { json: true }), io, () => new Date("2026-08-30T17:53:02.000Z"), () => "a1b2c3");

  const parsed = JSON.parse(stdout()) as {
    manifest: { runId: string; caseId: string };
    promptSteps: { id: string }[];
    assertions: { id: string; dimension: string; critical: boolean }[];
    allowedChangePaths: string[];
    forbiddenChangePaths: string[];
    publicVerification: { executor: string; args: string[] }[];
  };
  assert.equal(parsed.manifest.runId, "20260830T175302Z-a1b2c3");
  assert.equal(parsed.manifest.caseId, "F01");
  assert.deepEqual(parsed.promptSteps.map((step) => step.id), ["step-1"]);
  assert.deepEqual(parsed.assertions, [{ id: "assert-1", dimension: "functional", critical: true }]);
  assert.deepEqual(parsed.allowedChangePaths, ["src"]);
  assert.deepEqual(parsed.forbiddenChangePaths, ["secrets"]);
  assert.deepEqual(parsed.publicVerification, [{ executor: "npm", args: ["test"] }]);
});

test("an unknown case identifier raises an invocation error", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  await assert.rejects(
    runDryRun(options(project.root, { case: "F99" }), io),
    (error: unknown) => error instanceof InvocationError && error.exitCode === 2,
  );
});

test("an unknown variant identifier raises an invocation error", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  await assert.rejects(
    runDryRun(options(project.root, { variant: "missing" }), io),
    (error: unknown) => error instanceof InvocationError && error.exitCode === 2,
  );
});

test("an unknown runtime raises a dependency error", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  await assert.rejects(
    runDryRun(options(project.root, { runtime: "cursor" }), io),
    (error: unknown) => error instanceof DependencyError && error.exitCode === 2,
  );
});

test("a missing private oracle refuses to freeze the plan", async () => {
  const project = await createTempProject();
  await rm(project.oracleDirectory, { recursive: true, force: true });
  const { io } = createIo();

  await assert.rejects(
    runDryRun(options(project.root), io),
    (error: unknown) => error instanceof DependencyError && /oracle/u.test(error.message),
  );
});
