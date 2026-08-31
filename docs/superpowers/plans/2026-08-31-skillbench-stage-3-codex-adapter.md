# SkillBench Stage 3 Codex Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a real Codex session to the existing run pipeline and make multi-step cases meaningful by evaluating deterministic stop conditions between prompt steps.

**Architecture:** A new `codex` adapter lives behind the unchanged `RuntimeAdapter` boundary in `src/runtime/codex/`, spawning one `codex exec` process per prompt step and resuming the same thread for later steps. A new pure evaluator in `src/runs/transcript-rules.ts` grades typed rules over normalized transcript events; `execute-run.ts` calls it at each continuation point and merges its outcomes with private-oracle results. Limit enforcement and exhaustion classification move out of the core and into the adapter.

**Tech Stack:** Node.js 22+, TypeScript with native ESM, `node --test` via `tsx`, Ajv 2020 for schema validation, Commander for the CLI. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-skillbench-stage-3-codex-adapter-design.md`

## Global Constraints

- Node.js 22 or newer; TypeScript with native ESM; npm with exact versions from `package-lock.json`. No new runtime dependencies.
- Public prompts, schemas, CLI messages, reports, fixture text, and project documentation use concise international English. `README.md` keeps its English section first and a complete Russian translation second, both carrying identical content.
- Skills are data: core code must not branch on names such as LexForge, OpenSpec, or Superpowers. Runtime-specific command building and transcript parsing belong in `src/runtime/codex/`.
- Never place `.private/oracles/` content in an active agent workspace.
- Never execute arbitrary shell text from public manifests. Rule matchers are matched, never executed.
- Reject path traversal and symlink escapes; preserve raw and partial evidence when any pipeline step fails.
- Pass only explicitly allowed environment variables to child processes; never write an environment dump to evidence.
- CI runs the fake adapter only. No automated test may start a live Codex session.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Run `npm run check` before claiming any task complete. The stage gate is `npm run check`, `npm run build`, and `node dist/src/cli.js validate --project . --public-only` exiting `0`.
- Work happens in an isolated worktree created via `superpowers:using-git-worktrees` at `.worktrees/stage3-codex-adapter` on branch `stage3-codex-adapter`.
- Documents under `docs/` are ignored by Git; stage them with `git add -f`.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `src/runs/transcript-rules.ts` | Typed rule definitions and their pure evaluation over transcript events |
| `src/runtime/codex/build-command.ts` | Pure mapping from configuration and thread state to executable and arguments |
| `src/runtime/codex/normalize-command.ts` | Pure splitting of a reported shell command string into command records |
| `src/runtime/codex/parse-events.ts` | Pure mapping from one raw stream line to normalized events, thread identity, and usage |
| `src/runtime/codex/codex-home.ts` | Per-run runtime home directory with credential copy and cleanup |
| `src/runtime/codex/codex-version.ts` | Reads the installed runtime version |
| `src/runtime/codex/codex-adapter.ts` | The adapter: spawns steps, enforces limits, drives continuations |
| `tests/helpers/fake-codex.ts` | Builds a fake `codex` executable driven by a scripted scenario |
| `smoke/` | Material for the opt-in live check |
| `scripts/smoke-codex.mjs` | Assembles a temporary project from `smoke/` and runs it live |

**Modified:** `src/runtime/runtime-adapter.ts`, `src/runtime/fake-adapter.ts`, `src/runtime/select-adapter.ts`, `src/domain/model.ts`, `schemas/case.schema.json`, `src/oracles/oracle-manifest.ts`, `src/oracles/run-oracle.ts`, `src/catalog/load-catalog.ts`, `src/runs/result.ts`, `src/runs/execute-run.ts`, `src/commands/dry-run.ts`, `src/commands/run.ts`, `package.json`, `AGENTS.md`, `README.md`.

**Already present (captured while designing, do not regenerate):** `tests/data/codex/sample-first-step.jsonl`, `tests/data/codex/sample-resumed-step.jsonl`.

---

### Task 1: Transcript vocabulary and exhaustion cause

**Files:**
- Modify: `src/runtime/runtime-adapter.ts`
- Modify: `src/runtime/fake-adapter.ts`
- Modify: `src/runtime/select-adapter.ts:17-42` (`createFakeScript`)
- Test: `tests/runtime/fake-adapter.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `TranscriptEvent` including the `file_change` member; `ExhaustionCause`; `RuntimeExecution.exhaustion` and `RuntimeExecution.unparsedLines`; `RuntimeInput.onRawLine` and `RuntimeInput.config.environment`; `FakeStepEvent` including its `file_change` member; `FakeScript.exhaustion`.

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime/fake-adapter.test.ts`:

```ts
test("emits file change events and an exhaustion cause from the script", async () => {
  const adapter = new FakeAdapter({
    steps: [{
      stepId: "s1",
      events: [
        { type: "file_change", afterMs: 5, paths: ["src/a.js"], outsidePaths: [] },
        { type: "completion_claim", afterMs: 5, text: "done" },
      ],
    }],
    closeAfterMs: 1,
    process: { exitCode: 0, signal: null, timedOut: false },
    usage: { inputTokens: 1, outputTokens: 1 },
    exhaustion: "token_limit",
    metadata: { runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
  });

  const execution = await adapter.execute({
    workspace: "/tmp/workspace",
    promptSteps: [{ id: "s1", prompt: "go" }],
    config: {
      model: "m", reasoningEffort: "low", sandbox: "workspace-write",
      limits: { wallClockMs: 1000, outputBytes: 1000, tokenLimit: 1000 },
    },
    onContinuation: async () => {},
  });

  const change = execution.events.find((event) => event.type === "file_change");
  assert.deepEqual(change, { type: "file_change", atMs: 5, paths: ["src/a.js"], outsidePaths: [] });
  assert.equal(execution.exhaustion, "token_limit");
});

test("reports no exhaustion cause when the script omits one", async () => {
  const adapter = new FakeAdapter({
    steps: [{ stepId: "s1", events: [] }],
    closeAfterMs: 1,
    process: { exitCode: 0, signal: null, timedOut: false },
    usage: null,
    metadata: { runtimeVersion: "1.0.0", adapterVersion: "1.0.0" },
  });

  const execution = await adapter.execute({
    workspace: "/tmp/workspace",
    promptSteps: [{ id: "s1", prompt: "go" }],
    config: {
      model: "m", reasoningEffort: "low", sandbox: "workspace-write",
      limits: { wallClockMs: 1000, outputBytes: 1000, tokenLimit: 1000 },
    },
    onContinuation: async () => {},
  });

  assert.equal(execution.exhaustion, null);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --test-name-pattern="exhaustion cause"`
Expected: FAIL — TypeScript rejects the unknown `exhaustion` and `file_change` members.

- [ ] **Step 3: Extend the adapter boundary**

In `src/runtime/runtime-adapter.ts`, add the event member and the exhaustion type:

```ts
export type ExhaustionCause = "wall_clock" | "output_bytes" | "token_limit" | "signal";

export type TranscriptEvent =
  | { readonly type: "session_started"; readonly atMs: number }
  | { readonly type: "prompt_sent"; readonly atMs: number; readonly stepId: string; readonly text: string }
  | { readonly type: "assistant_message"; readonly atMs: number; readonly text: string }
  | { readonly type: "command"; readonly atMs: number; readonly executor: string; readonly args: readonly string[]; readonly exitCode: number }
  | { readonly type: "file_change"; readonly atMs: number; readonly paths: readonly string[]; readonly outsidePaths: readonly string[] }
  | { readonly type: "completion_claim"; readonly atMs: number; readonly text: string }
  | { readonly type: "session_closed"; readonly atMs: number };
```

Add to `RuntimeExecution`:

```ts
  /** Why the runtime stopped short of finishing, or null when it finished normally. */
  readonly exhaustion: ExhaustionCause | null;
  /** Stream lines this adapter did not recognize. Never fatal; preserved in raw evidence. */
  readonly unparsedLines: number;
```

Extend `RuntimeInput` so the core can persist raw evidence and pass variant-declared
environment without any adapter branching on runtime names:

```ts
export interface RuntimeInput {
  readonly workspace: string;
  readonly promptSteps: readonly PromptStep[];
  readonly config: {
    readonly model: string;
    readonly reasoningEffort: string;
    readonly sandbox: string;
    readonly limits: RuntimeLimits;
    /** Variant-declared variables that are safe to expose to the child process. */
    readonly environment: Readonly<Record<string, string>>;
  };
  readonly onContinuation: (step: PromptStep, events: readonly TranscriptEvent[]) => Promise<void>;
  /** Called for every raw stream line before parsing. Adapters without a stream never call it. */
  readonly onRawLine?: (stepId: string, line: string) => void;
}
```

Every existing call site that builds a `RuntimeInput` — `src/runs/execute-run.ts` and the
runtime tests — gains `environment: {}` or the variant's environment.

- [ ] **Step 4: Extend the fake adapter**

In `src/runtime/fake-adapter.ts`, add the script event member, the optional script field, and the two switch and freeze branches:

```ts
export type FakeStepEvent =
  | { readonly type: "assistant_message"; readonly afterMs: number; readonly text: string }
  | { readonly type: "command"; readonly afterMs: number; readonly executor: string; readonly args: readonly string[]; readonly exitCode: number }
  | { readonly type: "file_change"; readonly afterMs: number; readonly paths: readonly string[]; readonly outsidePaths: readonly string[] }
  | { readonly type: "completion_claim"; readonly afterMs: number; readonly text: string };
```

Add `readonly exhaustion?: ExhaustionCause | null;` to `FakeScript`, return
`exhaustion: this.script.exhaustion ?? null` and `unparsedLines: 0` from `execute`, and
extend both helpers:

```ts
function toTranscriptEvent(event: FakeStepEvent, atMs: number): TranscriptEvent {
  switch (event.type) {
    case "assistant_message":
      return freezeEvent({ type: "assistant_message", atMs, text: event.text });
    case "command":
      return freezeEvent({ type: "command", atMs, executor: event.executor, args: [...event.args], exitCode: event.exitCode });
    case "file_change":
      return freezeEvent({ type: "file_change", atMs, paths: [...event.paths], outsidePaths: [...event.outsidePaths] });
    case "completion_claim":
      return freezeEvent({ type: "completion_claim", atMs, text: event.text });
  }
}

function freezeEvent(event: TranscriptEvent): TranscriptEvent {
  if (event.type === "command") {
    return Object.freeze({ ...event, args: Object.freeze([...event.args]) });
  }
  if (event.type === "file_change") {
    return Object.freeze({
      ...event,
      paths: Object.freeze([...event.paths]),
      outsidePaths: Object.freeze([...event.outsidePaths]),
    });
  }
  return Object.freeze({ ...event });
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm run check`
Expected: PASS, all existing tests still green.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/runtime-adapter.ts src/runtime/fake-adapter.ts src/runtime/select-adapter.ts tests/runtime/fake-adapter.test.ts
git commit -m "$(cat <<'EOF'
feat: record file changes and exhaustion cause in the adapter boundary

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Typed rules in the domain model and their evaluator

**Files:**
- Create: `src/runs/transcript-rules.ts`
- Modify: `src/domain/model.ts:40-44` (the inline `transcriptRules` shape)
- Modify: `schemas/case.schema.json` (the `transcriptRule` definition)
- Modify: `src/catalog/load-catalog.ts` (remove the obsolete `beforeStepId` validation)
- Test: `tests/runs/transcript-rules.test.ts`
- Test: `tests/schemas/validator.test.ts`

The schema moves in the same task as the domain type on purpose: if the model said
`check` while the schema still required `event`, every case fixture in the test suite
would have to satisfy two contradictory shapes at once.

**Interfaces:**
- Consumes: `TranscriptEvent` from Task 1.
- Produces: `TranscriptRule` exported from `src/domain/model.ts`; `TranscriptRuleOutcome`, `evaluateRule(rule, events)`, `evaluateRules(rules, events)` exported from `src/runs/transcript-rules.ts`.

`TranscriptRule` belongs in the domain model, not in the evaluator: it is a manifest
type, and `src/runtime/runtime-adapter.ts` already imports from the domain model, so
defining it in the evaluator would create an import cycle.

- [ ] **Step 1: Write the failing test**

Create `tests/runs/transcript-rules.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptEvent } from "../../src/runtime/runtime-adapter.js";
import type { TranscriptRule } from "../../src/domain/model.js";
import { evaluateRule, evaluateRules } from "../../src/runs/transcript-rules.js";

function message(atMs: number): TranscriptEvent {
  return { type: "assistant_message", atMs, text: "hello" };
}

function command(atMs: number, executor: string, args: readonly string[]): TranscriptEvent {
  return { type: "command", atMs, executor, args, exitCode: 0 };
}

function change(atMs: number): TranscriptEvent {
  return { type: "file_change", atMs, paths: ["src/a.js"], outsidePaths: [] };
}

test("no_file_change holds when nothing was edited", () => {
  const rule: TranscriptRule = { id: "r", check: "no_file_change" };
  assert.equal(evaluateRule(rule, [message(1)]).satisfied, true);
  assert.equal(evaluateRule(rule, [message(1), change(2)]).satisfied, false);
});

test("assistant_message requires the agent to have spoken", () => {
  const rule: TranscriptRule = { id: "r", check: "assistant_message" };
  assert.equal(evaluateRule(rule, []).satisfied, false);
  assert.equal(evaluateRule(rule, [message(1)]).satisfied, true);
});

test("command_ran matches the executor and an argument prefix", () => {
  const rule: TranscriptRule = { id: "r", check: "command_ran", executor: "node", argsPrefix: ["--test"] };
  assert.equal(evaluateRule(rule, [command(1, "node", ["--test", "tests/"])]).satisfied, true);
  assert.equal(evaluateRule(rule, [command(1, "node", ["build.js"])]).satisfied, false);
  assert.equal(evaluateRule(rule, [command(1, "npm", ["--test"])]).satisfied, false);
});

test("command_ran with an empty prefix matches any arguments", () => {
  const rule: TranscriptRule = { id: "r", check: "command_ran", executor: "git", argsPrefix: [] };
  assert.equal(evaluateRule(rule, [command(1, "git", ["status"])]).satisfied, true);
});

test("expect false inverts the outcome and keeps the raw result visible", () => {
  const rule: TranscriptRule = { id: "r", check: "no_file_change", expect: false };
  const outcome = evaluateRule(rule, [change(1)]);
  assert.equal(outcome.held, true);
  assert.equal(outcome.satisfied, false);
});

test("command_before_file_change requires the command and correct order", () => {
  const rule: TranscriptRule = { id: "r", check: "command_before_file_change", executor: "node", argsPrefix: ["--test"] };
  assert.equal(evaluateRule(rule, [command(1, "node", ["--test"]), change(2)]).satisfied, true);
  assert.equal(evaluateRule(rule, [change(1), command(2, "node", ["--test"])]).satisfied, false);
  assert.equal(evaluateRule(rule, [command(1, "node", ["--test"])]).satisfied, true);
  assert.equal(evaluateRule(rule, [change(1)]).satisfied, false);
});

test("command_after_file_change requires the last command to follow the last edit", () => {
  const rule: TranscriptRule = { id: "r", check: "command_after_file_change", executor: "node", argsPrefix: ["--test"] };
  assert.equal(evaluateRule(rule, [change(1), command(2, "node", ["--test"])]).satisfied, true);
  assert.equal(evaluateRule(rule, [command(1, "node", ["--test"]), change(2)]).satisfied, false);
  assert.equal(evaluateRule(rule, [command(1, "node", ["--test"])]).satisfied, true);
  assert.equal(evaluateRule(rule, []).satisfied, false);
});

test("an empty window fails every positive check", () => {
  const rules: readonly TranscriptRule[] = [
    { id: "a", check: "assistant_message" },
    { id: "b", check: "command_ran", executor: "node", argsPrefix: [] },
  ];
  assert.deepEqual(evaluateRules(rules, []).map((outcome) => outcome.satisfied), [false, false]);
});

test("evaluateRules preserves rule order and identifiers", () => {
  const rules: readonly TranscriptRule[] = [
    { id: "second", check: "no_file_change" },
    { id: "first", check: "assistant_message" },
  ];
  assert.deepEqual(evaluateRules(rules, [message(1)]).map((outcome) => outcome.ruleId), ["second", "first"]);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --test-name-pattern="no_file_change"`
Expected: FAIL — `src/runs/transcript-rules.js` does not exist.

- [ ] **Step 3: Move the rule type into the domain model**

In `src/domain/model.ts`, replace the inline `transcriptRules` shape on `CaseManifest`
with a reference to a named union defined in the same file:

```ts
export interface CommandMatcher {
  readonly executor: string;
  readonly argsPrefix: readonly string[];
}

export type TranscriptRule =
  | { readonly id: string; readonly check: "no_file_change"; readonly expect?: boolean }
  | { readonly id: string; readonly check: "assistant_message"; readonly expect?: boolean }
  | ({ readonly id: string; readonly check: "command_ran"; readonly expect?: boolean } & CommandMatcher)
  | ({ readonly id: string; readonly check: "command_before_file_change"; readonly expect?: boolean } & CommandMatcher)
  | ({ readonly id: string; readonly check: "command_after_file_change"; readonly expect?: boolean } & CommandMatcher);
```

and in `CaseManifest`:

```ts
  readonly transcriptRules?: readonly TranscriptRule[];
```

- [ ] **Step 4: Replace the rule definition in the case schema**

In `schemas/case.schema.json`, replace the `transcriptRule` definition under `$defs`
with a discriminated pair. The `assertion` definition is left alone here; Task 3 extends
it.

```json
    "commandMatcher": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "check", "executor", "argsPrefix"],
      "properties": {
        "id": { "$ref": "#/$defs/id" },
        "check": { "enum": ["command_ran", "command_before_file_change", "command_after_file_change"] },
        "executor": { "type": "string", "minLength": 1 },
        "argsPrefix": { "type": "array", "items": { "type": "string" } },
        "expect": { "type": "boolean" }
      }
    },
    "eventPresence": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "check"],
      "properties": {
        "id": { "$ref": "#/$defs/id" },
        "check": { "enum": ["no_file_change", "assistant_message"] },
        "expect": { "type": "boolean" }
      }
    },
    "transcriptRule": {
      "oneOf": [
        { "$ref": "#/$defs/eventPresence" },
        { "$ref": "#/$defs/commandMatcher" }
      ]
    }
```

Append the two matching schema tests to `tests/schemas/validator.test.ts`:

```ts
test("rejects the removed free-form transcript rule shape", async () => {
  const validator = await ManifestValidator.create(schemaDirectory);
  assert.throws(
    () => validator.validateCase({
      ...baseCase,
      transcriptRules: [{ id: "stopped", event: "assistant_message", beforeStepId: "s2" }],
    }),
    /case manifest/,
  );
});

test("rejects a command rule without a matcher", async () => {
  const validator = await ManifestValidator.create(schemaDirectory);
  assert.throws(
    () => validator.validateCase({
      ...baseCase,
      transcriptRules: [{ id: "tested", check: "command_ran" }],
    }),
    /case manifest/,
  );
});
```

If `tests/schemas/validator.test.ts` has no `baseCase` helper holding a minimal
schema-valid case manifest, add one and reuse it.

- [ ] **Step 5: Delete the obsolete `beforeStepId` validation**

In `src/catalog/load-catalog.ts`, delete the second loop of `validateTranscriptReferences`
(the `beforeStepId` block) and remove `"TRANSCRIPT_STEP_NOT_FOUND"` from
`CatalogIssueCode`. Delete the test in `tests/catalog/load-catalog.test.ts` asserting
`TRANSCRIPT_STEP_NOT_FOUND`, and rewrite any test fixture still declaring `event` or
`beforeStepId` on a rule into the typed shape, for example
`{ id: "stopped", check: "no_file_change" }`.

- [ ] **Step 6: Implement the evaluator**

Create `src/runs/transcript-rules.ts`:

```ts
import type { CommandMatcher, TranscriptRule } from "../domain/model.js";
import type { TranscriptEvent } from "../runtime/runtime-adapter.js";

export interface TranscriptRuleOutcome {
  readonly ruleId: string;
  /** Whether the check itself holds, before `expect` is applied. */
  readonly held: boolean;
  /** Whether the rule is satisfied: `held` equals the expected value. */
  readonly satisfied: boolean;
  readonly detail: string;
}

export function evaluateRules(
  rules: readonly TranscriptRule[],
  events: readonly TranscriptEvent[],
): readonly TranscriptRuleOutcome[] {
  return Object.freeze(rules.map((rule) => evaluateRule(rule, events)));
}

export function evaluateRule(
  rule: TranscriptRule,
  events: readonly TranscriptEvent[],
): TranscriptRuleOutcome {
  const held = holds(rule, events);
  const expected = rule.expect ?? true;
  return Object.freeze({
    ruleId: rule.id,
    held,
    satisfied: held === expected,
    detail: `${rule.check} ${held ? "held" : "did not hold"}; expected ${expected ? "true" : "false"}`,
  });
}

function holds(rule: TranscriptRule, events: readonly TranscriptEvent[]): boolean {
  switch (rule.check) {
    case "no_file_change":
      return firstChangeIndex(events) === -1;
    case "assistant_message":
      return events.some((event) => event.type === "assistant_message");
    case "command_ran":
      return firstCommandIndex(events, rule) !== -1;
    case "command_before_file_change": {
      const command = firstCommandIndex(events, rule);
      if (command === -1) return false;
      const change = firstChangeIndex(events);
      return change === -1 || command < change;
    }
    case "command_after_file_change": {
      const command = lastCommandIndex(events, rule);
      if (command === -1) return false;
      const change = lastChangeIndex(events);
      return change === -1 || command > change;
    }
  }
}

function matchesCommand(event: TranscriptEvent, matcher: CommandMatcher): boolean {
  return event.type === "command" &&
    event.executor === matcher.executor &&
    matcher.argsPrefix.every((argument, index) => event.args[index] === argument);
}

function firstCommandIndex(events: readonly TranscriptEvent[], matcher: CommandMatcher): number {
  return events.findIndex((event) => matchesCommand(event, matcher));
}

function lastCommandIndex(events: readonly TranscriptEvent[], matcher: CommandMatcher): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && matchesCommand(event, matcher)) return index;
  }
  return -1;
}

