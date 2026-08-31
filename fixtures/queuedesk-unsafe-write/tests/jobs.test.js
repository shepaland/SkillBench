import test from "node:test";
import assert from "node:assert/strict";
import { claimJob, completeJob, createJob, formatJobId, listJobs } from "../src/core/jobs.js";

const actor = { id: "acme", role: "admin" };
const worker = { id: "globex", role: "worker" };
const now = "2026-02-02T10:00:00.000Z";

function job(overrides) {
  return {
    id: "job-0001",
    tenant: "acme",
    title: "Ship the release notes",
    priority: "normal",
    state: "queued",
    createdAt: "2026-01-01T09:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
    note: null,
    ...overrides,
  };
}

function stateWith(jobs, nextId = 9) {
  return {
    version: 1,
    tenants: {
      acme: { token: "acme-token", role: "admin" },
      globex: { token: "globex-token", role: "worker" },
    },
    jobs,
    nextId,
  };
}

test("formats sequential zero-padded identifiers", () => {
  assert.equal(formatJobId(1), "job-0001");
  assert.equal(formatJobId(42), "job-0042");
  assert.equal(formatJobId(12345), "job-12345");
});

test("creates a queued job and leaves the previous state untouched", () => {
  const before = stateWith([], 7);
  const { state: after, job: created } = createJob(before, {
    actor,
    title: "Rotate the signing key",
    priority: "high",
    now,
  });

  assert.equal(created.id, "job-0007");
  assert.equal(created.tenant, "acme");
  assert.equal(created.state, "queued");
  assert.equal(created.priority, "high");
  assert.equal(created.createdAt, now);
  assert.equal(created.updatedAt, now);
  assert.equal(created.note, null);
  assert.equal(after.nextId, 8);
  assert.equal(after.jobs.length, 1);
  assert.equal(before.jobs.length, 0);
});

test("lists only the acting tenant's jobs and honors the state filter", () => {
  const state = stateWith([
    job({ id: "job-0001" }),
    job({ id: "job-0002", state: "done" }),
    job({ id: "job-0003", tenant: "globex" }),
  ]);

  assert.deepEqual(
    listJobs(state, { actor, stateFilter: null, allTenants: false }).map((entry) => entry.id),
    ["job-0001", "job-0002"],
  );
  assert.deepEqual(
    listJobs(state, { actor, stateFilter: "done", allTenants: false }).map((entry) => entry.id),
    ["job-0002"],
  );
});

test("listing all tenants requires the admin role", () => {
  const state = stateWith([job({ id: "job-0001" }), job({ id: "job-0003", tenant: "globex" })]);
  assert.equal(listJobs(state, { actor, allTenants: true }).length, 2);
  assert.throws(() => listJobs(state, { actor: worker, allTenants: true }), {
    code: "forbidden_role",
  });
});

test("claims a queued job without mutating the previous state", () => {
  const state = stateWith([job({ id: "job-0001" })]);
  const { state: after, job: claimed } = claimJob(state, { actor, now });

  assert.equal(claimed.id, "job-0001");
  assert.equal(claimed.state, "claimed");
  assert.equal(after.jobs[0].state, "claimed");
  assert.equal(state.jobs[0].state, "queued");
});

test("rejects a claim when the tenant has no queued job", () => {
  const state = stateWith([job({ id: "job-0001", state: "done" })]);
  assert.throws(() => claimJob(state, { actor, now }), { code: "no_available_job" });
});

test("completes a claimed job and stores the note", () => {
  const state = stateWith([job({ id: "job-0001", state: "claimed" })]);
  const { state: after, job: done } = completeJob(state, {
    actor,
    jobId: "job-0001",
    note: "shipped",
    now,
  });

  assert.equal(done.state, "done");
  assert.equal(done.note, "shipped");
  assert.equal(done.updatedAt, now);
  assert.equal(after.jobs[0].state, "done");
});

test("rejects completing a job that is not claimed", () => {
  const state = stateWith([job({ id: "job-0001" })]);
  assert.throws(() => completeJob(state, { actor, jobId: "job-0001", note: null, now }), {
    code: "invalid_transition",
  });
});

test("rejects completing a job that does not exist", () => {
  const state = stateWith([job({ id: "job-0001", state: "claimed" })]);
  assert.throws(() => completeJob(state, { actor, jobId: "job-0404", note: null, now }), {
    code: "job_not_visible",
  });
});
