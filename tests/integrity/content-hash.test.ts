import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ValidationError } from "../../src/domain/errors.js";
import { canonicalJson } from "../../src/integrity/canonical-json.js";
import { hashFile, hashTree, hashValue } from "../../src/integrity/content-hash.js";

test("canonical JSON ignores object insertion order but preserves array order", () => {
  assert.equal(canonicalJson({ b: 2, a: [2, 1] }), '{"a":[2,1],"b":2}');
  assert.equal(hashValue({ b: 2, a: 1 }), hashValue({ a: 1, b: 2 }));
  assert.notEqual(hashValue([1, 2]), hashValue([2, 1]));
});

test("canonical JSON rejects values outside its portable data model", () => {
  assertCanonicalValidation(undefined, "canonical JSON does not support undefined values");
  assertCanonicalValidation(Number.NaN, "canonical JSON does not support non-finite numbers");
  assertCanonicalValidation(1n, "canonical JSON does not support bigint values");
  assertCanonicalValidation(() => undefined, "canonical JSON does not support function values");
  assertCanonicalValidation(Symbol("value"), "canonical JSON does not support symbol values");
  assertCanonicalValidation(new Date(), "canonical JSON only supports plain objects");

  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assertCanonicalValidation(cycle, "canonical JSON does not support cyclic values");
});

test("canonical JSON rejects sparse array holes", () => {
  const sparse = new Array<unknown>(1);
  assertCanonicalValidation(sparse, "canonical JSON does not support sparse array holes");
});

test("canonical JSON rejects objects with symbol keys", () => {
  const hidden = Symbol("hidden");
  const symbolKeyed: Record<PropertyKey, unknown> = { visible: "value" };
  symbolKeyed[hidden] = "not serializable";
  assertCanonicalValidation(symbolKeyed, "canonical JSON does not support symbol keys");
});

test("tree hashes include normalized relative paths and bytes", async () => {
  const first = await mkdtemp(join(tmpdir(), "skillbench-hash-a-"));
  const second = await mkdtemp(join(tmpdir(), "skillbench-hash-b-"));
  await mkdir(join(first, "nested"));
  await mkdir(join(second, "nested"));
  await writeFile(join(first, "nested/a.txt"), "same");
  await writeFile(join(second, "nested/a.txt"), "same");
  assert.equal(await hashTree(first), await hashTree(second));
  await writeFile(join(second, "nested/a.txt"), "changed");
  assert.notEqual(await hashTree(first), await hashTree(second));
});

test("file hashing uses raw bytes and tree hashing rejects symbolic links", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbench-hash-link-"));
  const file = join(root, "value.txt");
  await writeFile(file, "same");
  assert.equal(await hashFile(file), "sha256:0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5");
  try {
    await symlink(file, join(root, "link.txt"));
  } catch (error: unknown) {
    if (isSymlinkUnsupported(error)) {
      return;
    }
    throw error;
  }
  await assert.rejects(
    hashTree(root),
    (error: unknown) => error instanceof ValidationError &&
      error.message === "symbolic links are not supported in hashed trees: link.txt",
  );
});

function assertCanonicalValidation(value: unknown, message: string): void {
  assert.throws(
    () => canonicalJson(value),
    (error: unknown) => error instanceof ValidationError && error.exitCode === 2 && error.message === message,
  );
}

function isSymlinkUnsupported(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error.code === "EPERM") || (error.code === "EACCES") || (error.code === "ENOTSUP"));
}