function firstChangeIndex(events: readonly TranscriptEvent[]): number {
  return events.findIndex((event) => event.type === "file_change");
}

function lastChangeIndex(events: readonly TranscriptEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "file_change") return index;
  }
  return -1;
}
```

Note that `holds` receives `TranscriptRule` and narrows on `rule.check`; the
`CommandMatcher` fields are available on the three command branches.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/runs/transcript-rules.ts src/domain/model.ts schemas/case.schema.json src/catalog/load-catalog.ts tests/runs/transcript-rules.test.ts tests/schemas/validator.test.ts tests/catalog/load-catalog.test.ts
git commit -m "$(cat <<'EOF'
feat: evaluate typed transcript rules over normalized events

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Transcript-graded assertions

**Files:**
- Modify: `schemas/case.schema.json` (the `assertion` definition only)
- Modify: `src/domain/model.ts:22-26` (`AssertionDeclaration`)
- Test: `tests/schemas/validator.test.ts`

**Interfaces:**
- Consumes: `TranscriptRule` and the typed rule schema from Task 2.
- Produces: `AssertionDeclaration.transcriptRuleId?: string`, and a case schema that accepts it.

- [ ] **Step 1: Write the failing test**

Append to `tests/schemas/validator.test.ts`:

```ts
test("accepts typed transcript rules and a transcript-graded assertion", async () => {
  const validator = await ManifestValidator.create(schemaDirectory);
  const manifest = validator.validateCase({
    ...baseCase,
    promptSteps: [
      { id: "s1", prompt: "ask first", continuation: { eventRuleIds: ["stopped"] } },
      { id: "s2", prompt: "now do it" },
    ],
    transcriptRules: [
      { id: "stopped", check: "no_file_change" },
      { id: "tested", check: "command_before_file_change", executor: "node", argsPrefix: ["--test"] },
    ],
    assertions: [
      { id: "A1", dimension: "functional", critical: true },
      { id: "A2", dimension: "process", critical: false, transcriptRuleId: "stopped" },
    ],
  });

  assert.equal(manifest.transcriptRules?.[0]?.check, "no_file_change");
  assert.equal(manifest.assertions[1]?.transcriptRuleId, "stopped");
});

