# Design decisions

## One JSON data file, not a directory per job

**Decision:** All tenants and jobs live in a single JSON file.

**Why:** The queue is small and offline; a single file keeps reads simple and makes an atomic replacement possible.

## Ordering belongs to the job rules

**Decision:** `src/core/jobs.js` decides which job comes first, and the renderer prints what it receives.

**Why:** Two places deciding order would let listing and claiming disagree.

## Writes go through a temporary file and a rename

**Decision:** Saving state writes to a temporary file, then renames it into place.

**Why:** A crash mid-write must never leave a half-written queue behind.

## Sequential zero-padded identifiers

**Decision:** Job identifiers are sequential and zero-padded, such as `job-0001`.

**Why:** Output stays identical on every machine, which keeps tests and comparisons meaningful.

## An invisible job and a missing job answer alike

**Decision:** Asking for a job that exists but belongs to another tenant produces the same error as asking for a job that does not exist at all.

**Why:** Both produce `job_not_visible` with exit code `2`, so one tenant cannot discover whether another tenant's job exists.
