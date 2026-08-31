# SkillBench Stage 3 Codex Adapter Design

## Purpose

Stage 3 connects a real coding agent to the pipeline that Stage 2B completed, and
makes multi-step cases meaningful. It adds an executable Codex adapter behind the
existing `RuntimeAdapter` boundary, gives `transcriptRules` concrete deterministic
semantics, and turns the placeholder continuation callback into a real stop-condition
gate.

After Stage 3 the framework can run a case against Codex, evaluate declared stop
conditions between prompt steps, grade transcript-based assertions itself, classify
resource exhaustion from real evidence instead of heuristics, and preserve the raw
runtime stream for re-parsing.

Stage 3 does not add public cases, fixtures, variants, private oracles, metric
formulas, comparisons, or reports. `compare` and `report` keep returning exit
code `2`.

## Scope

Stage 3 includes:

- a `codex` runtime adapter that executes ordered prompt steps against `codex exec`
  and continues the session between steps;
- a seventh normalized transcript event for file changes reported by the runtime;
- typed transcript rules with a closed set of five checks, replacing the current
  free-form `event` string;
- single-evaluation continuation semantics: a rule referenced by a continuation is
  evaluated exactly once, at that continuation point;
- transcript-graded assertions, linked from an assertion declaration to a rule, and a
  narrowed private-oracle coverage invariant;
- adapter-owned limit enforcement and an explicit exhaustion cause on the execution
  result;
- per-run isolation of the runtime's home directory and an explicit child-process
  environment allowlist;
- raw runtime stream evidence written per step before parsing;
- a fake `codex` executable used by tests to exercise the real process, stream, and
  session-continuation paths without a network or an account;
- an opt-in live smoke check, excluded from `npm run check` and from CI.

Stage 3 excludes:

- adapters for any other runtime;
- public cases, fixtures, variants, or private oracle content;
- metric calculation, `compare`, and `report`;
- concurrent execution of runs;
- semantic or model-based judging of transcripts.

## Architecture

New and changed modules:

| Module | Responsibility |
|---|---|
| `src/runtime/codex/codex-adapter.ts` | Implements `RuntimeAdapter` for Codex: runs steps, enforces limits, emits normalized events |
| `src/runtime/codex/build-command.ts` | Pure mapping from run configuration and step position to executable and argument list |
| `src/runtime/codex/parse-events.ts` | Pure mapping from one raw stream line to zero or more normalized transcript events, plus session identity and usage |
| `src/runtime/codex/normalize-command.ts` | Pure splitting of a reported shell command into one or more executor/argument command records |
| `src/runtime/codex/codex-home.ts` | Per-run runtime home directory: creation, credential copy, cleanup |
| `src/runs/transcript-rules.ts` | Pure evaluation of typed rules over a list of transcript events |
| `src/runtime/runtime-adapter.ts` | Adds the `file_change` event and the `exhaustion` field; strengthens the `onContinuation` contract |
| `src/runtime/select-adapter.ts` | Becomes asynchronous; maps `codex` to the Codex adapter and reports its runtime version |
| `src/runs/execute-run.ts` | Implements `onContinuation`, merges transcript-graded assertions, reads the adapter's exhaustion cause, splits oracle setup into its own pipeline step |
| `src/catalog/` validation | Validates rule references, rule-to-assertion links, and the narrowed oracle coverage invariant |
| `schemas/case.schema.json` | Typed `transcriptRules`; optional `transcriptRuleId` on an assertion |

The core does not branch on skill names or runtime names beyond the data-driven
mapping in `selectAdapter`. All Codex command construction and stream parsing stay
inside `src/runtime/codex/`.

## Transcript Event Vocabulary

`TranscriptEvent` gains one member:

```ts
| { readonly type: "file_change"; readonly atMs: number; readonly paths: readonly string[] }
```

The adapter emits it whenever the runtime reports an applied file change. `paths` are
workspace-relative and sorted. This keeps rule evaluation a pure function of the event
list: no tree snapshots between steps and no filesystem access inside the evaluator.

