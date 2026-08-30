import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ValidationError } from "../../src/domain/errors.js";
import { hashFile } from "../../src/integrity/content-hash.js";
import { ProjectPaths } from "../../src/paths/project-paths.js";
import { ImmutableJsonStore, type StoreFileSystem } from "../../src/storage/immutable-json-store.js";

test("writes canonical JSON bytes with a trailing newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbench-store-"));
  const paths = await ProjectPaths.create(root);
  const store = new ImmutableJsonStore(paths);

  const result = await store.write("runs/run-1/record.json", { z: 1, a: [2, 1] });
  const path = join(root, "runs/run-1/record.json");

  assert.equal(result.path, path);
  assert.equal(await readFile(path, "utf8"), '{"a":[2,1],"z":1}\n');
  assert.equal(result.contentHash, await hashFile(path));
});

test("accepts a byte-identical immutable record idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbench-store-"));
  const paths = await ProjectPaths.create(root);
  const store = new ImmutableJsonStore(paths);

  const first = await store.write("runs/run-1/record.json", { b: 2, a: 1 });
  const second = await store.write("runs/run-1/record.json", { a: 1, b: 2 });

  assert.deepEqual(second, first);
  assert.equal(await readFile(first.path, "utf8"), '{"a":1,"b":2}\n');
});

test("rejects a different value when an immutable record already exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbench-store-"));
  const paths = await ProjectPaths.create(root);
  const store = new ImmutableJsonStore(paths);

  await store.write("runs/run-1/record.json", { value: "first" });

  await assert.rejects(
    () => store.write("runs/run-1/record.json", { value: "second" }),
    (error: unknown) => error instanceof ValidationError && /immutable record already exists/.test(error.message),
  );
});

test("removes only its temporary record when rename fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbench-store-"));
  const paths = await ProjectPaths.create(root);
  const failingFileSystem: StoreFileSystem = {
    mkdir,
    readFile,
    writeFile,
    rename: () => Promise.reject(new Error("forced rename failure")),
    unlink,
  };
  const store = new ImmutableJsonStore(paths, failingFileSystem);
  const target = join(root, "runs/run-1/record.json");

  await assert.rejects(() => store.write("runs/run-1/record.json", { value: "partial" }), /forced rename failure/);
  await assert.rejects(() => readFile(target, "utf8"), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(dirname(target))).filter((entry) => entry.includes(".tmp-")),
    [],
  );
});

test("reads a stored JSON value", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillbench-store-"));
  const paths = await ProjectPaths.create(root);
  const store = new ImmutableJsonStore(paths);

  await store.write("runs/run-1/record.json", { value: [1, 2] });

  assert.deepEqual(await store.read<{ value: number[] }>("runs/run-1/record.json"), { value: [1, 2] });
});
