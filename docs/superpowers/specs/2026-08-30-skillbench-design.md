# SkillBench Design

## Purpose

SkillBench measures whether an agent skill improves coding work under controlled,
repeatable conditions. Its first study compares LexForge, OpenSpec, Superpowers,
and an unassisted control. The framework must also accept unrelated skills and
new task suites without changes to its core.

The benchmark separates four questions:

1. Did the agent produce the required behavior without regressions?
2. Did the agent follow the process that applies to the task?
3. What did a successful result cost in time, tokens, and human intervention?
4. Did the repository remain understandable and consistent after the change?

The primary outcome is solve rate. A run is solved only when every critical
assertion passes. Detailed metrics explain why a variant won or lost; they do
not compensate for a critical correctness or security failure.

## Scope

Version 1 includes:

- a TypeScript CLI for Node.js 22;
- a runtime-neutral case and variant model;
- one executable runtime adapter for Codex CLI;
- deterministic grading with optional blinded human review;
- immutable run inputs identified by content hashes;
- a public twelve-case coding-process suite;
- an offline JavaScript ESM fixture named QueueDesk;
- four initial variants: control, OpenSpec, Superpowers, and LexForge;
- JSON results and a human-readable comparison report.

Version 1 does not include a hosted leaderboard, remote workers, a web interface,
automatic installation of arbitrary third-party dependencies, or adapters for
Claude Code, Cursor, and other agent runtimes. Those runtimes can be added behind
the adapter interface without changing case definitions or scoring formulas.

## Design Principles

- **Skills are data.** Core code contains no branches for named skills.
- **Cases are portable.** A case describes a task, fixture, dialogue, limits, and
  observable assertions without depending on one runtime.
- **The oracle is isolated.** Hidden tests never enter the agent workspace.
- **Evidence precedes scores.** Every metric can be traced to a test result,
  transcript event, repository diff, timing record, or usage record.
- **Critical failures stay visible.** A weighted average cannot hide a security
  violation or broken required behavior.
- **Comparisons use matched inputs.** Model, reasoning effort, sandbox, case pack,
  limits, and runtime version must match.
- **Public language is English.** Prompts, documentation, schemas, fixture copy,
  reports, and CLI messages use concise international English.

## Repository Layout

```text
SkillBench/
├── src/                       # CLI, domain model, adapters, runner, grading
├── tests/                     # unit and integration tests for SkillBench
├── methodology/               # experiment protocol and metric definitions
├── cases/                     # public case manifests, prompts, and setup data
├── fixtures/                  # public source projects and public tests
├── variants/                  # install manifests for benchmarked skills
├── schemas/                   # published JSON Schemas
├── docs/superpowers/specs/    # approved product designs
├── .private/oracles/          # hidden tests and reviewer keys; ignored by Git
└── runs/                      # transcripts, diffs, results, reports; ignored by Git
```

Source code, tests, methodology, public cases, fixtures, variants, schemas, and
product documentation are committed. `.private/` and `runs/` are ignored.

## Domain Model

### Case

A case is a versioned JSON document with:

- a stable ID and title;
- applicable categories and metric dimensions;
- a fixture reference and baseline content hash;
- one or more prompt steps;
- public verification commands;
- runtime limits;
- allowed and forbidden change paths;
- critical assertion IDs expected from the private oracle;
- optional deterministic transcript event rules.

Multi-step cases define explicit continuation points. A step can require the
agent to stop after asking a question or presenting a design. The next step
contains the fixed user response. This keeps approval-gate tests reproducible
without a semantic LLM judge.

### Variant

A variant is a versioned manifest that describes:

- its stable ID and display name;
- compatible runtimes;
- the local source files to install;
- the destination expected by each runtime;
- claimed task categories;
- environment settings that are safe to expose;
- a content hash of the installed material.

The control variant has no installed skill or process package. OpenSpec,
Superpowers, and LexForge use the same interface as any future variant.

### Runtime Adapter

The adapter boundary receives a materialized workspace, ordered prompt steps,
runtime configuration, and output sinks. It returns normalized transcript
events, process exit information, usage, elapsed time, and runtime metadata.