The fake adapter's script gains a matching `file_change` step event so that
transcript-rule behavior can be tested without a process.

## Transcript Rules

### Rule shape

A rule is one of five checks. Every rule carries `id` and an optional `expect` flag
that defaults to `true`; `expect: false` asserts the check does not hold.

| `check` | Additional fields | Holds when |
|---|---|---|
| `no_file_change` | — | The window contains no `file_change` event |
| `assistant_message` | — | The window contains at least one `assistant_message` event |
| `command_ran` | `executor`, `argsPrefix` | The window contains a `command` event whose executor equals `executor` and whose arguments start with `argsPrefix` |
| `command_after_file_change` | `executor`, `argsPrefix` | The window contains a matching `command` event, and either the window contains no `file_change` event or the last matching command follows the last `file_change` |
| `command_before_file_change` | `executor`, `argsPrefix` | The window contains a matching `command` event, and either the window contains no `file_change` event or the first matching command precedes the first `file_change` |

`executor` and `argsPrefix` are matchers, never executed, so `executor` accepts any
non-empty string rather than the typed `CommandExecutor` enum. An empty `argsPrefix`
matches any arguments.

There is deliberately no check for `completion_claim`. The runtime marks the end of a
turn, not a semantic claim that the work is finished, so such a check would hold on
every run and grade nothing. The `completion_claim` event is still emitted, because the
`rework_ratio` metric planned for Stage 6 needs the moment the agent first returned
control.

Example rules:

```json
{ "id": "asked_before_changing", "check": "no_file_change" },
{ "id": "spoke_first", "check": "assistant_message" },
{ "id": "verified_after_editing", "check": "command_after_file_change", "executor": "node", "argsPrefix": ["--test"] },
{ "id": "tests_first", "check": "command_before_file_change", "executor": "node", "argsPrefix": ["--test"] }
```

### Windows and single evaluation

A rule's window is determined by where the rule is referenced, not by a field on the
rule:

- A rule listed in `promptSteps[n].continuation.eventRuleIds` is evaluated **once**, at
  that continuation point, over every event recorded from session start up to that
  moment.
- A rule referenced by no continuation is evaluated **once**, after the session closes,
  over the complete transcript.

One evaluation per rule means the answer used as a stop condition and the answer that
reaches the report are the same value by construction; they cannot diverge.

The current `beforeStepId` field is removed from the rule. It expressed the same window
less directly and required cross-field validation to stay consistent.

### Continuation behavior

When a rule referenced by a continuation does not hold, the run **records the violation
and proceeds**. The next fixed user response is still sent, the run reaches the oracle,
and the report shows both the process violation and whether the agent solved the task.
Runs therefore always contain the same number of declared steps and stay comparable on
cost and time.

The adapter must await `onContinuation` before sending the next step. The callback's
type stays `Promise<void>`: because the decision is always "proceed", a return value
would be dead weight. What changes is the contract — the callback is no longer a no-op
and the core performs rule evaluation inside it.

### Grading

An assertion declaration gains an optional `transcriptRuleId`. When present:

- SkillBench produces that assertion's result itself, from the named rule;
- the private oracle must **not** cover that assertion.

`assertOracleCoversAssertions` narrows accordingly: the oracle manifest must cover
exactly the assertions **without** a `transcriptRuleId`. The two sets are mutually
exclusive and jointly exhaustive, so no assertion is graded twice and none is left
ungraded.

`AssertionResult` gains `source: "oracle" | "transcript"` so evidence records where a
result came from.

### Validation rules

`validate` and catalog loading reject a case when:

- a rule identifier is duplicated;
- `continuation.eventRuleIds` names a rule that is not declared;
- one rule is referenced by more than one continuation;
- `transcriptRuleId` names a rule that is not declared;
- two assertions name the same rule;
- an assertion carries `transcriptRuleId` and the oracle also covers it;
- an assertion carries no `transcriptRuleId` and the oracle does not cover it.

A declared rule referenced by no continuation and by no assertion is allowed: it is
evaluated at session close and recorded as evidence without producing an assertion.

## The Codex Adapter

