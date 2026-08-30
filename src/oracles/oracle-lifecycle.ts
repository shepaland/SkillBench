import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

const oracleRootPrefix = "skillbench-oracle-";

export class OracleLifecycle {
  private currentState: OracleLifecycleState = "agent_active";
  private oracleRootPath: string | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

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
    return this.serialize(() => this.mountOracleInternal());
  }

  public async cleanup(): Promise<void> {
    return this.serialize(() => this.cleanupInternal());
  }

  private async mountOracleInternal(): Promise<MountedOracle> {
    this.requireState("mountOracle", "agent_closed");

    const source = await this.resolveOracleSource();
    try {
      await this.removeOwnedRoot();
      const oracleRootPath = await this.allocateOwnedRoot();

      const gradingPath = join(oracleRootPath, "grading");
      await copySafeTree(source, gradingPath, this.fileSystem);
      this.currentState = "oracle_mounted";
      return Object.freeze({ gradingPath });
    } catch (cause: unknown) {
      return this.handleMountFailure(cause);
    }
  }

  private async cleanupInternal(): Promise<void> {
    if (this.currentState === "cleaned") return;

    try {
      await this.removeOwnedRoot();
    } catch (cause: unknown) {
      throw new FileLifecycleError(
        "CLEANUP_FAILURE",
        `oracle cleanup failed: ${errorMessage(cause)}`,
        { cause },
      );
    }
    this.currentState = "cleaned";
  }

  private async allocateOwnedRoot(): Promise<string> {
    const rawRootPath = await this.fileSystem.mkdtemp(join(this.tempParent, oracleRootPrefix));
    await this.assertOwnedRawRoot(rawRootPath);
    this.assertRootIsIsolated(rawRootPath);
    this.oracleRootPath = rawRootPath;

    const oracleRootPath = await this.fileSystem.realpath(rawRootPath);
    if (oracleRootPath !== rawRootPath) {
      throw new FileLifecycleError(
        "UNSAFE_FILESYSTEM_INPUT",
        `oracle root is not canonical: ${rawRootPath}`,
      );
    }
    this.assertRootIsIsolated(oracleRootPath);
    return oracleRootPath;
  }

  private async assertOwnedRawRoot(rawRootPath: string): Promise<void> {
    if (dirname(rawRootPath) !== this.tempParent || !basename(rawRootPath).startsWith(oracleRootPrefix)) {
      throw new FileLifecycleError(
        "UNSAFE_FILESYSTEM_INPUT",
        `oracle allocator returned an unsafe root: ${rawRootPath}`,
      );
    }

    const entry = await this.fileSystem.lstat(rawRootPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new FileLifecycleError(
        "UNSAFE_FILESYSTEM_INPUT",
        `oracle allocator returned a non-directory root: ${rawRootPath}`,
      );
    }
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

  private async handleMountFailure(cause: unknown): Promise<never> {
    try {
      await this.removeOwnedRoot();
    } catch (cleanupFailure: unknown) {
      throw this.mountFailure(cause, cleanupFailure);
    }

    throw this.mountFailure(cause);
  }

  private async removeOwnedRoot(): Promise<void> {
    if (this.oracleRootPath === undefined) return;
    await this.fileSystem.rm(this.oracleRootPath, { recursive: true, force: true });
    this.oracleRootPath = undefined;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: (() => void) | undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
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
