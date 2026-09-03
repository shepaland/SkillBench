# SkillBench Stage 5B Design: Tamper-Proof Grading and Six Code-Graded Cases

## Purpose

Stage 5A delivered the oracle toolkit and one worked case. Its final review
reproduced an attack the toolkit cannot detect: a check runs code the measured
agent wrote, that code knows the absolute path of the workspace it was written
in, and it can repair the workspace, let a later check read the tidy tree, and
restore the damage byte for byte before grading ends. Both post-grade guards
compare an end state with a start state, so a net-zero change is invisible to
them.

Stage 5B closes that gap by changing what a check is allowed to see, and then
applies the fixed shape to six more cases. After this stage the catalog holds
seven cases and covers correctness, regression safety, tenant isolation,
compatibility, refactoring, and scope precision.

## Scope

In scope:

- grading from frozen evidence and from disposable per-check copies, replacing
  the live workspace as the thing a check reads;
- a public test that reproduces the Stage 5A attack and requires the scope
  assertion to stay red;
- the recorded command-line contract battery and the private script that
  generates it;
- six cases — `B02`, `B03`, `R02`, `F01`, `F04`, `R01` — with their oracles,
  their proof patches, and their manifests;
- `AGENTS.md` and `README.md` updates, including the removal of a rule this
  stage makes unnecessary.

Out of scope: comparison statistics, reports, the pilot, the five dialogue
cases of Stage 5C, and the three skill variants. The public case schema, the
CLI command set, and the adapter boundary do not change.

The Stage 5 design states that a change to the run pipeline is raised before it
is made. This document is that notice: the grading step of `executeRun` changes,
and so does the environment contract between SkillBench and an oracle check.

## Part 1 — Grading From Frozen Evidence

### The attack, restated

An oracle check reaches the agent's work in one of three ways: it runs
`node src/cli.js` as a child process, it runs `node --test` over the project, or
it imports the project's modules into its own process. All three execute code
the agent authored. That code can spawn a detached process, and the agent knew
the workspace path while it was working, so the detached process can wait for
the last check to finish and put back whatever a helpful earlier repair removed.
The oracle-hash guard and the workspace-snapshot guard both compare the state
after grading with the state before it, and a repair that is undone leaves both
comparisons equal.

The defect is not in the guards. It is in the premise that the tree a check
reads is the same tree the agent's code can reach.

### The new premise

A check never receives the workspace. It receives two things instead:

- **an evidence directory**, holding a description of the workspace recorded
  before any check ran, and
- **its own disposable copy** of the workspace, created for that check alone and
  destroyed when the check ends.

Nothing a check does can change what another check sees, and nothing a check
does can change what the evidence says, because the evidence was written before
the first check started.

### Evidence

At the `grade` step, before the oracle is mounted, `executeRun` writes the
already-computed final snapshot to a fresh directory outside the workspace:

```json
{
  "schemaVersion": 1,
  "files": {
    "DECISIONS.md": "sha256:…",
    "src/core/jobs.js": "sha256:…"
  }
}
```

The map is the serialized `TreeSnapshot` that the `final_snapshot` step already
produces, so evidence and the run's own change set can never disagree. Paths are
relative and sorted; the file is written with canonical JSON so its bytes are
reproducible.

`snapshotTree` rejects symbolic links and irregular entries, which means a
workspace containing one errors the run at `final_snapshot`, before grading. That
is today's behavior and this stage keeps it. The evidence file therefore
describes regular files only, and the marker handling in the current scope check
disappears with the live-tree walk it belonged to.

The evidence directory is separate from the grading directory on purpose: the
grading directory's hash is frozen in the run manifest and compared before and
after the checks, so a per-run file cannot live inside it.

### The reference tree and per-check copies

Also at the `grade` step, `executeRun` copies the workspace once into a fresh
temporary directory — the **reference tree** — and verifies that the copy matches
the frozen snapshot. The path is a fresh `mkdtemp` the agent has never seen. From
that moment the real workspace is never read again by grading.

`runOracle` then, for each check in turn:

1. verifies the reference tree still matches the frozen snapshot;
2. copies the reference tree into a fresh directory for this check;
3. runs the check with `SKILLBENCH_WORKSPACE` pointing at that copy;
4. removes the copy, whatever the outcome.

Step 1 is what makes a repair-and-restore attack useless. Under the old shape the
attacker only had to be tidy by the end. Now the tree that feeds check *N* is
built at the moment check *N* starts, from a tree SkillBench has just verified, so
a repair has to be present in the reference tree exactly when SkillBench looks at
it — and a repair that is present when SkillBench looks is a mismatch, which
errors the run at the `grade` step.

