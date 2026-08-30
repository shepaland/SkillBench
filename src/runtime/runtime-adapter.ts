import type { PromptStep, RuntimeLimits } from "../domain/model.js";

export type TranscriptEvent =
  | { readonly type: "session_started"; readonly atMs: number }
  | { readonly type: "prompt_sent"; readonly atMs: number; readonly stepId: string; readonly text: string }
  | { readonly type: "assistant_message"; readonly atMs: number; readonly text: string }
  | { readonly type: "command"; readonly atMs: number; readonly executor: string; readonly args: readonly string[]; readonly exitCode: number }
  | { readonly type: "completion_claim"; readonly atMs: number; readonly text: string }
  | { readonly type: "session_closed"; readonly atMs: number };

export interface RuntimeInput {
  readonly workspace: string;
  readonly promptSteps: readonly PromptStep[];
  readonly config: {
    readonly model: string;
    readonly reasoningEffort: string;
    readonly sandbox: string;
    readonly limits: RuntimeLimits;
  };
  readonly onContinuation: (step: PromptStep, events: readonly TranscriptEvent[]) => Promise<void>;
}

export interface RuntimeExecution {
  readonly events: readonly TranscriptEvent[];
  readonly process: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null; readonly timedOut: boolean };
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly elapsedMs: number;
  readonly metadata: { readonly runtime: string; readonly runtimeVersion: string; readonly adapterVersion: string };
}

export interface RuntimeAdapter {
  execute(input: RuntimeInput): Promise<RuntimeExecution>;
}
