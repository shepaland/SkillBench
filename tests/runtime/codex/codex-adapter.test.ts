import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PromptStep } from "../../../src/domain/model.js";
import { CodexAdapter } from "../../../src/runtime/codex/codex-adapter.js";
import type { RuntimeInput } from "../../../src/runtime/runtime-adapter.js";
import { changeLine, createFakeCodex, messageLine, threadLine, usageLine, type FakeCodexStep } from "../../helpers/fake-codex.js";

const steps: readonly PromptStep[] = [
  { id: "s1", prompt: "ask first", continuation: { eventRuleIds: ["stopped"] } },
  { id: "s2", prompt: "now do it" },
];

async function authenticatedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "codex-home-"));
  await writeFile(join(home, "auth.json"), "{}", "utf8");
  return home;
}

async function run(
  script: readonly FakeCodexStep[],
  overrides: Partial<RuntimeInput["config"]> = {},
  promptSteps: readonly PromptStep[] = steps,
  hooks: Partial<Pick<RuntimeInput, "onContinuation" | "onRawLine">> = {},
) {
  const { executable } = await createFakeCodex(script);
  const workspace = await mkdtemp(join(tmpdir(), "codex-ws-"));
  const adapter = new CodexAdapter({
    runtimeVersion: "0.0.0-test",
    executable,
    sourceHome: await authenticatedHome(),
  });

  return adapter.execute({
    workspace,
    promptSteps,
    config: {
      model: "m",
      reasoningEffort: "low",
      sandbox: "workspace-write",
      limits: { wallClockMs: 30000, outputBytes: 1000000, tokenLimit: 1000000 },
      environment: {},
      ...overrides,
    },
    onContinuation: hooks.onContinuation ?? (async () => {}),
    ...(hooks.onRawLine === undefined ? {} : { onRawLine: hooks.onRawLine }),
  });
}

test("runs two steps, resuming the thread and awaiting the continuation", async () => {
  const seenAtContinuation: number[] = [];
  const execution = await run(
    [
      { lines: [threadLine("t-1"), messageLine("here is my plan"), usageLine(10, 5)] },
      { lines: [threadLine("t-1"), messageLine("done"), usageLine(10, 5)] },
    ],
    {},
    steps,
    {
      onContinuation: (_step, events) => {
        seenAtContinuation.push(events.filter((event) => event.type === "prompt_sent").length);
        return Promise.resolve();
      },
    },
  );

  // The gate ran once, and it ran while only the first prompt had been sent.
  assert.deepEqual(seenAtContinuation, [1]);
  assert.equal(execution.events.filter((event) => event.type === "prompt_sent").length, 2);
  assert.equal(execution.events.at(-1)?.type, "session_closed");
  assert.equal(execution.exhaustion, null);
  assert.deepEqual(execution.usage, { inputTokens: 20, outputTokens: 10 });
  assert.equal(execution.metadata.runtime, "codex");
  assert.equal(execution.metadata.runtimeVersion, "0.0.0-test");
});

test("fails with a clear message when the first step reports no thread", async () => {
  await assert.rejects(
    run([{ lines: [messageLine("hello"), usageLine(1, 1)] }, { lines: [] }]),
    /thread identifier/,
  );
});

test("counts an unparsed line without failing the run", async () => {
  const raw: string[] = [];
  const execution = await run(
    [
      { lines: [threadLine("t-1"), "garbage", usageLine(1, 1)] },
      { lines: [threadLine("t-1"), usageLine(1, 1)] },
    ],
    {},
    steps,
    { onRawLine: (_stepId, line) => raw.push(line) },
  );

  assert.equal(execution.unparsedLines, 1);
  assert.ok(raw.includes("garbage"));
  assert.ok(execution.events.some((event) => event.type === "completion_claim"));
});

test("survives a stream truncated mid-line", async () => {
  const execution = await run([
    { lines: [threadLine("t-1"), '{"type":"item.completed","item":{'] },
    { lines: [threadLine("t-1"), usageLine(1, 1)] },
  ]);

  assert.equal(execution.unparsedLines, 1);
  assert.equal(execution.exhaustion, null);
});

test("stops the child and reports wall_clock exhaustion", async () => {
  const execution = await run(
    [{ lines: [threadLine("t-1")], lingerMs: 30000 }],
    { limits: { wallClockMs: 100, outputBytes: 1000000, tokenLimit: 1000000 } },
  );

  assert.equal(execution.exhaustion, "wall_clock");
  assert.equal(execution.process.timedOut, true);
});

test("stops the child and reports output_bytes exhaustion", async () => {
  const execution = await run(
    [{ lines: [threadLine("t-1"), messageLine("x".repeat(5000)), usageLine(1, 1)], lingerMs: 2000 }],
    { limits: { wallClockMs: 30000, outputBytes: 200, tokenLimit: 1000000 } },
  );

  assert.equal(execution.exhaustion, "output_bytes");
});

test("does not send a later step once the token budget is spent", async () => {
  const execution = await run(
    [
      { lines: [threadLine("t-1"), usageLine(100, 100)] },
      { lines: [threadLine("t-1"), usageLine(1, 1)] },
    ],
    { limits: { wallClockMs: 30000, outputBytes: 1000000, tokenLimit: 10 } },
  );

  assert.equal(execution.exhaustion, "token_limit");
  assert.equal(execution.events.filter((event) => event.type === "prompt_sent").length, 1);
});

test("reports a non-zero exit as a process failure", async () => {
  const execution = await run([
    { lines: [threadLine("t-1")], exitCode: 3 },
    { lines: [threadLine("t-1"), usageLine(1, 1)] },
  ]);

  assert.equal(execution.process.exitCode, 3);
});

test("relativizes file change paths against the workspace", async () => {
  const execution = await run(
    [{ lines: [threadLine("t-1"), changeLine("/nowhere/outside.js"), usageLine(1, 1)] }],
    {},
    [{ id: "s1", prompt: "go" }],
  );

  const change = execution.events.find((event) => event.type === "file_change");
  assert.deepEqual(change?.type === "file_change" ? change.outsidePaths : null, ["/nowhere/outside.js"]);
});
