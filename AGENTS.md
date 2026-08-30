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

- Stage 1 and Stage 2A are complete.
- The repository validates benchmark catalogs and provides internal primitives for isolated fixture materialization, data-driven variant installation, and post-session private-oracle mounting.
- It does not run agents, execute oracle commands, freeze run manifests, normalize results, calculate metrics, compare variants, or generate reports.
- `validate` is implemented. `list`, `dry-run`, `run`, `compare`, and `report` are reserved commands and currently return exit code `2`.
- The next delivery stage is Stage 2B: run orchestration, frozen inputs, normalized results, and an operational `dry-run` command.
- There are no committed public cases or variants yet. Successful validation of this repository with `--public-only` reports `0` cases and `0` variants.

Do not describe planned functionality as already implemented. Update this section whenever a delivery stage changes the real CLI behavior.

## Development Record

- Stage 2A development used the isolated worktree `.worktrees/stage2a-file-lifecycles` on branch `stage2a-file-lifecycles`.

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

`npm run check` runs linting, TypeScript checks, and the automated test suite. Before claiming completion or committing a code change, run the checks relevant to that change. For a normal source change, run `npm run check` and `npm run build`.

## Architecture

- `src/domain/` contains runtime-neutral types and errors.
- `src/filesystem/` contains safe tree copying, containment checks, and rollback helpers that reject symbolic-link escapes.
- `src/workspace/` materializes isolated fixture workspaces, verifies fixture integrity, and cleans them up.
- `src/variants/` installs validated variant material into a workspace and verifies its installed content hash.
- `src/oracles/` controls the post-session private-oracle lifecycle and mounts an oracle in a separate grading area.
- `src/integrity/` contains canonical JSON and content hashing.
- `src/paths/` owns safe project-path resolution.
- `schemas/` contains the published case and variant JSON Schemas; `src/schemas/` validates data against them.
- `src/storage/` contains immutable JSON storage.
- `src/runtime/` defines the adapter boundary and deterministic fake adapter.
- `src/catalog/` loads and cross-validates catalogs.
- `src/commands/` and `src/cli/` implement CLI behavior.
- `tests/` mirrors these responsibilities with unit and command-level tests.

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

## Known Limitations to Preserve or Resolve Explicitly

- Safe-path checks have a time-of-check/time-of-use window if another hostile local process replaces a path after validation.
- The immutable JSON store protects sequential writes, but concurrent writers can race because standard POSIX `rename` may replace an existing destination.
- Manifest discovery currently looks exactly one directory below `cases/` and `variants/`.
- `--public-only` skips only private-oracle availability checks; it must not skip schema, reference, hash, or path validation.

If a later stage resolves one of these limitations, update this file and the README in the same change.
