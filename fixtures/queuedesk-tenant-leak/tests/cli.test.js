import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { job, queuedesk, writeData } from "./helpers/harness.js";

const acme = ["--tenant", "acme", "--token", "acme-token"];
const globex = ["--tenant", "globex", "--token", "globex-token"];

test("creates a job and shows it in the list", async () => {
  const dataPath = await writeData([], 5);
  const created = await queuedesk(["create", ...acme, "--data", dataPath, "--title", "Ship it"]);
  assert.equal(created.code, 0);
  assert.match(created.stdout, /^job-0005 {2}queued {2}normal {2}Ship it\n$/u);

  const listed = await queuedesk(["list", ...acme, "--data", dataPath]);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /job-0005 {2}queued/u);
  assert.match(listed.stdout, /\n1 job\n$/u);
});

test("reads the data path from the environment", async () => {
  const dataPath = await writeData([job({ id: "job-0001" })]);
  const listed = await queuedesk(["list", ...acme], { env: { QUEUEDESK_DATA: dataPath } });
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /job-0001/u);
});

test("lists jobs highest priority first", async () => {
  const dataPath = await writeData([
    job({ id: "job-0001", priority: "low", title: "Archive exports" }),
    job({ id: "job-0002", priority: "high", title: "Rotate the key" }),
    job({ id: "job-0003", priority: "normal", title: "Ship it" }),
  ]);
  const listed = await queuedesk(["list", ...acme, "--data", dataPath]);
  const identifiers = listed.stdout
    .split("\n")
    .slice(1, 4)
    .map((line) => line.slice(0, 8));
  assert.deepEqual(identifiers, ["job-0002", "job-0003", "job-0001"]);
});

test("hides other tenants' jobs and shows them to an admin asking for all tenants", async () => {
  const dataPath = await writeData([
    job({ id: "job-0001" }),
    job({ id: "job-0002", tenant: "globex", title: "Archive exports" }),
  ]);

  const own = await queuedesk(["list", ...globex, "--data", dataPath]);
  assert.match(own.stdout, /\n1 job\n$/u);
  assert.doesNotMatch(own.stdout, /job-0001/u);

  const all = await queuedesk(["list", ...acme, "--data", dataPath, "--all-tenants"]);
  assert.match(all.stdout, /\n2 jobs\n$/u);
});

test("refuses --all-tenants for a worker", async () => {
  const dataPath = await writeData([job({ id: "job-0001", tenant: "globex" })]);
  const result = await queuedesk(["list", ...globex, "--data", dataPath, "--all-tenants"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^queuedesk: tenant globex needs the admin role\n$/u);
});

test("filters the list by state", async () => {
  const dataPath = await writeData([
    job({ id: "job-0001" }),
    job({ id: "job-0002", state: "done", title: "Rotate the key" }),
  ]);
  const listed = await queuedesk(["list", ...acme, "--data", dataPath, "--state", "done"]);
  assert.match(listed.stdout, /job-0002/u);
  assert.match(listed.stdout, /\n1 job\n$/u);
});

test("prints an empty list as text and as JSON", async () => {
  const dataPath = await writeData([]);
  const text = await queuedesk(["list", ...acme, "--data", dataPath]);
  assert.equal(text.stdout, "no jobs\n");

  const json = await queuedesk(["list", ...acme, "--data", dataPath, "--json"]);
  assert.deepEqual(JSON.parse(json.stdout), []);
});

test("prints machine-readable job output with --json", async () => {
  const dataPath = await writeData([job({ id: "job-0001" })]);
  const listed = await queuedesk(["list", ...acme, "--data", dataPath, "--json"]);
  const [entry] = JSON.parse(listed.stdout);
  assert.equal(entry.id, "job-0001");
  assert.equal(entry.tenant, "acme");
  assert.equal(entry.state, "queued");
  assert.equal(entry.priority, "normal");
});

test("claim takes the highest priority queued job first", async () => {
  const dataPath = await writeData([
    job({ id: "job-0001", priority: "low", title: "Archive exports" }),
    job({ id: "job-0002", priority: "high", title: "Rotate the key" }),
  ]);
  const claimed = await queuedesk(["claim", ...acme, "--data", dataPath]);
  assert.equal(claimed.code, 0);
  assert.match(claimed.stdout, /^job-0002 {2}claimed {2}high/u);

  const stored = JSON.parse(await readFile(dataPath, "utf8"));
  assert.equal(stored.jobs.find((entry) => entry.id === "job-0002").state, "claimed");
  assert.equal(stored.jobs.find((entry) => entry.id === "job-0001").state, "queued");
});

test("completes a claimed job with a note", async () => {
  const dataPath = await writeData([job({ id: "job-0001", state: "claimed" })]);
  const completed = await queuedesk([
    "complete",
    "job-0001",
    ...acme,
    "--data",
    dataPath,
    "--note",
    "shipped",
  ]);
  assert.equal(completed.code, 0);
  assert.match(completed.stdout, /^job-0001 {2}done/u);

  const stored = JSON.parse(await readFile(dataPath, "utf8"));
  assert.equal(stored.jobs[0].note, "shipped");
});

test("exits 1 on an unknown command", async () => {
  const result = await queuedesk(["archive", ...acme]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "queuedesk: unknown command: archive\n");
});

test("exits 1 on an unknown flag and reports it as JSON when asked", async () => {
  const result = await queuedesk(["list", ...acme, "--verbose", "--json"]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    error: { code: "invalid_flag", message: "unknown flag: --verbose" },
  });
});

test("exits 2 on a wrong token", async () => {
  const dataPath = await writeData([]);
  const result = await queuedesk(["list", "--tenant", "acme", "--token", "wrong", "--data", dataPath]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /invalid token for tenant acme/u);
});

test("exits 2 when completing a job that does not exist", async () => {
  const dataPath = await writeData([job({ id: "job-0001", state: "claimed" })]);
  const result = await queuedesk(["complete", "job-0404", ...acme, "--data", dataPath]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no job job-0404 for tenant acme/u);
});

test("exits 3 when completing a job that is still queued", async () => {
  const dataPath = await writeData([job({ id: "job-0001" })]);
  const result = await queuedesk(["complete", "job-0001", ...acme, "--data", dataPath]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /only a claimed job can be completed/u);
});

test("exits 3 when there is nothing to claim", async () => {
  const dataPath = await writeData([job({ id: "job-0001", state: "done" })]);
  const result = await queuedesk(["claim", ...acme, "--data", dataPath]);
  assert.equal(result.code, 3);
  assert.equal(result.stderr, "queuedesk: no queued job available\n");
});

test("exits 4 when the data file is missing", async () => {
  const result = await queuedesk(["list", ...acme, "--data", "/nonexistent/queuedesk.json"]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /cannot read data file/u);
});
