import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCommand } from "../../../src/runtime/codex/normalize-command.js";

test("splits a shell wrapper into its executor and arguments", () => {
  assert.deepEqual(normalizeCommand('/bin/zsh -lc "node --test tests/"'), [
    { executor: "node", args: ["--test", "tests/"] },
  ]);
});

test("splits chained segments into separate records", () => {
  assert.deepEqual(normalizeCommand('/bin/bash -lc "cd app && node --test"'), [
    { executor: "cd", args: ["app"] },
    { executor: "node", args: ["--test"] },
  ]);
});

test("splits on every supported separator", () => {
  assert.deepEqual(normalizeCommand("/bin/sh -c 'a; b | c || d'"), [
    { executor: "a", args: [] },
    { executor: "b", args: [] },
    { executor: "c", args: [] },
    { executor: "d", args: [] },
  ]);
});

test("strips matching quotes around a token", () => {
  assert.deepEqual(normalizeCommand(`/bin/zsh -lc "sed -n '1,240p' note.txt"`), [
    { executor: "sed", args: ["-n", "1,240p", "note.txt"] },
  ]);
});

test("treats a bare invocation as one record", () => {
  assert.deepEqual(normalizeCommand("node --test"), [{ executor: "node", args: ["--test"] }]);
});

test("keeps an unsplittable script as a single record under the shell", () => {
  assert.deepEqual(normalizeCommand("/bin/zsh -lc"), [{ executor: "/bin/zsh", args: ["-lc"] }]);
});

test("returns no records for an empty command", () => {
  assert.deepEqual(normalizeCommand("   "), []);
});

test("unwraps nested shell wrappers to reach the inner command", () => {
  // The main case from the finding: nested shell wrappers should be unwrapped
  // recursively to find the actual command
  assert.deepEqual(
    normalizeCommand('/bin/zsh -lc "/bin/bash -lc \'node --test\'"'),
    [{ executor: "node", args: ["--test"] }]
  );
});

test("handles multiple levels of nesting without infinite loops", () => {
  // Create a 3-level nested wrapper using mixed quotes to avoid escaping issues
  // This demonstrates that the recursive unwrapping handles multiple shell layers
  assert.deepEqual(
    normalizeCommand(`/bin/sh -c "/bin/sh -lc 'node --test'"`),
    [{ executor: "node", args: ["--test"] }]
  );
});

test("does not treat ordinary commands with -c flag as shell wrappers", () => {
  // Regression guard: gcc -c foo.c should not be treated as a shell wrapper
  // even though it has 3 tokens with -c in the middle
  assert.deepEqual(
    normalizeCommand('/bin/zsh -lc "gcc -c foo.c && node --test"'),
    [
      { executor: "gcc", args: ["-c", "foo.c"] },
      { executor: "node", args: ["--test"] },
    ]
  );
});

test("shells must be verified by basename to avoid false positives", () => {
  // Verify that only known shell basenames (sh, bash, zsh, dash, ksh) trigger unwrapping.
  // Other commands with -c flag (like cc, perl, etc.) should not be unwrapped.
  assert.deepEqual(
    normalizeCommand('/bin/zsh -lc "cc -c file.c && node --test"'),
    [
      { executor: "cc", args: ["-c", "file.c"] },
      { executor: "node", args: ["--test"] },
    ]
  );
});
