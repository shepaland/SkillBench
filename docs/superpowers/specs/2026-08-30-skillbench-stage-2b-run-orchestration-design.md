# SkillBench Stage 2B Run Orchestration Design

## Purpose

Stage 2B turns the Stage 2A file-lifecycle primitives into a complete run
pipeline. It freezes run inputs, materializes and executes one run against a
runtime adapter, records what the agent changed, executes the private oracle,
and writes a normalized result. It makes `list`, `dry-run`, and `run`
operational.

Stage 2B does not implement the Codex adapter, multi-step continuation rules,
metric formulas, comparisons, or reports. `run` executes against the
deterministic fake adapter only. The Codex adapter arrives in Stage 3 through
the existing adapter interface.

## Scope

Stage 2B includes:

- freezing run inputs into an immutable run manifest with a run identifier;
- an operational `dry-run` command that prints the frozen plan without copying
  or executing anything;
- an operational `run` command that executes one or more independent runs
  through the full pipeline;
- an operational `list` command for cases and variants;
- workspace snapshots before and after the agent session, and a change set
  derived from them;
- a private oracle manifest schema and typed-command oracle execution;
- normalized per-run results holding raw assertion outcomes and observed costs;
- incremental evidence persistence that survives a failure at any pipeline step;
- deterministic unit and command-level tests for success and failure paths.

Stage 2B excludes:

- the Codex adapter and any live agent invocation;
- continuation stop-condition evaluation from `transcriptRules`;
- metric calculation, `compare`, and `report`, which keep returning exit code
  `2`;
- public cases, fixtures, variants, or private oracle content;
- concurrent execution of runs.

## Architecture

Stage 2B adds a linear pipeline of independently testable steps and a thin
runner that sequences them and owns rollback. `dry-run` reuses the first step,
so the printed plan and the executed plan cannot drift.

```text
catalog data
     |
     v
freezeRunInputs --------> RunManifest + runId       (shared by dry-run and run)
     |
     v
materializeWorkspace ---> temporary agent workspace  (Stage 2A)
     |
     v
installVariant ---------> installed skill material   (Stage 2A)
     |
     v
snapshotTree -----------> baseline snapshot
     |
     v
RuntimeAdapter.execute -> transcript, usage, process outcome
     |
     v
snapshotTree + diff ----> change set
     |
     | agent session closes
     v
OracleLifecycle --------> separate grading area      (Stage 2A)
     |
     v
runOracle --------------> per-assertion outcomes
     |
     v
writeResult ------------> result.json
```

Every step receives explicit inputs and returns explicit outputs. The runner
holds no hidden state beyond the rollback stack of paths it created.

## Run Identity and Storage

A run identifier is `<UTC timestamp>-<short random suffix>`. The timestamp uses
a compact sortable form so directory listings sort chronologically.

Runs are stored append-only:

```text
runs/<case-id>/<variant-id>/<run-id>/
├── manifest.json      # frozen inputs, written before execution starts
├── transcript.json    # raw normalized adapter events
├── changes.json       # added, modified, and removed workspace paths
└── result.json        # normalized run result
```

An existing run directory is never reused or overwritten. Repetitions requested
later add new directories beside earlier ones. The clock and the suffix
generator are injected parameters, which keeps tests deterministic.

`runs/` stays ignored by Git.

## Frozen Inputs

`freezeRunInputs()` builds the run manifest from validated catalog data. It
extends the Stage 1 `RunManifest` with the run identifier and the resolved case
and variant identifiers. The frozen fields are the case hash, variant hash,
fixture hash, oracle hash, model, reasoning effort, sandbox, runtime version,
adapter version, limits, and repetition index.

The oracle hash is required. When the private oracle is unavailable, freezing
fails: `dry-run` reports that the plan cannot be frozen, and `run` refuses to
start. Freezing never reads oracle contents beyond what hashing requires, and
never copies oracle material.

The repetition index is the zero-based position of a run within a single `run`
invocation. It is not globally unique: a later invocation starts again at zero.
The run identifier, not the repetition index, identifies a run.

The manifest is written through the existing immutable JSON store, so a second
write of a byte-identical manifest is idempotent and a differing write is
rejected.

## Runtime Configuration and Selection

`dry-run` and `run` accept the frozen configuration as options:

- `--runtime <id>` selects the adapter and defaults to `fake`;
- `--model <id>` defaults to `fake-model`;
- `--reasoning <effort>` defaults to `medium`;
- `--sandbox <mode>` defaults to `workspace-write`.

