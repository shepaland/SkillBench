import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { runList } from "../../src/commands/list.js";
import { DependencyError, InvocationError } from "../../src/domain/errors.js";
import { createTempProject, writeJson } from "../helpers/temp-project.js";

function createIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

test("lists cases with their assertion count and oracle availability", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runList("cases", { project: project.root, json: false }, io);

  assert.match(stdout(), /F01/u);
  assert.match(stdout(), /Implement QueueDesk behavior/u);
  assert.match(stdout(), /implementation/u);
  assert.match(stdout(), /oracle=available/u);
  assert.doesNotMatch(stdout(), /Variants:/u);
  assert.doesNotMatch(stdout(), /control/u);
});

test("lists variants with their compatible runtimes", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runList("variants", { project: project.root, json: false }, io);

  assert.match(stdout(), /control/u);
  assert.match(stdout(), /example/u);
  assert.match(stdout(), /fake/u);
  assert.doesNotMatch(stdout(), /Cases:/u);
  assert.doesNotMatch(stdout(), /F01/u);
});

test("no target lists both sections", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runList(undefined, { project: project.root, json: false }, io);

  assert.match(stdout(), /F01/u);
  assert.match(stdout(), /example/u);
});

test("--json emits a parseable document with both collections", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runList(undefined, { project: project.root, json: true }, io);

  const parsed = JSON.parse(stdout()) as {
    cases: { id: string; assertionCount: number; oracle: string }[];
    variants: { id: string; compatibleRuntimes: string[] }[];
  };
  assert.deepEqual(parsed.cases.map((entry) => entry.id), ["F01"]);
  assert.equal(parsed.cases[0]?.assertionCount, 1);
  assert.equal(parsed.cases[0].oracle, "available");
  assert.deepEqual(parsed.variants.map((entry) => entry.id), ["control", "example"]);
});

test("an unparseable oracle manifest is reported as invalid without failing the listing", async () => {
  const project = await createTempProject();
  await writeFile(project.oracleManifestPath, "{ not json\n");
  const { io, stdout } = createIo();

  await runList("cases", { project: project.root, json: false }, io);
  assert.match(stdout(), /oracle=invalid/u);

  const json = createIo();
  await runList("cases", { project: project.root, json: true }, json.io);
  const parsed = JSON.parse(json.stdout()) as { cases: { oracle: string }[] };
  assert.equal(parsed.cases[0]?.oracle, "invalid");
});

test("an oracle that does not cover the declared assertions is reported as invalid", async () => {
  const project = await createTempProject();
  await writeJson(project.oracleManifestPath, {
    schemaVersion: 1,
    caseId: "F01",
    checks: [
      {
        assertionId: "assert-unknown",
        command: { executor: "node", args: ["assert-1.js"] },
        workingDirectory: "checks",
        timeoutMs: 10_000,
      },
    ],
  });
  const { io, stdout } = createIo();

  await runList("cases", { project: project.root, json: false }, io);

  assert.match(stdout(), /oracle=invalid/u);
});

test("a case without a private oracle is reported as missing", async () => {
  const project = await createTempProject();
  await rm(project.oracleDirectory, { recursive: true, force: true });
  const { io, stdout } = createIo();

  await runList("cases", { project: project.root, json: false }, io);

  assert.match(stdout(), /oracle=missing/u);
});

test("a blocking catalog issue raises a dependency error", async () => {
  const project = await createTempProject();
  await writeFile(project.caseManifestPath, "{ not json\n");
  const { io } = createIo();

  await assert.rejects(
    runList(undefined, { project: project.root, json: false }, io),
    (error: unknown) => error instanceof DependencyError && error.exitCode === 2,
  );
});

test("an unknown target raises an invocation error", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  await assert.rejects(
    runList("oracles", { project: project.root, json: false }, io),
    (error: unknown) => error instanceof InvocationError && error.exitCode === 2,
  );
});
