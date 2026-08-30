import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { main } from "../../src/cli.js";
import { runValidate, type CommandIo } from "../../src/commands/validate.js";
import { FindingError } from "../../src/domain/errors.js";
import { createTempProject } from "../helpers/temp-project.js";

function captureIo(): { readonly io: CommandIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

test("runValidate reports singular case and plural variants for a valid project", async () => {
  const project = await createTempProject();
  const output = captureIo();

  await runValidate({ project: project.root, publicOnly: false }, output.io);

  assert.deepEqual(output.stdout, ["Validated 1 case and 2 variants.\n"]);
  assert.deepEqual(output.stderr, []);
});

test("runValidate prints catalog findings before throwing FindingError", async () => {
  const project = await createTempProject();
  await writeFile(join(project.fixtureDirectory, "unexpected.js"), "export const changed = true;\n");
  const output = captureIo();

  await assert.rejects(
    runValidate({ project: project.root, publicOnly: false }, output.io),
    FindingError,
  );

  assert.match(output.stderr.join(""), /^cases\/F01\/case\.json: FIXTURE_HASH_MISMATCH: /mu);
});

test("main maps catalog findings to exit code 1", async () => {
  const project = await createTempProject();
  await writeFile(join(project.fixtureDirectory, "unexpected.js"), "export const changed = true;\n");
  const output = captureIo();

  assert.equal(
    await main(["node", "skillbench", "validate", "--project", project.root], output.io),
    1,
  );
  assert.match(output.stderr.join(""), /^cases\/F01\/case\.json: FIXTURE_HASH_MISMATCH: /mu);
});

test("main maps malformed validate options to exit code 2", async () => {
  const output = captureIo();

  assert.equal(await main(["node", "skillbench", "validate", "--project"], output.io), 2);
});

test("public-only validation relaxes only private oracle availability", async () => {
  const project = await createTempProject();
  await rm(project.oracleDirectory, { recursive: true });

  const normalOutput = captureIo();
  await assert.rejects(
    runValidate({ project: project.root, publicOnly: false }, normalOutput.io),
    FindingError,
  );
  assert.match(normalOutput.stderr.join(""), /ORACLE_UNAVAILABLE/u);

  const publicOutput = captureIo();
  await runValidate({ project: project.root, publicOnly: true }, publicOutput.io);
  assert.deepEqual(publicOutput.stdout, ["Validated 1 case and 2 variants.\n"]);
  assert.deepEqual(publicOutput.stderr, []);
});
