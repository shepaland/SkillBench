import { DependencyError } from "../../domain/errors.js";

export interface CodexCommandInput {
  readonly executable: string;
  /** Null on the first step; the thread to resume on every later step. */
  readonly threadId: string | null;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sandbox: string;
  readonly workspace: string;
}

export interface CodexCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

const sandboxModes = new Set(["read-only", "workspace-write", "danger-full-access"]);

export function mapSandbox(sandbox: string): string {
  if (!sandboxModes.has(sandbox)) {
    throw new DependencyError(
      `sandbox ${JSON.stringify(sandbox)} is not supported by the codex runtime; supported: ${[...sandboxModes].sort().join(", ")}`,
    );
  }
  return sandbox;
}

export function buildCodexCommand(input: CodexCommandInput): CodexCommand {
  const sandboxMode = mapSandbox(input.sandbox);
  // `codex exec resume` rejects --cd, --sandbox, and --color, so the sandbox
  // travels as a config override on both forms and the working directory is set
  // on the spawned child for resumed steps.
  const overrides = [
    "-m", input.model,
    "-c", `model_reasoning_effort=${input.reasoningEffort}`,
    "-c", `sandbox_mode=${sandboxMode}`,
    "-",
  ];
  const common = ["--json", "--skip-git-repo-check", "--ignore-user-config"];

  return Object.freeze({
    executable: input.executable,
    args: Object.freeze(input.threadId === null
      ? ["exec", ...common, "-C", input.workspace, ...overrides]
      : ["exec", "resume", input.threadId, ...common, ...overrides]),
  });
}