test("rejects an unknown field on an assertion", async () => {
  const validator = await ManifestValidator.create(schemaDirectory);
  assert.throws(
    () => validator.validateCase({
      ...baseCase,
      assertions: [{ id: "A1", dimension: "functional", critical: true, gradedBy: "transcript" }],
    }),
    /case manifest/,
  );
});
```

Task 2 already added the `baseCase` helper holding a minimal schema-valid case manifest;
reuse it.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --test-name-pattern="transcript-graded assertion"`
Expected: FAIL — `transcriptRuleId` is not an allowed assertion property.

- [ ] **Step 3: Extend the assertion definition**

In `schemas/case.schema.json`, replace the `assertion` definition:

```json
    "assertion": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "dimension", "critical"],
      "properties": {
        "id": { "$ref": "#/$defs/id" },
        "dimension": { "enum": ["functional", "regression", "security", "scope", "process"] },
        "critical": { "type": "boolean" },
        "transcriptRuleId": { "$ref": "#/$defs/id" }
      }
    }
```

- [ ] **Step 4: Update the assertion declaration**

In `src/domain/model.ts`:

```ts
export interface AssertionDeclaration {
  readonly id: string;
  readonly dimension: "functional" | "regression" | "security" | "scope" | "process";
  readonly critical: boolean;
  /** When set, SkillBench grades this assertion from the named rule and the oracle must not cover it. */
  readonly transcriptRuleId?: string;
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add schemas/case.schema.json src/domain/model.ts tests/schemas/validator.test.ts
git commit -m "$(cat <<'EOF'
feat: type the transcript rule schema and evaluate rules over events

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Narrowed oracle coverage and rule reference validation

**Files:**
- Modify: `src/oracles/oracle-manifest.ts:30-52`
- Modify: `src/catalog/load-catalog.ts` (`CatalogIssueCode`, `validateTranscriptReferences`)
- Test: `tests/oracles/oracle-manifest.test.ts`
- Test: `tests/catalog/load-catalog.test.ts`

**Interfaces:**
- Consumes: `AssertionDeclaration.transcriptRuleId` from Task 3.
- Produces: `assertOracleCoversAssertions` that ignores transcript-graded assertions and rejects oracle checks for them; catalog issue codes `TRANSCRIPT_RULE_NOT_FOUND` and `TRANSCRIPT_RULE_REUSED`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/oracles/oracle-manifest.test.ts`:

```ts
test("a transcript-graded assertion needs no oracle check", () => {
  assert.doesNotThrow(() => assertOracleCoversAssertions(
    { schemaVersion: 1, caseId: "C1", checks: [oracleCheck("A1")] },
    [
      { id: "A1", dimension: "functional", critical: true },
      { id: "A2", dimension: "process", critical: false, transcriptRuleId: "stopped" },
    ],
  ));
});

test("the oracle must not cover a transcript-graded assertion", () => {
  assert.throws(
    () => assertOracleCoversAssertions(
      { schemaVersion: 1, caseId: "C1", checks: [oracleCheck("A1"), oracleCheck("A2")] },
      [
        { id: "A1", dimension: "functional", critical: true },
        { id: "A2", dimension: "process", critical: false, transcriptRuleId: "stopped" },
      ],
    ),
    /graded from the transcript/,
  );
});
```

Add an `oracleCheck(assertionId)` helper returning a minimal valid `OracleCheck` if the file has none.

Append to `tests/catalog/load-catalog.test.ts` cases asserting these issue codes, following the file's existing pattern of writing a case manifest into a temporary project and reading `catalog.issues`:

- an assertion whose `transcriptRuleId` names no declared rule produces `TRANSCRIPT_RULE_NOT_FOUND`;
- two assertions naming the same rule produce `TRANSCRIPT_RULE_REUSED`;
- two prompt steps whose continuations list the same rule produce `TRANSCRIPT_RULE_REUSED`;
- a rule referenced by neither a continuation nor an assertion produces no issue.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --test-name-pattern="transcript-graded|TRANSCRIPT_RULE"`
Expected: FAIL.

- [ ] **Step 3: Narrow the oracle coverage rule**

Replace the body of `assertOracleCoversAssertions` in `src/oracles/oracle-manifest.ts`:

```ts
export function assertOracleCoversAssertions(
  manifest: OracleManifest,
  assertions: readonly AssertionDeclaration[],
): void {
  const checkIds = new Set<string>();
  for (const check of manifest.checks) {
    if (checkIds.has(check.assertionId)) {
      throw new ValidationError(`oracle assertion ID ${JSON.stringify(check.assertionId)} is duplicated`);
    }
    checkIds.add(check.assertionId);
  }

  const transcriptGraded = new Set(
    assertions.filter(({ transcriptRuleId }) => transcriptRuleId !== undefined).map(({ id }) => id),
  );
  const oracleGraded = new Set(
    assertions.filter(({ transcriptRuleId }) => transcriptRuleId === undefined).map(({ id }) => id),
  );

  const overlapping = [...checkIds].filter((id) => transcriptGraded.has(id)).sort();
  if (overlapping.length > 0) {
    throw new ValidationError(
      `oracle declares check(s) for assertion(s) graded from the transcript: ${overlapping.join(", ")}`,
    );
  }

  const extra = [...checkIds].filter((id) => !oracleGraded.has(id)).sort();
  if (extra.length > 0) {
    throw new ValidationError(`oracle declares check(s) for undeclared assertion(s): ${extra.join(", ")}`);
  }

  const missing = [...oracleGraded].filter((id) => !checkIds.has(id)).sort();
  if (missing.length > 0) {
    throw new ValidationError(`oracle has no check for declared assertion(s): ${missing.join(", ")}`);
  }
}
```

- [ ] **Step 4: Validate rule references in the catalog**

Add `"TRANSCRIPT_RULE_NOT_FOUND"` and `"TRANSCRIPT_RULE_REUSED"` to `CatalogIssueCode`, keeping the union alphabetically sorted, and extend `validateTranscriptReferences`:

```ts
function validateTranscriptReferences(
  manifest: CaseManifest,
  source: string,
  issues: CatalogIssue[],
): void {
  const transcriptRuleIds = new Set((manifest.transcriptRules ?? []).map(({ id }) => id));
  const referencedBy = new Map<string, string>();

  for (const step of manifest.promptSteps) {
    for (const ruleId of step.continuation?.eventRuleIds ?? []) {
      if (!transcriptRuleIds.has(ruleId)) {
        addIssue(
          issues,
          source,
          "CONTINUATION_RULE_NOT_FOUND",
          `prompt step ${JSON.stringify(step.id)} references missing transcript rule ${JSON.stringify(ruleId)}`,
        );
        continue;
      }
      claimRule(ruleId, `prompt step ${JSON.stringify(step.id)}`, referencedBy, source, issues);
    }
  }

  const gradedBy = new Map<string, string>();
  for (const assertion of manifest.assertions) {
    const ruleId = assertion.transcriptRuleId;
    if (ruleId === undefined) continue;
    if (!transcriptRuleIds.has(ruleId)) {
      addIssue(
        issues,
        source,
        "TRANSCRIPT_RULE_NOT_FOUND",
        `assertion ${JSON.stringify(assertion.id)} references missing transcript rule ${JSON.stringify(ruleId)}`,
      );
      continue;
    }
    claimRule(ruleId, `assertion ${JSON.stringify(assertion.id)}`, gradedBy, source, issues);
  }
}

function claimRule(
  ruleId: string,
  claimant: string,
  claims: Map<string, string>,
  source: string,
  issues: CatalogIssue[],
): void {
  const existing = claims.get(ruleId);
  if (existing === undefined) {
    claims.set(ruleId, claimant);
    return;
  }
  addIssue(
    issues,
    source,
    "TRANSCRIPT_RULE_REUSED",
    `transcript rule ${JSON.stringify(ruleId)} is claimed by ${existing} and ${claimant}`,
  );
}
```

Continuation claims and grading claims are tracked separately: one rule may both gate a continuation and grade an assertion, but it may not be gated twice or grade twice.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/oracles/oracle-manifest.ts src/catalog/load-catalog.ts tests/oracles/oracle-manifest.test.ts tests/catalog/load-catalog.test.ts
git commit -m "$(cat <<'EOF'
feat: split oracle and transcript grading across declared assertions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Evaluate rules during a run and record the results

**Files:**
- Modify: `src/oracles/run-oracle.ts:8-16,132-148` (`AssertionResult`, `build`)
- Modify: `src/runs/result.ts:9-41`
- Modify: `src/runs/execute-run.ts`
- Test: `tests/runs/execute-run.test.ts`

**Interfaces:**
- Consumes: `evaluateRules` from Task 2, `RuntimeExecution.exhaustion` from Task 1.
- Produces: `AssertionResult.source`; `PipelineStep` including `"oracle_setup"`; `RunResult.transcriptRuleOutcomes`; `executeRun` behavior that gates continuations and merges both grading sources.

- [ ] **Step 1: Write the failing tests**

Append to `tests/runs/execute-run.test.ts`, following the file's existing pattern for building a temporary project and a `FakeAdapter`:

```ts
test("grades a transcript assertion at the continuation point and proceeds anyway", async () => {
  // Case: step s1 declares continuation rule "stopped" (no_file_change);
  // assertion A2 is graded from it; the fake script edits a file during s1.
  const result = await runWithScript({
    transcriptRules: [{ id: "stopped", check: "no_file_change" }],
    assertions: [
      { id: "A1", dimension: "functional", critical: true },
      { id: "A2", dimension: "process", critical: false, transcriptRuleId: "stopped" },
    ],
    promptSteps: [
      { id: "s1", prompt: "ask first", continuation: { eventRuleIds: ["stopped"] } },
      { id: "s2", prompt: "now do it" },
    ],
    scriptSteps: [
      { stepId: "s1", events: [{ type: "file_change", afterMs: 1, paths: ["src/a.js"], outsidePaths: [] }] },
      { stepId: "s2", events: [] },
    ],
  });

  const graded = result.assertions.find((assertion) => assertion.assertionId === "A2");
  assert.equal(graded?.outcome, "failed");
  assert.equal(graded?.source, "transcript");
  assert.equal(result.assertions.find((assertion) => assertion.assertionId === "A1")?.source, "oracle");
  assert.equal(result.transcriptRuleOutcomes.length, 1);
  // The violation does not stop the run: both declared steps were sent.
  assert.equal(result.events.filter((event) => event.type === "prompt_sent").length, 2);
});

test("evaluates an unreferenced rule after the session closes", async () => {
  const result = await runWithScript({
    transcriptRules: [{ id: "spoke", check: "assistant_message" }],
    assertions: [{ id: "A1", dimension: "functional", critical: true }],
    promptSteps: [{ id: "s1", prompt: "go" }],
    scriptSteps: [{ stepId: "s1", events: [{ type: "assistant_message", afterMs: 1, text: "hi" }] }],
  });

  assert.deepEqual(
    result.transcriptRuleOutcomes.map((outcome) => [outcome.ruleId, outcome.satisfied]),
    [["spoke", true]],
  );
});

