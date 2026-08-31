# SkillBench Stage 4 QueueDesk Fixture Design

## Purpose

SkillBench can execute a full run pipeline, but it has nothing to run against.
This stage delivers QueueDesk: the offline JavaScript project that every public
case will use as its starting repository, its public test suite, and four
deliberately defective copies that later cases need.

QueueDesk is the subject of the benchmark, not part of the benchmark engine. The
agent under measurement reads its source, its tests, and its documentation, and
edits it as if it were an ordinary small project. Everything committed in this
stage is therefore public material written in concise international English.

This stage adds no case, variant, or oracle. After it, `validate --public-only`
still reports `0` cases and `0` variants, because a fixture only becomes
reachable when a case manifest references it in Stage 5.

## Scope

In scope:

- the QueueDesk base application: four commands, layered source, ~800 lines;
- its public test suite, run with `node --test`;
- its own `README.md` and `DECISIONS.md`;
- four defect overlays and the composed fixtures built from them;
- `scripts/build-fixtures.mjs`, which composes and verifies those fixtures;
- a SkillBench test that proves the base suite is green and each composed
  fixture behaves exactly as documented;
- lint coverage for plain JavaScript under `scripts/` and `fixtures/`;
- `README.md` and `AGENTS.md` updates.

Out of scope: case manifests, prompt text, private oracles, variants, and any
change to the run pipeline, the adapter boundary, or the CLI commands.

## The QueueDesk Application

QueueDesk is an offline multi-tenant job queue. It uses only the Node.js
standard library, stores state in one JSON file, and ships no dependencies.

### Command surface

Every command names its caller with `--tenant <id>` and `--token <secret>`. The
data file comes from `--data <path>`, or `QUEUEDESK_DATA`, or the default
`./queuedesk.json`. Every command accepts `--json`.

| Command | Behavior |
|---|---|
| `create --title <text> [--priority low\|normal\|high]` | Adds a queued job owned by the calling tenant. Prints the new job. |
| `list [--state <state>] [--all-tenants]` | Lists the calling tenant's jobs, highest priority first, oldest first within a priority. `--all-tenants` requires the `admin` role. |
| `claim` | Claims the next available job for the calling tenant and marks it `claimed`. |
| `complete <job-id> [--note <text>]` | Marks a claimed job `done`. |

### Data model

The store file holds a version, a tenant table, and a job list:

```json
{
  "version": 1,
  "tenants": { "acme": { "token": "acme-token", "role": "admin" } },
  "jobs": [
    {
      "id": "job-0001",
      "tenant": "acme",
      "title": "Ship the release notes",
      "priority": "normal",
      "state": "queued",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "note": null
    }
  ],
  "nextId": 2
}
```

Job identifiers are sequential and zero-padded, so output is stable across
machines. Timestamps come from a single clock seam so tests can inject a fixed
clock.

### States

`queued → claimed → done`. Any other transition is rejected as a distinct
error, never as a generic failure. A job can be claimed only while `queued`,
and completed only while `claimed` and only by the tenant that claimed it.

### Layers

| File | Responsibility |
|---|---|
| `src/cli.js` | Entry point: parse, dispatch, render, exit |
| `src/args.js` | Flag parsing and usage errors |
| `src/commands/create.js`, `list.js`, `claim.js`, `complete.js` | One thin command each |
| `src/core/jobs.js` | Job rules: creation, ordering, allowed transitions |
| `src/core/auth.js` | Tenant, token, role resolution and permission checks |
| `src/core/errors.js` | Typed errors, each carrying its exit code |
| `src/store/store.js` | Load and save: version check, atomic write |
| `src/format/output.js` | Human-readable and `--json` rendering |

Dependencies point in one direction: `cli.js → commands → core → store`, with
`format` used only by `cli.js` and the commands. Ordering, authorization, and
transition rules live in `core` and nowhere else. That rule is what makes the
`claim-order` defect a structural defect rather than a typo.

### Exit codes

This table is the compatibility contract that a later case must preserve.

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Usage error: unknown command, missing or invalid flag |
| `2` | Authorization failure: unknown tenant, wrong token, insufficient role |
| `3` | Invalid state transition, including claiming an already claimed job |
| `4` | Storage failure: missing, unreadable, or unsupported data file |

Three mappings need to be explicit, because later oracles depend on them:

- a job identifier that the calling tenant cannot see, whether it does not
  exist or belongs to another tenant, produces the same authorization failure,
  code `2`. Refusing to distinguish the two is a recorded decision, not an
  oversight, and it is the behavior the `tenant-leak` overlay breaks;
- a malformed identifier is a usage error, code `1`;
- `claim` with no available job is code `3`, with the message
  `no queued job available`.

Errors print a single line to standard error in the form
`queuedesk: <message>`. With `--json`, errors print
`{"error": {"code": "<slug>", "message": "<text>"}}` to standard error instead.

### Documentation inside the fixture

`README.md` explains how to run QueueDesk, lists the commands, and states the
exit codes. `DECISIONS.md` records decisions with their reasons: one JSON file
instead of a directory per job, ordering owned by the job rules rather than the
renderer, atomic writes through a temporary file and a rename, and identifiers
generated sequentially. Stage 5 builds the design-coherence case and the
`spec_drift` metric on this file.

## Public Test Suite

Tests live in `fixtures/queuedesk/tests/`, run with `node --test`, and use only
`node:test` and `node:assert/strict`. `package.json` declares
`"test": "node --test"` and no dependencies.

Two levels:

