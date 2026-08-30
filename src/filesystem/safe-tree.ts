import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { FileLifecycleError } from "../domain/file-lifecycle-error.js";

export interface SafeTreeFileSystem {
  lstat(path: string): ReturnType<typeof lstat>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  mkdir(path: string): Promise<unknown>;
  copyFile(source: string, destination: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

export const safeTreeFileSystem: SafeTreeFileSystem = { lstat, readdir, mkdir, copyFile, rm };

export function isSameOrInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export async function copySafeTree(
  source: string,
  destination: string,
  fileSystem: SafeTreeFileSystem = safeTreeFileSystem,
): Promise<readonly string[]> {
  const created: string[] = [];
  await copyEntry(source, destination, "", created, fileSystem);
  return created;
}

export async function createAbsentParents(
  root: string,
  destination: string,
  fileSystem: SafeTreeFileSystem = safeTreeFileSystem,
): Promise<readonly string[]> {
  const parentDirectory = dirname(relative(root, destination));
  if (parentDirectory === ".." || parentDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(parentDirectory)) {
    throw new FileLifecycleError(
      "UNSAFE_FILESYSTEM_INPUT",
      `destination is outside its root: ${destination}`,
    );
  }

  const created: string[] = [];
  let candidate = root;
  for (const segment of parentDirectory.split(/[\\/]/u)) {
    if (segment === "" || segment === ".") continue;
    candidate = join(candidate, segment);
    try {
      const status = await fileSystem.lstat(candidate);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new FileLifecycleError(
          "UNSAFE_FILESYSTEM_INPUT",
          `destination parent is not a safe directory: ${candidate}`,
        );
      }
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error;
      await fileSystem.mkdir(candidate);
      created.push(candidate);
    }
  }
  return created;
}

async function copyEntry(
  source: string,
  destination: string,
  relativePath: string,
  created: string[],
  fileSystem: SafeTreeFileSystem,
): Promise<void> {
  const status = await fileSystem.lstat(source);
  if (status.isSymbolicLink() || (!status.isDirectory() && !status.isFile())) {
    throw new FileLifecycleError(
      "UNSAFE_FILESYSTEM_INPUT",
      `unsupported filesystem entry: ${relativePath || "."}`,
    );
  }
  if (status.isFile()) {
    created.push(destination);
    await fileSystem.copyFile(source, destination);
    return;
  }

  await fileSystem.mkdir(destination);
  created.push(destination);
  const entries = await fileSystem.readdir(source, { withFileTypes: true });
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
    await copyEntry(
      join(source, entry.name),
      join(destination, entry.name),
      childRelative,
      created,
      fileSystem,
    );
  }
}

export async function rollbackCreatedPaths(
  created: readonly string[],
  fileSystem: SafeTreeFileSystem = safeTreeFileSystem,
): Promise<void> {
  for (const path of [...created].sort((left, right) => right.length - left.length)) {
    await fileSystem.rm(path, { recursive: true, force: true });
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
