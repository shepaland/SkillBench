import { lstat } from "node:fs/promises";
import { dirname, posix } from "node:path";
import type { CatalogVariant } from "../catalog/load-catalog.js";
import { ValidationError } from "../domain/errors.js";
import { FileLifecycleError } from "../domain/file-lifecycle-error.js";
import type { ContentHash } from "../domain/model.js";
import {
  copySafeTree,
  createAbsentParents,
  isSameOrInside,
  rollbackCreatedEmptyDirectories,
  rollbackCreatedPaths,
} from "../filesystem/safe-tree.js";
import { hashTree, hashValue } from "../integrity/content-hash.js";
import { ProjectPaths } from "../paths/project-paths.js";

export interface InstallVariantInput {
  readonly variant: CatalogVariant;
  readonly runtime: string;
  readonly workspacePath: string;
}

export interface VariantInstallation {
  readonly destinations: readonly string[];
  readonly contentHash: ContentHash;
}

interface Mapping {
  readonly install: CatalogVariant["manifest"]["installs"][number];
  readonly sourcePath: string;
  readonly destination: string;
}

export async function installVariant(input: InstallVariantInput): Promise<VariantInstallation> {
  const mappings = await preflight(input);
  const createdParents: string[] = [];
  const copiedDestinations: string[] = [];

  try {
    for (const mapping of mappings) {
      createdParents.push(...await createAbsentParents(input.workspacePath, mapping.destination));
      await copySafeTree(mapping.sourcePath, mapping.destination);
      copiedDestinations.push(mapping.destination);
    }

    const material = [];
    for (const mapping of mappings) {
      material.push({
        source: mapping.install.source,
        contentHash: await hashTree(mapping.destination),
      });
    }
    const contentHash = hashValue(material);
    if (contentHash !== input.variant.manifest.contentHash) {
      throw new FileLifecycleError(
        "CONTENT_HASH_MISMATCH",
        `installed variant material has hash ${contentHash}; expected ${input.variant.manifest.contentHash}`,
      );
    }

    const destinations = Object.freeze(mappings.map(({ destination }) => destination));
    return Object.freeze({ destinations, contentHash });
  } catch (cause: unknown) {
    throw await rollbackAfterFailure(cause, copiedDestinations, createdParents);
  }
}

async function preflight(input: InstallVariantInput): Promise<Mapping[]> {
  const sourceRoot = normalizePosixPath(dirname(input.variant.source));
  const mappings = input.variant.manifest.installs.map((install, index) => {
    const normalizedSource = normalizePosixPath(install.source);
    if (!isSameOrInsidePosix(sourceRoot, normalizedSource)) {
      throw new FileLifecycleError(
        "UNSAFE_FILESYSTEM_INPUT",
        `install source must be inside ${sourceRoot}: ${install.source}`,
      );
    }

    const sourcePath = input.variant.installSourcePaths[index];
    const rawDestination = install.destinations[input.runtime];
    if (sourcePath === undefined) {
      throw new FileLifecycleError(
        "INSTALL_SOURCE_MISSING",
        `install source is unavailable: ${install.source}`,
      );
    }
    if (rawDestination === undefined) {
      throw new FileLifecycleError(
        "INSTALL_SOURCE_MISSING",
        `install source ${install.source} has no destination for runtime ${input.runtime}`,
      );
    }
    // Same normalization as the source: an install destination is never "the
    // workspace root itself", even though ProjectPaths.resolveOutput would
    // otherwise resolve "." there without complaint.
    const destination = normalizePosixPath(rawDestination);
    return { install, sourcePath, destination };
  });

  let paths: ProjectPaths;
  try {
    paths = await ProjectPaths.create(input.workspacePath);
  } catch (cause: unknown) {
    throw asUnsafeFilesystemInput(cause);
  }

  const resolvedMappings: Mapping[] = [];
  for (const mapping of mappings) {
    try {
      resolvedMappings.push({
        ...mapping,
        destination: await paths.resolveOutput(mapping.destination),
      });
    } catch (cause: unknown) {
      throw asUnsafeFilesystemInput(cause);
    }
  }

  const sortedDestinations = [...resolvedMappings].sort((left, right) =>
    Buffer.compare(Buffer.from(left.destination), Buffer.from(right.destination))
  );
  for (let index = 1; index < sortedDestinations.length; index += 1) {
    const previous = sortedDestinations[index - 1];
    const current = sortedDestinations[index];
    if (previous === undefined || current === undefined) continue;
    if (isSameOrInside(previous.destination, current.destination) ||
      isSameOrInside(current.destination, previous.destination)) {
      throw new FileLifecycleError(
        "INSTALL_DESTINATION_CONFLICT",
        `install destinations overlap: ${previous.destination} and ${current.destination}`,
      );
    }
  }

  for (const mapping of resolvedMappings) {
    try {
      await lstat(mapping.destination);
    } catch (cause: unknown) {
      if (isMissingPath(cause)) continue;
      throw new FileLifecycleError(
        "INSTALL_DESTINATION_CONFLICT",
        `install destination is unavailable: ${mapping.destination}`,
        { cause },
      );
    }
    throw new FileLifecycleError(
      "INSTALL_DESTINATION_CONFLICT",
      `install destination already exists: ${mapping.destination}`,
    );
  }

  return resolvedMappings;
}

async function rollbackAfterFailure(
  cause: unknown,
  copiedDestinations: readonly string[],
  createdParents: readonly string[],
): Promise<FileLifecycleError> {
  const primary = cause instanceof FileLifecycleError
    ? cause
    : new FileLifecycleError("UNSAFE_FILESYSTEM_INPUT", `variant installation failed: ${errorMessage(cause)}`, { cause });
  try {
    await rollbackCreatedPaths(copiedDestinations);
    await rollbackCreatedEmptyDirectories(createdParents);
  } catch (cleanupFailure: unknown) {
    return new FileLifecycleError(primary.code, primary.message, { cause: primary, cleanupFailure });
  }
  return primary;
}

function normalizePosixPath(path: string): string {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  if (normalized === "." || posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new FileLifecycleError("UNSAFE_FILESYSTEM_INPUT", `unsafe manifest path: ${path}`);
  }
  return normalized;
}

function isSameOrInsidePosix(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function asUnsafeFilesystemInput(cause: unknown): FileLifecycleError {
  if (cause instanceof FileLifecycleError) return cause;
  if (cause instanceof ValidationError) {
    return new FileLifecycleError("UNSAFE_FILESYSTEM_INPUT", cause.message, { cause });
  }
  return new FileLifecycleError("UNSAFE_FILESYSTEM_INPUT", `workspace path is unavailable: ${errorMessage(cause)}`, { cause });
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
