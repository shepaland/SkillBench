# QueueDesk Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver QueueDesk, the offline JavaScript project that SkillBench cases will run against, together with its public test suite, four defective copies, and the tooling that keeps those copies in step with the base.

**Architecture:** QueueDesk is a layered command-line application: `cli.js → commands → core → store`, with rendering isolated in `format`. It is committed as `fixtures/queuedesk/`. Defect overlays under `fixtures/overlays/` carry only the files they change; `scripts/build-fixtures.mjs` composes them into `fixtures/queuedesk-<overlay>/`, which are committed and verified for drift by `npm run check`.

**Tech Stack:** Node.js 22+, JavaScript ESM, Node standard library only inside the fixture (no dependencies, `node --test`). SkillBench-side tests stay TypeScript under `tests/`, run with `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-31-skillbench-stage-4-queuedesk-fixture-design.md`

## Global Constraints

- All committed text is concise international English. `README.md` keeps its English half first and a complete Russian translation second.
- The fixture depends on nothing outside the Node.js standard library, and `fixtures/queuedesk/package.json` declares no dependencies.
- Nothing inside a composed fixture may mark it as generated or hint at a seeded defect. The agent under measurement reads those files as an ordinary project.
- Public tests must never observe: cross-tenant `claim` or `complete` at any level, an interrupted write, the `updatedAt` of a claimed job, or job ordering anywhere except the command-level tests of `list` and `claim`. These four gaps are where the seeded defects live. Asserting `createdAt` and `updatedAt` on a newly created job, and `updatedAt` on a completed job, stays allowed: no overlay touches those paths.
- Job identifiers are `job-` plus a zero-padded four-digit sequence, so output is machine independent.
- Never execute shell text; scripts and tests spawn explicit executables with explicit arguments.
- Commits end with the line `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Files under `docs/` are ignored by Git and must be staged with `git add -f`.
- Work happens in the worktree `.worktrees/stage4-queuedesk-fixture` on branch `stage4-queuedesk-fixture`.

## File Structure

| File | Responsibility |
|---|---|
| `fixtures/queuedesk/package.json` | Fixture manifest: ESM, `test` script, no dependencies |
| `fixtures/queuedesk/src/core/errors.js` | `QueueDeskError`, error-code to exit-code table, `fail()` |
| `fixtures/queuedesk/src/args.js` | Argument parsing and usage errors |
| `fixtures/queuedesk/src/core/auth.js` | Tenant authentication, role check, job visibility check |
| `fixtures/queuedesk/src/store/store.js` | Data path resolution, validated load, atomic save |
| `fixtures/queuedesk/src/core/jobs.js` | Job creation, ordering, listing, claim and complete rules |
| `fixtures/queuedesk/src/format/output.js` | Human-readable and JSON rendering |
| `fixtures/queuedesk/src/commands/*.js` | One thin command each |
| `fixtures/queuedesk/src/cli.js` | Entry point: parse, dispatch, render, exit code |
| `fixtures/queuedesk/tests/*.test.js` | Public test suite |
| `fixtures/queuedesk/tests/helpers/harness.js` | Temporary data files and CLI spawning for tests |
| `fixtures/queuedesk/README.md`, `DECISIONS.md`, `examples/queuedesk.sample.json` | Fixture documentation and sample data |
| `fixtures/overlays/<overlay>/overlay.json`, `files/**` | Defect overlays |
| `fixtures/queuedesk-<overlay>/` | Composed fixtures, committed |
| `scripts/build-fixtures.mjs` | Composition and drift verification |
| `tests/fixtures/build-fixtures.test.ts` | Tests for the composition script |
| `tests/fixtures/queuedesk.test.ts` | Fixture proof: expected pass and failure picture |
| `eslint.config.js`, `package.json` | Lint coverage for plain JavaScript, new npm scripts |
| `README.md`, `AGENTS.md` | Project documentation |

---

### Task 1: Fixture scaffold, error vocabulary, argument parsing

**Files:**
- Create: `fixtures/queuedesk/package.json`
- Create: `fixtures/queuedesk/src/core/errors.js`
- Create: `fixtures/queuedesk/src/args.js`
- Test: `fixtures/queuedesk/tests/args.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `QueueDeskError` (properties `code: string`, `exitCode: number`), `fail(code: string, message: string): QueueDeskError`, `EXIT_CODES: Record<string, number>`, and `parseArgs(argv: string[]): Options`. `Options` has `command`, `tenant`, `token`, `dataPath`, `json`, and per-command fields `title`, `priority`, `state`, `allTenants`, `jobId`, `note`.

- [ ] **Step 1: Create the fixture manifest**

`fixtures/queuedesk/package.json`:

```json
{
  "name": "queuedesk",
  "version": "1.0.0",
  "private": true,
  "description": "Offline multi-tenant job queue",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Write the failing argument tests**

`fixtures/queuedesk/tests/args.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/args.js";

const credentials = ["--tenant", "acme", "--token", "acme-token"];

test("parses create with a title and the default priority", () => {
  const options = parseArgs(["create", ...credentials, "--title", "Ship the release notes"]);
  assert.equal(options.command, "create");
  assert.equal(options.tenant, "acme");
  assert.equal(options.token, "acme-token");
  assert.equal(options.title, "Ship the release notes");
  assert.equal(options.priority, "normal");
  assert.equal(options.json, false);
  assert.equal(options.dataPath, null);
});

test("parses list with a state filter, all tenants, and json output", () => {
  const options = parseArgs(["list", ...credentials, "--state", "queued", "--all-tenants", "--json"]);
  assert.equal(options.state, "queued");
  assert.equal(options.allTenants, true);
  assert.equal(options.json, true);
});

test("parses complete with a job identifier and a note", () => {
  const options = parseArgs(["complete", "job-0007", ...credentials, "--note", "done early"]);
  assert.equal(options.jobId, "job-0007");
  assert.equal(options.note, "done early");
});

test("rejects an unknown command", () => {
  assert.throws(() => parseArgs(["archive", ...credentials]), { code: "unknown_command" });
});

test("rejects a missing command", () => {
  assert.throws(() => parseArgs([]), { code: "unknown_command" });
});

test("rejects a missing tenant", () => {
  assert.throws(() => parseArgs(["list", "--token", "acme-token"]), { code: "missing_flag" });
});

test("rejects a flag without a value", () => {
  assert.throws(() => parseArgs(["list", ...credentials, "--state"]), { code: "missing_flag" });
});

test("rejects an unknown flag", () => {
  assert.throws(() => parseArgs(["list", ...credentials, "--verbose"]), { code: "invalid_flag" });
});

test("rejects an unsupported priority", () => {
  assert.throws(
    () => parseArgs(["create", ...credentials, "--title", "x", "--priority", "urgent"]),
    { code: "invalid_flag" },
  );
});

test("rejects a malformed job identifier", () => {
  assert.throws(() => parseArgs(["complete", "7", ...credentials]), { code: "invalid_job_id" });
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `cd fixtures/queuedesk && node --test tests/args.test.js`
Expected: FAIL, cannot find module `../src/args.js`.

- [ ] **Step 4: Write the error vocabulary**

`fixtures/queuedesk/src/core/errors.js`:

```js
export const EXIT_CODES = {
  unknown_command: 1,
  missing_flag: 1,
  invalid_flag: 1,
  invalid_job_id: 1,
  unknown_tenant: 2,
  invalid_token: 2,
  forbidden_role: 2,
  job_not_visible: 2,
  invalid_transition: 3,
  no_available_job: 3,
  storage_unreadable: 4,
  storage_unsupported_version: 4,
  storage_write_failed: 4,
};

export class QueueDeskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QueueDeskError";
    this.code = code;
  }

  get exitCode() {
    return EXIT_CODES[this.code];
  }
}

export function fail(code, message) {
  if (!Object.hasOwn(EXIT_CODES, code)) {
    throw new Error(`unknown error code: ${code}`);
  }
  return new QueueDeskError(code, message);
}
```

- [ ] **Step 5: Write the argument parser**

`fixtures/queuedesk/src/args.js`:

```js
import { fail } from "./core/errors.js";

const COMMANDS = new Set(["create", "list", "claim", "complete"]);
const PRIORITIES = new Set(["high", "normal", "low"]);
const STATES = new Set(["queued", "claimed", "done"]);
const JOB_ID = /^job-\d{4,}$/u;

const VALUE_FLAGS = new Map([
  ["--tenant", "tenant"],
  ["--token", "token"],
  ["--data", "dataPath"],
  ["--title", "title"],
  ["--note", "note"],
  ["--priority", "priority"],
  ["--state", "state"],
]);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) {
    throw fail("unknown_command", "missing command; expected create, list, claim, or complete");
  }
  if (!COMMANDS.has(command)) {
    throw fail("unknown_command", `unknown command: ${command}`);
  }

  const options = {
    command,
    tenant: null,
    token: null,
    dataPath: null,
    json: false,
    title: null,
    note: null,
    priority: "normal",
    state: null,
    allTenants: false,
    jobId: null,
  };
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const field = VALUE_FLAGS.get(argument);
    if (field !== undefined) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw fail("missing_flag", `flag ${argument} needs a value`);
      }
      options[field] = value;
      index += 1;
      continue;
    }
    if (argument === "--all-tenants") {
      options.allTenants = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument.startsWith("--")) {
      throw fail("invalid_flag", `unknown flag: ${argument}`);
    }
    positional.push(argument);
  }

  if (options.tenant === null) {
    throw fail("missing_flag", "flag --tenant is required");
  }
  if (options.token === null) {
    throw fail("missing_flag", "flag --token is required");
  }
  if (!PRIORITIES.has(options.priority)) {
    throw fail("invalid_flag", `unsupported priority: ${options.priority}`);
  }
  if (options.state !== null && !STATES.has(options.state)) {
    throw fail("invalid_flag", `unsupported state: ${options.state}`);
  }

  if (command === "create" && options.title === null) {
    throw fail("missing_flag", "flag --title is required for create");
  }
  if (command === "complete") {
    const [jobId, ...extra] = positional;
    if (jobId === undefined) {
      throw fail("missing_flag", "complete needs a job identifier");
    }
    if (extra.length > 0) {
      throw fail("invalid_flag", `unexpected argument: ${extra[0]}`);
    }
    if (!JOB_ID.test(jobId)) {
      throw fail("invalid_job_id", `malformed job identifier: ${jobId}`);
    }
    options.jobId = jobId;
  } else if (positional.length > 0) {
    throw fail("invalid_flag", `unexpected argument: ${positional[0]}`);
  }

  return options;
}
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `cd fixtures/queuedesk && node --test tests/args.test.js`
Expected: PASS, 10 tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add fixtures/queuedesk
git commit -m "$(cat <<'EOF'
feat: add the QueueDesk scaffold, error vocabulary, and argument parser

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Authorization

**Files:**
- Create: `fixtures/queuedesk/src/core/auth.js`
- Test: `fixtures/queuedesk/tests/auth.test.js`

**Interfaces:**
- Consumes: `fail` from `src/core/errors.js`.
- Produces: `authenticate(state, { tenant, token }): { id: string, role: string }`, `assertRole(actor, role): void`, `assertJobVisible(actor, job, jobId): void`.

`assertJobVisible` is the guard the `tenant-leak` overlay stops calling, so it must stay a separate exported function with its own tests.

- [ ] **Step 1: Write the failing authorization tests**

`fixtures/queuedesk/tests/auth.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { assertJobVisible, assertRole, authenticate } from "../src/core/auth.js";

const state = {
  version: 1,
  tenants: {
    acme: { token: "acme-token", role: "admin" },
    globex: { token: "globex-token", role: "worker" },
  },
  jobs: [],
  nextId: 1,
};

test("authenticates a known tenant with the right token", () => {
  assert.deepEqual(authenticate(state, { tenant: "acme", token: "acme-token" }), {
    id: "acme",
    role: "admin",
  });
});

test("rejects an unknown tenant", () => {
  assert.throws(() => authenticate(state, { tenant: "initech", token: "x" }), {
    code: "unknown_tenant",
  });
});

test("rejects a wrong token", () => {
  assert.throws(() => authenticate(state, { tenant: "acme", token: "wrong" }), {
    code: "invalid_token",
  });
});

test("rejects an inherited property used as a tenant name", () => {
  assert.throws(() => authenticate(state, { tenant: "constructor", token: "x" }), {
    code: "unknown_tenant",
  });
});

test("assertRole rejects a worker asking for an admin action", () => {
  const worker = { id: "globex", role: "worker" };
  assert.throws(() => assertRole(worker, "admin"), { code: "forbidden_role" });
  assert.equal(assertRole({ id: "acme", role: "admin" }, "admin"), undefined);
});

test("assertJobVisible rejects a missing job and another tenant's job", () => {
  const actor = { id: "acme", role: "admin" };
  assert.throws(() => assertJobVisible(actor, undefined, "job-0009"), { code: "job_not_visible" });
  assert.throws(
    () => assertJobVisible(actor, { id: "job-0002", tenant: "globex" }, "job-0002"),
    { code: "job_not_visible" },
  );
  assert.equal(assertJobVisible(actor, { id: "job-0001", tenant: "acme" }, "job-0001"), undefined);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd fixtures/queuedesk && node --test tests/auth.test.js`
Expected: FAIL, cannot find module `../src/core/auth.js`.

- [ ] **Step 3: Write the implementation**

`fixtures/queuedesk/src/core/auth.js`:

```js
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
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd fixtures/queuedesk && node --test tests/auth.test.js`
Expected: PASS, 6 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add fixtures/queuedesk
git commit -m "$(cat <<'EOF'
feat: add QueueDesk tenant authentication and permission checks

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Storage

**Files:**
- Create: `fixtures/queuedesk/src/store/store.js`
- Create: `fixtures/queuedesk/examples/queuedesk.sample.json`
- Test: `fixtures/queuedesk/tests/store.test.js`

**Interfaces:**
- Consumes: `fail` from `src/core/errors.js`.
- Produces: `STORE_VERSION: 1`, `DEFAULT_DATA_PATH: "queuedesk.json"`, `resolveDataPath(dataFlag, env): string`, `loadState(path): Promise<State>`, `saveState(path, state): Promise<void>`.

`saveState` writes a temporary file next to the target and renames it. The `unsafe-write` overlay replaces exactly that with a direct write, so the atomic write must live in this one function.

- [ ] **Step 1: Write the failing storage tests**

`fixtures/queuedesk/tests/store.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd fixtures/queuedesk && node --test tests/store.test.js`
Expected: FAIL, cannot find module `../src/store/store.js`.

- [ ] **Step 3: Write the implementation**

`fixtures/queuedesk/src/store/store.js`:

```js
import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fail } from "../core/errors.js";

export const STORE_VERSION = 1;
export const DEFAULT_DATA_PATH = "queuedesk.json";

export function resolveDataPath(dataFlag, env) {
  if (typeof dataFlag === "string" && dataFlag !== "") {
    return dataFlag;
  }
  const fromEnvironment = env.QUEUEDESK_DATA;
  if (typeof fromEnvironment === "string" && fromEnvironment !== "") {
    return fromEnvironment;
  }
  return DEFAULT_DATA_PATH;
}

export async function loadState(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw fail("storage_unreadable", `cannot read data file ${path}: ${cause.code ?? "unknown error"}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail("storage_unreadable", `data file ${path} is not valid JSON`);
  }

  if (parsed === null || typeof parsed !== "object") {
    throw fail("storage_unreadable", `data file ${path} is not an object`);
  }
  if (parsed.version !== STORE_VERSION) {
    throw fail(
      "storage_unsupported_version",
      `data file ${path} has version ${String(parsed.version)}; this build supports ${STORE_VERSION}`,
    );
  }
  if (parsed.tenants === null || typeof parsed.tenants !== "object" || Array.isArray(parsed.tenants)) {
    throw fail("storage_unreadable", `data file ${path} has no tenant table`);
  }
  if (!Array.isArray(parsed.jobs)) {
    throw fail("storage_unreadable", `data file ${path} has no job list`);
  }
  if (!Number.isInteger(parsed.nextId) || parsed.nextId < 1) {
    throw fail("storage_unreadable", `data file ${path} has no valid next identifier`);
  }

  return parsed;
}

export async function saveState(path, state) {
  const temporaryPath = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporaryPath, path);
  } catch (cause) {
    await unlink(temporaryPath).catch(() => undefined);
    throw fail("storage_write_failed", `cannot write data file ${path}: ${cause.code ?? "unknown error"}`);
  }
}
```

- [ ] **Step 4: Add the sample data file**

`fixtures/queuedesk/examples/queuedesk.sample.json`:

```json
{
  "version": 1,
  "tenants": {
    "acme": { "token": "acme-token", "role": "admin" },
    "globex": { "token": "globex-token", "role": "worker" }
  },
  "jobs": [
    {
      "id": "job-0001",
      "tenant": "acme",
      "title": "Ship the release notes",
      "priority": "normal",
      "state": "queued",
      "createdAt": "2026-01-01T09:00:00.000Z",
      "updatedAt": "2026-01-01T09:00:00.000Z",
      "note": null
    },
    {
      "id": "job-0002",
      "tenant": "acme",
      "title": "Rotate the signing key",
      "priority": "high",
      "state": "queued",
      "createdAt": "2026-01-01T09:05:00.000Z",
      "updatedAt": "2026-01-01T09:05:00.000Z",
      "note": null
    },
    {
      "id": "job-0003",
      "tenant": "globex",
      "title": "Archive last quarter's exports",
      "priority": "low",
      "state": "queued",
      "createdAt": "2026-01-01T09:10:00.000Z",
      "updatedAt": "2026-01-01T09:10:00.000Z",
      "note": null
    }
  ],
  "nextId": 4
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd fixtures/queuedesk && node --test tests/store.test.js`
Expected: PASS, 8 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add fixtures/queuedesk
git commit -m "$(cat <<'EOF'
feat: add the QueueDesk store with validated loads and atomic writes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Job rules

**Files:**
- Create: `fixtures/queuedesk/src/core/jobs.js`
- Test: `fixtures/queuedesk/tests/jobs.test.js`

**Interfaces:**
- Consumes: `fail` from `src/core/errors.js`; `assertJobVisible`, `assertRole` from `src/core/auth.js`.
- Produces: `formatJobId(sequence): string`, `orderJobs(jobs): Job[]`, `createJob(state, { actor, title, priority, now }): { state, job }`, `listJobs(state, { actor, stateFilter, allTenants }): Job[]`, `claimJob(state, { actor, now }): { state, job }`, `completeJob(state, { actor, jobId, note, now }): { state, job }`.

All functions are pure: they return a new state object and never mutate their input.

**Coverage constraint:** do not write a unit test that asserts what `orderJobs` returns, and do not write any test where `claim` or `complete` crosses tenants. Ordering is asserted through the command-level tests in Task 6. Both constraints come from the spec and are enforced by the fixture proof in Task 9.

- [ ] **Step 1: Write the failing job-rule tests**

`fixtures/queuedesk/tests/jobs.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd fixtures/queuedesk && node --test tests/jobs.test.js`
Expected: FAIL, cannot find module `../src/core/jobs.js`.

- [ ] **Step 3: Write the implementation**

`fixtures/queuedesk/src/core/jobs.js`:

```js
import { assertJobVisible, assertRole } from "./auth.js";
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

export function claimJob(state, { actor, now }) {
  const available = orderJobs(
    state.jobs.filter((job) => job.tenant === actor.id && job.state === "queued"),
  );
  const target = available[0];
  if (target === undefined) {
    throw fail("no_available_job", "no queued job available");
  }
  const claimed = { ...target, state: "claimed", updatedAt: now };
  return { state: replaceJob(state, claimed), job: claimed };
}

export function completeJob(state, { actor, jobId, note = null, now }) {
  const target = state.jobs.find((job) => job.id === jobId);
  assertJobVisible(actor, target, jobId);
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
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd fixtures/queuedesk && node --test tests/jobs.test.js`
Expected: PASS, 9 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add fixtures/queuedesk
git commit -m "$(cat <<'EOF'
feat: add QueueDesk job rules for creation, listing, claiming, and completion

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Output rendering

**Files:**
- Create: `fixtures/queuedesk/src/format/output.js`
- Test: `fixtures/queuedesk/tests/output.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `renderJob(job): string`, `renderJobList(jobs): string`, `renderJson(value): string`, `renderError(error): string`, `renderErrorJson(error): string`.

The renderer prints what it is given, in the order it is given. The `claim-order` overlay is the copy where sorting moves in here; the base must not sort.

**Coverage constraint:** no test in this file may depend on the order of the list it passes in, and no two jobs in a rendering test may have different priorities. The `claim-order` overlay makes this renderer sort, and an order-sensitive test here would turn that overlay's single expected failure into several.

- [ ] **Step 1: Write the failing rendering tests**

`fixtures/queuedesk/tests/output.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { renderError, renderErrorJson, renderJob, renderJobList, renderJson } from "../src/format/output.js";
import { fail } from "../src/core/errors.js";

const first = {
  id: "job-0001",
  tenant: "acme",
  title: "Ship the release notes",
  priority: "normal",
  state: "queued",
};
const second = { ...first, id: "job-0002", title: "Rotate the key" };

test("renders a single job on one line", () => {
  assert.equal(renderJob(first), "job-0001  queued  normal  Ship the release notes");
});

test("renders a table with a header and a plural footer", () => {
  assert.equal(
    renderJobList([first, second]),
    [
      "ID        STATE   PRIORITY  TITLE",
      "job-0001  queued  normal    Ship the release notes",
      "job-0002  queued  normal    Rotate the key",
      "2 jobs",
    ].join("\n"),
  );
});

test("uses the singular footer for one job", () => {
  assert.match(renderJobList([first]), /\n1 job$/u);
});

test("renders an empty list without a table", () => {
  assert.equal(renderJobList([]), "no jobs");
});

test("renders indented JSON", () => {
  assert.equal(renderJson({ id: "job-0001" }), '{\n  "id": "job-0001"\n}');
});

test("renders errors as a prefixed line and as JSON", () => {
  const error = fail("invalid_token", "invalid token for tenant acme");
  assert.equal(renderError(error), "queuedesk: invalid token for tenant acme");
  assert.deepEqual(JSON.parse(renderErrorJson(error)), {
    error: { code: "invalid_token", message: "invalid token for tenant acme" },
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd fixtures/queuedesk && node --test tests/output.test.js`
Expected: FAIL, cannot find module `../src/format/output.js`.

- [ ] **Step 3: Write the implementation**

`fixtures/queuedesk/src/format/output.js`:

```js
const COLUMNS = ["ID", "STATE", "PRIORITY", "TITLE"];

export function renderJob(job) {
  return [job.id, job.state, job.priority, job.title].join("  ");
}

export function renderJobList(jobs) {
  if (jobs.length === 0) {
    return "no jobs";
  }
  const rows = jobs.map((job) => [job.id, job.state, job.priority, job.title]);
  const widths = COLUMNS.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => row[index].length)),
  );
  const lines = [COLUMNS, ...rows].map((row) => renderRow(row, widths));
  lines.push(jobs.length === 1 ? "1 job" : `${jobs.length} jobs`);
  return lines.join("\n");
}

export function renderJson(value) {
  return JSON.stringify(value, null, 2);
}

export function renderError(error) {
  return `queuedesk: ${error.message}`;
}

export function renderErrorJson(error) {
  return JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2);
}

function renderRow(cells, widths) {
  return cells
    .map((cell, index) => cell.padEnd(widths[index]))
    .join("  ")
    .trimEnd();
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd fixtures/queuedesk && node --test tests/output.test.js`
Expected: PASS, 6 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add fixtures/queuedesk
git commit -m "$(cat <<'EOF'
feat: add QueueDesk output rendering for text and JSON

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Commands, entry point, and end-to-end tests

**Files:**
- Create: `fixtures/queuedesk/src/commands/create.js`, `list.js`, `claim.js`, `complete.js`
- Create: `fixtures/queuedesk/src/cli.js`
- Create: `fixtures/queuedesk/tests/helpers/harness.js`
- Test: `fixtures/queuedesk/tests/cli.test.js`

**Interfaces:**
- Consumes: `parseArgs`; `loadState`, `saveState`, `resolveDataPath`; `authenticate`; `createJob`, `listJobs`, `claimJob`, `completeJob`; the renderers; `QueueDeskError`.
- Produces: `runCreate`, `runList`, `runClaim`, `runComplete`, each `(options, { dataPath, now }) => Promise<Result>` where `Result` is `{ kind: "job", job }` or `{ kind: "jobs", jobs }`; and `main(argv, io): Promise<number>` where `io` is `{ stdout, stderr, env, now }`.

**Coverage constraint:** every claim and complete test uses data that belongs to one tenant only. Do not add a test that completes or claims across tenants — that gap is where the `tenant-leak` defect lives. Do not assert `createdAt` or `updatedAt` values.

- [ ] **Step 1: Write the test harness**

`fixtures/queuedesk/tests/helpers/harness.js`:

```js
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const fixtureRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const cliPath = join(fixtureRoot, "src", "cli.js");

export function job(overrides) {
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

export async function writeData(jobs, nextId = 9) {
  const directory = await mkdtemp(join(tmpdir(), "queuedesk-cli-"));
  const dataPath = join(directory, "queuedesk.json");
  await writeFile(
    dataPath,
    JSON.stringify(
      {
        version: 1,
        tenants: {
          acme: { token: "acme-token", role: "admin" },
          globex: { token: "globex-token", role: "worker" },
        },
        jobs,
        nextId,
      },
      null,
      2,
    ),
  );
  return dataPath;
}

export async function queuedesk(args, { env = {} } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
```

- [ ] **Step 2: Write the failing end-to-end tests**

`fixtures/queuedesk/tests/cli.test.js`:

```js
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
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `cd fixtures/queuedesk && node --test tests/cli.test.js`
Expected: FAIL, cannot find module `../src/cli.js`.

- [ ] **Step 4: Write the four commands**

`fixtures/queuedesk/src/commands/create.js`:

```js
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
```

`fixtures/queuedesk/src/commands/list.js`:

```js
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
```

`fixtures/queuedesk/src/commands/claim.js`:

```js
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
```

`fixtures/queuedesk/src/commands/complete.js`:

```js
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
```

- [ ] **Step 5: Write the entry point**

`fixtures/queuedesk/src/cli.js`:

```js
#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./args.js";
import { runClaim } from "./commands/claim.js";
import { runComplete } from "./commands/complete.js";
import { runCreate } from "./commands/create.js";
import { runList } from "./commands/list.js";
import { QueueDeskError } from "./core/errors.js";
import {
  renderError,
  renderErrorJson,
  renderJob,
  renderJobList,
  renderJson,
} from "./format/output.js";
import { resolveDataPath } from "./store/store.js";

const RUNNERS = {
  create: runCreate,
  list: runList,
  claim: runClaim,
  complete: runComplete,
};

export async function main(argv, io) {
  let json = argv.includes("--json");
  try {
    const options = parseArgs(argv);
    json = options.json;
    const dataPath = resolveDataPath(options.dataPath, io.env);
    const result = await RUNNERS[options.command](options, { dataPath, now: io.now });
    io.stdout.write(`${render(result, json)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof QueueDeskError)) {
      throw error;
    }
    io.stderr.write(`${json ? renderErrorJson(error) : renderError(error)}\n`);
    return error.exitCode;
  }
}

function render(result, json) {
  if (result.kind === "jobs") {
    return json ? renderJson(result.jobs) : renderJobList(result.jobs);
  }
  return json ? renderJson(result.job) : renderJob(result.job);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    now: () => new Date().toISOString(),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`queuedesk: unexpected failure: ${error.message}\n`);
      process.exitCode = 1;
    });
}
```

- [ ] **Step 6: Run the whole fixture suite and verify it passes**

Run: `cd fixtures/queuedesk && npm test`
Expected: PASS, 0 failures, roughly 50 assertions across 6 test files.

- [ ] **Step 7: Write the fixture documentation**

`fixtures/queuedesk/README.md`, containing exactly these sections: a one-paragraph description; a "Getting started" section showing `cp examples/queuedesk.sample.json ./queuedesk.json` followed by `node src/cli.js list --tenant acme --token acme-token`; a "Commands" section documenting `create`, `list`, `claim`, and `complete` with their flags; a "Data file" section describing `--data`, `QUEUEDESK_DATA`, and the default `./queuedesk.json`; an "Exit codes" table with `0` success, `1` usage error, `2` authorization failure, `3` invalid state transition, `4` storage failure; and a "Tests" section showing `npm test`.

`fixtures/queuedesk/DECISIONS.md`, one section per decision, each with a "Decision" line and a "Why" line:

1. **One JSON data file, not a directory per job.** The queue is small and offline; a single file keeps reads simple and makes an atomic replacement possible.
2. **Ordering belongs to the job rules.** `src/core/jobs.js` decides which job comes first, and the renderer prints what it receives. Two places deciding order would let listing and claiming disagree.
3. **Writes go through a temporary file and a rename.** A crash mid-write must never leave a half-written queue behind.
4. **Sequential zero-padded identifiers.** Output stays identical on every machine, which keeps tests and comparisons meaningful.
5. **An invisible job and a missing job answer alike.** Both produce `job_not_visible` with exit code `2`, so one tenant cannot discover whether another tenant's job exists.

- [ ] **Step 8: Verify the documentation matches the code**

Run: `cd fixtures/queuedesk && cp examples/queuedesk.sample.json /tmp/queuedesk-readme-check.json && node src/cli.js list --tenant acme --token acme-token --data /tmp/queuedesk-readme-check.json`
Expected: exit `0`, a table listing `job-0002` before `job-0001`, and the footer `2 jobs`.

- [ ] **Step 9: Commit**

```bash
git add fixtures/queuedesk
git commit -m "$(cat <<'EOF'
feat: complete QueueDesk with its commands, entry point, and documentation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Fixture composition script

**Files:**
- Create: `scripts/build-fixtures.mjs`
- Modify: `package.json`
- Modify: `eslint.config.js`
- Test: `tests/fixtures/build-fixtures.test.ts`

**Interfaces:**
- Consumes: nothing from the fixture.
- Produces: a script invoked as `node scripts/build-fixtures.mjs [--root <dir>] [--check]`. It reads `<root>/fixtures/overlays/*/overlay.json`, composes `<root>/fixtures/<base>` plus the overlay into `<root>/fixtures/<target>`, and in `--check` mode compares instead of writing. Exit `0` on success, `1` on drift or invalid input, with the reason on standard error.

- [ ] **Step 1: Write the failing composition tests**

`tests/fixtures/build-fixtures.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const run = promisify(execFile);
const script = join(import.meta.dirname, "../../scripts/build-fixtures.mjs");

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function build(root: string, extra: string[] = []): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, "--root", root, ...extra]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skillbench-fixtures-"));
  await mkdir(join(root, "fixtures/base/src"), { recursive: true });
  await writeFile(join(root, "fixtures/base/src/index.js"), "export const value = 1;\n");
  await writeFile(join(root, "fixtures/base/src/guard.js"), "export const guard = true;\n");
  await writeFile(join(root, "fixtures/base/README.md"), "# Base\n");
  return root;
}

