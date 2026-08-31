import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PromptStep } from "../../../src/domain/model.js";
import { CodexAdapter } from "../../../src/runtime/codex/codex-adapter.js";
import type { RuntimeExecution, RuntimeInput } from "../../../src/runtime/runtime-adapter.js";
import {
  changeLine,
  createFakeCodex,
  messageLine,
  readInvocationArgs,
  threadLine,
  usageLine,
  type FakeCodexStep,
} from "../../helpers/fake-codex.js";

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
): Promise<{ readonly execution: RuntimeExecution; readonly directory: string }> {
  const { executable, directory } = await createFakeCodex(script);
  const workspace = await mkdtemp(join(tmpdir(), "codex-ws-"));
  const adapter = new CodexAdapter({
    runtimeVersion: "0.0.0-test",
    executable,
    sourceHome: await authenticatedHome(),
  });

  const execution = await adapter.execute({
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

  return { execution, directory };
}

test("runs two steps, resuming the thread and awaiting the continuation", async () => {
  const seenAtContinuation: number[] = [];
  const { execution, directory } = await run(
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

  // The second invocation must actually carry `resume` and the thread ID from the
  // first step's output — not just any two arguments the fake happens to accept.
  const invocations = await readInvocationArgs(directory);
  assert.equal(invocations.length, 2);
  const secondArgs = invocations[1] ?? [];
  assert.ok(secondArgs.includes("exec"));
  assert.ok(secondArgs.includes("resume"));
  assert.ok(secondArgs.includes("t-1"));
});

test("fails with a clear message when the first step reports no thread", async () => {
  await assert.rejects(
    run([{ lines: [messageLine("hello"), usageLine(1, 1)] }, { lines: [] }]),
    /thread identifier/,
  );
});

test("counts an unparsed line without failing the run", async () => {
  const raw: string[] = [];
  const { execution } = await run(
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
  // The trailing content has no newline, so it never reaches the ordinary
  // per-line handler in the 'data' listener; it can only be observed through
  // the leftover-buffer flush that runs once the stream closes. If that flush
  // were removed, this content would simply vanish instead of being counted.
  const { execution } = await run([
    { lines: [threadLine("t-1")], trailingPartial: '{"type":"item.completed","item":{' },
    { lines: [threadLine("t-1"), usageLine(1, 1)] },
  ]);

  assert.equal(execution.unparsedLines, 1);
  assert.equal(execution.exhaustion, null);
});

test("stops the child and reports wall_clock exhaustion", async () => {
  const { execution } = await run(
    [{ lines: [threadLine("t-1")], lingerMs: 30000 }],
    { limits: { wallClockMs: 100, outputBytes: 1000000, tokenLimit: 1000000 } },
  );

  assert.equal(execution.exhaustion, "wall_clock");
  // Proves the child was actually stopped, not merely that it finished on its
  // own: it was told to linger 30s, and it received SIGTERM well before that.
  assert.equal(execution.process.signal, "SIGTERM");
  assert.ok(execution.elapsedMs < 10000, `expected an early stop, got elapsedMs=${String(execution.elapsedMs)}`);
});

test("stops the child and reports output_bytes exhaustion", async () => {
  const { execution } = await run(
    [{ lines: [threadLine("t-1"), messageLine("x".repeat(5000)), usageLine(1, 1)], lingerMs: 2000 }],
    { limits: { wallClockMs: 30000, outputBytes: 200, tokenLimit: 1000000 } },
  );

  assert.equal(execution.exhaustion, "output_bytes");
  // Proves the child was actually stopped before its scripted 2s linger elapsed.
  assert.equal(execution.process.signal, "SIGTERM");
  assert.ok(execution.elapsedMs < 2000, `expected an early stop, got elapsedMs=${String(execution.elapsedMs)}`);
});

test("does not send a later step once the token budget is spent", async () => {
  const { execution } = await run(
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
  const { execution } = await run([
    { lines: [threadLine("t-1")], exitCode: 3 },
    { lines: [threadLine("t-1"), usageLine(1, 1)] },
  ]);

  assert.equal(execution.process.exitCode, 3);
});

test("relativizes file change paths against the workspace", async () => {
  const { execution } = await run(
    [{ lines: [threadLine("t-1"), changeLine("/nowhere/outside.js"), usageLine(1, 1)] }],
    {},
    [{ id: "s1", prompt: "go" }],
  );

  const change = execution.events.find((event) => event.type === "file_change");
  assert.deepEqual(change?.type === "file_change" ? change.outsidePaths : null, ["/nowhere/outside.js"]);
});

test("does not hang when a grandchild keeps stdout open after the child exits", async () => {
  // The fake exits immediately but first spawns a detached grandchild that
  // inherits its stdout and holds that pipe open for 3s on its own — exactly
  // the shape of a sandboxed subprocess a real runtime might leave behind.
  // If the adapter waited on `close` alone this step would take ~3s; the
  // bounded exit-based fallback must resolve it far sooner.
  const { execution } = await run([{ lines: [threadLine("t-1")], spawnGrandchildMs: 3000 }]);

  assert.equal(execution.exhaustion, null);
  assert.ok(execution.elapsedMs < 2000, `expected an early resolve, got elapsedMs=${String(execution.elapsedMs)}`);
});

test("does not let a declared variable override the run's own isolation", async () => {
  const raw: string[] = [];
  await run(
    [{ lines: [threadLine("t-1")], probeEnvKeys: ["CODEX_HOME", "PATH"] }],
    { environment: { CODEX_HOME: "/should-not-win", PATH: "/should-not-win" } },
    [{ id: "s1", prompt: "go" }],
    { onRawLine: (_stepId, line) => raw.push(line) },
  );

  const probes = raw
    .map((line): { type: string; key: string; value: string | null } | null => {
      try {
        return JSON.parse(line) as { type: string; key: string; value: string | null };
      } catch {
        return null;
      }
    })
    .filter((probe): probe is { type: string; key: string; value: string | null } =>
      probe !== null && probe.type === "env.probe");

  const codexHome = probes.find((probe) => probe.key === "CODEX_HOME")?.value;
  const path = probes.find((probe) => probe.key === "PATH")?.value;

  assert.notEqual(codexHome, "/should-not-win");
  assert.ok(codexHome !== null && codexHome !== undefined && codexHome.length > 0);
  assert.notEqual(path, "/should-not-win");
});

test("stops listening to a step's stdio once that step has settled", async () => {
  const raw: string[] = [];
  const lateLine = messageLine("late-from-grandchild");
  const { execution } = await run(
    [
      // Step 1 exits almost immediately, but its detached grandchild inherits
      // stdout and writes `lateLine` well after step 1 has already settled.
      { lines: [threadLine("t-1")], grandchildWrite: { afterMs: 300, line: lateLine } },
      // Step 2 deliberately lingers, so it is still in progress at the 300ms
      // mark — if step 1's stdio were still being listened to, the late write
      // would land here, splicing a dead step's event into step 2's region.
      { lines: [threadLine("t-1"), usageLine(1, 1)], lingerMs: 1200 },
    ],
    {},
    steps,
    { onRawLine: (_stepId, line) => raw.push(line) },
  );

  assert.ok(!raw.includes(lateLine));
  assert.ok(!execution.events.some((event) =>
    event.type === "assistant_message" && event.text === "late-from-grandchild"));
});