### Command construction

The captured event stream of `codex-cli 0.151.0` shows that `codex exec` and
`codex exec resume` accept different option sets. `resume` rejects `--cd`, `--sandbox`,
and `--color`. Both forms accept `-c <key>=<value>` overrides, `-m`, `--json`,
`--skip-git-repo-check`, and `--ignore-user-config`.

The adapter therefore spawns every step with the child's working directory set to the
workspace, and passes the sandbox and reasoning settings as configuration overrides,
which both forms accept.

First step:

```text
codex exec --json --skip-git-repo-check --ignore-user-config
  -C <workspace> -m <model>
  -c model_reasoning_effort=<effort> -c sandbox_mode=<sandbox> -
```

Later steps:

```text
codex exec resume <thread-id> --json --skip-git-repo-check --ignore-user-config
  -m <model> -c model_reasoning_effort=<effort> -c sandbox_mode=<sandbox> -
```

Passing the sandbox as a command-line flag on the first step and forgetting it on a
resumed step is a silent failure, not an error: the resumed step falls back to a
read-only policy and the agent's edits quietly do not apply. Using the configuration
override on both forms is what keeps every step of a run under the same policy.

The prompt text is written to the child's standard input, never passed as an argument.
This avoids command-line length limits and keeps prompt text out of argument parsing
entirely.

`build-command.ts` is a pure function returning `{ executable, args }`. Its tests are a
table of configurations and expected argument lists, including the difference between
the first-step and resume forms.

The adapter declares its own `adapterVersion` constant, independent of the runtime
version. It is raised whenever command construction, stream parsing, or command
normalization changes observable behavior, because the frozen manifest records it and
comparisons refuse mismatched adapter versions.

### Session isolation

Each run receives a temporary runtime home directory. Only the credential file is
copied into it from the user's real runtime home; personal configuration is not, and
`--ignore-user-config` keeps it from being loaded. Consequences:

- runs cannot see or resume each other's sessions;
- a benchmark run never writes into the operator's profile;
- personal settings cannot skew a measured result.

This is not theoretical. A capture taken without `--ignore-user-config` shows the agent
loading the operator's personally installed skill packages before touching the task,
which would contaminate every measured variant.

If no credential file is found, the adapter raises a `DependencyError` explaining that
the runtime is not authenticated. The temporary home is removed during cleanup; a
removal failure is recorded in `cleanupFailures` like any other cleanup failure and
does not replace the run outcome.

`--ephemeral` is not used: session continuation requires persisted session files.

The child process receives an explicit environment: `PATH`, `HOME`, `TMPDIR`, `LANG`,
the temporary runtime home variable, and the variables the variant manifest declared
safe. The parent environment is never inherited wholesale and is never written to
evidence.

### Stream parsing

The adapter reads the child's standard output line by line. Each line is one JSON
object. The observed shapes of `codex-cli 0.151.0`, captured while designing this
stage, are:

```json
{"type":"thread.started","thread_id":"01a05672-40b8-7db1-823a-39a2fc5a735f"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution",
  "command":"/bin/zsh -lc \"sed -n '1p' note.txt\"","aggregated_output":"...",
  "exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_1","type":"file_change",
  "changes":[{"path":"/abs/path/note.txt","kind":"update"}],"status":"completed"}}
{"type":"turn.completed","usage":{"input_tokens":55965,"cached_input_tokens":46336,
  "cache_write_input_tokens":0,"output_tokens":385,"reasoning_output_tokens":70}}
```

Normalization:

| Raw line | Normalized event |
|---|---|
| `thread.started` | Session identity, recorded but not an event. Present on resumed steps too, carrying the same identifier |
| `item.completed` with `agent_message` | `assistant_message` |
| `item.completed` with `command_execution` | One or more `command` events, see **Command normalization** |
| `item.completed` with `file_change` | One `file_change` event whose `paths` are the item's change paths |
| `turn.completed` | `completion_claim`, plus the usage record |
| `item.started`, `turn.started`, anything else | Ignored, counted as skipped |