async function createOverlay(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<void> {
  const directory = join(root, "fixtures/overlays", name);
  await mkdir(join(directory, "files"), { recursive: true });
  await writeFile(join(directory, "overlay.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(directory, "files", relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
}

test("composes a fixture that replaces and adds files", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "broken",
    { baseFixture: "base", target: "base-broken", description: "Replaces the index.", removals: [] },
    { "src/index.js": "export const value = 2;\n", "src/extra.js": "export const extra = true;\n" },
  );

  const outcome = await build(root);
  assert.equal(outcome.code, 0);
  assert.equal(await readFile(join(root, "fixtures/base-broken/src/index.js"), "utf8"), "export const value = 2;\n");
  assert.equal(await readFile(join(root, "fixtures/base-broken/src/extra.js"), "utf8"), "export const extra = true;\n");
  assert.equal(await readFile(join(root, "fixtures/base-broken/README.md"), "utf8"), "# Base\n");
});

test("honors removals", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "no-guard",
    { baseFixture: "base", target: "base-no-guard", description: "Drops the guard.", removals: ["src/guard.js"] },
    { "src/index.js": "export const value = 3;\n" },
  );

  assert.equal((await build(root)).code, 0);
  await assert.rejects(readFile(join(root, "fixtures/base-no-guard/src/guard.js"), "utf8"));
});

