import { authenticate } from "../core/auth.js";
import { claimJob } from "../core/jobs.js";
import { loadState, saveState } from "../store/store.js";

export async function runClaim(options, { dataPath, now }) {
  const state = await loadState(dataPath);
  const actor = authenticate(state, options);
  const { state: next, job } = claimJob(state, { actor, now: now() });
  await saveState(dataPath, next);
  return { kind: "job", job };
}