test("reads the exhaustion cause from the adapter instead of guessing", async () => {
  const result = await runWithScript({ exhaustion: "wall_clock" });
  assert.equal(result.status, "exhausted");

  const finished = await runWithScript({ exhaustion: null, usage: { inputTokens: 5000, outputTokens: 5000 } });
  assert.equal(finished.status, "completed");
});

test("attributes an oracle lifecycle fault to the oracle_setup step", async () => {
  // Remove the private oracle directory after freezing so lifecycle creation fails.
  const result = await runWithMissingOracleDirectory();
  assert.equal(result.status, "errored");
  assert.equal(result.failedStep, "oracle_setup");
});
```

`runWithScript` is a local helper in this test file that assembles a temporary project with the given case fields and runs `executeRun` with a `FakeAdapter`. Add `result.events` to the helper's return value by reading the written `transcript.json`, or assert on the transcript file directly if the existing tests already do so.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --test-name-pattern="continuation point|exhaustion cause from the adapter|oracle_setup"`
Expected: FAIL.

- [ ] **Step 3: Add the assertion source**

In `src/oracles/run-oracle.ts`, add `readonly source: "oracle" | "transcript";` to `AssertionResult` and set `source: "oracle"` inside `build`.

- [ ] **Step 4: Extend the result shape**

In `src/runs/result.ts`:

```ts
export type PipelineStep =
  | "materialize"
  | "install"
  | "baseline_snapshot"
  | "oracle_setup"
  | "execute"
  | "final_snapshot"
  | "grade"
  | "verify_fixture";
```

and add to `RunResult`:

```ts
  readonly transcriptRuleOutcomes: readonly TranscriptRuleOutcome[];
```

importing `TranscriptRuleOutcome` from `./transcript-rules.js`.

- [ ] **Step 5: Wire evaluation into the run**

In `src/runs/execute-run.ts`, add the imports, collect outcomes, split the pipeline step, and drop `isExhausted`:

```ts
import { evaluateRules, type TranscriptRule, type TranscriptRuleOutcome } from "./transcript-rules.js";
```

Inside `executeRun`, before the `try` block:

```ts
  const ruleOutcomes: TranscriptRuleOutcome[] = [];
  const rules: readonly TranscriptRule[] = input.catalogCase.manifest.transcriptRules ?? [];
  const gatedRuleIds = new Set(
    input.catalogCase.manifest.promptSteps.flatMap((step) => [...(step.continuation?.eventRuleIds ?? [])]),
  );
```

Replace the `step = "execute"` block:

```ts
    step = "oracle_setup";
    lifecycle = await OracleLifecycle.create({
      paths: input.paths,
      caseId: input.catalogCase.manifest.id,
      workspacePath: workspace.workspacePath,
      ...(input.tempParent === undefined ? {} : { tempParent: input.tempParent }),
    });

    step = "execute";
    execution = await input.adapter.execute({
      workspace: workspace.workspacePath,
      promptSteps: input.catalogCase.manifest.promptSteps,
      config: {
        model: input.configuration.model,
        reasoningEffort: input.configuration.reasoningEffort,
        sandbox: input.configuration.sandbox,
        limits: input.catalogCase.manifest.limits,
        environment: input.variant.manifest.environment,
      },
      onContinuation: async (continuedStep, events) => {
        const gated = rules.filter((rule) => (continuedStep.continuation?.eventRuleIds ?? []).includes(rule.id));
        ruleOutcomes.push(...evaluateRules(gated, events));
      },
    });
    ruleOutcomes.push(...evaluateRules(rules.filter((rule) => !gatedRuleIds.has(rule.id)), execution.events));
    await writer.writeTranscript(execution);
```

Replace the status line at the end of the `try` block:

```ts
    status = execution.exhaustion === null ? "completed" : "exhausted";
```

After the oracle results are collected in the `grade` step, merge the transcript-graded assertions:

```ts
    assertions = mergeAssertions(input.catalogCase.manifest.assertions, assertions, ruleOutcomes);
```

Add the merge helper and delete `isExhausted` and `outputBytes`:

```ts
function mergeAssertions(
  declarations: readonly AssertionDeclaration[],
  oracleResults: readonly AssertionResult[],
  outcomes: readonly TranscriptRuleOutcome[],
): readonly AssertionResult[] {
  const oracleById = new Map(oracleResults.map((result) => [result.assertionId, result]));
  const outcomeById = new Map(outcomes.map((outcome) => [outcome.ruleId, outcome]));

  return Object.freeze(declarations.map((declaration) => {
    if (declaration.transcriptRuleId === undefined) {
      const result = oracleById.get(declaration.id);
      if (result === undefined) {
        throw new Error(`assertion ${declaration.id} has no oracle result after coverage validation`);
      }
      return result;
    }

    const outcome = outcomeById.get(declaration.transcriptRuleId);
    return Object.freeze({
      assertionId: declaration.id,
      dimension: declaration.dimension,
      critical: declaration.critical,
      outcome: outcome === undefined ? "error" : outcome.satisfied ? "passed" : "failed",
      exitCode: null,
      durationMs: 0,
      detail: outcome?.detail ?? `transcript rule ${declaration.transcriptRuleId} was never evaluated`,
      source: "transcript",
    } as const);
  }));
}
```

Add `transcriptRuleOutcomes: Object.freeze([...ruleOutcomes])` to the `RunResult` literal.
Import `AssertionDeclaration` from `../domain/model.js`.

Extend `RunEvidenceWriter#writeTranscript` to take the outcomes and record the adapter's
new fields:

```ts
  public async writeTranscript(
    execution: RuntimeExecution,
    ruleOutcomes: readonly TranscriptRuleOutcome[],
  ): Promise<void> {
    await this.store.write(`${this.directory}/transcript.json`, {
      schemaVersion: 1,
      runId: this.manifest.runId,
      events: execution.events,
      process: execution.process,
      usage: execution.usage,
      elapsedMs: execution.elapsedMs,
      exhaustion: execution.exhaustion,
      unparsedLines: execution.unparsedLines,
      transcriptRuleOutcomes: ruleOutcomes,
      metadata: execution.metadata,
    });
  }
```

and call it as `await writer.writeTranscript(execution, ruleOutcomes)`.

Note: `runOracle` is called with the full declaration list today. Pass only the oracle-graded declarations:

```ts
    assertions = await runOracle({
      manifest: oracleManifest,
      assertions: input.catalogCase.manifest.assertions.filter(
        ({ transcriptRuleId }) => transcriptRuleId === undefined,
      ),
      gradingPath: mounted.gradingPath,
      workspacePath: workspace.workspacePath,
    });
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/oracles/run-oracle.ts src/runs/result.ts src/runs/execute-run.ts tests/runs/execute-run.test.ts
git commit -m "$(cat <<'EOF'
feat: gate continuations on transcript rules and merge both grading sources

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Shell command normalization

**Files:**
- Create: `src/runtime/codex/normalize-command.ts`
- Test: `tests/runtime/codex/normalize-command.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CommandRecord { executor, args }` and `normalizeCommand(command: string): readonly CommandRecord[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/codex/normalize-command.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCommand } from "../../../src/runtime/codex/normalize-command.js";

test("splits a shell wrapper into its executor and arguments", () => {
  assert.deepEqual(normalizeCommand('/bin/zsh -lc "node --test tests/"'), [
    { executor: "node", args: ["--test", "tests/"] },
  ]);
});

test("splits chained segments into separate records", () => {
  assert.deepEqual(normalizeCommand('/bin/bash -lc "cd app && node --test"'), [
    { executor: "cd", args: ["app"] },
    { executor: "node", args: ["--test"] },
  ]);
});

test("splits on every supported separator", () => {
  assert.deepEqual(normalizeCommand("/bin/sh -c 'a; b | c || d'"), [
    { executor: "a", args: [] },
    { executor: "b", args: [] },
    { executor: "c", args: [] },
    { executor: "d", args: [] },
  ]);
});

test("strips matching quotes around a token", () => {
  assert.deepEqual(normalizeCommand(`/bin/zsh -lc "sed -n '1,240p' note.txt"`), [
    { executor: "sed", args: ["-n", "1,240p", "note.txt"] },
  ]);
});

test("treats a bare invocation as one record", () => {
  assert.deepEqual(normalizeCommand("node --test"), [{ executor: "node", args: ["--test"] }]);
});

test("keeps an unsplittable script as a single record under the shell", () => {
  assert.deepEqual(normalizeCommand("/bin/zsh -lc"), [{ executor: "/bin/zsh", args: ["-lc"] }]);
});

test("returns no records for an empty command", () => {
  assert.deepEqual(normalizeCommand("   "), []);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --test-name-pattern="shell wrapper"`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the normalizer**

Create `src/runtime/codex/normalize-command.ts`:

```ts
export interface CommandRecord {
  readonly executor: string;
  readonly args: readonly string[];
}

const shellFlags = new Set(["-lc", "-c", "-lic"]);

/**
 * Turns one reported command string into command records. The runtime reports a
 * command as text, usually wrapped in a login shell. Nothing here is executed and
 * nothing is expanded: this is a matcher's view of what ran, not a shell.
 */
export function normalizeCommand(command: string): readonly CommandRecord[] {
  const tokens = tokenize(command);
  if (tokens.length === 0) return Object.freeze([]);

  const script = unwrapShell(tokens);
  if (script === undefined) {
    return Object.freeze([record(tokens)].filter(isRecord));
  }

  const records: CommandRecord[] = [];
  for (const segment of script.split(/&&|\|\||;|\||\n/u)) {
    const built = record(tokenize(segment));
    if (built !== undefined) records.push(built);
  }
  return Object.freeze(records);
}

function unwrapShell(tokens: readonly string[]): string | undefined {
  const [executable, flag, script] = tokens;
  if (executable === undefined || flag === undefined || script === undefined) return undefined;
  if (tokens.length !== 3 || !shellFlags.has(flag)) return undefined;
  return script;
}

function record(tokens: readonly string[]): CommandRecord | undefined {
  const [executor, ...args] = tokens;
  if (executor === undefined) return undefined;
  return Object.freeze({ executor, args: Object.freeze(args) });
}

function isRecord(value: CommandRecord | undefined): value is CommandRecord {
  return value !== undefined;
}

function tokenize(text: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const character of text) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }

  if (current !== "") tokens.push(current);
  return tokens;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/codex/normalize-command.ts tests/runtime/codex/normalize-command.test.ts
git commit -m "$(cat <<'EOF'
feat: normalize reported shell commands into matchable records

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Stream parsing against the captured samples

**Files:**
- Create: `src/runtime/codex/parse-events.ts`
- Test: `tests/runtime/codex/parse-events.test.ts`
- Read: `tests/data/codex/sample-first-step.jsonl`, `tests/data/codex/sample-resumed-step.jsonl`

**Interfaces:**
- Consumes: `normalizeCommand` from Task 6, `TranscriptEvent` from Task 1.
- Produces: `ParsedLine { events, threadId, usage, recognized }` and `parseCodexLine(line, context)` where `context` is `{ atMs: number; workspace: string }`.

The samples were captured from `codex-cli 0.151.0` while designing this stage. Their absolute paths were rewritten to `/workspace/...` and long command output was truncated; the event shapes are otherwise untouched. Do not regenerate them — a live capture costs money and would introduce different identifiers.

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/codex/parse-events.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseCodexLine } from "../../../src/runtime/codex/parse-events.js";
import type { TranscriptEvent } from "../../../src/runtime/runtime-adapter.js";

const workspace = "/workspace";