test("check mode passes on a freshly built tree and fails after a hand edit", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "broken",
    { baseFixture: "base", target: "base-broken", description: "Replaces the index.", removals: [] },
    { "src/index.js": "export const value = 2;\n" },
  );
  assert.equal((await build(root)).code, 0);
  assert.equal((await build(root, ["--check"])).code, 0);

  await writeFile(join(root, "fixtures/base-broken/src/index.js"), "export const value = 99;\n");
  const drift = await build(root, ["--check"]);
  assert.equal(drift.code, 1);
  assert.match(drift.stderr, /base-broken\/src\/index\.js/u);
});

test("check mode reports a composed fixture that was never built", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "broken",
    { baseFixture: "base", target: "base-broken", description: "Replaces the index.", removals: [] },
    { "src/index.js": "export const value = 2;\n" },
  );
  const missing = await build(root, ["--check"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /base-broken/u);
});

test("rejects a target outside the fixtures directory", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "escape",
    { baseFixture: "base", target: "../escaped", description: "Escapes.", removals: [] },
    { "src/index.js": "export const value = 2;\n" },
  );
  const outcome = await build(root);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /target/u);
});

test("rejects an unknown base fixture", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "absent",
    { baseFixture: "missing", target: "missing-broken", description: "No base.", removals: [] },
    { "src/index.js": "export const value = 2;\n" },
  );
  const outcome = await build(root);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /missing/u);
});