An unknown runtime identifier is rejected. A variant whose
`compatibleRuntimes` does not list the selected runtime is rejected.

The `fake` runtime builds a deterministic script from the case prompt steps: one
assistant message and one completion claim per step, with fixed durations and
fixed usage. This keeps `run` exercisable end to end without a live agent. The
adapter reports its own runtime version and adapter version, and those reported
values are what the run manifest freezes.

## The `dry-run` Command

```text
skillbench dry-run --case <id> --variant <id> [--project <path>] [--json]
```

`dry-run` freezes inputs and prints:

- the frozen run manifest;
- the ordered prompt steps with their identifiers;
- allowed and forbidden change paths;
- the public verification commands;
- the declared assertion identifiers with their dimensions and criticality.

It creates no workspace, installs nothing, mounts no oracle, and starts no
adapter. It writes nothing under `runs/`.

Default output is human-readable text. `--json` prints the same content as a
machine-readable document.

Exit codes: `0` when the plan was frozen and printed; `2` when the case or
variant is unknown, the variant is incompatible with the runtime, or the
private oracle is unavailable.

## The `run` Command

```text
skillbench run --case <id> --variant <id> [--runs <n>] [--project <path>]
               [--keep-workspace] [--json]
```

`--runs` defaults to `1`. Runs execute sequentially and independently: each gets
its own frozen manifest, run directory, workspace, and grading area. A failed
run does not cancel the remaining repetitions.

### Pipeline order

1. Freeze inputs and write `manifest.json` before anything is executed, so a
   later failure still records what was attempted.
2. Materialize the fixture workspace.
3. Install the variant. The control variant installs nothing.
4. Take the baseline snapshot. This happens **after** variant installation, so
   installed skill material is not counted as an agent change.
5. Execute the runtime adapter and persist `transcript.json`.
6. Take the final snapshot, derive the change set, and persist `changes.json`.
7. Close the agent session, mount the private oracle in its separate grading
   area, execute the oracle checks, and remove the oracle material.
8. Verify that the source fixture hash in the repository is unchanged.
9. Write `result.json`.

### Run status

- `completed`: the adapter finished within its limits and every oracle check
  produced an outcome. This is the only status counted in metric denominators.
- `exhausted`: the agent hit a wall-clock, output-byte, or token limit. This is
  an agent outcome, not a tool failure. Later stages count it in the
  denominator as an unsolved run.
- `errored`: SkillBench itself failed — workspace materialization, variant
  installation, oracle mounting or execution, or an unexpected change to the
  source fixture. Later stages exclude these runs from metrics.

`result.json` records the status and, for a non-`completed` run, the pipeline
step at which the run stopped.

### Evidence and cleanup

Evidence is written as it becomes available, never assembled once at the end. A
failure at step 7 still leaves `manifest.json`, `transcript.json`, and
`changes.json` on disk, and `result.json` is written with status `errored`.

The workspace and the grading area are removed after each run. `--keep-workspace`
preserves the workspace for investigation and prints its path; it never
preserves oracle material.

Exit codes: `0` when every requested run reached status `completed` with every
critical assertion passed; `1` when a run reached status `completed` with a
failed critical assertion or reached status `exhausted`; `2` for invalid
invocation, unknown identifiers, an unavailable oracle, or any run that reached
status `errored`.

Default output is a human-readable per-run summary. `--json` prints the same
summary as a machine-readable document. Neither form replaces `result.json`,
which is always written.

## The `list` Command

```text
skillbench list [cases|variants] [--project <path>] [--json]
```

With no argument it prints both sections. `list cases` prints the identifier,
title, categories, assertion count, and private-oracle availability. `list
variants` prints the identifier, display name, claimed categories, and
compatible runtimes. `--json` prints the same content as a machine-readable
document. All data comes from the existing catalog loader; `list` adds no new
loading logic.

Exit codes: `0` on success; `2` for an unknown subcommand or an invalid project
path.

## Workspace Snapshots and Change Sets

`snapshotTree()` walks a directory and returns a sorted map from
workspace-relative path to content hash, reusing the Stage 1 hashing helpers. It
rejects symbolic links the same way the Stage 2A tree copy does. A symbolic link
the agent created inside the workspace therefore fails the final snapshot and
gives the run status `errored`, with the partial evidence preserved.

