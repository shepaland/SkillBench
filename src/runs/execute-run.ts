import type { CatalogCase, CatalogVariant } from "../catalog/load-catalog.js";
import { FileLifecycleError } from "../domain/file-lifecycle-error.js";
import type { AssertionDeclaration, TranscriptRule } from "../domain/model.js";
import { hashTree } from "../integrity/content-hash.js";
import type { RuntimeAdapter, RuntimeExecution } from "../runtime/runtime-adapter.js";
import { OracleLifecycle } from "../oracles/oracle-lifecycle.js";
import { loadOracleManifest } from "../oracles/oracle-manifest.js";
import { runOracle, type AssertionResult } from "../oracles/run-oracle.js";
import type { ProjectPaths } from "../paths/project-paths.js";
import type { ManifestValidator } from "../schemas/validator.js";
import type { ImmutableJsonStore } from "../storage/immutable-json-store.js";
import { installVariant } from "../variants/install-variant.js";
import { materializeWorkspace, type MaterializedWorkspace } from "../workspace/materialize-workspace.js";
import { freezeRunInputs, type RunConfiguration } from "./freeze-inputs.js";
import { RunEvidenceWriter, type PipelineStep, type RunResult, type RunStatus } from "./result.js";
import {
  diffSnapshots,
  observeChangePaths,
  snapshotTree,
  type ChangePathObservations,
  type ChangeSet,
  type TreeSnapshot,
} from "./snapshot.js";
import { evaluateRules, type TranscriptRuleOutcome } from "./transcript-rules.js";

export interface ExecuteRunInput {
  readonly paths: ProjectPaths;
  readonly store: ImmutableJsonStore;
  readonly validator: ManifestValidator;
  readonly catalogCase: CatalogCase;
  readonly variant: CatalogVariant;
  readonly configuration: RunConfiguration;
  readonly adapter: RuntimeAdapter;
  readonly runId: string;
  readonly repetitionIndex: number;
  readonly keepWorkspace?: boolean;
  readonly tempParent?: string;
}

const emptyChanges = Object.freeze({
  added: Object.freeze([]),
  modified: Object.freeze([]),
  removed: Object.freeze([]),
});
const emptyObservations = Object.freeze({
  outsideAllowed: Object.freeze([]),
  insideForbidden: Object.freeze([]),
});

