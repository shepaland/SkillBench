# SkillBench Stage 5 Cases and Oracles Design

## Purpose

SkillBench can execute a full run pipeline and QueueDesk gives it something to
run against, but the catalog is empty: `validate --public-only` reports `0`
cases and `0` variants. This stage delivers the twelve public cases of the
Initial Case Suite, one private oracle per case, and the machinery that proves
every oracle assertion can both pass and fail.

After this stage a real measurement is possible: a case, a variant, a live
Codex session, and graded assertions with evidence.

## Scope

In scope:

- twelve public case manifests under `cases/<id>/` with English prompts;
- one private oracle per case under `.private/oracles/<id>/`;
- a separate private repository that holds oracle sources and proof patches;
- `src/tools/prove-oracles.ts` and the `oracles:proof` npm script;
- a public `control` variant, without which nothing can be run;
- committed tests for the prover itself and for every declared transcript rule;
- `README.md` and `AGENTS.md` updates.

Out of scope: comparison statistics, reports, the pilot study, and the three
skill variants (OpenSpec, Superpowers, LexForge). No change to the run pipeline,
the adapter boundary, the schemas, or the CLI command set is planned. If a case
turns out to need one, that is a design change and is raised before it is made.

## Substages

The stage lands in three merges. Each leaves the repository green and useful.

| Substage | Content | What works afterwards |
|---|---|---|
| 5A | Private repository, oracle build, prover, prover test, `control` variant, case `B01` end to end | `run --case B01 --variant control --runtime codex` produces a graded result |
| 5B | `B02`, `B03`, `R02`, `F01`, `F04`, `R01` — six cases graded by running code | seven cases; correctness, regression safety, and scope are measurable |
| 5C | `F02`, `F03`, `P01`, `P02`, `P03` — five dialogue and process cases | all twelve cases; `validate` passes without `--public-only` |

5A fixes the shape. 5B and 5C apply it. Each substage gets its own
implementation plan; this document is the shared contract between them.

## Private Material

### Repository

Oracles and their proof patches live in `github.com/shepaland/SkillBench-private`,
a private repository cloned into `.private/` of the working copy. The public
repository ignores `.private/` exactly as it does today, so no answer key can
reach GitHub through an ordinary commit.

The private repository has no dependencies. Its only tooling is one composition
script run through the Node.js standard library.

### Layout

```text
.private/
├── package.json                  # build, test, and check scripts, no dependencies
├── scripts/build-oracles.mjs     # composes and verifies oracles/
├── scripts/build-baseline.mjs    # regenerates a case's baseline.json from its fixture
├── sources/
│   ├── _shared/                  # helpers copied into every composed oracle
│   └── <case-id>/
│       ├── oracle.json           # assertion ID to typed command
│       ├── baseline.json         # content hashes of the case's fixture
│       ├── checks/*.mjs          # one file per oracle-graded assertion
│       └── tests/…               # the oracle's own copy of the public suite
├── proofs/<case-id>/
│   ├── _patches/<name>/          # patches shared by several assertions
│   └── <assertion-id>/{pass,fail}/
│       ├── overlay.json          # description, includes, removals
│       └── files/…               # replaced or added files
└── oracles/<case-id>/            # composed output; the only tree SkillBench reads
```

A patch is a directory with an `overlay.json` and an optional `files/` tree, in
the same vocabulary `fixtures/overlays/` already uses. `overlay.json` may list
`include` names, applied in order before the patch's own files, so that a
reference solution shared by several assertions is stored once. A patch with no
files and no includes is legitimate and means "the untouched fixture", which is
the natural failing state for a bug-fix case.

### Why composition exists

`OracleLifecycle` copies `.private/oracles/<case-id>` into a temporary grading
directory and runs checks there. Nothing outside that directory is reachable:
the grading directory is a fresh `mkdtemp` outside the project, the working
directory of every check is confined to it, and no environment variable points
back at the SkillBench checkout. Shared helper code must therefore be physically
present inside every composed oracle.

