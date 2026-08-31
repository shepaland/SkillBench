import type { PromptStep, RuntimeLimits } from "../domain/model.js";

export type ExhaustionCause = "wall_clock" | "output_bytes" | "token_limit" | "signal";

export type TranscriptEvent =
  | { readonly type: "session_started"; readonly atMs: number }
  | { readonly type: "prompt_sent"; readonly atMs: number; readonly stepId: string; readonly text: string }
  | { readonly type: "assistant_message"; readonly atMs: number; readonly text: string }
  | { readonly type: "command"; readonly atMs: number; readonly executor: string; readonly args: readonly string[]; readonly exitCode: number }
  | { readonly type: "file_change"; readonly atMs: number; readonly paths: readonly string[]; readonly outsidePaths: readonly string[] }
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
    /** Variant-declared variables that are safe to expose to the child process. */
    readonly environment: Readonly<Record<string, string>>;
  };
  readonly onContinuation: (step: PromptStep, events: readonly TranscriptEvent[]) => Promise<void>;
  /** Called for every raw stream line before parsing. Adapters without a stream never call it. */
  readonly onRawLine?: (stepId: string, line: string) => void;
}

export interface RuntimeExecution {
  readonly events: readonly TranscriptEvent[];
  readonly process: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null; readonly timedOut: boolean };
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly elapsedMs: number;
  readonly metadata: { readonly runtime: string; readonly runtimeVersion: string; readonly adapterVersion: string };
  /** Why the runtime stopped short of finishing, or null when it finished normally. */
  readonly exhaustion: ExhaustionCause | null;
  /** Stream lines this adapter did not recognize. Never fatal; preserved in raw evidence. */
  readonly unparsedLines: number;
  /** Cleanup the adapter could not complete. Recorded beside the run outcome, never in place of it. */
  readonly cleanupFailures?: readonly string[];
}

export interface RuntimeAdapter {
  execute(input: RuntimeInput): Promise<RuntimeExecution>;
}
