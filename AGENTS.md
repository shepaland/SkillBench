# SkillBench Project Memory

## Source of Truth

- The approved product design is `docs/superpowers/specs/2026-08-30-skillbench-design.md`.
- The completed Stage 1 implementation plan is `docs/superpowers/plans/2026-08-30-skillbench-stage-1-foundation.md`.
- `README.md` is the user-facing guide. Keep its English section first and its Russian section second. Write both sections for a high-school reader.
- When documents disagree, follow the approved design and update stale supporting documentation in the same change.

## Product Goal

SkillBench is a TypeScript command-line utility for controlled, repeatable comparisons of coding-agent skills. It runs the same task with different skill variants and a no-skill control while keeping the model, reasoning effort, sandbox, task inputs, limits, and runtime version equal.

The primary metric is `solve_rate`. Diagnostic metrics are `correctness`, `regression_safety`, `process_compliance`, `scope_precision`, `first_pass_yield`, `rework_ratio`, `tokens_per_solve`, `wall_time_per_solve`, `human_interventions`, and `spec_drift`. Keep metrics separate; do not invent a composite leaderboard score. Use `not_applicable` when a formula has no valid denominator.

## Current State

- Stage 1, Stage 2A, Stage 2B, Stage 3, Stage 4, and Stage 5A are complete.
- `validate`, `list`, `dry-run`, and `run` are implemented. `compare` and `report` remain reserved commands and currently return exit code `2`.
- `validate` checks the catalog and, unless `--public-only` is used, loads each case's private oracle manifest and confirms it covers exactly the declared assertions without a `transcriptRuleId`.
- `list` prints the cases and variants in a project, with a `--json` option for machine-readable output.
- `dry-run` freezes every input for a run and prints the execution plan without materializing a workspace or starting an agent. `dry-run --runtime codex` still requires an installed runtime, because the frozen manifest records the runtime version.
- `run` executes against the deterministic fake runtime and against a live Codex session selected with `--runtime codex`.
- The QueueDesk fixture and its four defect copies are committed under `fixtures/`.
- The repository ships one case, `B01`, and one variant, `control`, so `validate --public-only` reports `1` case and `1` variant. No run can be started without a variant, which is why `control` exists.
- `B01` declares five oracle-graded assertions: three functional, one regression, and one scope. Four are critical; `functional-renderer-neutral` is a diagnostic structural check and is not.
- The private grading material lives in a separate private repository, `github.com/shepaland/SkillBench-private`, cloned into `.private/`. It holds the oracle sources, the composition script, the generated fixture baselines, and the proof patches. It has no dependencies, and its own commands are `npm run build` and `npm run check`, run from `.private`.
- `validate` without `--public-only` now passes when that private material is present.
- `npm run oracles:proof` proves that every oracle-graded assertion can both pass and fail. It is not part of `npm run check`, because a fresh clone has no private material; without it the command fails loudly instead of reporting success.
- The next delivery stage is Stage 5B, which adds six more cases graded by running code.

Do not describe planned functionality as already implemented. Update this section whenever a delivery stage changes the real CLI behavior.

## Development Record

- Stage 2A development used the isolated worktree `.worktrees/stage2a-file-lifecycles` on branch `stage2a-file-lifecycles`.
- Stage 2B development used the isolated worktree `.worktrees/stage2b-run-orchestration` on branch `stage2b-run-orchestration`.
- Stage 3 development used the isolated worktree `.worktrees/stage3-codex-adapter` on branch `stage3-codex-adapter`.
- Stage 4 development used the isolated worktree `.worktrees/stage4-queuedesk-fixture` on branch `stage4-queuedesk-fixture`.
- Stage 5A development used the isolated worktree `.worktrees/stage5a-oracle-toolkit` on branch `stage5a-oracle-toolkit`.

## Technology and Commands

- Runtime: Node.js 22 or newer.
- Language: TypeScript using native ESM.
- Package manager: npm with exact versions from `package-lock.json`.

Use these commands from the repository root:

```sh
npm ci
npm run check
npm run build
node dist/src/cli.js validate --project . --public-only
```

`npm run check` verifies the composed fixtures (`npm run fixtures:check`) before linting, then runs TypeScript checks and the automated test suite. Before claiming completion or committing a code change, run the checks relevant to that change. For a normal source change, run `npm run check` and `npm run build`.