async function parseSample(name: string): Promise<{
  readonly events: readonly TranscriptEvent[];
  readonly threadId: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly unrecognized: number;
}> {
  const path = fileURLToPath(new URL(`../../data/codex/${name}`, import.meta.url));
  const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");

  const events: TranscriptEvent[] = [];
  let threadId: string | null = null;
  let usage: { readonly inputTokens: number; readonly outputTokens: number } | null = null;
  let unrecognized = 0;

  for (const [index, line] of lines.entries()) {
    const parsed = parseCodexLine(line, { atMs: index, workspace });
    events.push(...parsed.events);
    threadId = parsed.threadId ?? threadId;
    usage = parsed.usage ?? usage;
    if (!parsed.recognized) unrecognized += 1;
  }

  return { events, threadId, usage, unrecognized };
}

test("parses the captured first step", async () => {
  const { events, threadId, usage } = await parseSample("sample-first-step.jsonl");

  assert.equal(threadId, "01a05672-40b8-7db1-823a-39a2fc5a735f");
  assert.deepEqual(usage, { inputTokens: 31504, outputTokens: 80 });
  assert.deepEqual(events.map((event) => event.type), [
    "assistant_message",
    "file_change",
    "assistant_message",
    "completion_claim",
  ]);

  const change = events.find((event) => event.type === "file_change");
  assert.deepEqual(change?.type === "file_change" ? change.paths : null, ["note.txt"]);
  assert.deepEqual(change?.type === "file_change" ? change.outsidePaths : null, []);
});

test("parses the captured resumed step, including commands", async () => {
  const { events, threadId } = await parseSample("sample-resumed-step.jsonl");

  assert.equal(threadId, "01a05672-40b8-7db1-823a-39a2fc5a735f");
  const commands = events.filter((event) => event.type === "command");
  assert.equal(commands.length, 2);
  assert.equal(commands[0]?.type === "command" ? commands[0].executor : null, "sed");
  assert.equal(commands[1]?.type === "command" ? commands[1].executor : null, "od");
});

test("ignores item.started so items are not counted twice", () => {
  const line = JSON.stringify({
    type: "item.started",
    item: { id: "item_1", type: "file_change", changes: [{ path: "/workspace/a.js", kind: "update" }], status: "in_progress" },
  });
  const parsed = parseCodexLine(line, { atMs: 0, workspace });
  assert.deepEqual(parsed.events, []);
  assert.equal(parsed.recognized, true);
});

test("keeps a path outside the workspace verbatim", () => {
  const line = JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "file_change", changes: [{ path: "/etc/hosts", kind: "update" }], status: "completed" },
  });
  const [event] = parseCodexLine(line, { atMs: 0, workspace }).events;
  assert.deepEqual(event?.type === "file_change" ? event.paths : null, []);
  assert.deepEqual(event?.type === "file_change" ? event.outsidePaths : null, ["/etc/hosts"]);
});

test("reports an unrecognized line without throwing", () => {
  const parsed = parseCodexLine("not json at all", { atMs: 0, workspace });
  assert.equal(parsed.recognized, false);
  assert.deepEqual(parsed.events, []);
  assert.equal(parsed.threadId, null);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --test-name-pattern="captured first step"`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the parser**

Create `src/runtime/codex/parse-events.ts`:

```ts
import { relative, isAbsolute } from "node:path";
import type { TranscriptEvent } from "../runtime-adapter.js";
import { normalizeCommand } from "./normalize-command.js";

export interface ParseContext {
  readonly atMs: number;
  readonly workspace: string;
}

export interface ParsedLine {
  readonly events: readonly TranscriptEvent[];
  readonly threadId: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  /** False when the line is not JSON or carries no shape this adapter knows. */
  readonly recognized: boolean;
}

const nothing: ParsedLine = Object.freeze({
  events: Object.freeze([]),
  threadId: null,
  usage: null,
  recognized: true,
});

const unrecognized: ParsedLine = Object.freeze({ ...nothing, recognized: false });

export function parseCodexLine(line: string, context: ParseContext): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return unrecognized;
  }
  if (!isRecord(value) || typeof value["type"] !== "string") return unrecognized;

  switch (value["type"]) {
    case "thread.started":
      return typeof value["thread_id"] === "string"
        ? Object.freeze({ ...nothing, threadId: value["thread_id"] })
        : unrecognized;
    case "turn.started":
      return nothing;
    case "turn.completed":
      return Object.freeze({
        ...nothing,
        events: Object.freeze([
          Object.freeze({ type: "completion_claim" as const, atMs: context.atMs, text: "" }),
        ]),
        usage: readUsage(value["usage"]),
      });
    case "item.started":
      return nothing;
    case "item.completed":
      return parseItem(value["item"], context);
    default:
      return unrecognized;
  }
}

function parseItem(item: unknown, context: ParseContext): ParsedLine {
  if (!isRecord(item) || typeof item["type"] !== "string") return unrecognized;

  switch (item["type"]) {
    case "agent_message":
      return typeof item["text"] === "string"
        ? withEvents([Object.freeze({ type: "assistant_message" as const, atMs: context.atMs, text: item["text"] })])
        : unrecognized;
    case "command_execution":
      return typeof item["command"] === "string"
        ? withEvents(normalizeCommand(item["command"]).map((record) => Object.freeze({
            type: "command" as const,
            atMs: context.atMs,
            executor: record.executor,
            args: Object.freeze([...record.args]),
            exitCode: typeof item["exit_code"] === "number" ? item["exit_code"] : 0,
          })))
        : unrecognized;
    case "file_change":
      return withEvents([buildFileChange(item["changes"], context)]);
    default:
      return unrecognized;
  }
}

function buildFileChange(changes: unknown, context: ParseContext): TranscriptEvent {
  const paths: string[] = [];
  const outsidePaths: string[] = [];

  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (!isRecord(change) || typeof change["path"] !== "string") continue;
      const absolute = change["path"];
      const relativePath = relative(context.workspace, absolute);
      if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
        outsidePaths.push(absolute);
      } else {
        paths.push(relativePath.replaceAll("\\", "/"));
      }
    }
  }

  paths.sort();
  outsidePaths.sort();
  return Object.freeze({
    type: "file_change",
    atMs: context.atMs,
    paths: Object.freeze(paths),
    outsidePaths: Object.freeze(outsidePaths),
  });
}

function readUsage(usage: unknown): { readonly inputTokens: number; readonly outputTokens: number } | null {
  if (!isRecord(usage)) return null;
  const inputTokens = usage["input_tokens"];
  const outputTokens = usage["output_tokens"];
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  return Object.freeze({ inputTokens, outputTokens });
}

function withEvents(events: readonly TranscriptEvent[]): ParsedLine {
  return Object.freeze({ ...nothing, events: Object.freeze([...events]) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/codex/parse-events.ts tests/runtime/codex/parse-events.test.ts tests/data/codex
git commit -m "$(cat <<'EOF'
feat: parse the codex event stream into normalized transcript events

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Command construction

**Files:**
- Create: `src/runtime/codex/build-command.ts`
- Test: `tests/runtime/codex/build-command.test.ts`

**Interfaces:**
- Consumes: `DependencyError` from `src/domain/errors.js`.
- Produces: `buildCodexCommand(input): { executable, args }` and `mapSandbox(sandbox): string`.

`codex exec resume` rejects `--cd`, `--sandbox`, and `--color`; both forms accept `-c key=value`. The sandbox and reasoning settings therefore travel as configuration overrides on every step, and the working directory is set on the spawned child rather than on the command line for resumed steps. Getting this wrong is silent: a resumed step falls back to a read-only policy and the agent's edits quietly do not apply.

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/codex/build-command.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DependencyError } from "../../../src/domain/errors.js";
import { buildCodexCommand, mapSandbox } from "../../../src/runtime/codex/build-command.js";

const base = {
  executable: "codex",
  model: "gpt-5-codex",
  reasoningEffort: "medium",
  sandbox: "workspace-write",
  workspace: "/tmp/ws",
};

test("builds the first step with the workspace and both overrides", () => {
  assert.deepEqual(buildCodexCommand({ ...base, threadId: null }), {
    executable: "codex",
    args: [
      "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
      "-C", "/tmp/ws", "-m", "gpt-5-codex",
      "-c", "model_reasoning_effort=medium",
      "-c", "sandbox_mode=workspace-write",
      "-",
    ],
  });
});

test("builds a resumed step without the rejected options and with the same overrides", () => {
  assert.deepEqual(buildCodexCommand({ ...base, threadId: "thread-1" }), {
    executable: "codex",
    args: [
      "exec", "resume", "thread-1", "--json", "--skip-git-repo-check", "--ignore-user-config",
      "-m", "gpt-5-codex",
      "-c", "model_reasoning_effort=medium",
      "-c", "sandbox_mode=workspace-write",
      "-",
    ],
  });
});

test("maps every supported sandbox name", () => {
  assert.equal(mapSandbox("read-only"), "read-only");
  assert.equal(mapSandbox("workspace-write"), "workspace-write");
  assert.equal(mapSandbox("danger-full-access"), "danger-full-access");
});

test("rejects an unmapped sandbox name before anything is spawned", () => {
  assert.throws(() => mapSandbox("wide-open"), DependencyError);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --test-name-pattern="builds the first step"`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the builder**

Create `src/runtime/codex/build-command.ts`:

```ts
import { DependencyError } from "../../domain/errors.js";

export interface CodexCommandInput {
  readonly executable: string;
  /** Null on the first step; the thread to resume on every later step. */
  readonly threadId: string | null;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sandbox: string;
  readonly workspace: string;
}

export interface CodexCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

const sandboxModes = new Set(["read-only", "workspace-write", "danger-full-access"]);

export function mapSandbox(sandbox: string): string {
  if (!sandboxModes.has(sandbox)) {
    throw new DependencyError(
      `sandbox ${JSON.stringify(sandbox)} is not supported by the codex runtime; supported: ${[...sandboxModes].sort().join(", ")}`,
    );
  }
  return sandbox;
}

export function buildCodexCommand(input: CodexCommandInput): CodexCommand {
  const sandboxMode = mapSandbox(input.sandbox);
  // `codex exec resume` rejects --cd, --sandbox, and --color, so the sandbox
  // travels as a config override on both forms and the working directory is set
  // on the spawned child for resumed steps.
  const overrides = [
    "-m", input.model,
    "-c", `model_reasoning_effort=${input.reasoningEffort}`,
    "-c", `sandbox_mode=${sandboxMode}`,
    "-",
  ];
  const common = ["--json", "--skip-git-repo-check", "--ignore-user-config"];

  return Object.freeze({
    executable: input.executable,
    args: Object.freeze(input.threadId === null
      ? ["exec", ...common, "-C", input.workspace, ...overrides]
      : ["exec", "resume", input.threadId, ...common, ...overrides]),
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/codex/build-command.ts tests/runtime/codex/build-command.test.ts
git commit -m "$(cat <<'EOF'
feat: build codex commands for first and resumed steps

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Per-run runtime home

**Files:**
- Create: `src/runtime/codex/codex-home.ts`
- Create: `src/runtime/codex/codex-version.ts`
- Test: `tests/runtime/codex/codex-home.test.ts`

**Interfaces:**
- Consumes: `DependencyError`.
- Produces: `CodexHome.create({ sourceHome, tempParent })`, `CodexHome#path`, `CodexHome#cleanup()`, `readCodexVersion(executable)`.

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/codex/codex-home.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DependencyError } from "../../../src/domain/errors.js";
import { CodexHome } from "../../../src/runtime/codex/codex-home.js";

async function sourceHomeWithCredentials(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "codex-source-"));
  await writeFile(join(home, "auth.json"), '{"token":"secret"}', "utf8");
  await writeFile(join(home, "config.toml"), 'model = "personal"', "utf8");
  return home;
}

test("copies only the credential file into a fresh home", async () => {
  const sourceHome = await sourceHomeWithCredentials();
  const home = await CodexHome.create({ sourceHome });

  assert.equal(await readFile(join(home.path, "auth.json"), "utf8"), '{"token":"secret"}');
  await assert.rejects(stat(join(home.path, "config.toml")));

  await home.cleanup();
  await assert.rejects(stat(home.path));
});

test("refuses to run when the runtime is not authenticated", async () => {
  const sourceHome = await mkdtemp(join(tmpdir(), "codex-empty-"));
  await assert.rejects(CodexHome.create({ sourceHome }), DependencyError);
});

test("cleanup is safe to call twice", async () => {
  const sourceHome = await sourceHomeWithCredentials();
  const home = await CodexHome.create({ sourceHome });
  await home.cleanup();
  await home.cleanup();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --test-name-pattern="credential file into a fresh home"`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the home and the version reader**

Create `src/runtime/codex/codex-home.ts`:

```ts
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DependencyError } from "../../domain/errors.js";

const credentialFilename = "auth.json";

export interface CodexHomeOptions {
  /** The operator's real runtime home. Defaults to `~/.codex`. */
  readonly sourceHome?: string;
  readonly tempParent?: string;
}

/**
 * A private runtime home for one run. Only the credential file is copied, so the
 * operator's personal configuration cannot reach a measured run and the run's own
 * sessions cannot reach the operator's profile.
 */
export class CodexHome {
  private removed = false;

  private constructor(public readonly path: string) {}

  public static async create(options: CodexHomeOptions = {}): Promise<CodexHome> {
    const sourceHome = options.sourceHome ?? join(homedir(), ".codex");
    const path = await mkdtemp(join(options.tempParent ?? tmpdir(), "skillbench-codex-home-"));

    try {
      await copyFile(join(sourceHome, credentialFilename), join(path, credentialFilename));
    } catch (cause: unknown) {
      await rm(path, { recursive: true, force: true });
      throw new DependencyError(
        `the codex runtime is not authenticated: could not read ${join(sourceHome, credentialFilename)}: ${message(cause)}`,
      );
    }

    return new CodexHome(path);
  }

  public async cleanup(): Promise<void> {
    if (this.removed) return;
    this.removed = true;
    await rm(this.path, { recursive: true, force: true });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

Create `src/runtime/codex/codex-version.ts`:

```ts
import { execFile } from "node:child_process";
import { DependencyError } from "../../domain/errors.js";

/** Reads the installed runtime version so it can be frozen into the run manifest. */
export async function readCodexVersion(executable = "codex"): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(executable, ["--version"], { windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        reject(new DependencyError(
          `the codex runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ));
        return;
      }
      const version = stdout.trim().split(/\s+/u).at(-1) ?? "";
      if (version === "") {
        reject(new DependencyError("the codex runtime reported no version"));
        return;
      }
      resolve(version);
    });
  });
}
```

Remove the unused `execFile` import from `codex-home.ts` if the linter flags it.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/codex/codex-home.ts src/runtime/codex/codex-version.ts tests/runtime/codex/codex-home.test.ts
git commit -m "$(cat <<'EOF'
feat: isolate each run in its own codex home

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The Codex adapter

**Files:**
- Create: `src/runtime/codex/codex-adapter.ts`
- Create: `tests/helpers/fake-codex.ts`
- Test: `tests/runtime/codex/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `buildCodexCommand` (Task 8), `parseCodexLine` (Task 7), `CodexHome` (Task 9), `RuntimeAdapter`, `RuntimeExecution`, `ExhaustionCause` (Task 1).
- Produces: `CodexAdapter` implementing `RuntimeAdapter`, `codexAdapterVersion`, and `CodexAdapterOptions { runtimeVersion, executable, sourceHome, tempParent, killGraceMs, nowMs }`. Raw lines travel through `RuntimeInput.onRawLine` from Task 1, so nothing branches on the runtime name.