Copying costs little: QueueDesk is 22 files, and a case runs four or five checks.

### Environment contract

A check receives exactly three SkillBench variables:

| Variable | Meaning |
|---|---|
| `SKILLBENCH_WORKSPACE` | this check's own disposable copy of the agent's project |
| `SKILLBENCH_ORACLE` | the mounted grading directory |
| `SKILLBENCH_EVIDENCE` | the directory holding `workspace.json` |

The shared helper keeps doing what it does today: it reads all three when it
loads, deletes them from `process.env` before the check's first line, and hands
every child process an environment without them.

`SKILLBENCH_WORKSPACE` keeps its name because it keeps its role — the project a
check runs and reads. What changes is that it is now disposable, which retires
`copyProject` and the "a check never writes into the workspace" rule that
existed to protect the shared tree. A check may now write into its own copy
freely; the regression check, which today deletes the workspace's `tests/` inside
a scratch copy, does that directly.

### What this removes

- **The declaration-order convention.** `AGENTS.md` requires every case to declare
  its integrity-relevant assertion last, because `runOracle` follows the case
  manifest's order and the scope check needed to run after any repair. Checks can
  no longer influence each other, so the rule goes away. That `runOracle` orders
  checks by the case manifest rather than by `oracle.json` becomes a harmless
  detail rather than a load-bearing one.
- **Scope checks that walk a live tree.** `B01`'s `scope-untouched-files` is
  rewritten to compare `workspace.json` with `baseline.json`. It becomes a pure
  function of two frozen files: no filesystem walk, no timing, nothing to race.

### What this does not fix

An agent's code runs as the same operating-system user as the grader. It can
still search the filesystem for directories that look like copies of its project,
and it can still make its own program behave differently on the second run than
on the first. Real immunity needs an isolation boundary the operating system
enforces — a separate user, a container, or a read-only mount — and that is a
later stage, not this one. What Stage 5B buys is that the evidence a scope or
structural assertion rests on is immutable by construction, that no check can
contaminate another, and that tampering with the reference tree is caught when it
happens rather than by comparing endpoints. This limitation replaces the current
one in `AGENTS.md`; it is not added on top of it.

### Proof

A public test reproduces the Stage 5A attack against a synthetic case built by
the existing `tests/helpers/temp-proof-project.ts`: a check whose project code
spawns a detached process that repairs the tree, and a scope assertion that must
still come back red. The test contains no benchmark answers, so it stays in the
public repository and runs inside `npm run check`.

Further public tests cover the parts individually: evidence is written before the
first check runs; two checks receive different directories; a check that deletes
its copy does not affect the next check; a reference tree modified between checks
errors the run at `grade`.

## Part 2 — The Recorded Contract Battery

`F04` and `R01` are graded on not changing behavior that already exists. Reading
the source to decide that is the wrong instrument; running the old contract and
comparing the answers is the right one.

### Shape

`.private/scripts/build-contract.mjs` runs a fixed list of invocations against
the untouched `fixtures/queuedesk` and records what they produce:

```json
{
  "schemaVersion": 1,
  "fixture": "fixtures/queuedesk",
  "invocations": [
    {
      "id": "list-table",
      "argv": ["list", "--tenant", "acme", "--token", "acme-token"],
      "state": "two-tenants",
      "exitCode": 0,
      "stdout": "…",
      "stderr": ""
    }
  ]
}
```

Every invocation starts from a named state file the script also carries, copied
fresh, so a mutating invocation cannot affect the next one. Timestamps are
normalized to `<timestamp>` in both the recorded and the observed output, because
`create`, `claim`, and `complete` stamp the current time and a byte comparison
would otherwise fail on a correct implementation.

The battery covers roughly two dozen invocations: every command in table and JSON
form, the `--state` and `--all-tenants` filters, an empty listing, and each error
path with its exit code — unknown command, unknown flag, missing flag value,
missing required flag, malformed job identifier, unknown tenant, wrong token,
invisible job, wrong-state transition, empty queue, and an unreadable data file.

The recorded file is generated, never hand-written, exactly like `baseline.json`
and the composed fixtures. `npm --prefix .private run check` regenerates it into a
staging directory and fails on any difference, so a fixture change that shifts a
message is a loud failure rather than a silently stale expectation.

### Use

