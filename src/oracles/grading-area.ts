import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentHash } from "../domain/model.js";
import { FileLifecycleError } from "../domain/file-lifecycle-error.js";
import { copySafeTree } from "../filesystem/safe-tree.js";
import { canonicalJson } from "../integrity/canonical-json.js";
import { hashFile } from "../integrity/content-hash.js";
import { describeChanges, diffSnapshots, snapshotTree, type TreeSnapshot } from "../runs/snapshot.js";

const areaPrefix = "skillbench-grading-area-";
const copyPrefix = "check-";
const evidenceFileName = "workspace.json";

/** A disposable copy of the reference tree, handed to exactly one check. */
export interface CheckCopy {
  readonly path: string;
  remove(): Promise<void>;
}

export interface GradingArea {
  /** The tree every check copy is made from. No agent-authored code ever runs in it. */
  readonly referencePath: string;
  /** Directory holding `workspace.json`, written before the first check started. */
  readonly evidencePath: string;
  /**
   * Rejects when the reference tree no longer matches the snapshot it was built from, or
   * when the evidence file has changed since it was written. Nothing a check does may
   * change what the evidence says, so both are checked every time, not just the tree.
   */
  verifyMaterial(): Promise<void>;
  createCheckCopy(): Promise<CheckCopy>;
  cleanup(): Promise<void>;
}

export interface CreateGradingAreaInput {
  readonly workspacePath: string;
  readonly snapshot: TreeSnapshot;
  readonly tempParent?: string;
}

/**
 * Builds the material grading reads: a copy of the agent's finished workspace, and a
 * description of it recorded before any check runs.
 *
 * A check runs code the measured agent wrote, and that code knows the path of the
 * workspace it was written in. Handing a check the workspace itself therefore lets the
 * agent's code repair the tree for one check and restore the damage afterwards. Checks
 * see a copy at a path the agent has never seen, a fresh one each time, and anything
 * graded from tree state is graded from `workspace.json`, which no check can reach.
 */
export async function createGradingArea(input: CreateGradingAreaInput): Promise<GradingArea> {
  // The parent is resolved first, so every path below is canonical. A check runs the
  // agent's project as `node <copy>/src/cli.js`, and Node resolves symbolic links when
  // it loads that entry point: on macOS the system temporary directory sits behind a
  // `/var` -> `/private/var` link, so an unresolved path makes `process.argv[1]` and
  // `import.meta.url` disagree and a CLI entrypoint guard never fires.
  const parent = await realpath(input.tempParent ?? tmpdir());
  const root = await mkdtemp(join(parent, areaPrefix));
  const referencePath = join(root, "reference");
  const evidencePath = join(root, "evidence");
  const evidenceFilePath = join(evidencePath, evidenceFileName);

  let evidenceHash: ContentHash;
  try {
    await copySafeTree(input.workspacePath, referencePath);
    await assertMatches(referencePath, input.snapshot, "the workspace changed while the grading area was prepared");

    await mkdir(evidencePath, { recursive: true });
    const files: Record<string, string> = {};
    for (const entry of input.snapshot) {
      files[entry.path] = entry.contentHash;
    }
    await writeFile(evidenceFilePath, `${canonicalJson({ schemaVersion: 1, files })}\n`);
    evidenceHash = await hashFile(evidenceFilePath);
  } catch (cause: unknown) {
    await rm(root, { recursive: true, force: true });
    throw cause;
  }

  return Object.freeze({
    referencePath,
    evidencePath,
    verifyMaterial: async () => {
      await assertMatches(referencePath, input.snapshot, "the graded copy changed while the checks ran");
      await assertFileMatches(evidenceFilePath, evidenceHash, "the evidence file changed while the checks ran");
    },
    createCheckCopy: async (): Promise<CheckCopy> => {
      const copyRoot = await mkdtemp(join(root, copyPrefix));
      const path = join(copyRoot, "workspace");
      await copySafeTree(referencePath, path);
      return Object.freeze({
        path,
        remove: async () => {
          await rm(copyRoot, { recursive: true, force: true });
        },
      });
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  });
}

async function assertMatches(path: string, snapshot: TreeSnapshot, headline: string): Promise<void> {
  const changes = diffSnapshots(snapshot, await snapshotTree(path));
  if (changes.added.length + changes.modified.length + changes.removed.length === 0) return;
  throw new FileLifecycleError("CONTENT_HASH_MISMATCH", `${headline}: ${describeChanges(changes)}`);
}

/**
 * Unlike `assertMatches`, this checks one file, not a tree, so the failure names the
 * evidence file itself rather than a path relative to some tree — nothing here should
 * read as if it were reporting a change inside the workspace.
 */
async function assertFileMatches(path: string, expected: ContentHash, headline: string): Promise<void> {
  const actual = await hashFile(path);
  if (actual === expected) return;
  throw new FileLifecycleError("CONTENT_HASH_MISMATCH", `${headline}: ${evidenceFileName}`);
}
