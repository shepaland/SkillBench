# SkillBench Stage 2A File Lifecycle Design

## Purpose

Stage 2A adds the safe file-lifecycle primitives needed by later benchmark
execution. It materializes an isolated fixture workspace, installs a variant
from data, and enforces the private-oracle boundary. It does not orchestrate a
run or change the behavior of the reserved CLI commands.

This is a deliberately smaller delivery increment than Stage 2 in the product
design. Run orchestration, frozen run manifests, normalized results, and an
operational `dry-run` command move to Stage 2B. The Codex adapter and multi-step
prompt execution remain Stage 3 work.

## Scope

Stage 2A includes:

- copying a validated fixture into a fresh temporary workspace;
- detecting any change to the source fixture during the workspace lifecycle;
- installing control and file-backed variants from manifest mappings;
- rejecting unsafe sources, destinations, symbolic-link escapes, duplicate or
  overlapping destinations, and installed-content hash mismatches;
- representing agent-session closure explicitly before private oracle access;
- copying a private oracle into a separate temporary grading area only after
  the agent session is closed;
- idempotent cleanup of workspace and oracle grading areas;
- deterministic unit and integration tests for success and failure paths.

Stage 2A excludes:

- run manifests and `result.json`;
- a runner or other end-to-end orchestration service;
- adapter invocation and transcript processing;
- oracle command execution and assertion normalization;
- changes to `list`, `dry-run`, `run`, `compare`, or `report` behavior;
- public cases, fixtures, variants, or private oracle content.

## Architecture

The implementation adds three focused modules. Each module owns one lifecycle
and exposes a small typed interface rather than leaking temporary-directory or
copying details to callers.

```text
validated catalog data
        |
        v
WorkspaceMaterializer ----> temporary agent workspace
        |
        v
VariantInstaller ----------> installed public skill material
        |
        | agent session closes outside Stage 2A
        v
OracleLifecycle -----------> separate temporary grading area
```

The oracle grading area is never nested inside or copied into the agent
workspace. Stage 2A does not provide an API that returns private oracle paths
while the lifecycle is in the `agent_active` state.

## Workspace Materialization

`src/workspace/materialize-workspace.ts` owns fixture copying and workspace
cleanup.

Its public operation accepts the validated project paths, a fixture path, and
an optional temporary parent used by tests. It:

1. resolves the fixture beneath the project's `fixtures/` directory with the
   existing safe-path rules;
2. calculates the fixture tree content hash;
3. creates a new temporary directory and a `workspace/` child;
4. copies regular files and directories without following symbolic links;
5. rejects a symbolic link anywhere in the fixture tree;
6. returns a lifecycle object containing the workspace path, frozen fixture
   hash, source-verification operation, and idempotent cleanup operation.

Source verification recalculates the fixture tree hash and raises an integrity
error when it differs from the frozen hash. Callers can use it after agent or
grading work in Stage 2B. Cleanup removes only the unique temporary root created
by this operation. A failed copy removes that root before returning the error.

The tree hash retains the Stage 1 `hashTree()` semantics: regular-file paths and
bytes contribute in deterministic lexical order, while metadata and empty
directories do not. Materialization still preserves empty directories even
though they do not affect the published fixture hash.

## Variant Installation

`src/variants/install-variant.ts` installs public skill material into a
materialized workspace. Core code remains data-driven and contains no branches
for LexForge, OpenSpec, Superpowers, or other named skills.

The installer accepts a validated variant, runtime identifier, project paths,
and workspace path. It selects the manifest mappings for that runtime and
performs two phases:

1. Preflight resolves every project-relative source below the variant directory
   identified by the catalog entry and every destination below the workspace.
   It rejects missing sources, symbolic links, destination escapes, duplicate
   destinations, ancestor/descendant destination overlaps, and collisions with
   existing workspace paths.
2. Apply copies the sources only after every mapping passes preflight, then
   calculates the installed tree hash and compares it with the manifest's
   declared content hash.

The declared variant hash retains the Stage 1 catalog formula: the canonical
array of `{ source, contentHash }` records, where `contentHash` is the source
tree hash. After copying, the installer hashes each destination and reconstructs
the same records with the manifest's source labels. Comparing that value with
the declared hash makes the check independent of absolute checkout and
temporary workspace paths while proving the applied bytes match the validated
source material.

A control variant is represented by an empty mapping list and a declared hash
of the canonical empty installation. It performs no workspace writes and still
returns a successful installation record. An apply or hash failure removes only
paths created by the installer, in reverse depth order, and preserves all
pre-existing workspace content.

