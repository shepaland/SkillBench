import type { PromptStep } from "../domain/model.js";
import type { RuntimeAdapter, RuntimeExecution, RuntimeInput, TranscriptEvent } from "./runtime-adapter.js";

export type FakeStepEvent =
  | { readonly type: "assistant_message"; readonly afterMs: number; readonly text: string }
  | { readonly type: "command"; readonly afterMs: number; readonly executor: string; readonly args: readonly string[]; readonly exitCode: number }
  | { readonly type: "completion_claim"; readonly afterMs: number; readonly text: string };

export interface FakeScriptStep {
  readonly stepId: string;
  readonly events: readonly FakeStepEvent[];
}

export interface FakeScript {
  readonly steps: readonly FakeScriptStep[];
  readonly closeAfterMs: number;
  readonly process: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null; readonly timedOut: boolean };
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly metadata: { readonly runtimeVersion: string; readonly adapterVersion: string };
}

export class FakeAdapter implements RuntimeAdapter {
  public constructor(private readonly script: FakeScript) {}

  public async execute(input: RuntimeInput): Promise<RuntimeExecution> {
    validateStepIds(input.promptSteps, this.script.steps);

    let clockMs = 0;
    const events: TranscriptEvent[] = [freezeEvent({ type: "session_started", atMs: clockMs })];

    for (const step of input.promptSteps) {
      events.push(freezeEvent({ type: "prompt_sent", atMs: clockMs, stepId: step.id, text: step.prompt }));
      const scriptStep = this.script.steps.find((candidate) => candidate.stepId === step.id);
      if (scriptStep === undefined) {
        throw new Error("script step IDs must exactly match prompt step IDs");
      }

      for (const scriptedEvent of scriptStep.events) {
        clockMs = advanceClock(clockMs, scriptedEvent.afterMs);
        events.push(toTranscriptEvent(scriptedEvent, clockMs));
      }

      if (step.continuation !== undefined) {
        await input.onContinuation(step, Object.freeze([...events]));
      }
    }

    clockMs = advanceClock(clockMs, this.script.closeAfterMs);
    events.push(freezeEvent({ type: "session_closed", atMs: clockMs }));

    return Object.freeze({
      events: Object.freeze([...events]),
      process: Object.freeze({ ...this.script.process }),
      usage: this.script.usage === null ? null : Object.freeze({ ...this.script.usage }),
      elapsedMs: clockMs,
      metadata: Object.freeze({
        runtime: "fake",
        runtimeVersion: this.script.metadata.runtimeVersion,
        adapterVersion: this.script.metadata.adapterVersion
      })
    });
  }
}

function validateStepIds(promptSteps: readonly PromptStep[], scriptSteps: readonly FakeScriptStep[]): void {
  const promptIds = new Set(promptSteps.map((step) => step.id));
  const scriptIds = new Set(scriptSteps.map((step) => step.stepId));
  if (promptIds.size !== promptSteps.length || scriptIds.size !== scriptSteps.length ||
    promptIds.size !== scriptIds.size || [...promptIds].some((id) => !scriptIds.has(id))) {
    throw new Error("script step IDs must exactly match prompt step IDs");
  }
}

function advanceClock(clockMs: number, durationMs: number): number {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new Error("fake script durations must be non-negative safe integers");
  }
  const nextClockMs = clockMs + durationMs;
  if (!Number.isSafeInteger(nextClockMs)) {
    throw new Error("fake clock exceeds the safe integer range");
  }
  return nextClockMs;
}

function toTranscriptEvent(event: FakeStepEvent, atMs: number): TranscriptEvent {
  switch (event.type) {
    case "assistant_message":
      return freezeEvent({ type: "assistant_message", atMs, text: event.text });
    case "command":
      return freezeEvent({ type: "command", atMs, executor: event.executor, args: [...event.args], exitCode: event.exitCode });
    case "completion_claim":
      return freezeEvent({ type: "completion_claim", atMs, text: event.text });
  }
}

function freezeEvent(event: TranscriptEvent): TranscriptEvent {
  if (event.type === "command") {
    return Object.freeze({ ...event, args: Object.freeze([...event.args]) });
  }
  return Object.freeze({ ...event });
}