`item.started` is deliberately ignored: it repeats the same item identifier that
`item.completed` carries, so honoring both would double every command and every file
change.

The runtime reports absolute paths in `file_change`. The adapter converts them to
workspace-relative paths and sorts them. A path outside the workspace is kept verbatim
and flagged in the event, so it can be seen in evidence rather than silently dropped.

Robustness rules:

- an unrecognized or malformed line is counted as unparsed and preserved in the raw
  evidence; it never fails the run;
- a missing session identifier after the first step **is** a failure, with a clear
  message, because the next step has nowhere to go; a case with a single prompt step
  has no next step, so it is not a failure there;
- the raw stream of each step is written to evidence before parsing, so a parser defect
  never destroys the underlying data.

The captured sample is committed as test data so parsing can be re-checked offline
against a real stream rather than a hand-written imitation.

### Command normalization

The runtime reports a command as a single string, not an argument vector — for example
`/bin/zsh -lc "cd app && node --test"`. `normalize-command.ts` turns one such string
into one or more command records:

1. If the string is a shell wrapper (`<shell> -lc <script>` or `<shell> -c <script>`),
   the script is split into segments on `&&`, `||`, `;`, `|`, and newlines. Otherwise
   the whole string is treated as one segment.
2. Each segment is split on whitespace; a token wrapped in matching single or double
   quotes has those quotes stripped. No expansion, substitution, or execution occurs.
3. Each resulting segment becomes a `command` transcript event with `executor` set to
   its first token and `args` set to the rest.

If a script cannot be split this way, the whole script becomes one record whose
executor is the shell. The exit code reported by the runtime is attached to every
record derived from that invocation.

### Limits and exhaustion

The adapter owns limit enforcement:

- **Wall clock**: a single budget across all steps. On expiry the child receives a
  termination signal, then a kill signal after a short grace period.
- **Output bytes**: the adapter counts stream bytes and terminates the child when the
  case limit is exceeded.
- **Token limit**: usage is summed across steps and checked **between** steps. When the
  budget is spent, the next step is not sent.

`RuntimeExecution` gains:

```ts
readonly exhaustion: "wall_clock" | "output_bytes" | "token_limit" | "signal" | null;
```

`isExhausted` in `execute-run.ts` is deleted. The run status reads the adapter's answer
directly. This removes threshold guessing from the core and removes the fake-runtime
trap in which synthetic token counts would mark small-limit cases exhausted on every
run. The fake adapter reports `null` unless its script says otherwise.

### Failure handling

- Runtime executable absent: `DependencyError` before the workspace is materialized;
  exit code `2`.
- Child fails to start, or exits non-zero on the first step: the run is `errored` at the
  `execute` step, with the raw stream preserved.
- A later step fails after earlier steps succeeded: earlier evidence and rule outcomes
  are preserved and the run is `errored` with the failing step named.

## Core Changes

`PipelineStep` gains `oracle_setup`, placed between `baseline_snapshot` and `execute`.
Oracle lifecycle creation moves into it, so a lifecycle or transcript-writing fault is
no longer attributed to the adapter. This closes a deferred item from Stage 2B.

`executeRun` implements `onContinuation`: it evaluates the rules the step references,
appends their outcomes to a collected list, and returns. After execution it evaluates
the remaining unreferenced rules over the full transcript, converts rule outcomes into
assertion results for assertions carrying `transcriptRuleId`, and merges them with the
oracle results.

`selectAdapter` becomes asynchronous because the Codex runtime version is obtained by
invoking the runtime. `resolveRunTargets` and `runRun` await it. This means `dry-run
--runtime codex` also requires an installed runtime — correct, since the frozen manifest
records the runtime version.

`supportedRuntimes` becomes `["codex", "fake"]`.

## Evidence

The run directory gains raw stream files:

```text
runs/<case>/<variant>/<run-id>/
  manifest.json
  transcript.json
  changes.json
  result.json
  raw/step-<step-id>.jsonl
  raw/step-<step-id>.err.log
```

