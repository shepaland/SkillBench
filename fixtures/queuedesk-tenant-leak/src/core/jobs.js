import { assertRole } from "./auth.js";
import { fail } from "./errors.js";

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

export function formatJobId(sequence) {
  return `job-${String(sequence).padStart(4, "0")}`;
}

export function orderJobs(jobs) {
  return [...jobs].sort((left, right) => {
    const byPriority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
    if (byPriority !== 0) {
      return byPriority;
    }
    return left.id.localeCompare(right.id);
  });
}

export function createJob(state, { actor, title, priority, now }) {
  const job = {
    id: formatJobId(state.nextId),
    tenant: actor.id,
    title,
    priority,
    state: "queued",
    createdAt: now,
    updatedAt: now,
    note: null,
  };
  return {
    state: { ...state, jobs: [...state.jobs, job], nextId: state.nextId + 1 },
    job,
  };
}

export function listJobs(state, { actor, stateFilter = null, allTenants = false }) {
  if (allTenants) {
    assertRole(actor, "admin");
  }
  const visible = state.jobs.filter(
    (job) =>
      (allTenants || job.tenant === actor.id) && (stateFilter === null || job.state === stateFilter),
  );
  return orderJobs(visible);
}

export function claimJob(state, { now }) {
  const available = orderJobs(state.jobs.filter((job) => job.state === "queued"));
  const target = available[0];
  if (target === undefined) {
    throw fail("no_available_job", "no queued job available");
  }
  const claimed = { ...target, state: "claimed", updatedAt: now };
  return { state: replaceJob(state, claimed), job: claimed };
}

export function completeJob(state, { actor, jobId, note = null, now }) {
  const target = state.jobs.find((job) => job.id === jobId);
  if (target === undefined) {
    throw fail("job_not_visible", `no job ${jobId} for tenant ${actor.id}`);
  }
  if (target.state !== "claimed") {
    throw fail(
      "invalid_transition",
      `job ${jobId} is ${target.state}; only a claimed job can be completed`,
    );
  }
  const done = { ...target, state: "done", note, updatedAt: now };
  return { state: replaceJob(state, done), job: done };
}

function replaceJob(state, job) {
  return {
    ...state,
    jobs: state.jobs.map((candidate) => (candidate.id === job.id ? job : candidate)),
  };
}