`diffSnapshots(before, after)` returns three sorted path lists: `added`,
`modified`, and `removed`. Directory entries are represented by their files
only; an emptied directory shows as removed files.

The change set also records whether any changed path falls outside
`allowedChangePaths` or inside `forbiddenChangePaths`. These are recorded as raw
observations. Stage 2B does not convert them into metric values.

## Private Oracle Contract

A case oracle is `.private/oracles/<case-id>/oracle.json`. Its JSON Schema is
published as `schemas/oracle.schema.json` — the schema is public; oracle content
is not.

The manifest declares one check per assertion:

- `assertionId`: an identifier declared by the case;
- `command`: a `TypedCommand` with executor `node`, `npm`, or `git` and explicit
  arguments;
- `workingDirectory`: a safe relative path resolved inside the grading area;
- `timeoutMs`: a positive integer.

No shell text is accepted, matching the rule that already governs
`publicVerification`.

Checks never receive a templated path. SkillBench sets the working directory
inside the grading area and passes two environment variables: `SKILLBENCH_WORKSPACE`
with the absolute agent workspace path, and `SKILLBENCH_ORACLE` with the absolute
grading-area path. A check reads the workspace through `SKILLBENCH_WORKSPACE`.

### Execution rules

- Exit code `0` maps to `passed`; any other exit code maps to `failed`.
- A timeout, a signal, or a failure to spawn maps to `error` for that assertion
  only.
- Every check runs. One failing or erroring check never prevents the others from
  producing outcomes.
- Checks run from the grading area and read the agent workspace. The agent
  session is already closed when they run.
- The assertion identifiers in the oracle and in the case must correspond one to
  one. A missing or extra identifier is rejected before any check executes,
  rather than producing a silently incomplete result.

`validate` gains this correspondence check wherever it already checks oracle
availability. `--public-only` continues to skip it, because it cannot read
private material.

## Normalized Result

`result.json` records raw observations only:

- `runId`, the frozen run manifest, and the schema version;
- the run status and, when applicable, the failed pipeline step;
- per-assertion outcomes: identifier, dimension, criticality, outcome
  (`passed`, `failed`, `error`), exit code, and duration;
- the change set and the allowed/forbidden path observations;
- observed costs: input and output tokens, wall-clock milliseconds, and the
  number of unplanned user turns;
- adapter metadata: runtime, runtime version, and adapter version.

Metrics are not computed here. `solve_rate` and the diagnostic metrics are
derived at comparison time, so revising a formula never requires re-running an
agent.

## File Structure

```text
src/runs/freeze-inputs.ts      # frozen manifest and run identifier
src/runs/snapshot.ts           # tree snapshots and change sets
src/runs/execute-run.ts        # pipeline runner and rollback stack
src/runs/result.ts             # normalized result types and writer
src/oracles/run-oracle.ts      # typed-command oracle execution
src/commands/dry-run.ts
src/commands/run.ts
src/commands/list.ts
schemas/oracle.schema.json
src/schemas/                   # oracle manifest validation
```

The clock, run-identifier suffix generator, and runtime adapter are injected
parameters. Nothing in `src/runs/` branches on a named skill or a named runtime.

## Testing Strategy

Snapshots and change sets: added, modified, and removed files; nested and
emptied directories; symbolic-link rejection; stable sort order.

Frozen inputs: stable manifest hashes across repeated freezes; rejection when
the oracle is unavailable; idempotent rewrite and rejection of a differing
rewrite.

Oracle execution: `passed`, `failed`, and `error` outcomes; timeout handling;
rejection of mismatched assertion identifiers before execution; one failing
check not suppressing the others; refusal to run while the session is open.

Runner: a fully successful run; a forced failure at each pipeline step leaving
the expected partial evidence and status; `exhausted` on a limit hit; detection
of an unexpected source-fixture change; workspace removal by default and
preservation under `--keep-workspace`.

Commands: exit codes for each documented condition; `--json` output shape;
unknown case and variant identifiers; `--runs` greater than one producing
independent run directories; `compare` and `report` still returning `2`.

All tests use the deterministic fake adapter and temporary directories. No test
invokes a live agent.

## Documentation and Delivery State

`AGENTS.md` and `README.md` change in the same delivery. The README describes
`list`, `dry-run`, and `run` as working commands in both its English and Russian
sections, and continues to state that comparisons, metrics, and reports are not
implemented. `AGENTS.md` records Stage 2B as complete and names Stage 3 — the
Codex adapter and multi-step prompt execution — as the next stage.
