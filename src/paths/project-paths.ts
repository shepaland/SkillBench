import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { ValidationError } from "../domain/errors.js";

type ExpectedEntry = "file" | "directory";

export class ProjectPaths {
  private constructor(
    private readonly root: string,
    private readonly realRoot: string,
  ) {}

  public static async create(root: string): Promise<ProjectPaths> {
    if (!isAbsolute(root)) {
      throw new ValidationError("project root must be absolute");
    }

    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      throw new ValidationError("project root must be a directory");
    }

    return new ProjectPaths(root, await realpath(root));
  }

  public async resolveExisting(relativePath: string, expected: ExpectedEntry): Promise<string> {
    const segments = parseManifestPath(relativePath);
    let candidate = this.realRoot;

    for (const segment of segments) {
      candidate = join(candidate, segment);
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink()) {
        throw new ValidationError(`manifest path contains a symbolic link: ${relativePath}`);
      }
      this.assertContained(await realpath(candidate), relativePath);
    }

    const entry = await lstat(candidate);
    if ((expected === "file" && !entry.isFile()) || (expected === "directory" && !entry.isDirectory())) {
      throw new ValidationError(`manifest path must resolve to a ${expected}: ${relativePath}`);
    }

    return join(this.root, ...segments);
  }

  public async resolveOutput(relativePath: string): Promise<string> {
    const segments = parseManifestPath(relativePath);
    let candidate = this.realRoot;

    for (const segment of segments) {
      candidate = join(candidate, segment);
      try {
        const entry = await lstat(candidate);
        if (entry.isSymbolicLink()) {
          throw new ValidationError(`manifest path contains a symbolic link: ${relativePath}`);
        }
        this.assertContained(await realpath(candidate), relativePath);
      } catch (error: unknown) {
        if (isMissingPath(error)) {
          return join(this.root, ...segments);
        }
        throw error;
      }
    }

    return join(this.root, ...segments);
  }

  private assertContained(candidate: string, relativePath: string): void {
    const pathFromRoot = relative(this.realRoot, candidate);
    if (pathFromRoot === ".." || pathFromRoot.startsWith("../") || isAbsolute(pathFromRoot)) {
      throw new ValidationError(`manifest path escapes project root: ${relativePath}`);
    }
  }
}

function parseManifestPath(relativePath: string): string[] {
  if (relativePath.includes("\0")) {
    throw new ValidationError("manifest path must not contain NUL bytes");
  }

  const normalized = relativePath.replaceAll("\\", "/");
  if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    throw new ValidationError("manifest path must be relative");
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new ValidationError(`manifest path escapes project root: ${relativePath}`);
    }
    if (segment === "" || segment === ".") {
      throw new ValidationError(`manifest path contains an invalid segment: ${relativePath}`);
    }
  }

  return segments;
}

function isMissingPath(error: unknown): boolean {
  return isErrorWithCode(error, "ENOENT");
}

function isErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
