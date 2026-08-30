import { execFile } from "node:child_process";
import type { AssertionDeclaration, OracleCheck, OracleManifest } from "../domain/model.js";
import { ProjectPaths } from "../paths/project-paths.js";
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
  readonly detail: string;
}

export type OracleSpawn = (request: OracleSpawnRequest) => Promise<OracleSpawnResult>;

export interface RunOracleInput {
  readonly manifest: OracleManifest;
  readonly assertions: readonly AssertionDeclaration[];
  readonly gradingPath: string;
  readonly workspacePath: string;
  readonly spawn?: OracleSpawn;
  readonly nowMs?: () => number;
}

export const defaultOracleSpawn: OracleSpawn = async (request) =>
  new Promise<OracleSpawnResult>((resolve, reject) => {
    const child = execFile(
      resolveExecutable(request.executor),
      [...request.args],
      { cwd: request.cwd, timeout: request.timeoutMs, env: { ...request.env }, windowsHide: true },
      (error, _stdout, stderr) => {
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
        resolve({
          exitCode,
          timedOut,
          detail: timedOut ? "check timed out" : truncate(stderr),
        });
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
  const env = {
    ...filterEnvironment(process.env),
    SKILLBENCH_WORKSPACE: input.workspacePath,
    SKILLBENCH_ORACLE: input.gradingPath,
  };

  const results: AssertionResult[] = [];
  for (const assertion of input.assertions) {
    const check = checkById.get(assertion.id);
    if (check === undefined) {
      throw new Error(`assertion ${assertion.id} has no oracle check after correspondence validation`);
    }
    results.push(await executeCheck(assertion, check, gradingPaths, env, spawn, nowMs));
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
    return outcome.exitCode === 0
      ? build(assertion, "passed", 0, nowMs() - startedMs, "")
      : build(assertion, "failed", outcome.exitCode, nowMs() - startedMs, outcome.detail);
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
