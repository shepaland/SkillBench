import { execFile } from "node:child_process";
import { DependencyError } from "../../domain/errors.js";

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
      const version = stdout.trim().split(/\s+/u).at(-1) ?? "";
      if (version === "") {
        reject(new DependencyError("the codex runtime reported no version"));
        return;
      }
      resolve(version);
    });
  });
}