- [ ] **Step 1: Write the fake runtime helper**

Create `tests/helpers/fake-codex.ts`:

```ts
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCodexStep {
  /** Lines printed to stdout, in order. */
  readonly lines: readonly string[];
  /** Milliseconds to stay alive after printing, before exiting. */
  readonly lingerMs?: number;
  readonly exitCode?: number;
}

/**
 * Writes an executable that impersonates `codex`. It reads the prompt from stdin,
 * prints the scripted lines for the current invocation, and exits. Invocations are
 * counted in a file next to the script, so successive steps get successive scripts.
 */
export async function createFakeCodex(steps: readonly FakeCodexStep[]): Promise<{
  readonly executable: string;
  readonly directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const executable = join(directory, "fake-codex.mjs");
  const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const steps = ${JSON.stringify(steps)};
const counterPath = ${JSON.stringify(join(directory, "invocations"))};
const index = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
writeFileSync(counterPath, String(index + 1));

// Drain stdin so the parent's write always completes.
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const step = steps[index] ?? { lines: [], exitCode: 0 };
  for (const line of step.lines) process.stdout.write(line + "\\n");
  const linger = step.lingerMs ?? 0;
  if (linger > 0) {
    setTimeout(() => process.exit(step.exitCode ?? 0), linger);
  } else {
    process.exit(step.exitCode ?? 0);
  }
});
`;
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  return { executable, directory };
}

export function threadLine(threadId: string): string {
  return JSON.stringify({ type: "thread.started", thread_id: threadId });
}

export function messageLine(text: string): string {
  return JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text } });
}

export function changeLine(absolutePath: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { id: "c", type: "file_change", changes: [{ path: absolutePath, kind: "update" }], status: "completed" },
  });
}

export function usageLine(inputTokens: number, outputTokens: number): string {
  return JSON.stringify({ type: "turn.completed", usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
}
```

- [ ] **Step 2: Write the failing adapter tests**

Create `tests/runtime/codex/codex-adapter.test.ts`. The first test is written out in
full; the rest follow exactly the same shape, changing only the script and the
assertions.

```ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PromptStep } from "../../../src/domain/model.js";
import { CodexAdapter } from "../../../src/runtime/codex/codex-adapter.js";
import type { RuntimeInput } from "../../../src/runtime/runtime-adapter.js";
import { changeLine, createFakeCodex, messageLine, threadLine, usageLine, type FakeCodexStep } from "../../helpers/fake-codex.js";

const steps: readonly PromptStep[] = [
  { id: "s1", prompt: "ask first", continuation: { eventRuleIds: ["stopped"] } },
  { id: "s2", prompt: "now do it" },
];

async function authenticatedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "codex-home-"));
  await writeFile(join(home, "auth.json"), "{}", "utf8");
  return home;
}

async function run(
  script: readonly FakeCodexStep[],
  overrides: Partial<RuntimeInput["config"]> = {},
  promptSteps: readonly PromptStep[] = steps,
  hooks: Partial<Pick<RuntimeInput, "onContinuation" | "onRawLine">> = {},
) {
  const { executable } = await createFakeCodex(script);
  const workspace = await mkdtemp(join(tmpdir(), "codex-ws-"));
  const adapter = new CodexAdapter({
    runtimeVersion: "0.0.0-test",
    executable,
    sourceHome: await authenticatedHome(),
  });

  return adapter.execute({
    workspace,
    promptSteps,
    config: {
      model: "m",
      reasoningEffort: "low",
      sandbox: "workspace-write",
      limits: { wallClockMs: 30000, outputBytes: 1000000, tokenLimit: 1000000 },
      environment: {},
      ...overrides,
    },
    onContinuation: hooks.onContinuation ?? (async () => {}),
    ...(hooks.onRawLine === undefined ? {} : { onRawLine: hooks.onRawLine }),
  });
}

test("runs two steps, resuming the thread and awaiting the continuation", async () => {
  const seenAtContinuation: number[] = [];
  const execution = await run(
    [
      { lines: [threadLine("t-1"), messageLine("here is my plan"), usageLine(10, 5)] },
      { lines: [threadLine("t-1"), messageLine("done"), usageLine(10, 5)] },
    ],
    {},
    steps,
    {
      onContinuation: async (_step, events) => {
        seenAtContinuation.push(events.filter((event) => event.type === "prompt_sent").length);
      },
    },
  );

  // The gate ran once, and it ran while only the first prompt had been sent.
  assert.deepEqual(seenAtContinuation, [1]);
  assert.equal(execution.events.filter((event) => event.type === "prompt_sent").length, 2);
  assert.equal(execution.events.at(-1)?.type, "session_closed");
  assert.equal(execution.exhaustion, null);
  assert.deepEqual(execution.usage, { inputTokens: 20, outputTokens: 10 });
  assert.equal(execution.metadata.runtime, "codex");
  assert.equal(execution.metadata.runtimeVersion, "0.0.0-test");
});

test("fails with a clear message when the first step reports no thread", async () => {
  await assert.rejects(
    run([{ lines: [messageLine("hello"), usageLine(1, 1)] }, { lines: [] }]),
    /thread identifier/,
  );
});

test("counts an unparsed line without failing the run", async () => {
  const raw: string[] = [];
  const execution = await run(
    [
      { lines: [threadLine("t-1"), "garbage", usageLine(1, 1)] },
      { lines: [threadLine("t-1"), usageLine(1, 1)] },
    ],
    {},
    steps,
    { onRawLine: (_stepId, line) => raw.push(line) },
  );

  assert.equal(execution.unparsedLines, 1);
  assert.ok(raw.includes("garbage"));
  assert.ok(execution.events.some((event) => event.type === "completion_claim"));
});

test("survives a stream truncated mid-line", async () => {
  const execution = await run([
    { lines: [threadLine("t-1"), '{"type":"item.completed","item":{'] },
    { lines: [threadLine("t-1"), usageLine(1, 1)] },
  ]);

  assert.equal(execution.unparsedLines, 1);
  assert.equal(execution.exhaustion, null);
});

test("stops the child and reports wall_clock exhaustion", async () => {
  const execution = await run(
    [{ lines: [threadLine("t-1")], lingerMs: 30000 }],
    { limits: { wallClockMs: 100, outputBytes: 1000000, tokenLimit: 1000000 } },
  );

  assert.equal(execution.exhaustion, "wall_clock");
  assert.equal(execution.process.timedOut, true);
});

test("stops the child and reports output_bytes exhaustion", async () => {
  const execution = await run(
    [{ lines: [threadLine("t-1"), messageLine("x".repeat(5000)), usageLine(1, 1)], lingerMs: 2000 }],
    { limits: { wallClockMs: 30000, outputBytes: 200, tokenLimit: 1000000 } },
  );

  assert.equal(execution.exhaustion, "output_bytes");
});

test("does not send a later step once the token budget is spent", async () => {
  const execution = await run(
    [
      { lines: [threadLine("t-1"), usageLine(100, 100)] },
      { lines: [threadLine("t-1"), usageLine(1, 1)] },
    ],
    { limits: { wallClockMs: 30000, outputBytes: 1000000, tokenLimit: 10 } },
  );

  assert.equal(execution.exhaustion, "token_limit");
  assert.equal(execution.events.filter((event) => event.type === "prompt_sent").length, 1);
});

test("reports a non-zero exit as a process failure", async () => {
  const execution = await run([
    { lines: [threadLine("t-1")], exitCode: 3 },
    { lines: [threadLine("t-1"), usageLine(1, 1)] },
  ]);

  assert.equal(execution.process.exitCode, 3);
});

