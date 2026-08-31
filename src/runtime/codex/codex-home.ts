import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DependencyError } from "../../domain/errors.js";

const credentialFilename = "auth.json";

export interface CodexHomeOptions {
  /** The operator's real runtime home. Defaults to `~/.codex`. */
  readonly sourceHome?: string;
  readonly tempParent?: string;
}

/**
 * A private runtime home for one run. Only the credential file is copied, so the
 * operator's personal configuration cannot reach a measured run and the run's own
 * sessions cannot reach the operator's profile.
 */
export class CodexHome {
  private removed = false;

  private constructor(public readonly path: string) {}

  public static async create(options: CodexHomeOptions = {}): Promise<CodexHome> {
    const sourceHome = options.sourceHome ?? join(homedir(), ".codex");
    const path = await mkdtemp(join(options.tempParent ?? tmpdir(), "skillbench-codex-home-"));

    try {
      await copyFile(join(sourceHome, credentialFilename), join(path, credentialFilename));
    } catch (cause: unknown) {
      await rm(path, { recursive: true, force: true });
      throw new DependencyError(
        `the codex runtime is not authenticated: could not read ${join(sourceHome, credentialFilename)}: ${message(cause)}`,
      );
    }

    return new CodexHome(path);
  }

  public async cleanup(): Promise<void> {
    if (this.removed) return;
    this.removed = true;
    await rm(this.path, { recursive: true, force: true });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