- `npm run fixtures:build` composes `fixtures/queuedesk-<name>/` from `fixtures/queuedesk/` and its overlays.
- `npm run fixtures:check` verifies the committed composed fixtures still match what `fixtures:build` would produce.

These two commands need the private repository cloned into `.private/` and do nothing useful without it:

- `npm run oracles:proof` composes a correct and a deliberately broken copy of each case's project and grades both through SkillBench's own mounting and oracle-running code, proving that every oracle-graded assertion can both pass and fail. It is deliberately outside `npm run check`.
- `npm --prefix .private run check` verifies the composed oracles still match their sources and runs the private repository's own tests. Use `npm --prefix .private run build` to recompose them after editing a source.

Their order matters. `npm run oracles:proof` reads the composed oracle under `.private/oracles/`, not the sources, so `npm --prefix .private run check` must run first; otherwise a stale composed oracle is what gets proven. The delivery gate is these five commands in this order, and all five must exit `0`:

```sh
npm --prefix .private run check
npm run check
npm run build
node dist/src/cli.js validate --project .
npm run oracles:proof
```

## Architecture

- `src/domain/` contains runtime-neutral types and errors.
- `src/filesystem/` contains safe tree copying, containment checks, and rollback helpers that reject symbolic-link escapes.
- `src/workspace/` materializes isolated fixture workspaces, verifies fixture integrity, and cleans them up.
- `src/variants/` installs validated variant material into a workspace and verifies its installed content hash.
- `src/oracles/` controls the post-session private-oracle lifecycle and mounts an oracle in a separate grading area; it additionally owns the oracle manifest and typed-command oracle execution.
- `src/runs/` owns tree snapshots, frozen run inputs, normalized results, and the pipeline runner.
- `src/integrity/` contains canonical JSON and content hashing.
- `src/paths/` owns safe project-path resolution.
- `schemas/` contains the published case, variant, and oracle JSON Schemas; `src/schemas/` validates data against them.
- `src/storage/` contains immutable JSON storage.
- `src/runtime/` defines the adapter boundary and deterministic fake adapter; `src/runtime/select-adapter.ts` maps a runtime identifier to an adapter, asynchronously, and reports its runtime version.
- `src/runtime/codex/` implements the `codex` runtime adapter: `codex-adapter.ts` is the `RuntimeAdapter` implementation itself, built from command construction (`build-command.ts`), stream parsing (`parse-events.ts`), reported-shell-command normalization (`normalize-command.ts`), a per-run isolated runtime home (`codex-home.ts`), and runtime version discovery (`codex-version.ts`).
- `src/runs/transcript-rules.ts` evaluates typed transcript rules — a closed set of five checks — as a pure function of the recorded event list.
- `src/catalog/` loads and cross-validates catalogs.
- `src/commands/` and `src/cli/` implement CLI behavior.
- `src/tools/` holds development tools that use SkillBench's own modules rather than reimplementing them; today that is the oracle prover, `src/tools/prove-oracles.ts`.
- `tests/` mirrors these responsibilities with unit and command-level tests.
- `fixtures/queuedesk/` is the QueueDesk base fixture, a dependency-free JavaScript ESM command-line application with its own public test suite.
- `fixtures/overlays/<name>/` holds defect overlays as `overlay.json` plus the files they change.
- `fixtures/queuedesk-<name>/` are composed fixtures produced only by `scripts/build-fixtures.mjs`.
- `tests/fixtures/` proves both the composition script and the fixtures' documented pass and failure picture.
- `cases/<case-id>/case.json` and `variants/<variant-id>/variant.json` are the public catalog.
- `.private/` is a clone of a separate private repository. `.private/sources/` holds the oracle sources, `.private/scripts/build-oracles.mjs` composes them, `.private/oracles/<case-id>/` holds the composed oracles, and `.private/proofs/<case-id>/` holds the patches `npm run oracles:proof` uses.

Keep case definitions independent of a specific agent runtime. Keep skills as data: core code must not branch on names such as LexForge, OpenSpec, or Superpowers. Runtime-specific command building and transcript parsing belong in runtime adapters.

## Non-Negotiable Rules