test("rejects a symbolic link in an overlay", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "linked",
    { baseFixture: "base", target: "base-linked", description: "Contains a link.", removals: [] },
    { "src/index.js": "export const value = 2;\n" },
  );
  await symlink("/etc/hosts", join(root, "fixtures/overlays/linked/files/src/link.js"));
  const outcome = await build(root);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /symbolic link/u);
});

test("rejects a removal that names no file in the base", async () => {
  const root = await createRoot();
  await createOverlay(
    root,
    "phantom",
    { baseFixture: "base", target: "base-phantom", description: "Removes nothing.", removals: ["src/absent.js"] },
    { "src/index.js": "export const value = 2;\n" },
  );
  const outcome = await build(root);
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /src\/absent\.js/u);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --import tsx --test tests/fixtures/build-fixtures.test.ts`
Expected: FAIL, cannot find `scripts/build-fixtures.mjs`.

- [ ] **Step 3: Write the composition script**

`scripts/build-fixtures.mjs`:

```js
#!/usr/bin/env node
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";

const FIXTURES = "fixtures";
const OVERLAYS = "overlays";

async function main(argv) {
  const options = parseOptions(argv);
  const overlaysDirectory = join(options.root, FIXTURES, OVERLAYS);
  const names = (await readdir(overlaysDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    const overlay = await readOverlay(options.root, name);
    const composed = await compose(options.root, overlay);
    if (options.check) {
      await verify(options.root, overlay, composed);
    } else {
      const target = join(options.root, FIXTURES, overlay.target);
      await rm(target, { recursive: true, force: true });
      await cp(composed, target, { recursive: true, dereference: false, verbatimSymlinks: true });
      process.stdout.write(`composed ${FIXTURES}/${overlay.target}\n`);
    }
    await rm(composed, { recursive: true, force: true });
  }
  if (options.check) {
    process.stdout.write(`verified ${String(names.length)} composed fixtures\n`);
  }
}

function parseOptions(argv) {
  const options = { root: process.cwd(), check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") {
      options.check = true;
      continue;
    }
    if (argv[index] === "--root") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--root needs a directory");
      }
      options.root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

async function readOverlay(root, name) {
  const directory = join(root, FIXTURES, OVERLAYS, name);
  const manifest = JSON.parse(await readFile(join(directory, "overlay.json"), "utf8"));
  for (const field of ["baseFixture", "target", "description"]) {
    if (typeof manifest[field] !== "string" || manifest[field] === "") {
      throw new Error(`overlay ${name} has no ${field}`);
    }
  }
  const removals = manifest.removals ?? [];
  if (!Array.isArray(removals) || removals.some((entry) => typeof entry !== "string")) {
    throw new Error(`overlay ${name} has a malformed removals list`);
  }
  assertInsideFixtures(root, manifest.baseFixture, `overlay ${name} base`);
  assertInsideFixtures(root, manifest.target, `overlay ${name} target`);
  return { name, directory, ...manifest, removals };
}

function assertInsideFixtures(root, candidate, label) {
  const fixtures = join(root, FIXTURES);
  const resolved = resolve(fixtures, candidate);
  const inside = resolved.startsWith(fixtures + sep) && relative(fixtures, resolved).split(sep).length === 1;
  if (!inside) {
    throw new Error(`${label} must name one directory inside ${FIXTURES}/: ${candidate}`);
  }
}

async function compose(root, overlay) {
  const base = join(root, FIXTURES, overlay.baseFixture);
  if (!(await isDirectory(base))) {
    throw new Error(`overlay ${overlay.name} names a missing base fixture: ${overlay.baseFixture}`);
  }
  await assertNoSymbolicLinks(base, overlay.baseFixture);

  const files = join(overlay.directory, "files");
  if (!(await isDirectory(files))) {
    throw new Error(`overlay ${overlay.name} has no files directory`);
  }
  await assertNoSymbolicLinks(files, `overlay ${overlay.name}`);

  const staging = await mkdtemp(join(tmpdir(), "skillbench-compose-"));
  const composed = join(staging, overlay.target);
  await mkdir(composed, { recursive: true });
  await cp(base, composed, { recursive: true, dereference: false, verbatimSymlinks: true });

  for (const removal of overlay.removals) {
    const target = join(composed, removal);
    if (!(await exists(target))) {
      throw new Error(`overlay ${overlay.name} removes a path that the base does not have: ${removal}`);
    }
    await rm(target, { recursive: true });
  }

  await cp(files, composed, { recursive: true, dereference: false, verbatimSymlinks: true });
  return composed;
}

async function verify(root, overlay, composed) {
  const target = join(root, FIXTURES, overlay.target);
  if (!(await isDirectory(target))) {
    throw new Error(`composed fixture ${FIXTURES}/${overlay.target} is missing; run npm run fixtures:build`);
  }
  const expected = await listFiles(composed);
  const actual = await listFiles(target);

  for (const path of new Set([...expected.keys(), ...actual.keys()])) {
    const left = expected.get(path);
    const right = actual.get(path);
    if (left === undefined) {
      throw new Error(`${FIXTURES}/${overlay.target}/${path} is not produced by its overlay; run npm run fixtures:build`);
    }
    if (right === undefined) {
      throw new Error(`${FIXTURES}/${overlay.target}/${path} is missing; run npm run fixtures:build`);
    }
    if (!left.equals(right)) {
      throw new Error(`${FIXTURES}/${overlay.target}/${path} differs from its overlay; run npm run fixtures:build`);
    }
  }
}

async function listFiles(root, prefix = "", collected = new Map()) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await listFiles(root, relativePath, collected);
      continue;
    }
    collected.set(relativePath, await readFile(join(root, relativePath)));
  }
  return collected;
}

