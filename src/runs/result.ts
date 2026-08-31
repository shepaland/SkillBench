import type { FrozenRunManifest } from "../domain/model.js";
import type { AssertionResult } from "../oracles/run-oracle.js";
import type { RuntimeExecution } from "../runtime/runtime-adapter.js";
import type { ImmutableJsonStore } from "../storage/immutable-json-store.js";
import { runDirectory } from "./freeze-inputs.js";
import type { ChangePathObservations, ChangeSet } from "./snapshot.js";
import type { TranscriptRuleOutcome } from "./transcript-rules.js";

export type RunStatus = "completed" | "exhausted" | "errored";

export type PipelineStep =
  | "materialize"
  | "install"
  | "baseline_snapshot"
  | "oracle_setup"
  | "execute"
  | "final_snapshot"
  | "grade"
  | "verify_fixture";

export interface RunCosts {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly wallClockMs: number;
  readonly unplannedUserTurns: number;
}

export interface RunResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly manifest: FrozenRunManifest;
  readonly status: RunStatus;
  readonly failedStep: PipelineStep | null;
  readonly failureMessage: string;
  readonly assertions: readonly AssertionResult[];
  readonly transcriptRuleOutcomes: readonly TranscriptRuleOutcome[];
  readonly changes: ChangeSet;
  readonly changePathObservations: ChangePathObservations;
  readonly costs: RunCosts;
  readonly adapter: {
    readonly runtime: string;
    readonly runtimeVersion: string;
    readonly adapterVersion: string;
  };
  readonly preservedWorkspacePath: string | null;
  readonly cleanupFailures: readonly string[];
}

export class RunEvidenceWriter {
  public readonly directory: string;

  public constructor(
    private readonly store: ImmutableJsonStore,
    private readonly manifest: FrozenRunManifest,
  ) {
    this.directory = runDirectory(manifest);
  }

  public async writeManifest(): Promise<void> {
    await this.store.write(`${this.directory}/manifest.json`, this.manifest);
  }

  public async writeTranscript(
    execution: RuntimeExecution,
    ruleOutcomes: readonly TranscriptRuleOutcome[],
  ): Promise<void> {
    await this.store.write(`${this.directory}/transcript.json`, {
      schemaVersion: 1,
      runId: this.manifest.runId,
      events: execution.events,
      process: execution.process,
      usage: execution.usage,
      elapsedMs: execution.elapsedMs,
      exhaustion: execution.exhaustion,
      unparsedLines: execution.unparsedLines,
      transcriptRuleOutcomes: ruleOutcomes,
      metadata: execution.metadata,
    });
  }

  public async writeChanges(changes: ChangeSet, observations: ChangePathObservations): Promise<void> {
    await this.store.write(`${this.directory}/changes.json`, {
      schemaVersion: 1,
      runId: this.manifest.runId,
      changes,
      changePathObservations: observations,
    });
  }

  public async writeResult(result: RunResult): Promise<void> {
    await this.store.write(`${this.directory}/result.json`, result);
  }
}

export function hasFailedCriticalAssertion(result: RunResult): boolean {
  return result.assertions.some((assertion) => assertion.critical && assertion.outcome !== "passed");
}
