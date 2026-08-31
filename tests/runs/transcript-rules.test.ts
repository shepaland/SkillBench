import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptEvent } from "../../src/runtime/runtime-adapter.js";
import type { TranscriptRule } from "../../src/domain/model.js";
import { evaluateRule, evaluateRules } from "../../src/runs/transcript-rules.js";

function message(atMs: number): TranscriptEvent {
  return { type: "assistant_message", atMs, text: "hello" };
}

function command(atMs: number, executor: string, args: readonly string[]): TranscriptEvent {
  return { type: "command", atMs, executor, args, exitCode: 0 };
}

function change(atMs: number): TranscriptEvent {
  return { type: "file_change", atMs, paths: ["src/a.js"], outsidePaths: [] };
}

test("no_file_change holds when nothing was edited", () => {
  const rule: TranscriptRule = { id: "r", check: "no_file_change" };
  assert.equal(evaluateRule(rule, [message(1)]).satisfied, true);
  assert.equal(evaluateRule(rule, [message(1), change(2)]).satisfied, false);
});

test("assistant_message requires the agent to have spoken", () => {
  const rule: TranscriptRule = { id: "r", check: "assistant_message" };
  assert.equal(evaluateRule(rule, []).satisfied, false);
  assert.equal(evaluateRule(rule, [message(1)]).satisfied, true);
});

test("command_ran matches the executor and an argument prefix", () => {
  const rule: TranscriptRule = { id: "r", check: "command_ran", executor: "node", argsPrefix: ["--test"] };
  assert.equal(evaluateRule(rule, [command(1, "node", ["--test", "tests/"])]).satisfied, true);
  assert.equal(evaluateRule(rule, [command(1, "node", ["build.js"])]).satisfied, false);
  assert.equal(evaluateRule(rule, [command(1, "npm", ["--test"])]).satisfied, false);
});

test("command_ran with an empty prefix matches any arguments", () => {
  const rule: TranscriptRule = { id: "r", check: "command_ran", executor: "git", argsPrefix: [] };
  assert.equal(evaluateRule(rule, [command(1, "git", ["status"])]).satisfied, true);
});

test("expect false inverts the outcome and keeps the raw result visible", () => {
  const rule: TranscriptRule = { id: "r", check: "no_file_change", expect: false };
  const outcome = evaluateRule(rule, [message(1)]);
  assert.equal(outcome.held, true);
  assert.equal(outcome.satisfied, false);
});

test("command_before_file_change requires the command and correct order", () => {
  const rule: TranscriptRule = { id: "r", check: "command_before_file_change", executor: "node", argsPrefix: ["--test"] };
  assert.equal(evaluateRule(rule, [command(1, "node", ["--test"]), change(2)]).satisfied, true);
  assert.equal(evaluateRule(rule, [change(1), command(2, "node", ["--test"])]).satisfied, false);
  assert.equal(evaluateRule(rule, [command(1, "node", ["--test"])]).satisfied, true);
  assert.equal(evaluateRule(rule, [change(1)]).satisfied, false);
});

test("command_after_file_change requires the last command to follow the last edit", () => {
  const rule: TranscriptRule = { id: "r", check: "command_after_file_change", executor: "node", argsPrefix: ["--test"] };
  assert.equal(evaluateRule(rule, [change(1), command(2, "node", ["--test"])]).satisfied, true);
  assert.equal(evaluateRule(rule, [command(1, "node", ["--test"]), change(2)]).satisfied, false);
  assert.equal(evaluateRule(rule, [command(1, "node", ["--test"])]).satisfied, true);
  assert.equal(evaluateRule(rule, []).satisfied, false);
});

test("an empty window fails every positive check", () => {
  const rules: readonly TranscriptRule[] = [
    { id: "a", check: "assistant_message" },
    { id: "b", check: "command_ran", executor: "node", argsPrefix: [] },
  ];
  assert.deepEqual(evaluateRules(rules, []).map((outcome) => outcome.satisfied), [false, false]);
});

test("evaluateRules preserves rule order and identifiers", () => {
  const rules: readonly TranscriptRule[] = [
    { id: "second", check: "no_file_change" },
    { id: "first", check: "assistant_message" },
  ];
  assert.deepEqual(evaluateRules(rules, [message(1)]).map((outcome) => outcome.ruleId), ["second", "first"]);
});
