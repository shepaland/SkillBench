import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLifecycleError } from "../domain/file-lifecycle-error.js";
import type { ContentHash } from "../domain/model.js";
import { copySafeTree, safeTreeFileSystem } from "../filesystem/safe-tree.js";
import type { SafeTreeFileSystem } from "../filesystem/safe-tree.js";
import { hashTree } from "../integrity/content-hash.js";
import { ProjectPaths } from "../paths/project-paths.js";

export interface WorkspaceFileSystem extends SafeTreeFileSystem {
  mkdtemp(prefix: string): Promise<string>;
}

export interface MaterializedWorkspace {
  readonly rootPath: string;
  readonly workspacePath: string;
  readonly fixtureHash: ContentHash;
  verifySource(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface MaterializeWorkspaceInput {
  readonly paths: ProjectPaths;
  readonly fixture: string;
  readonly tempParent?: string;
  readonly fileSystem?: WorkspaceFileSystem;
}

export const workspaceFileSystem: WorkspaceFileSystem = { ...safeTreeFileSystem, mkdtemp };

export async function materializeWorkspace(
  input: MaterializeWorkspaceInput,
): Promise<MaterializedWorkspace> {
  if (!input.fixture.replaceAll("\\", "/").startsWith("fixtures/")) {
    throw new FileLifecycleError(
      "UNSAFE_FILESYSTEM_INPUT",
      `fixture path must be inside fixtures/: ${input.fixture}`,
    );
  }

  const source = await input.paths.resolveExisting(input.fixture, "directory");
  let fixtureHash: ContentHash;
  try {
    fixtureHash = await hashTree(source);
  } catch (cause: unknown) {
    throw new FileLifecycleError(
      "UNSAFE_FILESYSTEM_INPUT",
      `fixture hash failed: ${errorMessage(cause)}`,
      { cause },
    );
  }

  const fileSystem = input.fileSystem ?? workspaceFileSystem;
  const rootPath = await fileSystem.mkdtemp(join(input.tempParent ?? tmpdir(), "skillbench-workspace-"));
  const workspacePath = join(rootPath, "workspace");

  try {
    await copySafeTree(source, workspacePath, fileSystem);
  } catch (cause: unknown) {
    try {
      await fileSystem.rm(rootPath, { recursive: true, force: true });
    } catch (cleanupFailure: unknown) {
      throw new FileLifecycleError(
        cause instanceof FileLifecycleError ? cause.code : "UNSAFE_FILESYSTEM_INPUT",
        `workspace materialization failed: ${errorMessage(cause)}`,
        { cause, cleanupFailure },
      );
    }
    if (cause instanceof FileLifecycleError) throw cause;
    throw new FileLifecycleError(
      "UNSAFE_FILESYSTEM_INPUT",
      `workspace materialization failed: ${errorMessage(cause)}`,
      { cause },
    );
  }

  let cleaned = false;
  return {
    rootPath,
    workspacePath,
    fixtureHash,
    async verifySource(): Promise<void> {
      const currentHash = await hashTree(source);
      if (currentHash !== fixtureHash) {
        throw new FileLifecycleError(
          "CONTENT_HASH_MISMATCH",
          `fixture source changed: ${input.fixture}`,
        );
      }
    },
    async cleanup(): Promise<void> {
      if (cleaned) return;
      try {
        await fileSystem.rm(rootPath, { recursive: true, force: true });
      } catch (cause: unknown) {
        throw new FileLifecycleError(
          "CLEANUP_FAILURE",
          `workspace cleanup failed: ${errorMessage(cause)}`,
          { cause },
        );
      }
      cleaned = true;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