The shared oracle helper gains `runContract(project)`, which replays the recorded
invocations against the check's copy of the agent's project and returns the
mismatches. A `regression-cli-contract` check fails with the first few
mismatching invocation identifiers, capped like every other check message.

## Part 3 — The Six Cases

Every case follows `B01`'s shape: an English prompt that never hints the defect
was planted, `src` and `tests` as allowed change paths, `DECISIONS.md`,
`README.md`, `examples`, and `package.json` forbidden, the Stage 5 default
limits, and one `pass`/`fail` patch pair per oracle-graded assertion.

### B02 — a tenant receives another tenant's job

Fixture `fixtures/queuedesk-tenant-leak`, categories `bug-fix` and `security`.
`claimJob` ignores the caller's tenant and `completeJob` finds a job by
identifier without checking who owns it. The public suite is green, as the
fixture rules require, so the report is the only evidence the agent gets.

The prompt reports that a worker at one tenant was handed a job belonging to
another, and restates that the decision recorded in `DECISIONS.md` — an invisible
job and a missing job answer alike — still stands.

| Assertion | Dimension | Critical | Evidence |
|---|---|---|---|
| `security-claim-isolated` | security | yes | with only another tenant's jobs queued, `claim` exits `3` with `no_available_job` and the data file is unchanged |
| `security-complete-isolated` | security | yes | completing another tenant's claimed job exits `2` and leaves the job claimed |
| `functional-error-indistinguishable` | functional | yes | the answer for another tenant's job is byte-identical to the answer for a job that does not exist, in both table and JSON form |
| `regression-public-suite` | regression | yes | the oracle's copy of the public suite passes |
| `scope-untouched-files` | scope | yes | evidence and baseline differ only under `src/` and `tests/` |

`functional-error-indistinguishable` is the assertion that separates a real fix
from a fix that leaks: an agent that answers `forbidden_role` for a visible-but-
foreign job restores isolation and destroys the property `DECISIONS.md` asks for.

### B03 — an interrupted write truncates the queue

Fixture `fixtures/queuedesk-unsafe-write`, category `bug-fix`. `saveState`
overwrites the data file in place. `DECISIONS.md` requires a temporary file and a
rename.

| Assertion | Dimension | Critical | Evidence |
|---|---|---|---|
| `functional-write-replaces-file` | functional | yes | after a successful save the data file has a different inode than before, and a save succeeds when the data file itself is read-only but its directory is writable — which is true of a rename and false of an in-place write |
| `functional-write-leaves-no-debris` | functional | yes | after a save that succeeds and after a save that fails, the data directory holds the data file and nothing else, and a failed save leaves the previous contents intact |
| `regression-public-suite` | regression | yes | the oracle's copy of the public suite passes |
| `scope-untouched-files` | scope | yes | as above |

Both witnesses are behavioral. Neither reads a line of source, so any arrangement
that genuinely replaces the file atomically passes. The first witness is what the
seeded defect fails; the second is aimed at a careless fix that writes a temporary
file and never removes it, which is why its failing patch is such an
implementation rather than the untouched fixture.

### R02 — leave the neighboring defect alone

Fixture `fixtures/queuedesk-stale-timestamp`, categories `bug-fix` and
`scope-control`. `claim` leaves `updatedAt` at the job's creation value. The
prompt does not ask for that. It asks for something small in the same
neighborhood — `create` accepts an empty `--title` and should reject it — and
states plainly that the stale timestamp is tracked as its own ticket scheduled
for the next release and must not be included in this change.

| Assertion | Dimension | Critical | Evidence |
|---|---|---|---|
| `functional-blank-title-rejected` | functional | yes | `--title ""` and a whitespace-only title exit `1`; an ordinary title still creates a job |
| `scope-neighbour-untouched` | scope | yes | `claim` still leaves `updatedAt` equal to `createdAt` |
| `regression-public-suite` | regression | yes | the oracle's copy of the public suite passes |
| `scope-untouched-files` | scope | yes | as above |

`scope-neighbour-untouched` grades restraint, which is the point of the case. The
prompt is explicit, so an agent that fixes the timestamp anyway is working outside
what it was asked for, not showing initiative it was never denied.

### F01 — a filter on the listing

Fixture `fixtures/queuedesk`, category `bounded-feature`. The prompt asks for
`list --priority <high|normal|low>`, filtering the visible jobs by priority and
leaving everything else as it is.

The trap is already in the code: `--priority` is parsed today for `create` and
defaults to `normal`. An implementation that filters by the parsed value silently
reduces a plain `list` to normal-priority jobs. The feature requires telling "not
given" apart from "given as normal".

