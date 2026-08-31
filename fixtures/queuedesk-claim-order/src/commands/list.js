import { authenticate } from "../core/auth.js";
import { listJobs } from "../core/jobs.js";
import { loadState } from "../store/store.js";

export async function runList(options, { dataPath }) {
  const state = await loadState(dataPath);
  const actor = authenticate(state, options);
  const jobs = listJobs(state, {
    actor,
    stateFilter: options.state,
    allTenants: options.allTenants,
  });
  return { kind: "jobs", jobs };
}
