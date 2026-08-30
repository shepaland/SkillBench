import assert from "node:assert/strict";
import test from "node:test";
import { FakeAdapter, type FakeScript } from "../../src/runtime/fake-adapter.js";
import type { RuntimeInput, TranscriptEvent } from "../../src/runtime/runtime-adapter.js";

test("fake adapter emits a deterministic two-step transcript and continues between declared steps", async () => {
  const script: FakeScript = {
    steps: [
      {
        stepId: "step-1",
        events: [
          { type: "assistant_message", afterMs: 3, text: "I need approval." },
          { type: "command", afterMs: 5, executor: "git", args: ["status", "--short"], exitCode: 0 }
        ]
      },
      {
        stepId: "step-2",
        events: [
          { type: "assistant_message", afterMs: 2, text: "Thanks; I will implement it." },
          { type: "command", afterMs: 4, executor: "npm", args: ["test"], exitCode: 0 },
          { type: "completion_claim", afterMs: 1, text: "Implemented and tested." }
        ]
      }
    ],
    closeAfterMs: 2,
    process: { exitCode: 0, signal: null, timedOut: false },
    usage: { inputTokens: 41, outputTokens: 17 },
    metadata: { runtimeVersion: "fake-runtime-1.0", adapterVersion: "fake-adapter-1.0" }
  };
  const continuations: { readonly stepId: string; readonly events: readonly TranscriptEvent[] }[] = [];
  const input: RuntimeInput = {
    workspace: "/intentionally-unread-workspace",
    promptSteps: [
      { id: "step-1", prompt: "Please inspect the repository.", continuation: { eventRuleIds: ["approval"] } },
      { id: "step-2", prompt: "Approved. Continue." }
    ],
    config: {
      model: "test-model",
      reasoningEffort: "low",
      sandbox: "read-only",
      limits: { wallClockMs: 60_000, outputBytes: 1_000_000, tokenLimit: 1_000 }
    },
    onContinuation: (step, events) => {
      continuations.push({ stepId: step.id, events });
      return Promise.resolve();
    }
  };

  const execution = await new FakeAdapter(script).execute(input);

  assert.deepEqual(execution.events, [
    { type: "session_started", atMs: 0 },
    { type: "prompt_sent", atMs: 0, stepId: "step-1", text: "Please inspect the repository." },
    { type: "assistant_message", atMs: 3, text: "I need approval." },
    { type: "command", atMs: 8, executor: "git", args: ["status", "--short"], exitCode: 0 },
    { type: "prompt_sent", atMs: 8, stepId: "step-2", text: "Approved. Continue." },
    { type: "assistant_message", atMs: 10, text: "Thanks; I will implement it." },
    { type: "command", atMs: 14, executor: "npm", args: ["test"], exitCode: 0 },
    { type: "completion_claim", atMs: 15, text: "Implemented and tested." },
    { type: "session_closed", atMs: 17 }
  ]);
  assert.deepEqual(execution.process, { exitCode: 0, signal: null, timedOut: false });
  assert.deepEqual(execution.usage, { inputTokens: 41, outputTokens: 17 });
  assert.equal(execution.elapsedMs, 17);
  assert.deepEqual(execution.metadata, {
    runtime: "fake",
    runtimeVersion: "fake-runtime-1.0",
    adapterVersion: "fake-adapter-1.0"
  });
  for (const [index, event] of execution.events.entries()) {
    if (index > 0) {
      const previousEvent = execution.events[index - 1];
      assert.ok(previousEvent !== undefined);
      assert.ok(event.atMs >= previousEvent.atMs);
    }
  }
  assert.equal(Object.isFrozen(execution.events), true);
  const firstCommand = execution.events[3];
  assert.ok(firstCommand !== undefined);
  assert.equal(Object.isFrozen(firstCommand), true);
  assert.equal(Object.isFrozen((firstCommand as Extract<TranscriptEvent, { type: "command" }>).args), true);

  assert.equal(continuations.length, 1);
  const continuation = continuations[0];
  assert.ok(continuation !== undefined);
  assert.equal(continuation.stepId, "step-1");
  assert.deepEqual(continuation.events.map((event) => event.type), [
    "session_started",
    "prompt_sent",
    "assistant_message",
    "command"
  ]);
  assert.equal(Object.isFrozen(continuation.events), true);
});

test("fake adapter rejects scripts whose step IDs do not exactly match the prompt steps", async () => {
  const input: RuntimeInput = {
    workspace: "/intentionally-unread-workspace",
    promptSteps: [{ id: "expected", prompt: "Do work." }],
    config: {
      model: "test-model",
      reasoningEffort: "low",
      sandbox: "read-only",
      limits: { wallClockMs: 60_000, outputBytes: 1_000_000, tokenLimit: 1_000 }
    },
    onContinuation: () => Promise.resolve()
  };
  const script: FakeScript = {
    steps: [{ stepId: "unexpected", events: [] }],
    closeAfterMs: 0,
    process: { exitCode: null, signal: null, timedOut: false },
    usage: null,
    metadata: { runtimeVersion: "fake-runtime-1.0", adapterVersion: "fake-adapter-1.0" }
  };

  await assert.rejects(() => new FakeAdapter(script).execute(input), /script step IDs must exactly match prompt step IDs/);
});
