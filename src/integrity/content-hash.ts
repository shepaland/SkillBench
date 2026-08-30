import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContentHash } from "../domain/model.js";
import { ValidationError } from "../domain/errors.js";
import { canonicalJson } from "./canonical-json.js";

interface TreeFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export function hashValue(value: unknown): ContentHash {
  return hashBytes(canonicalJson(value));
}

export async function hashFile(path: string): Promise<ContentHash> {
  return hashBytes(await readFile(path));
}

export async function hashTree(root: string): Promise<ContentHash> {
  const files: TreeFile[] = [];
  await collectFiles(root, "", files);
  files.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));

  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(file.absolutePath);
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
  }
  return contentHash(hash.digest("hex"));
}

async function collectFiles(root: string, relativePath: string, files: TreeFile[]): Promise<void> {
  const status = await lstat(root);
  if (status.isSymbolicLink()) {
    throw new ValidationError(`symbolic links are not supported in hashed trees: ${relativePath || root}`);
  }
  if (status.isFile()) {
    files.push({ absolutePath: root, relativePath });
    return;
  }
  if (!status.isDirectory()) {
    throw new ValidationError(`unsupported entry in hashed tree: ${relativePath || root}`);
  }

  for (const entry of await readdir(root)) {
    const entryRelativePath = relativePath === "" ? entry : `${relativePath}/${entry}`;
    await collectFiles(join(root, entry), entryRelativePath, files);
  }
}

function hashBytes(value: string | Uint8Array): ContentHash {
  return contentHash(createHash("sha256").update(value).digest("hex"));
}

function contentHash(digest: string): ContentHash {
  return `sha256:${digest}` as ContentHash;
}
