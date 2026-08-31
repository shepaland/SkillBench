import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DATA_PATH, loadState, resolveDataPath, saveState } from "../src/store/store.js";

const validState = {
  version: 1,
  tenants: { acme: { token: "acme-token", role: "admin" } },
  jobs: [],
  nextId: 1,
};

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "queuedesk-store-"));
}

test("resolveDataPath prefers the flag, then the environment, then the default", () => {
  assert.equal(resolveDataPath("/tmp/flag.json", { QUEUEDESK_DATA: "/tmp/env.json" }), "/tmp/flag.json");
  assert.equal(resolveDataPath(null, { QUEUEDESK_DATA: "/tmp/env.json" }), "/tmp/env.json");
  assert.equal(resolveDataPath(null, {}), DEFAULT_DATA_PATH);
});

test("loads a valid data file", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "queuedesk.json");
  await writeFile(path, JSON.stringify(validState));
  assert.deepEqual(await loadState(path), validState);
});

test("rejects a missing data file", async () => {
  const directory = await temporaryDirectory();
  await assert.rejects(loadState(join(directory, "absent.json")), { code: "storage_unreadable" });
});

test("rejects a data file that is not valid JSON", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "queuedesk.json");
  await writeFile(path, "{ not json");
  await assert.rejects(loadState(path), { code: "storage_unreadable" });
});

test("rejects a data file with an unsupported version", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "queuedesk.json");
  await writeFile(path, JSON.stringify({ ...validState, version: 2 }));
  await assert.rejects(loadState(path), { code: "storage_unsupported_version" });
});

test("rejects a data file with a malformed shape", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "queuedesk.json");
  await writeFile(path, JSON.stringify({ version: 1, tenants: {}, jobs: {}, nextId: 1 }));
  await assert.rejects(loadState(path), { code: "storage_unreadable" });
});

test("saves state, leaves no extra file behind, and round-trips", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "queuedesk.json");
  await saveState(path, validState);
  assert.deepEqual(await readdir(directory), ["queuedesk.json"]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), validState);
});

test("reports a write into a missing directory as a storage failure", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "absent", "queuedesk.json");
  await assert.rejects(saveState(path, validState), { code: "storage_write_failed" });
});