- Public prompts, schemas, CLI messages, reports, fixture text, and project documentation use concise international English. The README additionally provides a complete Russian translation after the English section.
- Never place `.private/oracles/` content in an active agent workspace. Install or mount an oracle only after the agent session is closed, then remove its temporary material.
- Never execute arbitrary shell text from public manifests. Commands must use typed executors and explicit arguments.
- Reject path traversal, symbolic-link escapes, and invalid allowed/forbidden path overlaps.
- Preserve raw and partial evidence when a run, adapter, oracle, or report step fails.
- Freeze run inputs with content hashes and refuse comparisons with incompatible model, reasoning, sandbox, case, runtime, or adapter inputs.
- Develop behavior changes with tests. Prefer deterministic tests and use the fake adapter in CI; live Codex smoke tests must remain opt-in.
- Do not commit generated or private data from `node_modules/`, `dist/`, `coverage/`, `.private/`, `runs/`, `.worktrees/`, or `.superpowers/`.
- Never hand-edit a composed fixture (`fixtures/queuedesk-<name>/`); regenerate it with `scripts/build-fixtures.mjs`.
- Never hand-edit a composed oracle (`.private/oracles/<case-id>/`); edit its source under `.private/sources/` and regenerate it with `npm --prefix .private run build`. This is the same discipline the composed fixtures follow.
- A case's `categories` come from a closed vocabulary: `bug-fix`, `bounded-feature`, `ambiguous-feature`, `architectural-feature`, `compatibility`, `refactoring`, `security`, `scope-control`, and `process`. `schemas/case.schema.json` accepts any non-empty string, so this is a convention the reviewer enforces, not the schema.
- An oracle check never writes into the agent's workspace. It copies what it needs into its own temporary directory and removes that directory in every case, including when the assertion does not hold.
- A check runs code the measured agent wrote, so that code must never learn where the grading directory is. The shared oracle helper reads `SKILLBENCH_WORKSPACE` and `SKILLBENCH_ORACLE` once when it loads, removes them from `process.env`, and hands every child process an environment without them. As a second line of defence, `executeRun` hashes the mounted oracle again after the last check and reports the run as errored at the `grade` step when it changed.
- `tests/` stays an allowed change path in every case. Forbidding it would punish any skill that writes a test first. The protection against a weakened test is that the oracle carries its own copy of the public suite and grades against that copy, not against the one in the workspace. `npm run oracles:proof` compares that carried copy with the baseline in both directions, so an oracle that carries only part of the suite is a failure too.
- Never write a public QueueDesk test that observes cross-tenant `claim` or `complete`, an interrupted write, a timestamp value, `orderJobs` directly, or job ordering through `list --json`, because the seeded defects live in exactly those gaps.

## Known Limitations to Preserve or Resolve Explicitly

- Safe-path checks have a time-of-check/time-of-use window if another hostile local process replaces a path after validation.
- The immutable JSON store protects sequential writes, but concurrent writers can race because standard POSIX `rename` may replace an existing destination.
- Manifest discovery currently looks exactly one directory below `cases/` and `variants/`.
- `--public-only` skips only private-oracle availability checks; it must not skip schema, reference, hash, or path validation.
- Runs execute sequentially. Exhaustion (`wall_clock`, `output_bytes`, `token_limit`, or `signal`) is now classified by the adapter itself, from real evidence, not guessed by the core.
- A file edited through a shell command rather than the runtime's own edit tool produces no `file_change` transcript event. The final tree comparison still detects the change for scope metrics, but transcript rules do not see it.
- Command normalization does not implement shell grammar. Quoting is handled only as stripped matched quotes around a token; subshells, redirections, and expansions are not interpreted.
- Stream parsing is pinned to the observed event shape of one runtime version. A different version may produce unparsed lines; the run still completes and the raw stream is preserved, but transcript rules may see fewer events. The frozen `runtimeVersion` already prevents comparing runs across versions.
- Wall-clock and output budgets are enforced by the adapter, so a child that ignores a termination signal is only stopped by the subsequent kill signal.
- A case's `publicVerification` is frozen into the run manifest and printed by `dry-run`, but `run` never executes it. The regression assertion is what actually runs the public suite, from the oracle's own copy of it.
- An oracle check that crashes and one that cleanly decides the assertion does not hold both exit non-zero, so `src/oracles/run-oracle.ts` grades both as `failed`. Only stderr tells them apart.
- The three skill variants (OpenSpec, Superpowers, LexForge) have no delivery stage of their own. They need one before the pilot; only `control` exists today.
- The prover's "nothing was proven" guard treats any empty proof run as a failure. Stage 5C must revisit it when a case is graded entirely from the transcript and therefore has nothing for the prover to run.

If a later stage resolves one of these limitations, update this file and the README in the same change.
