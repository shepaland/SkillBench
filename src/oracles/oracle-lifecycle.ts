import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLifecycleError } from "../domain/file-lifecycle-error.js";
import {
  copySafeTree,
  isSameOrInside,
  safeTreeFileSystem,
} from "../filesystem/safe-tree.js";
import type { SafeTreeFileSystem } from "../filesystem/safe-tree.js";
import { ProjectPaths } from "../paths/project-paths.js";

export type OracleLifecycleState =
  | "agent_active"
  | "agent_closed"
  | "oracle_mounted"
  | "cleaned";

export interface MountedOracle {
  readonly gradingPath: string;
}

export interface OracleFileSystem extends SafeTreeFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  realpath(path: string): Promise<string>;
}

export interface CreateOracleLifecycleInput {
  readonly paths: ProjectPaths;
  readonly caseId: string;
  readonly workspacePath: string;
  readonly tempParent?: string;
  readonly fileSystem?: OracleFileSystem;
}

export const oracleFileSystem: OracleFileSystem = { ...safeTreeFileSystem, mkdtemp, realpath };

export class OracleLifecycle {
  private currentState: OracleLifecycleState = "agent_active";
  private oracleRootPath: string | undefined;

  private constructor(
    private readonly paths: ProjectPaths,
    private readonly caseId: string,
    private readonly workspacePath: string,
    private readonly tempParent: string,
    private readonly fileSystem: OracleFileSystem,
  ) {}

  public static async create(input: CreateOracleLifecycleInput): Promise<OracleLifecycle> {
    const fileSystem = input.fileSystem ?? oracleFileSystem;
    let workspacePath: string;
    let tempParent: string;
    try {
      workspacePath = await fileSystem.realpath(input.workspacePath);
      tempParent = await fileSystem.realpath(input.tempParent ?? tmpdir());
    } catch (cause: unknown) {
      throw new FileLifecycleError(
        "UNSAFE_FILESYSTEM_INPUT",
        `oracle path resolution failed: ${errorMessage(cause)}`,
        { cause },
      );
    }

    if (isSameOrInside(workspacePath, tempParent)) {
      throw new FileLifecycleError(
        "UNSAFE_FILESYSTEM_INPUT",
        `oracle temporary parent is inside the workspace: ${tempParent}`,
      );
    }

    return new OracleLifecycle(input.paths, input.caseId, workspacePath, tempParent, fileSystem);
  }

  public get state(): OracleLifecycleState {
    return this.currentState;
  }

  public markAgentClosed(): void {
    this.requireState("markAgentClosed", "agent_active");
    this.currentState = "agent_closed";
  }

  public async mountOracle(): Promise<MountedOracle> {
    this.requireState("mountOracle", "agent_closed");

    const source = await this.resolveOracleSource();
    let safeAllocatedRoot: string | undefined;
    try {
      const allocatedRoot = await this.fileSystem.mkdtemp(join(this.tempParent, "skillbench-oracle-"));
      const oracleRootPath = await this.fileSystem.realpath(allocatedRoot);
      this.assertRootIsIsolated(oracleRootPath);
      this.oracleRootPath = oracleRootPath;
      safeAllocatedRoot = oracleRootPath;

      const gradingPath = join(oracleRootPath, "grading");
      await copySafeTree(source, gradingPath, this.fileSystem);
      this.currentState = "oracle_mounted";
      return Object.freeze({ gradingPath });
    } catch (cause: unknown) {
      return this.handleMountFailure(cause, safeAllocatedRoot);
    }
  }

  public async cleanup(): Promise<void> {
    if (this.currentState === "cleaned") return;

    if (this.oracleRootPath !== undefined) {
      try {
        await this.fileSystem.rm(this.oracleRootPath, { recursive: true, force: true });
      } catch (cause: unknown) {
        throw new FileLifecycleError(
          "CLEANUP_FAILURE",
          `oracle cleanup failed: ${errorMessage(cause)}`,
          { cause },
        );
      }
      this.oracleRootPath = undefined;
    }
    this.currentState = "cleaned";
  }

  private async resolveOracleSource(): Promise<string> {
    try {
      return await this.paths.resolveExisting(`.private/oracles/${this.caseId}`, "directory");
    } catch (cause: unknown) {
      if (isMissingPath(cause)) {
        throw new FileLifecycleError(
          "INSTALL_SOURCE_MISSING",
          `private oracle is missing for case ${this.caseId}`,
          { cause },
        );
      }
      throw new FileLifecycleError(
        "UNSAFE_FILESYSTEM_INPUT",
        `private oracle source is unsafe: ${errorMessage(cause)}`,
        { cause },
      );
    }
  }

  private assertRootIsIsolated(oracleRootPath: string): void {
    if (isSameOrInside(this.workspacePath, oracleRootPath) ||
      isSameOrInside(oracleRootPath, this.workspacePath)) {
      throw new FileLifecycleError(
        "UNSAFE_FILESYSTEM_INPUT",
        `oracle root overlaps the workspace: ${oracleRootPath}`,
      );
    }
  }

  private async handleMountFailure(cause: unknown, allocatedRoot: string | undefined): Promise<never> {
    if (this.oracleRootPath !== undefined) {
      try {
        await this.fileSystem.rm(this.oracleRootPath, { recursive: true, force: true });
        this.oracleRootPath = undefined;
      } catch (cleanupFailure: unknown) {
        throw this.mountFailure(cause, cleanupFailure);
      }
    } else if (allocatedRoot !== undefined) {
      try {
        await this.fileSystem.rm(allocatedRoot, { recursive: true, force: true });
      } catch (cleanupFailure: unknown) {
        throw this.mountFailure(cause, cleanupFailure);
      }
    }

    throw this.mountFailure(cause);
  }

  private mountFailure(cause: unknown, cleanupFailure?: unknown): FileLifecycleError {
    if (cause instanceof FileLifecycleError && cleanupFailure === undefined) return cause;
    return new FileLifecycleError(
      cause instanceof FileLifecycleError ? cause.code : "UNSAFE_FILESYSTEM_INPUT",
      `oracle mount failed: ${errorMessage(cause)}`,
      cleanupFailure === undefined ? { cause } : { cause, cleanupFailure },
    );
  }

  private requireState(operation: string, expected: OracleLifecycleState): void {
    if (this.currentState !== expected) {
      throw new FileLifecycleError(
        "INVALID_LIFECYCLE_TRANSITION",
        `${operation} requires ${expected}; current state is ${this.currentState}`,
      );
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
