import { execFile } from "node:child_process";
import { DependencyError } from "../../domain/errors.js";

const versionPattern = /^\d+\.\d+/u;

/** Extracts a version string (leading digits with at least one dot) from output. */
export function extractVersion(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new DependencyError("the codex runtime reported no version");
  }

  const tokens = trimmed.split(/\s+/u);
  for (const token of tokens) {
    if (versionPattern.test(token)) {
      return token;
    }
  }

  throw new DependencyError(`the codex runtime reported an invalid version: ${trimmed}`);
}

/** Reads the installed runtime version so it can be frozen into the run manifest. */
export async function readCodexVersion(executable = "codex"): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(executable, ["--version"], { windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        reject(new DependencyError(
          `the codex runtime is unavailable: ${error.message}`,
        ));
        return;
      }

      try {
        resolve(extractVersion(stdout));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
