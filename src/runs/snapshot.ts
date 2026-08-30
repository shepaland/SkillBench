import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../domain/errors.js";
import type { ContentHash } from "../domain/model.js";
import { hashFile } from "../integrity/content-hash.js";

export interface SnapshotEntry {
  readonly path: string;
  readonly contentHash: ContentHash;
}

export type TreeSnapshot = readonly SnapshotEntry[];

export interface ChangeSet {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly removed: readonly string[];
}

export interface ChangePathObservations {
  readonly outsideAllowed: readonly string[];
  readonly insideForbidden: readonly string[];
}

export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const entries: SnapshotEntry[] = [];
  await collect(root, "", entries);
  entries.sort((left, right) => comparePaths(left.path, right.path));
  return Object.freeze(entries);
}

export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): ChangeSet {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry.contentHash]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry.contentHash]));

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, contentHash] of afterByPath) {
    const previous = beforeByPath.get(path);
    if (previous === undefined) {
      added.push(path);
    } else if (previous !== contentHash) {
      modified.push(path);
    }
  }
  for (const path of beforeByPath.keys()) {
    if (!afterByPath.has(path)) {
      removed.push(path);
    }
  }

  added.sort(comparePaths);
  modified.sort(comparePaths);
  removed.sort(comparePaths);
  return Object.freeze({
    added: Object.freeze(added),
    modified: Object.freeze(modified),
    removed: Object.freeze(removed),
  });
}

export function observeChangePaths(
  changes: ChangeSet,
  allowedChangePaths: readonly string[],
  forbiddenChangePaths: readonly string[],
): ChangePathObservations {
  const allowed = allowedChangePaths.map(normalize);
  const forbidden = forbiddenChangePaths.map(normalize);
  const changed = [...changes.added, ...changes.modified, ...changes.removed].sort(comparePaths);

  const outsideAllowed: string[] = [];
  const insideForbidden: string[] = [];
  for (const path of changed) {
    if (!allowed.some((prefix) => isInside(prefix, path))) {
      outsideAllowed.push(path);
    }
    if (forbidden.some((prefix) => isInside(prefix, path))) {
      insideForbidden.push(path);
    }
  }

  return Object.freeze({
    outsideAllowed: Object.freeze(outsideAllowed),
    insideForbidden: Object.freeze(insideForbidden),
  });
}

async function collect(absolutePath: string, relativePath: string, entries: SnapshotEntry[]): Promise<void> {
  const status = await lstat(absolutePath);
  if (status.isSymbolicLink()) {
    throw new ValidationError(`symbolic links are not supported in workspace snapshots: ${relativePath || absolutePath}`);
  }
  if (status.isFile()) {
    entries.push({ path: relativePath, contentHash: await hashFile(absolutePath) });
    return;
  }
  if (!status.isDirectory()) {
    throw new ValidationError(`unsupported entry in workspace snapshot: ${relativePath || absolutePath}`);
  }

  for (const child of await readdir(absolutePath)) {
    const childRelativePath = relativePath === "" ? child : `${relativePath}/${child}`;
    await collect(join(absolutePath, child), childRelativePath, entries);
  }
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

function isInside(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