The Codex adapter is the only version 1 implementation. Runtime-specific command
construction and transcript parsing remain inside that adapter.

### Oracle

An oracle belongs to a case but is stored under `.private/oracles/<case-id>/`.
It contains deterministic functional, regression, security, scope, and process
checks. The public case lists assertion IDs and their dimensions but does not
contain implementations or expected secret values.

### Run and Comparison

A run manifest freezes the case hash, variant hash, fixture hash, oracle hash,
model, reasoning effort, sandbox, runtime version, limits, and repetition index.
Its result records raw assertion outcomes and observed costs.

A comparison aggregates compatible runs. It refuses inputs whose frozen model,
reasoning effort, sandbox, case hash, or runtime adapter version differs.

## CLI

Version 1 exposes:

```text
skillbench validate
skillbench list [cases|variants]
skillbench dry-run --case <id> --variant <id>
skillbench run --case <id> --variant <id> --runs <n>
skillbench compare <run-id>...
skillbench report <comparison-id>
```

`validate` checks schemas, references, assertion IDs, path constraints, fixture
hashes, and private-oracle availability. `dry-run` freezes inputs and prints the
execution plan without starting Codex. `run` creates evidence for one case and
variant. `compare` builds an aggregate from compatible runs. `report` renders
the aggregate as Markdown and JSON.

CLI exit codes follow common command-line conventions:

- `0`: command completed and requested validations passed;
- `1`: benchmark findings or failed assertions;
- `2`: invalid invocation, malformed input, or unavailable dependency.

## Execution Flow

1. Load and validate the case, variant, adapter configuration, fixture, and
   private oracle.
2. Hash every input and write an immutable run manifest.
3. Copy the fixture baseline into a new temporary workspace.
4. Install the selected variant into the runtime's repository-local skill path.
   The control variant leaves that path empty.
5. Start the Codex adapter and execute the ordered prompt steps. At each required
   continuation point, evaluate deterministic stop conditions before sending the
   next fixed user response.
6. Capture transcript events, commands, repository diff, completion claims,
   elapsed time, token usage, and unplanned human turns.
7. Close the agent session. Mount or copy the private oracle only after the agent
   can no longer inspect the workspace.
8. Execute oracle checks, normalize assertion results, and remove all temporary
   oracle material.
9. Verify that the source fixture hash is unchanged and write `result.json`.
10. Aggregate compatible repetitions into a comparison and render reports.

## Initial QueueDesk Fixture

QueueDesk is an offline multi-tenant job queue CLI written in JavaScript ESM.
It uses only the Node.js standard library and stores data in JSON. Public tests
run with `node --test`.

The base application supports creating, listing, claiming, and completing jobs.
Its small domain still exposes realistic concerns: CLI compatibility, tenant
isolation, persistence failure, authorization, state transitions, and output
formats. Each case materializes an independent baseline from the fixture; no run
can affect a later run.

## Initial Case Suite

| ID | Type | Observable challenge |
|---|---|---|
| `F01` | bounded feature | Implement a precise, local behavior change. |
| `F02` | ambiguous feature | Ask for missing information before changing files. |
| `F03` | architectural feature | Present an approach and wait for approval. |
| `F04` | compatibility | Add behavior without breaking the existing CLI contract. |
| `B01` | bug fix | Find the cause instead of patching the visible symptom. |
| `B02` | tenant isolation | Block direct access to another tenant's job. |
| `B03` | persistence | Prevent a failed write from corrupting stored JSON. |
| `R01` | refactoring | Preserve behavior without inventing a requirement. |
| `R02` | scope control | Leave a nearby, unrelated defect unchanged. |
| `P01` | TDD pressure | Respond correctly when asked to skip tests for speed. |
| `P02` | design coherence | Follow an approved decision despite an easier alternative. |
| `P03` | verification | Reject stale evidence after a later change. |

Every case contains an English user prompt, fixture baseline, public check,
limits, allowed changes, critical failure rules, and public assertion metadata.
Its private oracle contains functional, regression, security, scope, and process
checks. Correct and deliberately defective reference mutations prove that each
oracle assertion can both pass and fail.

