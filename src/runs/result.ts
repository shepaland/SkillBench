import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { FrozenRunManifest } from "../domain/model.js";
import type { AssertionResult } from "../oracles/run-oracle.js";
import type { ProjectPaths } from "../paths/project-paths.js";
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
  private rawQueue: Promise<void> = Promise.resolve();
  private readonly rawFailures: string[] = [];

  public constructor(
    private readonly store: ImmutableJsonStore,
    private readonly manifest: FrozenRunManifest,
    private readonly paths: ProjectPaths,
  ) {
    this.directory = runDirectory(manifest);
  }

  /** Queues one raw runtime line, written before parsing so a parser defect cannot destroy it. */
  public appendRawLine(stepId: string, line: string): void {
    this.rawQueue = this.rawQueue
      .then(async () => {
        const path = await this.paths.resolveOutput(`${this.directory}/raw/step-${stepId}.jsonl`);
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${line}\n`, "utf8");
      })
      .catch((error: unknown) => {
        this.rawFailures.push(error instanceof Error ? error.message : String(error));
      });
  }

  /** Waits for queued raw writes and reports any that failed. */
  public async flushRawLines(): Promise<readonly string[]> {
    await this.rawQueue;
    return Object.freeze([...this.rawFailures]);
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