test("relativizes file change paths against the workspace", async () => {
  const execution = await run(
    [{ lines: [threadLine("t-1"), changeLine("/nowhere/outside.js"), usageLine(1, 1)] }],
    {},
    [{ id: "s1", prompt: "go" }],
  );

  const change = execution.events.find((event) => event.type === "file_change");
  assert.deepEqual(change?.type === "file_change" ? change.outsidePaths : null, ["/nowhere/outside.js"]);
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test -- --test-name-pattern="resuming the thread"`
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Implement the adapter**

Create `src/runtime/codex/codex-adapter.ts`:

```ts
import { spawn } from "node:child_process";
import { DependencyError } from "../../domain/errors.js";
import type {
  ExhaustionCause,
  RuntimeAdapter,
  RuntimeExecution,
  RuntimeInput,
  TranscriptEvent,
} from "../runtime-adapter.js";
import { buildCodexCommand } from "./build-command.js";
import { CodexHome } from "./codex-home.js";
import { parseCodexLine } from "./parse-events.js";

/** Raise this whenever command building, parsing, or normalization changes what is observed. */
export const codexAdapterVersion = "1.0.0";

const inheritedVariables = ["PATH", "HOME", "TMPDIR", "LANG"] as const;

export interface CodexAdapterOptions {
  readonly runtimeVersion: string;
  readonly executable?: string;
  readonly sourceHome?: string;
  readonly tempParent?: string;
  readonly killGraceMs?: number;
  readonly nowMs?: () => number;
}

interface StepResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly threadId: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly unparsedLines: number;
  readonly bytes: number;
  readonly stopped: ExhaustionCause | null;
}

export class CodexAdapter implements RuntimeAdapter {
  public constructor(private readonly options: CodexAdapterOptions) {}

  public async execute(input: RuntimeInput): Promise<RuntimeExecution> {
    const nowMs = this.options.nowMs ?? ((): number => Date.now());
    const startedMs = nowMs();
    const atMs = (): number => nowMs() - startedMs;
    const deadlineMs = startedMs + input.config.limits.wallClockMs;

    const home = await CodexHome.create({
      ...(this.options.sourceHome === undefined ? {} : { sourceHome: this.options.sourceHome }),
      ...(this.options.tempParent === undefined ? {} : { tempParent: this.options.tempParent }),
    });

    const events: TranscriptEvent[] = [Object.freeze({ type: "session_started" as const, atMs: 0 })];
    let threadId: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    let bytes = 0;
    let unparsedLines = 0;
    let exhaustion: ExhaustionCause | null = null;
    let exitCode: number | null = 0;
    let signal: NodeJS.Signals | null = null;

    try {
      for (const [index, step] of input.promptSteps.entries()) {
        events.push(Object.freeze({
          type: "prompt_sent" as const, atMs: atMs(), stepId: step.id, text: step.prompt,
        }));

        const result = await this.runStep({
          command: buildCodexCommand({
            executable: this.options.executable ?? "codex",
            threadId,
            model: input.config.model,
            reasoningEffort: input.config.reasoningEffort,
            sandbox: input.config.sandbox,
            workspace: input.workspace,
          }),
          prompt: step.prompt,
          stepId: step.id,
          workspace: input.workspace,
          environment: input.config.environment,
          homePath: home.path,
          remainingBytes: input.config.limits.outputBytes - bytes,
          timeoutMs: Math.max(0, deadlineMs - nowMs()),
          atMs,
          onEvent: (event) => events.push(event),
          ...(input.onRawLine === undefined ? {} : { onRawLine: input.onRawLine }),
        });

        bytes += result.bytes;
        unparsedLines += result.unparsedLines;
        exitCode = result.exitCode;
        signal = result.signal;
        threadId = result.threadId ?? threadId;
        if (result.usage !== null) {
          sawUsage = true;
          inputTokens += result.usage.inputTokens;
          outputTokens += result.usage.outputTokens;
        }

        if (exhaustion === null) exhaustion = result.stopped;
        if (exhaustion === null && signal !== null) exhaustion = "signal";
        if (exhaustion === null && sawUsage &&
          inputTokens + outputTokens >= input.config.limits.tokenLimit) {
          exhaustion = "token_limit";
        }
        if (exhaustion !== null) break;

        if (index === 0 && threadId === null) {
          throw new DependencyError(
            "the codex runtime reported no thread identifier; a later step cannot be resumed",
          );
        }

        if (step.continuation !== undefined && index < input.promptSteps.length - 1) {
          await input.onContinuation(step, Object.freeze([...events]));
        }
      }
    } finally {
      await home.cleanup();
    }

    events.push(Object.freeze({ type: "session_closed" as const, atMs: atMs() }));

    return Object.freeze({
      events: Object.freeze([...events]),
      process: Object.freeze({ exitCode, signal, timedOut: exhaustion === "wall_clock" }),
      usage: sawUsage ? Object.freeze({ inputTokens, outputTokens }) : null,
      elapsedMs: atMs(),
      exhaustion,
      unparsedLines,
      metadata: Object.freeze({
        runtime: "codex",
        runtimeVersion: this.options.runtimeVersion,
        adapterVersion: codexAdapterVersion,
      }),
    });
  }

  private runStep(options: {
    readonly command: { readonly executable: string; readonly args: readonly string[] };
    readonly prompt: string;
    readonly stepId: string;
    readonly workspace: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly homePath: string;
    readonly remainingBytes: number;
    readonly timeoutMs: number;
    readonly atMs: () => number;
    readonly onEvent: (event: TranscriptEvent) => void;
    readonly onRawLine?: (stepId: string, line: string) => void;
  }): Promise<StepResult> {
    const killGraceMs = this.options.killGraceMs ?? 5000;

    return new Promise<StepResult>((resolve, reject) => {
      const child = spawn(options.command.executable, [...options.command.args], {
        cwd: options.workspace,
        env: buildEnvironment(options.homePath, options.environment),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      let bytes = 0;
      let unparsed = 0;
      let buffer = "";
      let threadId: string | null = null;
      let usage: { readonly inputTokens: number; readonly outputTokens: number } | null = null;
      let stopped: ExhaustionCause | null = null;

      const stop = (cause: ExhaustionCause): void => {
        if (stopped !== null) return;
        stopped = cause;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), killGraceMs).unref();
      };

      const handleLine = (line: string): void => {
        if (line === "") return;
        options.onRawLine?.(options.stepId, line);
        const parsed = parseCodexLine(line, { atMs: options.atMs(), workspace: options.workspace });
        if (!parsed.recognized) unparsed += 1;
        for (const event of parsed.events) options.onEvent(event);
        threadId = parsed.threadId ?? threadId;
        usage = parsed.usage ?? usage;
      };

      const count = (chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > options.remainingBytes) stop("output_bytes");
      };

      const timer = setTimeout(() => stop("wall_clock"), options.timeoutMs);
      timer.unref();

      child.stderr.on("data", count);
      child.stdout.on("data", (chunk: Buffer) => {
        count(chunk);
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;
          handleLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      });

      child.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(new DependencyError(`could not start the codex runtime: ${error.message}`));
      });

      child.once("close", (code: number | null, closeSignal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        // A stream cut mid-line still becomes evidence: it is counted, never dropped.
        handleLine(buffer);
        resolve(Object.freeze({
          exitCode: code, signal: closeSignal, threadId, usage,
          unparsedLines: unparsed, bytes, stopped,
        }));
      });

      child.stdin.end(options.prompt, "utf8");
    });
  }
}

function buildEnvironment(
  homePath: string,
  declared: Readonly<Record<string, string>>,
): Record<string, string> {
  // The parent environment is never inherited wholesale.
  const environment: Record<string, string> = { CODEX_HOME: homePath };
  for (const key of inheritedVariables) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...declared };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/codex/codex-adapter.ts tests/helpers/fake-codex.ts tests/runtime/codex/codex-adapter.test.ts
git commit -m "$(cat <<'EOF'
feat: execute codex sessions step by step behind the adapter boundary

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Register the runtime and persist raw evidence

**Files:**
- Modify: `src/runtime/select-adapter.ts`
- Modify: `src/commands/dry-run.ts:52`
- Modify: `src/commands/run.ts:36`
- Modify: `src/runs/result.ts` (`RunEvidenceWriter`)
- Modify: `src/runs/execute-run.ts`
- Test: `tests/runtime/select-adapter.test.ts`
- Test: `tests/commands/run.test.ts`

**Interfaces:**
- Consumes: `CodexAdapter`, `readCodexVersion`, `codexAdapterVersion`.
- Produces: `selectAdapter(runtime, caseManifest): Promise<SelectedAdapter>`; `supportedRuntimes = ["codex", "fake"]`; `RunEvidenceWriter#appendRawLine(stepId, line)` and `RunEvidenceWriter#flushRawLines()`.

- [ ] **Step 1: Write the failing tests**

In `tests/runtime/select-adapter.test.ts`, convert existing calls to `await selectAdapter(...)` and add:

```ts
test("lists both supported runtimes", () => {
  assert.deepEqual([...supportedRuntimes], ["codex", "fake"]);
});

test("rejects an unknown runtime with the supported list", async () => {
  await assert.rejects(selectAdapter("cursor", caseManifest), /supported runtimes: codex, fake/);
});
```

In `tests/commands/run.test.ts`, add a test asserting that a run against the fake runtime writes no `raw/` directory. In `tests/runs/result.test.ts` (or the file that already covers `RunEvidenceWriter`), add a test asserting that two `appendRawLine` calls followed by `flushRawLines` produce `raw/step-s1.jsonl` containing both lines in order.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --test-name-pattern="both supported runtimes"`
Expected: FAIL.

- [ ] **Step 3: Make selection asynchronous and register the runtime**

In `src/runtime/select-adapter.ts`:

```ts
export const supportedRuntimes: readonly string[] = Object.freeze(["codex", "fake"]);

export async function selectAdapter(runtime: string, caseManifest: CaseManifest): Promise<SelectedAdapter> {
  if (runtime === "fake") {
    return Object.freeze({
      adapter: new FakeAdapter(createFakeScript(caseManifest)),
      runtimeVersion: fakeRuntimeVersion,
      adapterVersion: fakeAdapterVersion,
    });
  }

  if (runtime === "codex") {
    const runtimeVersion = await readCodexVersion();
    return Object.freeze({
      adapter: new CodexAdapter({ runtimeVersion }),
      runtimeVersion,
      adapterVersion: codexAdapterVersion,
    });
  }

  throw new DependencyError(
    `runtime ${runtime} is not available in this build; supported runtimes: ${supportedRuntimes.join(", ")}`,
  );
}
```

Await it in `src/commands/dry-run.ts:52` and `src/commands/run.ts:36`.

- [ ] **Step 4: Persist the raw stream**

`ImmutableJsonStore` writes canonical JSON documents only, so raw stream lines are
appended directly. `RunEvidenceWriter` gains `ProjectPaths` for that, and serializes the
appends so lines arriving from a stream callback cannot interleave.

In `src/runs/result.ts`:

```ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProjectPaths } from "../paths/project-paths.js";

export class RunEvidenceWriter {
  public readonly directory: string;
  private rawQueue: Promise<void> = Promise.resolve();
  private readonly rawFailures: string[] = [];

  public constructor(
    private readonly store: ImmutableJsonStore,
    private readonly manifest: FrozenRunManifest,
    private readonly paths: ProjectPaths,
  ) {
    this.directory = runDirectory(manifest);
  }