`npm run build` in the private repository copies `sources/_shared/` into
`oracles/<case-id>/shared/` alongside the case's own files. `npm run check` runs
the same composition into a staging directory and fails on any difference,
including symbolic links and file modes. This mirrors `scripts/build-fixtures.mjs`
and its `fixtures:check` counterpart, and for the same reason: a hand-edited
composed tree is an untracked source of truth.

## Oracle Design

### Check form

One assertion is one file. A check is declared as a typed command:

```json
{
  "assertionId": "functional-claim-priority",
  "command": { "executor": "node", "args": ["checks/functional-claim-priority.mjs"] },
  "workingDirectory": ".",
  "timeoutMs": 120000
}
```

SkillBench reads only the exit code: `0` means the assertion holds, any other
value means it does not. Check output is deliberately discarded before
`result.json` is written, so expected values never leak into a durable artifact.
A check may still print freely; the text only reaches the operator's terminal
during a proof run.

### How a check reaches the agent's work

The agent's final workspace path arrives in `SKILLBENCH_WORKSPACE`; the grading
directory arrives in `SKILLBENCH_ORACLE`. Checks come in three kinds, following
the rule that structure is graded only where the case is about structure:

- **Behavioral checks** run QueueDesk as an ordinary program — a child `node`
  process on `<workspace>/src/cli.js` — and judge exit codes, stdout, and the
  contents of the data file. Any internal arrangement that behaves correctly
  passes.
- **Structural checks** read or import source files from the workspace. They
  appear only in cases whose prompt states that a documented design decision is
  part of the task, and they are never the only evidence for a case outcome.
- **Scope checks** hash the workspace tree and compare it against
  `baseline.json`, requiring that only paths the case allows differ.

Every one of those kinds ends up running code the measured agent wrote, as a child
process, as `node --test` over the agent's project, or as a dynamic import into
the check's own process. That code inherits the check's environment, so the shared
helper reads both variables once when it loads and removes them from
`process.env` before the check's first line, and hands every child an environment
without them. An agent that could read `SKILLBENCH_ORACLE` would be able to
rewrite the baseline and the carried test suite it is about to be graded against.

### Regression checks own their tests

A regression check runs the fixture's original public test suite from a copy the
oracle carries, never the copy left in the workspace. Deleting or weakening a
public test therefore cannot turn a regression assertion green.

### Baseline manifest

`baseline.json` lists the relative path and content hash of every file in the
case's fixture. `scripts/build-baseline.mjs` generates it; it is never written
by hand. `npm run oracles:proof` recomputes the fixture hashes and fails when
they no longer match. A stale baseline is a loud failure, not a silent one.

The same manifest keeps the oracle's carried copy of the public test suite
honest: the prover hashes every file the oracle holds under `tests/` and
requires it to equal the baseline entry for the same path. The comparison runs in
both directions, so a public test that changes in the fixture and not in the
oracle, and an oracle that carries only part of the suite, are both caught there.

### Isolation rules

- A check never writes into the agent's workspace. It creates its own temporary
  directory, copies in whatever it needs, and removes it. Checks run in sequence
  against one workspace, so a check that leaves a file behind would corrupt the
  scope check that follows it.
- A check never reads outside its grading directory and the workspace.
- A check never contacts the network.
- The grading directory is hashed again after the last check has finished and
  compared with the hash frozen into the run manifest. Agent code that reached the
  oracle by some route the environment scrub does not cover still changes those
  bytes, and a run whose oracle changed while the checks ran is reported as
  errored at the `grade` step rather than graded.

## Proving the Oracles

Every declared assertion must be shown to both pass and fail. The two kinds of
assertion are proven by different means.

### Oracle-graded assertions

`src/tools/prove-oracles.ts`, exposed as `npm run oracles:proof`, proves the
assertions that a private check decides. For each case, for each such assertion,
it takes the `pass` and `fail` patches and, for each of them:

1. composes a temporary project copy from the case's fixture plus the patch;
2. mounts the case's oracle through the real `OracleLifecycle`;
3. runs the assertion's check through the real `runOracle`;
4. removes the temporary material.

A `pass` patch must produce `passed`; a `fail` patch must produce `failed`. Every
other outcome is reported with the case, assertion, patch, and observed result.

