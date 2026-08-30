import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../../src/integrity/canonical-json.js";
import { hashFile, hashTree, hashValue } from "../../src/integrity/content-hash.js";

test("canonical JSON ignores object insertion order but preserves array order", () => {
  assert.equal(canonicalJson({ b: 2, a: [2, 1] }), '{"a":[2,1],"b":2}');
  assert.equal(hashValue({ b: 2, a: 1 }), hashValue({ a: 1, b: 2 }));
  assert.notEqual(hashValue([1, 2]), hashValue([2, 1]));
});

test("canonical JSON rejects values outside its portable data model", () => {
  assert.throws(() => canonicalJson(undefined));
  assert.throws(() => canonicalJson(Number.NaN));
  assert.throws(() => canonicalJson(1n));
  assert.throws(() => canonicalJson(() => undefined));
  assert.throws(() => canonicalJson(Symbol("value")));
  assert.throws(() => canonicalJson(new Date()));

  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle));
});

test("canonical JSON rejects sparse array holes", () => {
  const sparse = new Array<unknown>(1);
  assert.throws(() => canonicalJson(sparse));
});

test("canonical JSON rejects objects with symbol keys", () => {
  const hidden = Symbol("hidden");
  const symbolKeyed: Record<PropertyKey, unknown> = { visible: "value" };
  symbolKeyed[hidden] = "not serializable";
  assert.throws(() => canonicalJson(symbolKeyed));
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
  await symlink(file, join(root, "link.txt"));
  await assert.rejects(hashTree(root));
});
