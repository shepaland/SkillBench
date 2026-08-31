import { fail } from "./errors.js";

export function authenticate(state, { tenant, token }) {
  if (!Object.hasOwn(state.tenants, tenant)) {
    throw fail("unknown_tenant", `unknown tenant: ${tenant}`);
  }
  const record = state.tenants[tenant];
  if (record.token !== token) {
    throw fail("invalid_token", `invalid token for tenant ${tenant}`);
  }
  return { id: tenant, role: record.role };
}

export function assertRole(actor, role) {
  if (actor.role !== role) {
    throw fail("forbidden_role", `tenant ${actor.id} needs the ${role} role`);
  }
}

export function assertJobVisible(actor, job, jobId) {
  if (job === undefined || job.tenant !== actor.id) {
    throw fail("job_not_visible", `no job ${jobId} for tenant ${actor.id}`);
  }
}