## Private Oracle Lifecycle

`src/oracles/oracle-lifecycle.ts` enforces the ordering rule for hidden tests.
It uses these explicit states:

```text
agent_active -> agent_closed -> oracle_mounted -> cleaned
                                     |
                                     +--------------> cleaned
agent_active ---------------------------------------> cleaned
agent_closed ---------------------------------------> cleaned
```

The lifecycle starts in `agent_active`. `markAgentClosed()` is the only
transition to `agent_closed`. `mountOracle()` is valid only from
`agent_closed`; it resolves `.private/oracles/<case-id>/` beneath the project,
rejects symbolic links, copies it into a new temporary grading root that is not
inside the agent workspace, and transitions to `oracle_mounted`.

The mount result exposes the grading copy, never the private source directory.
The lifecycle accepts the agent workspace path at construction and verifies
that neither the temporary root nor grading copy is equal to, inside, or an
ancestor of that workspace.

`cleanup()` is valid from every non-cleaned state and is idempotent. It removes
the grading temporary root when present and transitions to `cleaned`. A mount
failure cleans partial grading material and leaves the lifecycle in
`agent_closed`, allowing the caller to inspect the error or retry after an
external availability problem. No method can return an oracle path after
cleanup.

Stage 2A cannot prove that an external agent process is actually closed. It
provides the typed transition that Stage 2B must call only after its adapter
reports session closure. Tests prove the state machine and filesystem boundary.

## Types and Errors

The new modules expose readonly records and narrow lifecycle methods. Temporary
paths use absolute filesystem paths internally and are never serialized as
portable benchmark inputs.

Expected domain failures extend the existing SkillBench error model with stable
codes for:

- unsafe or symbolic-link filesystem input;
- missing installation source;
- conflicting installation destination;
- content hash mismatch;
- invalid oracle lifecycle transition;
- cleanup failure.

Messages use concise international English and identify the manifest-relative
path or lifecycle operation that failed. Errors retain their original cause
when Node.js supplies one. Cleanup errors are reported rather than silently
discarded. If a primary operation and cleanup both fail, the primary error is
preserved and the cleanup failure is attached as additional evidence.

## Failure Atomicity

All mappings are preflighted before variant installation writes anything. The
installer records each path it creates and removes those paths if apply or hash
verification fails. It never deletes a pre-existing path.

Workspace materialization and oracle mounting allocate unique temporary roots,
so their failure cleanup cannot target a shared directory. Cleanup targets are
stored as resolved absolute paths created by the module; cleanup never accepts a
caller-provided deletion target.

Concurrent replacement by another hostile local process remains outside the
Stage 2A guarantee. The existing time-of-check/time-of-use limitation remains
documented in project memory and the README.

## Testing Strategy

Development follows test-driven development with Node's built-in test runner and
temporary filesystem fixtures.

Workspace tests cover:

- byte-for-byte copying of nested files and preservation of empty directories;
- unique workspaces for repeated materializations;
- deterministic hashes and detection of source mutation;
- rejection of fixture symbolic links;
- idempotent cleanup and cleanup after copy failure.

Variant tests cover:

- an empty control installation;
- multiple nested file and directory mappings;
- missing sources, traversal, source symlinks, destination symlink escapes,
  duplicate destinations, overlaps, and pre-existing collisions;
- no workspace mutation when preflight fails;
- rollback of installer-created paths after apply or hash failure;
- declared versus installed content hash verification.

Oracle tests cover:

- rejection of mount while the agent is active;
- successful mount after explicit closure into a directory outside the agent
  workspace;
- rejection of private-oracle symlinks and missing oracle directories;
- cleanup after mount failure, cleanup from every state, and repeated cleanup;
- inability to mount or obtain paths after cleanup.

The normal completion gate is:

```sh
npm run check
npm run build
node dist/src/cli.js validate --project . --public-only
```

The final CLI command must continue to report successful validation with zero
public cases and variants. Reserved commands must continue to return exit code
`2`.

## Documentation and Delivery State

After implementation, `README.md` is updated in both English and Russian. It
describes the new internal file-lifecycle primitives without claiming that
SkillBench can execute agents or oracles. `AGENTS.md` is updated to say Stage 2A
is complete and to identify Stage 2B as run orchestration, frozen inputs,
normalized results, and the operational `dry-run` increment.

No generated or private content under `.private/`, `runs/`, `.worktrees/`, or
`.superpowers/` is committed.