The child's standard output and its error output are preserved in separate files. Both
count against the output budget, and the error output is where a rejected model, an
expired login, or an option this runtime version does not accept is explained; mixing
plain text into the JSON Lines file would corrupt it.

`transcript.json` additionally records, per step, the raw file name, the count of
unparsed lines, and the rule outcomes evaluated at that step's continuation point.
Raw files are written directly rather than through the immutable JSON store, which
accepts JSON documents only. A runtime that produces no stream, such as the fake
adapter, writes no `raw/` directory and records no raw file name.

## CLI

No new commands and no new flags. The existing `--runtime <id>` option, which already
defaults to `fake`, accepts `codex` once the adapter is registered. Error messages for
an unsupported runtime keep listing the supported set.

## Testing Strategy

Deterministic tests, no live agent:

- `build-command.ts`: a table of configurations mapped to expected argument lists,
  including the first-step and resume forms and the sandbox mapping failure.
- `parse-events.ts`: parsing against the committed sample stream; unparsed-line
  counting; a missing session identifier.
- `normalize-command.ts`: single invocation, shell wrapper with one command, chained
  segments, quoted tokens, and an unsplittable script.
- `transcript-rules.ts`: each of the five checks passing and failing, `expect: false`,
  empty windows, and both ordering checks with no file change at all.
- Catalog validation: every rejection listed under **Validation rules**.
- `execute-run.ts`: rule outcomes reaching `result.json`; transcript-graded and
  oracle-graded assertions merged without duplication; exhaustion read from the
  adapter; a fault at `oracle_setup` attributed to that step.

Process-level tests use a **fake `codex` executable**: a small Node script placed on
`PATH` for the test, which reads standard input and prints a scripted stream. It
exercises real process spawning, real stream reading, and real session continuation
while covering wall-clock termination, a stream truncated mid-line, a garbage line, a
missing session identifier, refusal to send a later step after the token budget is
spent, and a non-zero exit. It also covers the unplanned-user-turn branch that Stage 2B
left untested, by scripting an extra prompt event.

Live verification is a separate opt-in check:

- `smoke/` holds the material of a tiny task: a couple of files, two prompt steps whose
  first must end in a question, one continuation rule, and one assertion.
- A script assembles a complete temporary project from that material using the same
  helper the test suite already uses, so no private material is committed and
  `.gitignore` is untouched.
- It runs as `npm run smoke:codex` and only when the opt-in environment variable is set.
  It is excluded from `npm run check` and from CI.
- It verifies exactly this: the second step was sent only after the first step stopped,
  the transcript parsed, and evidence reached disk.

Because `smoke/` lives outside `cases/`, `validate --project . --public-only` still
reports zero cases and zero variants.

## Known Limitations

Added by this stage:

- A file edited through a shell command rather than the runtime's own edit tool produces
  no `file_change` transcript event. The final tree comparison still detects the change
  for scope metrics, but transcript rules do not see it.
- Command normalization does not implement shell grammar. Quoting is handled only as
  stripped matched quotes around a token; subshells, redirections, and expansions are
  not interpreted.
- Stream parsing is pinned to the observed event shape of one runtime version. A
  different version may produce unparsed lines; the run still completes and the raw
  stream is preserved, but transcript rules may see fewer events. The frozen
  `runtimeVersion` already prevents comparing runs across versions.
- Wall-clock and output budgets are enforced by the adapter, so a child that ignores a
  termination signal is only stopped by the subsequent kill signal.

Resolved by this stage: exhaustion classification, the fake-runtime token trap, the
untested unplanned-user-turn branch, and step attribution for oracle-setup faults.

## Documentation and Delivery State

The same change updates:

- `AGENTS.md`: current state, the architecture entry for `src/runtime/codex/`, the new
  limitations, and the resolved ones;
- `README.md`: both halves, English first and a complete Russian translation second,
  covering `--runtime codex`, what a live run requires, and the opt-in smoke check.

Stage gate, with fresh command output recorded beneath any completion claim:

```sh
npm run check
npm run build
node dist/src/cli.js validate --project . --public-only
```

plus one manual live run of `npm run smoke:codex`.
