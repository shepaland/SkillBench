import { DependencyError, FindingError, InvocationError } from "../domain/errors.js";
import { executeRun } from "../runs/execute-run.js";
import { createRunId, defaultRunIdSuffix } from "../runs/freeze-inputs.js";
import { hasFailedCriticalAssertion, type RunResult } from "../runs/result.js";
import { selectAdapter } from "../runtime/select-adapter.js";
import { ImmutableJsonStore } from "../storage/immutable-json-store.js";
import { resolveRunTargets, type RunSelectionOptions } from "./dry-run.js";
import type { CommandIo } from "./validate.js";

export interface RunCommandOptions extends RunSelectionOptions {
  readonly runs: string;
  readonly keepWorkspace: boolean;
  /** Temporary parent for workspaces and grading areas. Tests set it; the command line does not. */
  readonly tempParent?: string;
}

export async function runRun(
  options: RunCommandOptions,
  io: CommandIo,
  clock: () => Date = () => new Date(),
  suffix: () => string = defaultRunIdSuffix,
): Promise<void> {
  const repetitions = parseRepetitions(options.runs);
  const targets = await resolveRunTargets(options);
  const store = new ImmutableJsonStore(targets.paths);
  const results: RunResult[] = [];

  for (let repetitionIndex = 0; repetitionIndex < repetitions; repetitionIndex += 1) {
    results.push(await executeRun({
      paths: targets.paths,
      store,
      validator: targets.validator,
      catalogCase: targets.catalogCase,
      variant: targets.variant,
      configuration: targets.configuration,
      adapter: (await selectAdapter(options.runtime, targets.catalogCase.manifest)).adapter,
      runId: createRunId(clock(), suffix()),
      repetitionIndex,
      keepWorkspace: options.keepWorkspace,
      ...(options.tempParent === undefined ? {} : { tempParent: options.tempParent }),
    }));
  }

  report(results, options.json, io);

  const errored = results.filter((result) => result.status === "errored");
  if (errored.length > 0) {
    throw new DependencyError(
      errored.map((result) => `${result.runId}: ${result.failedStep ?? "unknown"}: ${result.failureMessage}`).join("\n"),
    );
  }

  const uncleaned = results.filter((result) => result.cleanupFailures.length > 0);
  if (uncleaned.length > 0) {
    throw new DependencyError(
      uncleaned
        .map((result) => `${result.runId}: material left behind: ${result.cleanupFailures.join("; ")}`)
        .join("\n"),
    );
  }

  const unsolved = results.filter(
    (result) => result.status === "exhausted" || hasFailedCriticalAssertion(result),
  );
  if (unsolved.length > 0) {
    throw new FindingError(`${unsolved.length.toString()} of ${results.length.toString()} run(s) did not solve the case.`);
  }
}

function report(results: readonly RunResult[], json: boolean, io: CommandIo): void {
  if (json) {
    io.stdout(`${JSON.stringify({
      runs: results.map((result) => ({
        runId: result.runId,
        status: result.status,
        failedStep: result.failedStep,
        failureMessage: result.failureMessage,
        failedCriticalAssertions: result.assertions
          .filter((assertion) => assertion.critical && assertion.outcome !== "passed")
          .map((assertion) => assertion.assertionId),
        changedPaths: result.changes.added.length + result.changes.modified.length + result.changes.removed.length,
        costs: result.costs,
        preservedWorkspacePath: result.preservedWorkspacePath,
        cleanupFailures: result.cleanupFailures,
      })),
    }, null, 2)}\n`);
    return;
  }

  for (const result of results) {
    const passed = result.assertions.filter((assertion) => assertion.outcome === "passed").length;
    io.stdout(
      `${result.runId}  ${result.status}  assertions=${passed.toString()}/${result.assertions.length.toString()}  wallClockMs=${result.costs.wallClockMs.toString()}\n`,
    );
    if (result.preservedWorkspacePath !== null) {
      io.stdout(`${result.runId}: workspace preserved at ${result.preservedWorkspacePath}\n`);
    }
    if (result.failedStep !== null) {
      io.stderr(`${result.runId}: failed at ${result.failedStep}: ${result.failureMessage}\n`);
    }
    if (result.cleanupFailures.length > 0) {
      io.stderr(`${result.runId}: cleanup failures: ${result.cleanupFailures.join("; ")}\n`);
    }
  }
}

function parseRepetitions(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new InvocationError(`--runs must be a positive integer: ${value}`);
  }
  const repetitions = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(repetitions) || repetitions > 1_000) {
    throw new InvocationError(`--runs must be between 1 and 1000: ${value}`);
  }
  return repetitions;
}
