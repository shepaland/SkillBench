import { execFile } from "node:child_process";
import type { AssertionDeclaration, OracleCheck, OracleManifest } from "../domain/model.js";
import { ProjectPaths } from "../paths/project-paths.js";
import type { GradingArea } from "./grading-area.js";
import { assertOracleCoversAssertions } from "./oracle-manifest.js";

export type AssertionOutcome = "passed" | "failed" | "error";

export interface AssertionResult {
  readonly assertionId: string;
  readonly dimension: AssertionDeclaration["dimension"];
  readonly critical: boolean;
  readonly outcome: AssertionOutcome;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly detail: string;
  readonly source: "oracle" | "transcript";
}

export interface OracleSpawnRequest {
  readonly executor: "node" | "npm" | "git";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface OracleSpawnResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** SkillBench's own explanation of an error outcome. Never check output. */
  readonly detail: string;
}

export type OracleSpawn = (request: OracleSpawnRequest) => Promise<OracleSpawnResult>;

export interface RunOracleInput {
  readonly manifest: OracleManifest;
  readonly assertions: readonly AssertionDeclaration[];
  readonly gradingPath: string;
  /** Supplies the frozen evidence and one disposable workspace copy per check. */
  readonly gradingArea: GradingArea;
  readonly spawn?: OracleSpawn;
  readonly nowMs?: () => number;
}

export const defaultOracleSpawn: OracleSpawn = async (request) =>
  new Promise<OracleSpawnResult>((resolve, reject) => {
    const child = execFile(
      resolveExecutable(request.executor),
      [...request.args],
      { cwd: request.cwd, timeout: request.timeoutMs, env: { ...request.env }, windowsHide: true },
      (error) => {
        if (error === null) {
          resolve({ exitCode: 0, timedOut: false, detail: "" });
          return;
        }

        const timedOut = error.killed === true || Boolean(error.signal);
        const exitCode = typeof error.code === "number" ? error.code : null;
        if (exitCode === null && !timedOut) {
          reject(error instanceof Error ? error : new Error(error.message));
          return;
        }
        // A failing check writes expected values to its own streams, so the
        // captured output is deliberately dropped instead of reported.
        resolve({ exitCode, timedOut, detail: timedOut ? "check timed out" : "" });
      },
    );
    child.once("error", reject);
  });

export async function runOracle(input: RunOracleInput): Promise<readonly AssertionResult[]> {
  assertOracleCoversAssertions(input.manifest, input.assertions);

  const spawn = input.spawn ?? defaultOracleSpawn;
  const nowMs = input.nowMs ?? (() => Date.now());
  const checkById = new Map(input.manifest.checks.map((check) => [check.assertionId, check]));
  const gradingPaths = await ProjectPaths.create(input.gradingPath);
  const baseEnvironment = {
    ...filterEnvironment(process.env),
    SKILLBENCH_ORACLE: input.gradingPath,
    SKILLBENCH_EVIDENCE: input.gradingArea.evidencePath,
  };

  const results: AssertionResult[] = [];
  for (const assertion of input.assertions) {
    const check = checkById.get(assertion.id);
    if (check === undefined) {
      throw new Error(`assertion ${assertion.id} has no oracle check after correspondence validation`);
    }

    // The reference is verified immediately before the copy is taken, so a repair has to
    // be in place exactly when SkillBench looks. Restoring it afterwards no longer helps:
    // the tree this check reads was built from what was verified, not from what is left
    // at the end.
    await input.gradingArea.verifyReference();
    const copy = await input.gradingArea.createCheckCopy();
    try {
      const env = { ...baseEnvironment, SKILLBENCH_WORKSPACE: copy.path };
      results.push(await executeCheck(assertion, check, gradingPaths, env, spawn, nowMs));
    } finally {
      await copy.remove();
    }
  }
  return Object.freeze(results);
}

async function executeCheck(
  assertion: AssertionDeclaration,
  check: OracleCheck,
  gradingPaths: ProjectPaths,
  env: Readonly<Record<string, string>>,
  spawn: OracleSpawn,
  nowMs: () => number,
): Promise<AssertionResult> {
  const startedMs = nowMs();

  let cwd: string;
  try {
    cwd = await gradingPaths.resolveExisting(check.workingDirectory, "directory");
  } catch (cause: unknown) {
    return build(assertion, "error", null, nowMs() - startedMs, `working directory escapes or is missing: ${errorMessage(cause)}`);
  }

  try {
    const outcome = await spawn({
      executor: check.command.executor,
      args: check.command.args,
      cwd,
      timeoutMs: check.timeoutMs,
      env,
    });
    if (outcome.timedOut) {
      return build(assertion, "error", outcome.exitCode, nowMs() - startedMs, outcome.detail || "check timed out");
    }
    // `detail` stays empty for passed and failed outcomes: check output names
    // private expected values and result.json is a shared durable artifact.
    return outcome.exitCode === 0
      ? build(assertion, "passed", 0, nowMs() - startedMs, "")
      : build(assertion, "failed", outcome.exitCode, nowMs() - startedMs, "");
  } catch (cause: unknown) {
    return build(assertion, "error", null, nowMs() - startedMs, errorMessage(cause));
  }
}

function build(
  assertion: AssertionDeclaration,
  outcome: AssertionOutcome,
  exitCode: number | null,
  durationMs: number,
  detail: string,
): AssertionResult {
  return Object.freeze({
    assertionId: assertion.id,
    dimension: assertion.dimension,
    critical: assertion.critical,
    outcome,
    exitCode,
    durationMs,
    detail: truncate(detail),
    source: "oracle",
  });
}

function resolveExecutable(executor: "node" | "npm" | "git"): string {
  switch (executor) {
    case "node":
      return process.execPath;
    case "npm":
      return process.platform === "win32" ? "npm.cmd" : "npm";
    case "git":
      return "git";
  }
}

function filterEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function truncate(detail: string): string {
  const collapsed = detail.replaceAll("\n", "; ").trim();
  return collapsed.length > 500 ? `${collapsed.slice(0, 500)}…` : collapsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