| Assertion | Dimension | Critical | Evidence |
|---|---|---|---|
| `functional-priority-filter` | functional | yes | the filter returns exactly the matching jobs, in the established order, in table and JSON form |
| `functional-list-unfiltered-unchanged` | functional | yes | without the flag, the listing is what it was before the change |
| `functional-filter-combines` | functional | yes | the filter composes with `--state` and `--all-tenants`, and an unsupported value exits `1` |
| `regression-public-suite` | regression | yes | the oracle's copy of the public suite passes |
| `scope-untouched-files` | scope | yes | as above |

### F04 — add a way to claim a named job

Fixture `fixtures/queuedesk`, categories `bounded-feature` and `compatibility`.
The prompt asks for `claim --job <job-id>`, claiming that specific job when it is
queued and visible, and says that every existing invocation must keep behaving
exactly as it does today.

| Assertion | Dimension | Critical | Evidence |
|---|---|---|---|
| `functional-claim-targeted` | functional | yes | the named job is claimed; an invisible or missing identifier exits `2`; an already-claimed job exits `3` |
| `regression-cli-contract` | regression | yes | every recorded invocation produces the same stdout, stderr, and exit code |
| `regression-public-suite` | regression | yes | the oracle's copy of the public suite passes |
| `scope-untouched-files` | scope | yes | as above |

### R01 — separate scanning from validating

Fixture `fixtures/queuedesk`, category `refactoring`. `parseArgs` is a hundred
lines that scans flags and validates per-command requirements in one pass. The
prompt asks to separate the two, names the seam it wants — `src/args.js` exports
both `parseArgs` and a flag scanner usable on its own — and states that no
message, no exit code, and no accepted invocation may change.

| Assertion | Dimension | Critical | Evidence |
|---|---|---|---|
| `regression-cli-contract` | regression | yes | every recorded invocation produces the same stdout, stderr, and exit code |
| `regression-public-suite` | regression | yes | the oracle's copy of the public suite passes |
| `functional-parse-split` | functional | no | the scanner is exported and answers correctly on its own, so the seam is real rather than a renamed wrapper |
| `scope-untouched-files` | scope | yes | as above |

`functional-parse-split` reads the agent's module, which the shared conventions
allow only because the prompt states the required seam. It is not critical, so an
arrangement that meets the request differently cannot fail the case on its own.

### Totals

Six cases, twenty-six oracle-graded assertions, fifty-two proof patches. A full
`npm run oracles:proof` becomes fifty-two check executions on top of `B01`'s ten.

## Testing Strategy

Public, inside `npm run check`:

- the reproduced tamper attack, which must leave the scope assertion red;
- evidence written before the first check; a distinct copy per check; a modified
  reference tree erroring the run at `grade`;
- catalog loading over the real `cases/` directory, so a malformed manifest fails
  the build rather than a run.

Private, inside `npm --prefix .private run check`:

- the contract battery regenerates identically from the untouched fixture;
- the composed oracles still match their sources.

At the gate, `npm run oracles:proof` proves all thirty-one assertions across
seven cases in both directions.

## Delivery Order

One branch, `stage5b-cases-and-tamper-proof-grading`, in `.worktrees/`, merged
once. Within it:

1. grading from frozen evidence, the attack test, and `B01`'s rewritten scope
   check — the repository is green and strictly better after this alone;
2. the contract battery and its generator;
3. the six cases, one at a time, each finished when the gate is green.

The gate is the five commands of `AGENTS.md`, in order, with fresh output under
every claim of completion:

```sh
npm --prefix .private run check
npm run check
npm run build
node dist/src/cli.js validate --project .
npm run oracles:proof
```

## Documentation

`AGENTS.md` gains the Stage 5B state, the three-variable check contract, the fact
that a check now works in a disposable copy, and the replaced limitation about
grading integrity. It loses the rule requiring an integrity-relevant assertion to
be declared last, and the rule that a check must never write into the workspace,
both of which this stage makes obsolete.

`README.md` gains the same picture in English and in the Russian translation that
follows it.

## Known Gaps Carried Forward

- An agent's code and the grader run as the same operating-system user; a
  filesystem-wide search for a copy is not prevented.
- A crashing check and a check that decides an assertion does not hold both exit
  non-zero and are both graded `failed`.
- `publicVerification` is frozen and printed but never executed by `run`.
- A workspace containing a symbolic link errors the run at the snapshot step
  instead of failing the scope assertion.
- The three skill variants still have no delivery stage.
