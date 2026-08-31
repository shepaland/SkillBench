import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const run = promisify(execFile);
const repositoryRoot = join(import.meta.dirname, "../..");

interface SuiteOutcome {
  readonly passed: number;
  readonly failed: number;
  readonly output: string;
}

async function runFixtureSuite(fixture: string): Promise<SuiteOutcome> {
  const cwd = join(repositoryRoot, "fixtures", fixture);
  // This test itself runs under `node --test`, which sets NODE_TEST_CONTEXT in
  // this process's environment. That variable is inherited by the child below
  // by default and makes it switch to an internal IPC reporter instead of
  // writing TAP to stdout, leaving `output` empty. Strip it so the child always
  // reports over stdout as requested via --test-reporter=tap.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  let output: string;
  try {
    const result = await run(process.execPath, ["--test", "--test-reporter=tap"], { cwd, env });
    output = result.stdout;
  } catch (error) {
    output = (error as { stdout?: string }).stdout ?? "";
  }
  return {
    passed: readCount(output, "pass"),
    failed: readCount(output, "fail"),
    output,
  };
}

function readCount(output: string, label: string): number {
  const match = new RegExp(`^# ${label} (\\d+)$`, "mu").exec(output);
  assert.notEqual(match, null, `the ${label} summary line is missing from the reporter output`);
  return Number(match?.[1]);
}

test("the base fixture suite is green", async () => {
  const outcome = await runFixtureSuite("queuedesk");
  assert.equal(outcome.failed, 0);
  assert.ok(outcome.passed >= 40, `expected a dense suite, saw ${String(outcome.passed)} passing tests`);
});

for (const fixture of ["queuedesk-tenant-leak", "queuedesk-unsafe-write", "queuedesk-stale-timestamp"]) {
  test(`the ${fixture} defect stays invisible to the public suite`, async () => {
    const outcome = await runFixtureSuite(fixture);
    assert.equal(outcome.failed, 0, outcome.output);
  });
}

test("the queuedesk-claim-order defect shows exactly one failing test", async () => {
  const outcome = await runFixtureSuite("queuedesk-claim-order");
  assert.equal(outcome.failed, 1, outcome.output);
  assert.match(outcome.output, /not ok \d+ - claim takes the highest priority queued job first/u);
});
