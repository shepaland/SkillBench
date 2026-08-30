import assert from "node:assert/strict";
import test from "node:test";
import { runList } from "../../src/commands/list.js";
import { InvocationError } from "../../src/domain/errors.js";
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

test("lists cases with their assertion count and oracle availability", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runList("cases", { project: project.root, json: false }, io);

  assert.match(stdout(), /F01/u);
  assert.match(stdout(), /Implement QueueDesk behavior/u);
  assert.match(stdout(), /implementation/u);
});

test("lists variants with their compatible runtimes", async () => {
  const project = await createTempProject();
  const { io, stdout } = createIo();

  await runList("variants", { project: project.root, json: false }, io);

  assert.match(stdout(), /control/u);
  assert.match(stdout(), /example/u);
  assert.match(stdout(), /fake/u);
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
    cases: { id: string; assertionCount: number; oracleAvailable: boolean }[];
    variants: { id: string; compatibleRuntimes: string[] }[];
  };
  assert.deepEqual(parsed.cases.map((entry) => entry.id), ["F01"]);
  assert.equal(parsed.cases[0]?.assertionCount, 1);
  assert.equal(parsed.cases[0].oracleAvailable, true);
  assert.deepEqual(parsed.variants.map((entry) => entry.id), ["control", "example"]);
});

test("an unknown target raises an invocation error", async () => {
  const project = await createTempProject();
  const { io } = createIo();

  await assert.rejects(
    runList("oracles", { project: project.root, json: false }, io),
    (error: unknown) => error instanceof InvocationError && error.exitCode === 2,
  );
});