export async function executeRun(input: ExecuteRunInput): Promise<RunResult> {
  const manifest = freezeRunInputs({
    catalogCase: input.catalogCase,
    variant: input.variant,
    configuration: input.configuration,
    repetitionIndex: input.repetitionIndex,
    runId: input.runId,
  });
  const writer = new RunEvidenceWriter(input.store, manifest, input.paths);
  await writer.writeManifest();

  let workspace: MaterializedWorkspace | undefined;
  let lifecycle: OracleLifecycle | undefined;
  let step: PipelineStep = "materialize";
  let baseline: TreeSnapshot = [];
  let execution: RuntimeExecution | undefined;
  let changes: ChangeSet = emptyChanges;
  let observations: ChangePathObservations = emptyObservations;
  let assertions: readonly AssertionResult[] = [];
  let status: RunStatus = "completed";
  let failedStep: PipelineStep | null = null;
  let failureMessage = "";
  let preservedWorkspacePath: string | null = null;
  const cleanupFailures: string[] = [];
  const ruleOutcomes: TranscriptRuleOutcome[] = [];
  const rules: readonly TranscriptRule[] = input.catalogCase.manifest.transcriptRules ?? [];

  try {
    workspace = await materializeWorkspace({
      paths: input.paths,
      fixture: input.catalogCase.manifest.fixture.path,
      ...(input.tempParent === undefined ? {} : { tempParent: input.tempParent }),
    });

    step = "install";
    await installVariant({
      variant: input.variant,
      runtime: input.configuration.runtime,
      workspacePath: workspace.workspacePath,
    });

    step = "baseline_snapshot";
    baseline = await snapshotTree(workspace.workspacePath);

    step = "oracle_setup";
    lifecycle = await OracleLifecycle.create({
      paths: input.paths,
      caseId: input.catalogCase.manifest.id,
      workspacePath: workspace.workspacePath,
      ...(input.tempParent === undefined ? {} : { tempParent: input.tempParent }),
    });

    step = "execute";
    execution = await input.adapter.execute({
      workspace: workspace.workspacePath,
      promptSteps: input.catalogCase.manifest.promptSteps,
      config: {
        model: input.configuration.model,
        reasoningEffort: input.configuration.reasoningEffort,
        sandbox: input.configuration.sandbox,
        limits: input.catalogCase.manifest.limits,
        environment: input.variant.manifest.environment,
      },
      onContinuation: (continuedStep, events) => {
        const gated = rules.filter((rule) => (continuedStep.continuation?.eventRuleIds ?? []).includes(rule.id));
        ruleOutcomes.push(...evaluateRules(gated, events));
        return Promise.resolve();
      },
      onRawLine: (stepId, line, stream) => { writer.appendRawLine(stepId, line, stream); },
    });
    // Every rule still without an outcome is evaluated here, over the full transcript:
    // rules no continuation references, and gated rules whose continuation point was
    // never reached because the session ended early. A rule already evaluated at its
    // continuation keeps that answer, so no rule is ever evaluated twice.
    const evaluatedRuleIds = new Set(ruleOutcomes.map((outcome) => outcome.ruleId));
    ruleOutcomes.push(...evaluateRules(
      rules.filter((rule) => !evaluatedRuleIds.has(rule.id)),
      execution.events,
    ));
    await writer.writeTranscript(execution, ruleOutcomes);

    step = "final_snapshot";
    changes = diffSnapshots(baseline, await snapshotTree(workspace.workspacePath));
    observations = observeChangePaths(
      changes,
      input.catalogCase.manifest.allowedChangePaths,
      input.catalogCase.manifest.forbiddenChangePaths,
    );
    await writer.writeChanges(changes, observations);

    step = "grade";
    lifecycle.markAgentClosed();
    const mounted = await lifecycle.mountOracle();
    const mountedOracleHash = await hashTree(mounted.gradingPath);
    if (mountedOracleHash !== manifest.oracleHash) {
      throw new FileLifecycleError(
        "CONTENT_HASH_MISMATCH",
        `private oracle changed after freezing: mounted ${mountedOracleHash}, frozen ${manifest.oracleHash}`,
      );
    }
    const oracleManifest = await loadOracleManifest(mounted.gradingPath, input.validator);
    const oracleResults = await runOracle({
      manifest: oracleManifest,
      assertions: input.catalogCase.manifest.assertions.filter(
        ({ transcriptRuleId }) => transcriptRuleId === undefined,
      ),
      gradingPath: mounted.gradingPath,
      workspacePath: workspace.workspacePath,
    });
    assertions = mergeAssertions(input.catalogCase.manifest.assertions, oracleResults, ruleOutcomes);

    step = "verify_fixture";
    await workspace.verifySource();

    if (execution.exhaustion !== null) {
      status = "exhausted";
    } else if (execution.process.exitCode !== null && execution.process.exitCode !== 0) {
      status = "errored";
      failedStep = "execute";
      failureMessage = `the runtime exited with code ${execution.process.exitCode.toString()}`;
    } else if (execution.process.signal !== null) {
      status = "errored";
      failedStep = "execute";
      failureMessage = `the runtime was terminated by signal ${execution.process.signal}`;
    } else {
      status = "completed";
    }
  } catch (error: unknown) {
    status = "errored";
    failedStep = step;
    failureMessage = errorMessage(error);
  } finally {
    for (const failure of await writer.flushRawLines()) {
      cleanupFailures.push(`raw evidence: ${failure}`);
    }
    // Cleanup the adapter could not complete is recorded like any other cleanup
    // failure: it belongs beside the run outcome, never in place of it.
    cleanupFailures.push(...execution?.cleanupFailures ?? []);
    const oracleFailure = await cleanupQuietly(lifecycle, "oracle");
    if (oracleFailure !== undefined) cleanupFailures.push(oracleFailure);
    if (input.keepWorkspace === true) {
      preservedWorkspacePath = workspace?.workspacePath ?? null;
    } else {
      const workspaceFailure = await cleanupQuietly(workspace, "workspace");
      if (workspaceFailure !== undefined) cleanupFailures.push(workspaceFailure);
    }
  }

  const result: RunResult = Object.freeze({
    schemaVersion: 1,
    runId: manifest.runId,
    manifest,
    status,
    failedStep,
    failureMessage,
    assertions,
    transcriptRuleOutcomes: Object.freeze([...ruleOutcomes]),
    changes,
    changePathObservations: observations,
    costs: Object.freeze({
      inputTokens: execution?.usage?.inputTokens ?? null,
      outputTokens: execution?.usage?.outputTokens ?? null,
      wallClockMs: execution?.elapsedMs ?? 0,
      unplannedUserTurns: countUnplannedUserTurns(execution, input.catalogCase),
    }),
    adapter: Object.freeze({
      runtime: execution?.metadata.runtime ?? input.configuration.runtime,
      runtimeVersion: execution?.metadata.runtimeVersion ?? input.configuration.runtimeVersion,
      adapterVersion: execution?.metadata.adapterVersion ?? input.configuration.adapterVersion,
    }),
    preservedWorkspacePath,
    cleanupFailures: Object.freeze(cleanupFailures),
  });

  await writer.writeResult(result);
  return result;
}

function mergeAssertions(
  declarations: readonly AssertionDeclaration[],
  oracleResults: readonly AssertionResult[],
  outcomes: readonly TranscriptRuleOutcome[],
): readonly AssertionResult[] {
  const oracleById = new Map(oracleResults.map((result) => [result.assertionId, result]));
  const outcomeById = new Map(outcomes.map((outcome) => [outcome.ruleId, outcome]));

  return Object.freeze(declarations.map((declaration) => {
    if (declaration.transcriptRuleId === undefined) {
      const result = oracleById.get(declaration.id);
      if (result === undefined) {
        throw new Error(`assertion ${declaration.id} has no oracle result after coverage validation`);
      }
      return result;
    }

    const outcome = outcomeById.get(declaration.transcriptRuleId);
    return Object.freeze({
      assertionId: declaration.id,
      dimension: declaration.dimension,
      critical: declaration.critical,
      outcome: outcome === undefined ? "error" : outcome.satisfied ? "passed" : "failed",
      exitCode: null,
      durationMs: 0,
      detail: outcome?.detail ?? `transcript rule ${declaration.transcriptRuleId} was never evaluated`,
      source: "transcript",
    } as const);
  }));
}

function countUnplannedUserTurns(
  execution: RuntimeExecution | undefined,
  catalogCase: CatalogCase,
): number {
  if (execution === undefined) return 0;
  const declared = new Set(catalogCase.manifest.promptSteps.map(({ id }) => id));
  return execution.events.filter((event) => event.type === "prompt_sent" && !declared.has(event.stepId)).length;
}

async function cleanupQuietly(
  target: { cleanup(): Promise<void> } | undefined,
  label: string,
): Promise<string | undefined> {
  if (target === undefined) return undefined;
  try {
    await target.cleanup();
    return undefined;
  } catch (error: unknown) {
    // Cleanup failure must not replace the recorded run outcome, but it must be recorded.
    return `${label}: ${errorMessage(error)}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
