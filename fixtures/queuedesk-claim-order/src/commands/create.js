import { authenticate } from "../core/auth.js";
import { createJob } from "../core/jobs.js";
import { loadState, saveState } from "../store/store.js";

export async function runCreate(options, { dataPath, now }) {
  const state = await loadState(dataPath);
  const actor = authenticate(state, options);
  const { state: next, job } = createJob(state, {
    actor,
    title: options.title,
    priority: options.priority,
    now: now(),
  });
  await saveState(dataPath, next);
  return { kind: "job", job };
}
