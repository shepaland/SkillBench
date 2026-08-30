import assert from "node:assert/strict";
import test from "node:test";
import { createProgram } from "../../src/cli/create-program.js";
import { main } from "../../src/cli.js";

test("help publishes the version 1 commands", () => {
  const output: string[] = [];
  const program = createProgram().configureOutput({
    writeOut: (value) => output.push(value),
    writeErr: (value) => output.push(value),
  });
  program.exitOverride();
  assert.throws(() => program.parse(["node", "skillbench", "--help"]));
  const help = output.join("");
  for (const command of ["validate", "list", "dry-run", "run", "compare", "report"]) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }
});

test("an invalid invocation returns exit code 2", async () => {
  assert.equal(await main(["node", "skillbench", "unknown-command"]), 2);
});

test("an invalid invocation renders its error only once", async (t) => {
  const output: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  t.after(() => {
    process.stderr.write = originalWrite;
  });
  process.stderr.write = ((value: string | Uint8Array) => {
    output.push(value.toString());
    return true;
  }) as typeof process.stderr.write;

  assert.equal(await main(["node", "skillbench", "unknown-command"]), 2);
  assert.deepEqual(output.join("").match(/error: unknown command 'unknown-command'/g), [
    "error: unknown command 'unknown-command'",
  ]);
});
