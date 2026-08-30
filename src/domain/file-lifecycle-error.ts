import { SkillBenchError } from "./errors.js";

export type FileLifecycleErrorCode =
  | "UNSAFE_FILESYSTEM_INPUT"
  | "INSTALL_SOURCE_MISSING"
  | "INSTALL_DESTINATION_CONFLICT"
  | "CONTENT_HASH_MISMATCH"
  | "INVALID_LIFECYCLE_TRANSITION"
  | "CLEANUP_FAILURE";

export class FileLifecycleError extends SkillBenchError {
  public readonly cause: unknown;
  public readonly cleanupFailure: unknown;

  public constructor(
    public readonly code: FileLifecycleErrorCode,
    message: string,
    details: { readonly cause?: unknown; readonly cleanupFailure?: unknown } = {},
  ) {
    super(message, 2);
    this.cause = details.cause;
    this.cleanupFailure = details.cleanupFailure;
  }
}