  /** Queues one raw runtime line, written before parsing so a parser defect cannot destroy it. */
  public appendRawLine(stepId: string, line: string): void {
    this.rawQueue = this.rawQueue
      .then(async () => {
        const path = await this.paths.resolveOutput(`${this.directory}/raw/step-${stepId}.jsonl`);
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${line}\n`, "utf8");
      })
      .catch((error: unknown) => {
        this.rawFailures.push(error instanceof Error ? error.message : String(error));
      });
  }

  /** Waits for queued raw writes and reports any that failed. */
  public async flushRawLines(): Promise<readonly string[]> {
    await this.rawQueue;
    return Object.freeze([...this.rawFailures]);
  }
}
```

In `src/runs/execute-run.ts`, construct the writer with `input.paths`, pass the sink into
the adapter, and fold any raw-write failures into the recorded failures:

```ts
  const writer = new RunEvidenceWriter(input.store, manifest, input.paths);
```

```ts
      onRawLine: (stepId, line) => { writer.appendRawLine(stepId, line); },
```

and inside the `finally` block, before workspace cleanup:

```ts
    for (const failure of await writer.flushRawLines()) {
      cleanupFailures.push(`raw evidence: ${failure}`);
    }
```

The fake adapter never calls `onRawLine`, so a fake run writes no `raw/` directory and
nothing branches on the runtime name.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm run check && npm run build && node dist/src/cli.js validate --project . --public-only; echo "exit=$?"`
Expected: PASS, then `exit=0` with `0 cases and 0 variants`.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/select-adapter.ts src/commands/dry-run.ts src/commands/run.ts src/runs/result.ts src/runs/execute-run.ts tests/runtime/select-adapter.test.ts tests/commands/run.test.ts
git commit -m "$(cat <<'EOF'
feat: register the codex runtime and persist its raw stream

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: The opt-in live check

**Files:**
- Create: `smoke/case.json`, `smoke/prompt-steps.md` (reference copy for humans), `smoke/fixture/app.js`, `smoke/fixture/README.md`, `smoke/oracle/oracle.json`, `smoke/oracle/check-greeting.mjs`, `smoke/variant/variant.json`
- Create: `scripts/smoke-codex.mjs`
- Modify: `package.json` (`scripts.smoke:codex`)
- Modify: `.gitignore` only if `smoke/` is matched by an existing rule

**Interfaces:**
- Consumes: the built CLI at `dist/src/cli.js`; `tests/helpers/temp-project.ts` patterns for assembling a project.
- Produces: `npm run smoke:codex`.

The smoke material must be a two-step case whose first step forbids file changes, so the live check proves the gate really runs before the second prompt.

- [ ] **Step 1: Write the smoke material**

`smoke/fixture/app.js`:

```js
export function greet(name) {
  return `hi ${name}`;
}
```

`smoke/fixture/README.md`:

```markdown
# Smoke fixture

A three-line module used only to prove that the live Codex adapter works end to end.
```

`smoke/case.json` — the fixture hash is a placeholder that the assembly script replaces
with the real one before the CLI reads it:

```json
{
  "schemaVersion": 1,
  "id": "SMOKE",
  "title": "Live adapter smoke check",
  "categories": ["bounded-feature"],
  "fixture": {
    "path": "fixtures/smoke",
    "contentHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "promptSteps": [
    {
      "id": "s1",
      "prompt": "Read app.js. In one sentence, describe how you would change greet so that greet(\"ann\") returns \"hello ann\". Do not edit any file yet; wait for my go-ahead.",
      "continuation": { "eventRuleIds": ["stopped_first"] }
    },
    { "id": "s2", "prompt": "Go ahead and make that change now." }
  ],
  "publicVerification": [{ "executor": "node", "args": ["--check", "app.js"] }],
  "limits": { "wallClockMs": 600000, "outputBytes": 4000000, "tokenLimit": 400000 },
  "allowedChangePaths": ["app.js"],
  "forbiddenChangePaths": ["README.md"],
  "assertions": [
    { "id": "A_GREETING", "dimension": "functional", "critical": true },
    { "id": "A_STOPPED", "dimension": "process", "critical": false, "transcriptRuleId": "stopped_first" }
  ],
  "transcriptRules": [{ "id": "stopped_first", "check": "no_file_change" }]
}
```

`smoke/oracle/oracle.json`:

```json
{
  "schemaVersion": 1,
  "caseId": "SMOKE",
  "checks": [
    {
      "assertionId": "A_GREETING",
      "command": { "executor": "node", "args": ["check-greeting.mjs"] },
      "workingDirectory": ".",
      "timeoutMs": 30000
    }
  ]
}
```

`smoke/oracle/check-greeting.mjs`:

```js
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.env.SKILLBENCH_WORKSPACE;
if (workspace === undefined) {
  console.error("SKILLBENCH_WORKSPACE is not set");
  process.exit(2);
}

const { greet } = await import(pathToFileURL(join(workspace, "app.js")).href);
const actual = greet("ann");
if (actual !== "hello ann") {
  console.error(`greet("ann") returned ${JSON.stringify(actual)}`);
  process.exit(1);
}
```

`smoke/variant/variant.json` is a control variant with no installed material. Mirror the
control manifest that `tests/helpers/temp-project.ts` already builds: empty `installs`,
`compatibleRuntimes` containing `"codex"`, empty `claimedCategories` semantics as that
helper uses them, and a `contentHash` that the assembly script recomputes.

- [ ] **Step 2: Write the assembly script**

Create `scripts/smoke-codex.mjs`:

```js
#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashTree, hashValue } from "../dist/src/integrity/content-hash.js";

if (process.env.SKILLBENCH_LIVE !== "1") {
  console.error("Refusing to start a live agent. Set SKILLBENCH_LIVE=1 to run this check.");
  process.exit(2);
}

// fileURLToPath, not .pathname: a repository path with non-ASCII characters
// comes back percent-encoded from .pathname and resolves to nothing.
const repository = fileURLToPath(new URL("..", import.meta.url));
const project = await mkdtemp(join(tmpdir(), "skillbench-smoke-"));

await cp(join(repository, "schemas"), join(project, "schemas"), { recursive: true });
await cp(join(repository, "smoke/fixture"), join(project, "fixtures/smoke"), { recursive: true });
await mkdir(join(project, "cases/smoke"), { recursive: true });
await mkdir(join(project, "variants/control"), { recursive: true });
await cp(join(repository, "smoke/oracle"), join(project, ".private/oracles/SMOKE"), { recursive: true });

const caseManifest = JSON.parse(await readFile(join(repository, "smoke/case.json"), "utf8"));
caseManifest.fixture.contentHash = await hashTree(join(project, "fixtures/smoke"));
await writeFile(join(project, "cases/smoke/case.json"), `${JSON.stringify(caseManifest, null, 2)}\n`, "utf8");

const variantManifest = JSON.parse(await readFile(join(repository, "smoke/variant/variant.json"), "utf8"));
variantManifest.contentHash = hashValue([]);
await writeFile(join(project, "variants/control/variant.json"), `${JSON.stringify(variantManifest, null, 2)}\n`, "utf8");

const result = spawnSync(process.execPath, [
  join(repository, "dist/src/cli.js"), "run",
  "--project", project,
  "--case", "SMOKE",
  "--variant", "control",
  "--runtime", "codex",
  "--model", process.env.SKILLBENCH_MODEL ?? "gpt-5-codex",
  "--reasoning", "low",
  "--sandbox", "workspace-write",
  "--runs", "1",
  "--json",
], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

process.stdout.write(result.stdout ?? "");

const runs = JSON.parse(result.stdout ?? "{}").runs ?? [];
const [run] = runs;
if (run === undefined) {
  console.error("The CLI produced no run report.");
  process.exit(1);
}

const resultPath = join(project, "runs/SMOKE/control", run.runId, "result.json");
const evidence = JSON.parse(await readFile(resultPath, "utf8"));
const stopped = evidence.transcriptRuleOutcomes.find((outcome) => outcome.ruleId === "stopped_first");

console.log(`run directory: ${join(project, "runs/SMOKE/control", run.runId)}`);
for (const assertion of evidence.assertions) {
  console.log(`  ${assertion.assertionId}: ${assertion.outcome} (${assertion.source})`);
}
console.log(`  stop rule evaluated: ${stopped === undefined ? "no" : "yes"}, satisfied: ${stopped?.satisfied}`);

if (stopped === undefined) {
  console.error("The continuation gate never ran: the second step was sent without evaluating the rule.");
  process.exit(1);
}
for (const stepId of ["s1", "s2"]) {
  await readFile(join(project, "runs/SMOKE/control", run.runId, "raw", `step-${stepId}.jsonl`), "utf8");
}
```

The script exits non-zero when the gate never ran or when a raw stream file is missing,
so a silent regression in the continuation path fails the check rather than passing it.

- [ ] **Step 3: Register the script**

Add to `package.json`:

```json
    "smoke:codex": "node scripts/smoke-codex.mjs"
```

Do not add it to `check`.

- [ ] **Step 4: Verify the repository gate is unaffected**

Run: `npm run check && npm run build && node dist/src/cli.js validate --project . --public-only; echo "exit=$?"`
Expected: PASS, `exit=0`, still `0 cases and 0 variants` because `smoke/` is not under `cases/`.

- [ ] **Step 5: Run the live check once, by hand**

Run: `SKILLBENCH_LIVE=1 npm run smoke:codex`
Expected: the run completes, `A_GREETING` passes, `A_STOPPED` reports its real outcome, and both raw step files exist. Paste the output beneath any completion claim.

- [ ] **Step 6: Commit**

```bash
git add smoke scripts/smoke-codex.mjs package.json
git commit -m "$(cat <<'EOF'
test: add an opt-in live codex smoke check

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Documentation and stage gate

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documentation matching real behavior.

- [ ] **Step 1: Update the project memory**

In `AGENTS.md`:

- **Current State**: Stage 3 is complete; `run` executes against the deterministic fake runtime and against a live Codex session selected with `--runtime codex`; the next stage is Stage 4, the QueueDesk fixture.
- **Architecture**: add `src/runtime/codex/` (command construction, stream parsing, command normalization, per-run runtime home) and `src/runs/transcript-rules.ts`.
- **Known Limitations**: add the four new ones from the spec's *Known Limitations* section, verbatim in substance: edits made through a shell command produce no transcript file-change event; command normalization does not implement shell grammar; stream parsing is pinned to one runtime version; wall-clock and output budgets rely on signals the child may delay.
- **Known Limitations**: remove the resolved sentence about the fake runtime producing a scripted transcript being the only end-to-end path, and state that exhaustion is now classified by the adapter.

- [ ] **Step 2: Update the README, both halves**

Add to the English section, then mirror the same content in the Russian section:

- `--runtime codex` on `dry-run` and `run`, and what it requires: Codex installed, logged in, and a matching sandbox name.
- That each run gets a private runtime home so personal Codex settings never affect a measured run.
- Transcript rules: the five checks, that a rule listed in a step's continuation is checked before the next prompt is sent, and that a failing rule records a violation without stopping the run.
- That an assertion with `transcriptRuleId` is graded by SkillBench and must not appear in the private oracle.
- `npm run smoke:codex` and its `SKILLBENCH_LIVE=1` requirement, plus the fact that it never runs in CI.

- [ ] **Step 3: Run the stage gate**

Run:

```bash
npm run check
npm run build
node dist/src/cli.js validate --project . --public-only; echo "exit=$?"
```

Expected: all pass; the last command prints `0 cases and 0 variants` and `exit=0`.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "$(cat <<'EOF'
docs: record stage 3 delivery

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Finish the branch**

Use `superpowers:finishing-a-development-branch` to merge `stage3-codex-adapter` into `main` and remove the worktree.

---

## Spec Coverage

| Spec section | Task |
|---|---|
| Transcript Event Vocabulary | 1 |
| Transcript Rules — rule shape, windows, single evaluation | 2, 3 |
| Transcript Rules — continuation behavior | 5 |
| Transcript Rules — grading, validation rules | 3, 4 |
| Codex Adapter — command construction | 8 |
| Codex Adapter — session isolation | 9 |
| Codex Adapter — stream parsing | 7 |
| Codex Adapter — command normalization | 6 |
| Codex Adapter — limits and exhaustion | 1, 10 |
| Codex Adapter — failure handling | 9, 10 |
| Core Changes | 5, 11 |
| Evidence | 11 |
| CLI | 11 |
| Testing Strategy — deterministic | 2, 4, 5, 6, 7, 8, 9, 10 |
| Testing Strategy — live smoke | 12 |
| Known Limitations, Documentation and Delivery State | 13 |