## Scoring and Metrics

### Primary Outcome

`solved` is true only when all critical assertions pass. The study reports:

```text
solve_rate = solved_runs / completed_runs
```

Incomplete runs remain visible and do not count as solved.

### Diagnostic Metrics

```text
correctness = passed_functional_assertions / functional_assertions
regression_safety = passed_regression_assertions / regression_assertions
process_compliance = passed_applicable_process_assertions / applicable_process_assertions
scope_precision = requested_behavior_changes / all_behavior_changes
first_pass_yield = runs_without_repair_turn / completed_runs
rework_ratio = changed_lines_after_first_completion_claim / final_changed_lines
tokens_per_solve = total_tokens / solved_runs
wall_time_per_solve = total_elapsed_time / solved_runs
human_interventions = unplanned_user_turns / completed_runs
spec_drift = contradictory_durable_spec_assertions / durable_spec_assertions
```

Undefined denominators produce `not_applicable`, never zero. Reports show each
metric separately. Version 1 does not publish a composite leaderboard score.

Functional and security results come from deterministic code. Transcript rules
can grade exact observable events such as a required stop, test command order, or
completion claim. Judgments that require semantic interpretation are optional,
blinded human-review fields and never critical assertions.

## Experimental Protocol

The initial study runs four variants: control, OpenSpec, Superpowers, and
LexForge. Each block uses the same case pack, Codex model, reasoning effort,
sandbox, runtime version, prompt steps, timeout, and token limit. Variant order
is randomized within each block.

The pilot uses two repetitions per case and variant. The main study uses at
least five, producing 240 main runs for twelve cases and four variants. Reports
include solve rate, median cost measures, absolute and relative differences from
control, and 95% bootstrap confidence intervals. Raw repetition results remain
available so readers can inspect variance and failures.

A future skill declares the categories it claims to improve. SkillBench selects
compatible cases and always includes control. Comparisons across different case
packs, runtime versions, models, reasoning settings, or sandboxes are rejected.

## Safety and Failure Handling

- Resolve and validate all paths beneath the selected project or temporary
  workspace; reject traversal and symlink escapes.
- Never place private oracle files in an active agent workspace.
- Do not record secrets or complete environment dumps.
- Pass only explicitly allowed environment variables to child processes.
- Do not execute arbitrary shell text from an untrusted public manifest. Commands
  resolve through a typed allowlist of executors and arguments.
- Enforce wall-clock and output limits. A timeout produces an `incomplete` result
  with captured evidence.
- Keep each run in a fresh workspace and verify the source fixture hash afterward.
- Preserve partial evidence when the adapter, oracle, or report renderer fails.
- Reject incompatible comparisons with a precise explanation and next action.

## Verification Strategy

SkillBench itself is developed with test-driven development.

- Unit tests cover schemas, hashes, metric formulas, compatibility checks, path
  isolation, transcript normalization, and redaction.
- Integration tests cover workspace materialization, variant installation,
  multi-step continuation, oracle isolation, timeout handling, and result storage.
- A deterministic fake adapter exercises the complete pipeline in CI without a
  model account or network access.
- A Codex end-to-end smoke test is opt-in because it requires authentication and
  incurs runtime cost.
- Each benchmark case has a correct reference mutation and at least one defective
  mutation. The correct mutation must pass its oracle; each defect must fail the
  assertion designed to catch it.

## Delivery Stages

1. Define schemas, storage paths, hashes, validation, and the fake adapter.
2. Implement workspace materialization, variant installation, oracle lifecycle,
   and normalized run results.
3. Implement the Codex adapter and multi-step prompt execution.
4. Build QueueDesk and prove its public test suite.
5. Add the twelve public cases and private mutation-tested oracles.
6. Implement comparison statistics and Markdown/JSON reports.
7. Run the two-repetition pilot, revise invalid cases without inspecting variant
   rankings, freeze the case pack, and run the main study.

Each stage leaves a testable CLI increment. The main study starts only after all
case oracles pass their positive and negative mutation checks.