`error` is narrower than it sounds. `run-oracle.ts` maps every non-zero exit to
`failed`, so only a timeout or a spawn failure ever becomes `error`; a check that
crashes exits non-zero and is graded `failed` like a check that decided the
assertion does not hold. The prover still catches a check that only ever crashes,
because such a check fails its own `pass` patch. Telling a crash apart from a
caught failure needs richer evidence than an exit code, and that is a change for a
later stage.

The prover uses SkillBench's own mounting and execution code rather than
reimplementing it. A proof that exercised a private imitation of the runner
would prove only the imitation. It is therefore TypeScript under `src/tools/`,
run as `node --import tsx src/tools/prove-oracles.ts`, so the existing
`tsconfig.json` include list and the strict ESLint configuration already cover
it.

It also enforces correspondence, the same way the catalog enforces it between a
case and its oracle: every oracle-graded assertion has exactly one `pass` and
one `fail` patch, and no patch directory names an assertion that does not exist.

`npm run oracles:proof` is not part of `npm run check`, because a fresh clone
has no `.private/`. Without it the prover exits with a non-zero status and names
the repository to clone. It never reports success on missing material. Each patch
runs only the check under proof, so a full `B01` proof is ten check executions and
takes about five seconds.

### Transcript-graded assertions

An assertion carrying a `transcriptRuleId` is decided by
`src/runs/transcript-rules.ts` from the recorded event list. The rule is public;
it is in the case manifest. Its proof is therefore an ordinary committed test
that feeds a synthetic event list to `evaluateRules` and requires the rule to
hold for one list and not hold for another. This runs inside `npm run check`
and needs no private material.

### The prover's own proof

A committed test drives the prover against a synthetic case that
`tests/helpers/temp-proof-project.ts` generates into a temporary directory: a tiny
project, an oracle with an honest check and a check that always exits `0`, and
patches for both. The test requires the prover to accept
the honest assertion and to reject the always-green one, naming that assertion
and its `fail` patch. The synthetic material contains no benchmark answers and
is public. This closes the same gap Stage 4 closed for fixtures: machinery that
can only pass proves nothing.

## Case Design

### Shared conventions

Every case manifest lives at `cases/<id>/case.json`. Prompts are concise
international English and never suggest that a defect was planted or that the
work is an experiment. Where a case grades structure or a documented decision,
the prompt says so plainly; grading a rule the agent was never told about would
measure guesswork.

### Category vocabulary

Categories are a closed, hyphenated list, matching the form already used in
`smoke/`:

`bug-fix`, `bounded-feature`, `ambiguous-feature`, `architectural-feature`,
`compatibility`, `refactoring`, `security`, `scope-control`, `process`.

A future skill declares which of these it claims to improve, and SkillBench
selects compatible cases from that declaration.

### Change paths and the tests directory

`tests/` is an allowed change path in every case that has one. A skill that
requires writing a test before the implementation would otherwise be recorded as
working outside its scope, and the benchmark would measure adherence to a house
style rather than the quality of the work. Protection against weakened tests
comes from the oracle carrying its own copy of the public suite, not from
forbidding the directory.

Files that state the task's ground truth — `DECISIONS.md`, `README.md`,
`package.json`, `examples/` — are forbidden change paths unless a case is
specifically about revising them.

### Limits

Unless a case states otherwise: `wallClockMs` 900000, `outputBytes` 4000000,
`tokenLimit` 400000. These follow the live smoke check's budget with more time,
and each case can override them in one line.

## Worked Case: B01

`B01` is the 5A pilot and the reference for every later case.

- **Fixture:** `fixtures/queuedesk-claim-order`. Verified: 56 public tests, one
  red — `claim takes the highest priority queued job first`.
- **Categories:** `bug-fix`.
- **Prompt:** one step. `claim` should hand a worker the highest-priority queued
  job and instead hands out the oldest one; the public suite has one failing
  test that shows it; fix the cause rather than the failing test; keep the design
  decisions recorded in `DECISIONS.md` in force; keep the rest of the suite
  green.
- **Allowed change paths:** `src`, `tests`. **Forbidden:** `package.json`,
  `examples`, `README.md`, `DECISIONS.md`.

