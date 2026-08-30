import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ValidationError } from "../domain/errors.js";
import type { ContentHash } from "../domain/model.js";
import { canonicalJson } from "../integrity/canonical-json.js";
import { ProjectPaths } from "../paths/project-paths.js";

export interface StoreFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { flag: "wx"; mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultFileSystem: StoreFileSystem = { mkdir, readFile, writeFile, rename, unlink };

export class ImmutableJsonStore {
  public constructor(
    private readonly paths: ProjectPaths,
    private readonly fileSystem: StoreFileSystem = defaultFileSystem,
  ) {}

  public async write(relativePath: string, value: unknown): Promise<{ path: string; contentHash: ContentHash }> {
    const path = await this.paths.resolveOutput(relativePath);
    const bytes = `${canonicalJson(value)}\n`;
    const existingHash = await this.hashMatchingExisting(path, bytes);
    if (existingHash !== undefined) {
      return { path, contentHash: existingHash };
    }

    await this.fileSystem.mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    let renameAttempted = false;

    try {
      await this.fileSystem.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      renameAttempted = true;
      await this.fileSystem.rename(temporaryPath, path);
      return { path, contentHash: hashBytes(bytes) };
    } catch (error: unknown) {
      await this.removeTemporaryFile(temporaryPath);

      if (renameAttempted) {
        const concurrentHash = await this.hashMatchingExisting(path, bytes);
        if (concurrentHash !== undefined) {
          return { path, contentHash: concurrentHash };
        }
      }

      throw error;
    }
  }

  public async read<T>(relativePath: string): Promise<T> {
    const path = await this.paths.resolveOutput(relativePath);
    return JSON.parse(await this.fileSystem.readFile(path, "utf8")) as T;
  }

  private async hashMatchingExisting(path: string, bytes: string): Promise<ContentHash | undefined> {
    let existing: string;
    try {
      existing = await this.fileSystem.readFile(path, "utf8");
    } catch (error: unknown) {
      if (isMissingPath(error)) {
        return undefined;
      }
      throw error;
    }

    if (existing !== bytes) {
      throw new ValidationError(`immutable record already exists: ${path}`);
    }
    return hashBytes(existing);
  }

  private async removeTemporaryFile(path: string): Promise<void> {
    try {
      await this.fileSystem.unlink(path);
    } catch {
      // Cleanup must not hide the original write failure.
    }
  }
}

function hashBytes(bytes: string): ContentHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
