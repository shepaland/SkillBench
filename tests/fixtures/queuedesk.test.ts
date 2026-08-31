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

// Read once and shared by every test below, so the latent copies and the
// claim-order copy are all measured against the same base count instead of
// each spawning their own redundant run of the base suite.
const basePromise = runFixtureSuite("queuedesk");

test("the base fixture suite is green", async () => {
  const outcome = await basePromise;
  assert.equal(outcome.failed, 0, outcome.output);
});

for (const fixture of ["queuedesk-tenant-leak", "queuedesk-unsafe-write", "queuedesk-stale-timestamp"]) {
  test(`the ${fixture} defect stays invisible to the public suite`, async () => {
    const [base, outcome] = await Promise.all([basePromise, runFixtureSuite(fixture)]);
    assert.equal(outcome.failed, 0, outcome.output);
    assert.equal(
      outcome.passed,
      base.passed,
      `expected exactly ${String(base.passed)} passing tests, saw ${String(outcome.passed)}`,
    );
  });
}

test("the queuedesk-claim-order defect shows exactly one failing test", async () => {
  const [base, outcome] = await Promise.all([basePromise, runFixtureSuite("queuedesk-claim-order")]);
  assert.equal(outcome.failed, 1, outcome.output);
  assert.equal(
    outcome.passed,
    base.passed - 1,
    `expected exactly ${String(base.passed - 1)} passing tests, saw ${String(outcome.passed)}`,
  );
  assert.match(outcome.output, /not ok \d+ - claim takes the highest priority queued job first/u);
});