| Assertion | Dimension | Critical | Evidence |
|---|---|---|---|
| `functional-claim-priority` | functional | yes | `claim` returns the highest-priority queued job |
| `functional-json-order` | functional | yes | `list --json` is ordered too |
| `regression-public-suite` | regression | yes | the oracle's copy of the 56 public tests passes |
| `functional-renderer-neutral` | functional | no | the output layer does not sort |
| `scope-untouched-files` | scope | yes | nothing outside `src` and `tests` differs from the baseline |

`functional-json-order` is what separates a real fix from a patch, without
reading a line of source. `list --json` bypasses the renderer, so an agent that
only teaches `claim` to pick by priority turns the red test green and leaves the
JSON listing unordered. Both assertions hold only when ordering has moved back
into the job rules. `functional-renderer-neutral` is a third witness and is not
critical, so an unusual but correct arrangement cannot fail the case on its own.

`B01` declares no security or process assertion. Those dimensions report
`not_applicable` for it, which is the designed behavior for an absent
denominator. Process assertions concentrate in `F02`, `F03`, and `P01`–`P03`.

## Case Suite Allocation

| ID | Substage | Fixture | Dimensions with assertions |
|---|---|---|---|
| `B01` | 5A | `queuedesk-claim-order` | functional, regression, scope |
| `B02` | 5B | `queuedesk-tenant-leak` | functional, regression, security, scope |
| `B03` | 5B | `queuedesk-unsafe-write` | functional, regression, scope |
| `R02` | 5B | `queuedesk-stale-timestamp` | functional, regression, scope |
| `F01` | 5B | `queuedesk` | functional, regression, scope |
| `F04` | 5B | `queuedesk` | functional, regression, scope |
| `R01` | 5B | `queuedesk` | functional, regression, scope |
| `F02` | 5C | `queuedesk` | process, scope, functional |
| `F03` | 5C | `queuedesk` | process, scope, functional |
| `P01` | 5C | `queuedesk` | process, functional, regression |
| `P02` | 5C | `queuedesk` | process, functional, regression |
| `P03` | 5C | `queuedesk` | process, functional, regression |

A case that needs a fixture variant beyond the four committed copies gets it
through a new overlay in `fixtures/overlays/` and `npm run fixtures:build`.
Composed fixtures are never hand-edited.

## Control Variant

`variants/control/variant.json` declares the no-skill control: no installed
material, compatible with the `codex` runtime, and every category claimed. It is
public, tiny, and required — `run` takes a variant identifier, so without it no
case can execute.

The three skill variants are deliberately left out. The approved design assigns
them to no delivery stage, and they belong to a stage of their own before the
pilot. This gap is recorded in `AGENTS.md` rather than absorbed here.

## Testing Strategy

- The prover is tested against synthetic public material and must reject an
  always-green check.
- Every transcript rule declared by a case is tested for both a holding and a
  non-holding event list.
- Catalog loading is exercised against the real `cases/` directory, so a
  malformed manifest fails `npm run check` rather than waiting for a run.
- The full oracle proof runs from `npm run oracles:proof` at the delivery gate
  and is not part of CI, because CI has no private material.

## Delivery Gate

Each substage closes only with fresh output from all of:

```sh
npm run check
npm run build
node dist/src/cli.js validate --project .
npm run oracles:proof
npm --prefix .private run check
```

`validate` runs without `--public-only` from 5A onward, because oracles exist
from 5A onward.

## Documentation

`AGENTS.md` gains the stage state, the category vocabulary, where the private
material comes from and how to obtain it, the rule that a check never writes
into the agent's workspace, the rule that `tests/` stays editable while the
oracle carries its own copy of the public suite, and the missing skill-variant
stage as a known gap.

`README.md` gains the same information for a reader, English first and a
complete Russian translation second, including what still works without the
private repository: `validate --public-only`, `list`, `dry-run`, the fixtures,
and their public test suites.

## Known Gaps to Record

- `publicVerification` is frozen and printed but never executed by `run`. Cases
  declare it truthfully; the regression assertion is what actually runs the
  public suite.
- An oracle check that crashes is reported as a failed assertion, not an errored
  one, because only the exit code is available. The prover is what distinguishes
  the two, by rejecting a check that cannot pass.
- The skill variants have no delivery stage.