async function assertNoSymbolicLinks(root, label, prefix = "") {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const status = await lstat(join(root, relativePath));
    if (status.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link: ${relativePath}`);
    }
    if (status.isDirectory()) {
      await assertNoSymbolicLinks(root, label, relativePath);
    }
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`build-fixtures: ${error.message}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Wire the npm scripts**

In `package.json`, add to `scripts`:

```json
"fixtures:build": "node scripts/build-fixtures.mjs",
"fixtures:check": "node scripts/build-fixtures.mjs --check"
```

and change `check` to:

```json
"check": "npm run fixtures:check && npm run lint && npm run typecheck && npm test"
```

and change `lint` to:

```json
"lint": "eslint src tests scripts fixtures"
```

- [ ] **Step 5: Extend the lint configuration**

In `eslint.config.js`, append this block as the last entry of the exported configuration:

```js
  {
    files: ["scripts/**/*.mjs", "fixtures/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { projectService: false, project: null },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        structuredClone: "readonly",
        setTimeout: "readonly",
      },
    },
  },
```

- [ ] **Step 6: Run the tests and the linter**

Run: `node --import tsx --test tests/fixtures/build-fixtures.test.ts` then `npm run lint`
Expected: the composition tests pass, and `eslint src tests scripts fixtures` reports no errors. If the linter cannot parse the fixture files, fix the block from Step 5 rather than narrowing the lint targets.

- [ ] **Step 7: Commit**

```bash
git add scripts/build-fixtures.mjs tests/fixtures/build-fixtures.test.ts package.json eslint.config.js
git commit -m "$(cat <<'EOF'
feat: compose and verify fixture overlays with a build script

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The four defect overlays

**Files:**
- Create: `fixtures/overlays/claim-order/overlay.json` and `files/src/core/jobs.js`, `files/src/format/output.js`
- Create: `fixtures/overlays/tenant-leak/overlay.json` and `files/src/core/jobs.js`
- Create: `fixtures/overlays/unsafe-write/overlay.json` and `files/src/store/store.js`
- Create: `fixtures/overlays/stale-timestamp/overlay.json` and `files/src/core/jobs.js`
- Create: `fixtures/queuedesk-claim-order/`, `fixtures/queuedesk-tenant-leak/`, `fixtures/queuedesk-unsafe-write/`, `fixtures/queuedesk-stale-timestamp/` (all produced by the build script, never by hand)

**Interfaces:**
- Consumes: `scripts/build-fixtures.mjs` from Task 7 and the base fixture from Tasks 1-6.
- Produces: four composed fixtures whose behavior Task 9 asserts.

Each overlay file starts as an exact copy of the base file and then receives one change. Copy the base file first, then apply the change shown below; do not retype the file.

- [ ] **Step 1: Write the claim-order overlay**

`fixtures/overlays/claim-order/overlay.json`:

```json
{
  "baseFixture": "queuedesk",
  "target": "queuedesk-claim-order",
  "description": "Ordering lives in the renderer, so claim hands out the oldest job instead of the most important one.",
  "removals": []
}
```

In `fixtures/overlays/claim-order/files/src/core/jobs.js`, copy the base `src/core/jobs.js` and replace the body of `orderJobs`, leaving the rest untouched:

```js
export function orderJobs(jobs) {
  // Presentation decides the order; the rules keep insertion order.
  return [...jobs];
}
```

`PRIORITY_ORDER` is then unused in this file, so delete that constant to keep the file lint-clean.

In `fixtures/overlays/claim-order/files/src/format/output.js`, copy the base `src/format/output.js` and add the sorting the renderer now owns:

```js
const COLUMNS = ["ID", "STATE", "PRIORITY", "TITLE"];
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

function byPriority(jobs) {
  return [...jobs].sort((left, right) => {
    const difference = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
    return difference !== 0 ? difference : left.id.localeCompare(right.id);
  });
}
```

and change the first lines of `renderJobList` to sort before measuring:

```js
export function renderJobList(unordered) {
  const jobs = byPriority(unordered);
  if (jobs.length === 0) {
    return "no jobs";
  }
```

- [ ] **Step 2: Write the tenant-leak overlay**

`fixtures/overlays/tenant-leak/overlay.json`:

```json
{
  "baseFixture": "queuedesk",
  "target": "queuedesk-tenant-leak",
  "description": "Claim and complete find a job by identifier without checking which tenant owns it.",
  "removals": []
}
```

In `fixtures/overlays/tenant-leak/files/src/core/jobs.js`, copy the base file and make two changes. In `claimJob`, drop the tenant condition:

```js
  const available = orderJobs(state.jobs.filter((job) => job.state === "queued"));
```

In `completeJob`, replace the visibility check with a bare existence check:

```js
  const target = state.jobs.find((job) => job.id === jobId);
  if (target === undefined) {
    throw fail("job_not_visible", `no job ${jobId} for tenant ${actor.id}`);
  }
```

The import of `assertJobVisible` is then unused; change the import to `import { assertRole } from "./auth.js";` so the file stays lint-clean.

- [ ] **Step 3: Write the unsafe-write overlay**

`fixtures/overlays/unsafe-write/overlay.json`:

```json
{
  "baseFixture": "queuedesk",
  "target": "queuedesk-unsafe-write",
  "description": "Saving overwrites the data file in place, so an interrupted write truncates the queue.",
  "removals": []
}
```

In `fixtures/overlays/unsafe-write/files/src/store/store.js`, copy the base file and replace `saveState`:

```js
export async function saveState(path, state) {
  try {
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch (cause) {
    throw fail("storage_write_failed", `cannot write data file ${path}: ${cause.code ?? "unknown error"}`);
  }
}
```

`randomBytes`, `rename`, and `unlink` become unused; drop them from the imports so the file stays lint-clean.

- [ ] **Step 4: Write the stale-timestamp overlay**

`fixtures/overlays/stale-timestamp/overlay.json`:

```json
{
  "baseFixture": "queuedesk",
  "target": "queuedesk-stale-timestamp",
  "description": "Claiming a job leaves updatedAt at its creation value.",
  "removals": []
}
```

In `fixtures/overlays/stale-timestamp/files/src/core/jobs.js`, copy the base file and change one line in `claimJob`:

```js
  const claimed = { ...target, state: "claimed" };
```

`now` is still a declared parameter of `claimJob` and stays in the signature, because `completeJob` and the callers keep using it.

- [ ] **Step 5: Compose the fixtures**

Run: `npm run fixtures:build`
Expected: four `composed fixtures/queuedesk-<name>` lines and exit `0`.

- [ ] **Step 6: Verify each composed fixture behaves as the spec says**

Run each of these and compare with the expectation:

```bash
cd fixtures/queuedesk-tenant-leak && npm test; cd -
cd fixtures/queuedesk-unsafe-write && npm test; cd -
cd fixtures/queuedesk-stale-timestamp && npm test; cd -
cd fixtures/queuedesk-claim-order && npm test; cd -
```

Expected: the first three pass with zero failures. The fourth fails with exactly one failing test, `claim takes the highest priority queued job first`. If any other test fails, the overlay is wrong or the base suite reaches into one of the four documented gaps; fix the overlay or the base test, not the expectation.

- [ ] **Step 7: Confirm the drift check is clean**

Run: `npm run fixtures:check`
Expected: `verified 4 composed fixtures` and exit `0`.

- [ ] **Step 8: Commit**

```bash
git add fixtures
git commit -m "$(cat <<'EOF'
feat: add the four QueueDesk defect overlays and their composed fixtures

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Fixture proof

**Files:**
- Test: `tests/fixtures/queuedesk.test.ts`

**Interfaces:**
- Consumes: the composed fixtures from Task 8.
- Produces: the assertion that the fixture family keeps its documented pass and failure picture.

- [ ] **Step 1: Write the proof test**

`tests/fixtures/queuedesk.test.ts`:

```ts
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const run = promisify(execFile);
const repositoryRoot = join(import.meta.dirname, "../..");

interface SuiteOutcome {
  readonly passed: number;
  readonly failed: number;
  readonly output: string;
}

async function runFixtureSuite(fixture: string): Promise<SuiteOutcome> {
  const cwd = join(repositoryRoot, "fixtures", fixture);
  let output: string;
  try {
    const result = await run(process.execPath, ["--test", "--test-reporter=tap"], { cwd });
    output = result.stdout;
  } catch (error) {
    output = (error as { stdout?: string }).stdout ?? "";
  }
  return {
    passed: readCount(output, "pass"),
    failed: readCount(output, "fail"),
    output,
  };
}

function readCount(output: string, label: string): number {
  const match = new RegExp(`^# ${label} (\\d+)$`, "mu").exec(output);
  assert.notEqual(match, null, `the ${label} summary line is missing from the reporter output`);
  return Number(match?.[1]);
}

test("the base fixture suite is green", async () => {
  const outcome = await runFixtureSuite("queuedesk");
  assert.equal(outcome.failed, 0);
  assert.ok(outcome.passed >= 40, `expected a dense suite, saw ${String(outcome.passed)} passing tests`);
});

for (const fixture of ["queuedesk-tenant-leak", "queuedesk-unsafe-write", "queuedesk-stale-timestamp"]) {
  test(`the ${fixture} defect stays invisible to the public suite`, async () => {
    const outcome = await runFixtureSuite(fixture);
    assert.equal(outcome.failed, 0, outcome.output);
  });
}

test("the queuedesk-claim-order defect shows exactly one failing test", async () => {
  const outcome = await runFixtureSuite("queuedesk-claim-order");
  assert.equal(outcome.failed, 1, outcome.output);
  assert.match(outcome.output, /not ok \d+ - claim takes the highest priority queued job first/u);
});
```

- [ ] **Step 2: Run the proof test**

Run: `node --import tsx --test tests/fixtures/queuedesk.test.ts`
Expected: PASS, 5 tests, 0 failures. If the base suite reports fewer than 40 passing tests, the earlier tasks dropped coverage; restore it rather than lowering the threshold.

- [ ] **Step 3: Run the whole project check**

Run: `npm run check`
Expected: PASS. Note the added wall-clock time; if the fixture suites dominate the run, report it rather than removing the proof.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/queuedesk.test.ts
git commit -m "$(cat <<'EOF'
test: prove the QueueDesk fixtures keep their documented outcomes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Project documentation and the stage gate

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documentation that matches the delivered behavior, and a verified stage gate.

- [ ] **Step 1: Update `AGENTS.md`**

In "Current State", replace the Stage 3 sentences so they read: Stage 1, Stage 2A, Stage 2B, Stage 3, and Stage 4 are complete; the QueueDesk fixture and its four defect copies are committed under `fixtures/`; there are still no public cases, variants, or oracles, so `validate --public-only` reports `0` cases and `0` variants; the next delivery stage is Stage 5, the public case suite and its private oracles.

In "Development Record", add: Stage 4 development used the isolated worktree `.worktrees/stage4-queuedesk-fixture` on branch `stage4-queuedesk-fixture`.

In "Technology and Commands", add `npm run fixtures:build` and `npm run fixtures:check`, and note that `npm run check` verifies the composed fixtures before linting.

In "Architecture", add: `fixtures/queuedesk/` is the QueueDesk base fixture, a dependency-free JavaScript ESM command-line application with its own public test suite; `fixtures/overlays/<name>/` holds defect overlays as `overlay.json` plus the files they change; `fixtures/queuedesk-<name>/` are composed fixtures produced only by `scripts/build-fixtures.mjs`; and `tests/fixtures/` proves both the composition script and the fixtures' documented pass and failure picture.

In "Non-Negotiable Rules", add: never hand-edit a composed fixture, and never write a public QueueDesk test that observes cross-tenant `claim` or `complete`, an interrupted write, a timestamp value, or `orderJobs` directly, because the seeded defects live in exactly those gaps.

- [ ] **Step 2: Update `README.md`**

Add a "QueueDesk fixture" section to the English half, placed after the existing description of the repository layout, covering: what QueueDesk is; that `fixtures/queuedesk/` is the base project agents work on; that `fixtures/queuedesk-<name>/` are composed copies carrying one seeded defect each, built by `npm run fixtures:build` and verified by `npm run fixtures:check`; and that composed copies are never edited by hand. Add the same content, translated, in the matching position of the Russian half.

- [ ] **Step 3: Verify the documentation claims**

Run: `npm run fixtures:check && npm run check && npm run build && node dist/src/cli.js validate --project . --public-only; echo "exit: $?"`
Expected: every command passes, the validate output reports `0` cases and `0` variants, and the final line reads `exit: 0`.

- [ ] **Step 4: Confirm the build ignores the fixture**

Run: `ls dist/ && ls dist/src`
Expected: no `fixtures` directory anywhere under `dist/`. If the fixture was compiled, exclude `fixtures` in `tsconfig.json` and re-run `npm run build`.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md README.md
git commit -m "$(cat <<'EOF'
docs: record the QueueDesk fixture in the project memory and guide

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

Spec coverage: the application (Tasks 1-6), documentation inside the fixture (Task 6), the public suite and its four coverage gaps (Tasks 1-6 constraints, enforced by Task 9), the overlays and composition tooling (Tasks 7-8), the fixture proof (Task 9), lint and script wiring (Task 7), project documentation and the delivery gate (Task 10).

Names used across tasks and kept consistent: `fail`, `EXIT_CODES`, `QueueDeskError.exitCode`, `parseArgs`, `authenticate`, `assertRole`, `assertJobVisible`, `resolveDataPath`, `loadState`, `saveState`, `STORE_VERSION`, `DEFAULT_DATA_PATH`, `formatJobId`, `orderJobs`, `createJob`, `listJobs`, `claimJob`, `completeJob`, `renderJob`, `renderJobList`, `renderJson`, `renderError`, `renderErrorJson`, `runCreate`, `runList`, `runClaim`, `runComplete`, `main`.

The one test name that the fixture proof matches exactly is `claim takes the highest priority queued job first`, defined in Task 6 and asserted in Task 9. Renaming it requires updating both places.
