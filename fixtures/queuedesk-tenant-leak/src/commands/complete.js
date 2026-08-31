import { authenticate } from "../core/auth.js";
import { completeJob } from "../core/jobs.js";
import { loadState, saveState } from "../store/store.js";

export async function runComplete(options, { dataPath, now }) {
  const state = await loadState(dataPath);
  const actor = authenticate(state, options);
  const { state: next, job } = completeJob(state, {
    actor,
    jobId: options.jobId,
    note: options.note,
    now: now(),
  });
  await saveState(dataPath, next);
  return { kind: "job", job };
}