- unit tests over `args`, `core/jobs`, `core/auth`, `store`, and `format`;
- command-level tests that spawn `node src/cli.js` in a temporary data
  directory and assert stdout, stderr, and exit code.

Coverage is dense over documented behavior: every command, both output formats,
and all five exit codes. 56 tests.

### Three deliberate coverage gaps

Dense coverage and latent defects conflict unless the gaps are chosen on
purpose. These three are natural gaps that real suites have, and the seeded
defects live inside them:

1. `claim` and `complete` are exercised only within the acting tenant, so
   cross-tenant lookup is never observed;
2. an interrupted write cannot be provoked without a filesystem fault
   injection the public suite does not have;
3. timestamps are never asserted, because they differ between runs.

A fourth constraint follows from the same reasoning: job ordering is asserted
end to end, through `list` output and through which job `claim` returns, and
never through a direct unit test of `orderJobs`. The `claim-order` overlay moves
ordering from the job rules into the renderer, so a direct unit test would turn
that overlay's single expected failure into several.

The gaps are documented in this spec and enforced by the fixture proof test
described below. They are not documented inside the fixture, where they would
read as a hint.

## Defect Overlays

The base fixture is clean. Each defect lives in an overlay that carries only the
files it changes.

| Overlay | Defect | Base suite at baseline | Stage 5 case |
|---|---|---|---|
| `claim-order` | `claim` returns the oldest queued job instead of the highest priority one, because ordering was implemented in `format/output.js` and `core/jobs.js` returns insertion order. A symptom patch adds a second sort inside `commands/claim.js`; the real fix moves ordering into `core/jobs.js`. | one named failing test, the visible symptom | `B01` |
| `tenant-leak` | `claim` and `complete` look up a job by identifier without comparing its tenant, so one tenant can complete another tenant's job. | green | `B02` |
| `unsafe-write` | `store.saveState` writes over the data file directly instead of writing a temporary file and renaming it. An interrupted write truncates stored JSON. Loading still validates, so only the write path differs. | green | `B03` |
| `stale-timestamp` | `updatedAt` is not refreshed when a job is claimed. A harmless nearby wart that a tidy agent wants to fix without being asked. | green | `R02` |

### Storage and composition

```text
fixtures/queuedesk/                 base application, used directly by clean cases
fixtures/overlays/<overlay>/        overlay.json plus the changed files
fixtures/queuedesk-<overlay>/       composed fixture, committed
scripts/build-fixtures.mjs          composition and drift verification
```

An overlay directory contains `overlay.json` and a `files/` tree:

```json
{
  "baseFixture": "queuedesk",
  "target": "queuedesk-tenant-leak",
  "description": "Job lookup in claim and complete ignores the tenant.",
  "removals": []
}
```

`files/` is copied over a fresh copy of the base, replacing or adding paths.
`removals` lists base-relative paths to delete; it exists because a defect may
have to remove a guard file, and it stays empty for the four overlays here.

The composed fixtures are committed because a case manifest pins a fixture's
content hash, and a fresh clone must validate without running a build step.
Nothing inside a composed fixture marks it as generated: the agent under
measurement sees those files as its own project, so a marker would be a hint.
Hand edits are prevented by verification, not by a notice.

- `npm run fixtures:build` composes every overlay into its target directory.
- `npm run fixtures:check` composes into a temporary directory and compares the
  result with the committed tree, failing on any difference.
- `npm run check` runs `fixtures:check`.

Composition is deterministic: file contents and modes are copied, symbolic links
are rejected, and the target directory is replaced rather than merged into.

## Fixture Proof

`tests/fixtures/queuedesk.test.ts` runs the fixture suites through
`node --test` and asserts the documented outcome:

- the base fixture passes with zero failures;
- `tenant-leak`, `unsafe-write`, and `stale-timestamp` pass with zero failures,
  which proves their defects stay latent;
- `claim-order` fails with exactly one failing test, matched by name.

This is both the proof that the fixture works and the guard on the three
coverage gaps: if a later edit makes a latent defect observable to the public
suite, the assertion turns red. The suites run offline and add roughly ten to
twenty seconds to `npm run check`.

## Tooling Changes

`package.json` gains `fixtures:build` and `fixtures:check`, and `check` calls
`fixtures:check` before linting.

`lint` becomes `eslint src tests scripts fixtures`. The ESLint configuration
gains a block for plain JavaScript files that applies the recommended rules
without the type-checked rules, since fixture and script files are not part of
the TypeScript program. This closes the Stage 3 note that `scripts/` was not
linted. The TypeScript program is unchanged: `fixtures/` is not compiled.

## Testing Strategy

QueueDesk itself is developed test-first: each layer's tests are written before
its implementation, and the command-level tests are written against the exit
code table above.

SkillBench-side tests added in this stage:

- the fixture proof described above;
- unit tests for the composition script: an overlay replaces a file, adds a
  file, honors `removals`, rejects an overlay whose target escapes `fixtures/`,
  rejects a symbolic link, and reports drift in check mode.

Everything is deterministic and offline. No test in this stage touches a live
runtime.

## Delivery Gate

- `npm run check` and `npm run build` pass;
- `node dist/src/cli.js validate --project . --public-only` exits `0` and still
  reports `0` cases and `0` variants;
- `npm run fixtures:check` reports no drift;
- the fixture proof shows the documented pass and failure picture.

## Documentation

`README.md` gains a QueueDesk section in the English half and the same content
in the Russian half. `AGENTS.md` records the new current state, the fixture and
overlay layout, the new commands, and the Stage 4 worktree.
