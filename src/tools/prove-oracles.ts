import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { loadCatalog, type CatalogCase } from "../catalog/load-catalog.js";
import type { AssertionDeclaration, OracleManifest } from "../domain/model.js";
import { copySafeTree, isSameOrInside } from "../filesystem/safe-tree.js";
import { hashFile } from "../integrity/content-hash.js";
import { OracleLifecycle } from "../oracles/oracle-lifecycle.js";
import { loadOracleManifest } from "../oracles/oracle-manifest.js";
import { runOracle } from "../oracles/run-oracle.js";
import { ProjectPaths } from "../paths/project-paths.js";
import { ManifestValidator } from "../schemas/validator.js";

export type PatchKind = "pass" | "fail";

export interface ProveOraclesInput {
  readonly root: string;
  readonly caseIds?: readonly string[];
}

export interface ProofFailure {
  /** Absent when the failure is about the project rather than one case. */
  readonly caseId?: string;
  /** Absent for a failure that belongs to the case rather than one assertion. */
  readonly assertionId?: string;
  /** Absent when no single patch is at fault. */
  readonly patch?: PatchKind;
  readonly message: string;
}

export interface ProvenAssertion {
  readonly caseId: string;
  readonly assertionId: string;
}

export interface ProofReport {
  readonly provenAssertions: number;
  readonly proven: readonly ProvenAssertion[];
  readonly failures: readonly ProofFailure[];
}

interface PatchOverlay {
  readonly description: string;
  readonly include: readonly string[];
  readonly removals: readonly string[];
}

interface Baseline {
  readonly fixture: string;
  readonly files: Readonly<Record<string, string>>;
}

const privateOracles = ".private/oracles";
const privateProofs = ".private/proofs";
const sharedPatchesDirectory = "_patches";
const patchKinds: readonly PatchKind[] = ["pass", "fail"];

/**
 * Proves that every oracle-graded assertion of the selected cases can both pass and
 * fail. Each assertion carries a `pass` patch, which is a correct solution, and a
 * `fail` patch, which is a deliberately broken one; the real oracle must agree with
 * both. An assertion whose check is always green never earns its `fail` patch and is
 * reported here rather than silently reporting every agent as successful.
 */
export async function proveOracles(input: ProveOraclesInput): Promise<ProofReport> {
  const failures: ProofFailure[] = [];
  const proven: ProvenAssertion[] = [];

  if (!(await isDirectory(join(input.root, privateOracles)))) {
    return report(proven, [{ message: `${privateOracles} is absent; the private oracle repository is not checked out` }]);
  }

  const paths = await ProjectPaths.create(input.root);
  const validator = await ManifestValidator.create(join(input.root, "schemas"));
  const catalog = await loadCatalog(input.root, { requirePrivateOracles: false });
  const selected = selectCases(catalog.cases, input.caseIds, failures);

  // An issue whose source never became a case belongs to no case at all, so a per-case
  // filter would drop it: a `case.json` that fails to parse would leave this gate green
  // having proved nothing.
  for (const issue of catalog.issues) {
    const owner = catalog.cases.find(({ source }) => source === issue.source);
    if (owner !== undefined && !selected.includes(owner)) continue;
    const message = `catalog issue ${issue.code} in ${issue.source}: ${issue.message}`;
    failures.push(owner === undefined ? { message } : { caseId: owner.manifest.id, message });
  }

  for (const catalogCase of selected) {
    await proveCase({ input, paths, validator, catalogCase, proven, failures });
  }

  // Proving nothing is never a pass: an empty or unreadable catalog would otherwise
  // report success without having run a single check.
  if (proven.length === 0 && failures.length === 0) {
    failures.push({ message: "nothing was proven: no selected case declares an oracle-graded assertion with a patch" });
  }

  return report(proven, failures);
}

function report(proven: readonly ProvenAssertion[], failures: readonly ProofFailure[]): ProofReport {
  return Object.freeze({ provenAssertions: proven.length, proven: Object.freeze([...proven]), failures: Object.freeze([...failures]) });
}

function selectCases(
  cases: readonly CatalogCase[],
  caseIds: readonly string[] | undefined,
  failures: ProofFailure[],
): readonly CatalogCase[] {
  if (caseIds === undefined) return cases;
  if (caseIds.length === 0) {
    failures.push({ message: "no case was selected, so nothing could be proven" });
    return [];
  }

  const selected: CatalogCase[] = [];
  for (const caseId of caseIds) {
    const catalogCase = cases.find(({ manifest }) => manifest.id === caseId);
    if (catalogCase === undefined) {
      failures.push({ caseId, message: `unknown case ${JSON.stringify(caseId)}` });
      continue;
    }
    selected.push(catalogCase);
  }
  return selected;
}

interface ProveCaseInput {
  readonly input: ProveOraclesInput;
  readonly paths: ProjectPaths;
  readonly validator: ManifestValidator;
  readonly catalogCase: CatalogCase;
  readonly proven: ProvenAssertion[];
  readonly failures: ProofFailure[];
}

async function proveCase(context: ProveCaseInput): Promise<void> {
  const { catalogCase, failures } = context;
  const caseId = catalogCase.manifest.id;

  let oracleDirectory: string;
  try {
    oracleDirectory = await context.paths.resolveExisting(`${privateOracles}/${caseId}`, "directory");
  } catch (error: unknown) {
    failures.push({ caseId, message: `private oracle is unavailable: ${errorMessage(error)}` });
    return;
  }

  const fixturePath = catalogCase.fixturePath;
  if (fixturePath === undefined) {
    failures.push({ caseId, message: "the fixture is unavailable, so no patch can be composed" });
    return;
  }

  await verifyBaseline(caseId, oracleDirectory, fixturePath, catalogCase.manifest.fixture.path, failures);

  let checkIds: ReadonlySet<string>;
  try {
    const manifest = await loadOracleManifest(oracleDirectory, context.validator);
    checkIds = new Set(manifest.checks.map(({ assertionId }) => assertionId));
  } catch (error: unknown) {
    failures.push({ caseId, message: `oracle manifest could not be read: ${errorMessage(error)}` });
    return;
  }

  const oracleGraded = catalogCase.manifest.assertions.filter(({ transcriptRuleId }) => transcriptRuleId === undefined);
  const gradedIds = new Set(oracleGraded.map(({ id }) => id));

  const undeclared = [...checkIds].filter((id) => !gradedIds.has(id)).sort();
  if (undeclared.length > 0) {
    failures.push({
      caseId,
      message: `the oracle declares check(s) the case does not grade from the oracle: ${undeclared.join(", ")}`,
    });
    return;
  }

  // The oracle grows one check per task, so an assertion that has no check yet is
  // reported instead of being handed to `runOracle`, which rejects an assertion list
  // wider than the manifest and would stop the whole run.
  const covered = oracleGraded.filter(({ id }) => checkIds.has(id));
  for (const assertion of oracleGraded) {
    if (checkIds.has(assertion.id)) continue;
    failures.push({
      caseId,
      assertionId: assertion.id,
      message: `case ${caseId} assertion ${assertion.id} has no oracle check yet`,
    });
  }

  const proofsRoot = join(context.input.root, privateProofs, caseId);
  await reportUnknownPatchDirectories(caseId, proofsRoot, gradedIds, failures);

  for (const assertion of covered) {
    const failureCount = failures.length;
    for (const patch of patchKinds) {
      await proveAssertionPatch({ context, fixturePath, proofsRoot, assertion, patch });
    }
    if (failures.length === failureCount) {
      context.proven.push({ caseId, assertionId: assertion.id });
    }
  }
}

async function reportUnknownPatchDirectories(
  caseId: string,
  proofsRoot: string,
  gradedIds: ReadonlySet<string>,
  failures: ProofFailure[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(proofsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingPath(error)) return;
    failures.push({ caseId, message: `proof directory could not be read: ${errorMessage(error)}` });
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === sharedPatchesDirectory || gradedIds.has(entry.name)) continue;
    failures.push({
      caseId,
      assertionId: entry.name,
      message: `proof directory names an unknown assertion ${JSON.stringify(entry.name)}`,
    });
  }
}

interface ProveAssertionPatchInput {
  readonly context: ProveCaseInput;
  readonly fixturePath: string;
  readonly proofsRoot: string;
  readonly assertion: AssertionDeclaration;
  readonly patch: PatchKind;
}

async function proveAssertionPatch(input: ProveAssertionPatchInput): Promise<void> {
  const { context, assertion, patch } = input;
  const caseId = context.catalogCase.manifest.id;
  const patchDirectory = join(input.proofsRoot, assertion.id, patch);

  if (!(await isDirectory(patchDirectory))) {
    context.failures.push({
      caseId,
      assertionId: assertion.id,
      patch,
      message: `case ${caseId} assertion ${assertion.id} has no ${patch} patch`,
    });
    return;
  }

  const workspaceParent = await mkdtemp(join(tmpdir(), "skillbench-proof-workspace-"));
  try {
    const workspacePath = join(workspaceParent, "workspace");
    await composePatched({
      fixturePath: input.fixturePath,
      patchDirectory,
      sharedPatchesRoot: join(input.proofsRoot, sharedPatchesDirectory),
      target: workspacePath,
      label: `case ${caseId} assertion ${assertion.id} ${patch} patch`,
    });

    const outcome = await gradeWorkspace({ context, caseId, workspacePath, assertion });

    const expected = patch === "pass" ? "passed" : "failed";
    if (outcome.outcome === expected) return;
    const detail = outcome.detail === "" ? "" : `: ${outcome.detail}`;
    context.failures.push({
      caseId,
      assertionId: assertion.id,
      patch,
      message: `expected the assertion to ${patch} but it ${outcome.outcome}${detail}`,
    });
  } catch (error: unknown) {
    context.failures.push({
      caseId,
      assertionId: assertion.id,
      patch,
      message: errorMessage(error),
    });
  } finally {
    await rm(workspaceParent, { recursive: true, force: true });
  }
}

interface GradeWorkspaceInput {
  readonly context: ProveCaseInput;
  readonly caseId: string;
  readonly workspacePath: string;
  readonly assertion: AssertionDeclaration;
}

async function gradeWorkspace(input: GradeWorkspaceInput): Promise<{ outcome: string; detail: string }> {
  const lifecycle = await OracleLifecycle.create({
    paths: input.context.paths,
    caseId: input.caseId,
    workspacePath: input.workspacePath,
  });
  lifecycle.markAgentClosed();
  const mounted = await lifecycle.mountOracle();
  try {
    const manifest = await loadOracleManifest(mounted.gradingPath, input.context.validator);
    const check = manifest.checks.find(({ assertionId }) => assertionId === input.assertion.id);
    if (check === undefined) {
      throw new Error(`the mounted oracle declares no check for assertion ${input.assertion.id}`);
    }

    // Only the check under proof runs. `runOracle` insists the assertion list and the
    // manifest cover each other, so both are narrowed to this one assertion: an
    // unrelated check must not decide, or slow down, this assertion's proof.
    const narrowed: OracleManifest = {
      schemaVersion: manifest.schemaVersion,
      caseId: manifest.caseId,
      checks: [check],
    };
    const results = await runOracle({
      manifest: narrowed,
      assertions: [input.assertion],
      gradingPath: mounted.gradingPath,
      workspacePath: input.workspacePath,
    });
    const result = results[0];
    if (result === undefined) {
      throw new Error(`the oracle returned no result for assertion ${input.assertion.id}`);
    }
    return { outcome: result.outcome, detail: result.outcome === "error" ? result.detail : "" };
  } finally {
    await lifecycle.cleanup();
  }
}

async function verifyBaseline(
  caseId: string,
  oracleDirectory: string,
  fixturePath: string,
  declaredFixture: string,
  failures: ProofFailure[],
): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(oracleDirectory, "baseline.json"), "utf8");
  } catch (error: unknown) {
    // A silent skip here would disable both the fixture comparison and the carried-test
    // comparison, which is the vacuous pass this tool exists to catch.
    const reason = isMissingPath(error) ? "it does not exist" : errorMessage(error);
    failures.push({ caseId, message: `the oracle has no readable baseline.json: ${reason}` });
    return;
  }

  const baseline = parseBaseline(text);
  if (typeof baseline === "string") {
    failures.push({ caseId, message: `baseline.json is malformed: ${baseline}` });
    return;
  }

  if (baseline.fixture !== declaredFixture) {
    failures.push({
      caseId,
      message: `baseline names fixture ${JSON.stringify(baseline.fixture)} but the case uses ${JSON.stringify(declaredFixture)}`,
    });
    return;
  }

  let fixtureFiles: readonly string[];
  try {
    fixtureFiles = await listTreeFiles(fixturePath, `fixture ${declaredFixture}`);
  } catch (error: unknown) {
    failures.push({ caseId, message: `baseline could not be compared with the fixture: ${errorMessage(error)}` });
    return;
  }

  const recorded = new Set(Object.keys(baseline.files));
  for (const relativePath of fixtureFiles) {
    if (!recorded.has(relativePath)) {
      failures.push({ caseId, message: `fixture file ${JSON.stringify(relativePath)} has no baseline entry` });
    }
  }

  for (const relativePath of [...recorded].sort()) {
    if (!fixtureFiles.includes(relativePath)) {
      failures.push({ caseId, message: `baseline entry ${JSON.stringify(relativePath)} has no file in the fixture` });
      continue;
    }
    const actual = await hashFile(join(fixturePath, relativePath));
    if (actual !== baseline.files[relativePath]) {
      failures.push({ caseId, message: `baseline entry ${JSON.stringify(relativePath)} no longer matches the fixture file` });
    }
  }

  await verifyCarriedTests(caseId, oracleDirectory, baseline, failures);
}

/**
 * The oracle carries its own copy of the public test suite so that grading never reads
 * the copy the agent could have edited. That carried copy has to stay the fixture's,
 * which the baseline already records.
 */
async function verifyCarriedTests(
  caseId: string,
  oracleDirectory: string,
  baseline: Baseline,
  failures: ProofFailure[],
): Promise<void> {
  const carriedTests = join(oracleDirectory, "tests");
  if (!(await isDirectory(carriedTests))) return;

  let carried: readonly string[];
  try {
    carried = await listTreeFiles(carriedTests, `oracle tests of case ${caseId}`);
  } catch (error: unknown) {
    failures.push({ caseId, message: `carried tests could not be compared with the baseline: ${errorMessage(error)}` });
    return;
  }

  const carriedPaths = new Set(carried.map((relativePath) => `tests/${relativePath}`));
  for (const relativePath of carried) {
    const baselinePath = `tests/${relativePath}`;
    const expected = baseline.files[baselinePath];
    if (expected === undefined) {
      failures.push({ caseId, message: `oracle test file ${JSON.stringify(baselinePath)} has no baseline entry` });
      continue;
    }
    const actual = await hashFile(join(carriedTests, relativePath));
    if (actual !== expected) {
      failures.push({
        caseId,
        message: `oracle test file ${JSON.stringify(baselinePath)} does not match the baseline entry`,
      });
    }
  }

  // The comparison has to run in both directions. An oracle carrying only part of the
  // public suite matches every file it has and would grade the regression assertion
  // against a quietly weakened suite for as long as nobody noticed.
  for (const baselinePath of Object.keys(baseline.files).sort()) {
    if (!baselinePath.startsWith("tests/") || carriedPaths.has(baselinePath)) continue;
    failures.push({
      caseId,
      message: `public test file ${JSON.stringify(baselinePath)} is not carried by the oracle`,
    });
  }
}

function parseBaseline(text: string): Baseline | string {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    return `invalid JSON: ${errorMessage(error)}`;
  }

  if (!isRecord(value)) return "the baseline must be a JSON object";
  const fixture = value["fixture"];
  if (typeof fixture !== "string" || fixture === "") return "the baseline has no fixture path";
  const files = value["files"];
  if (!isRecord(files)) return "the baseline has no files object";

  const entries: Record<string, string> = {};
  for (const [key, hash] of Object.entries(files)) {
    if (typeof hash !== "string") return `the baseline entry ${JSON.stringify(key)} is not a hash`;
    entries[key] = hash;
  }
  return { fixture, files: entries };
}

interface ComposePatchedInput {
  readonly fixturePath: string;
  readonly patchDirectory: string;
  readonly sharedPatchesRoot: string;
  readonly target: string;
  readonly label: string;
}

/**
 * Copies the fixture, applies every shared patch the overlay includes in the listed
 * order, then the patch's own removals and files. Every path stays inside the copy.
 */
async function composePatched(input: ComposePatchedInput): Promise<void> {
  await mkdir(dirname(input.target), { recursive: true });
  await copySafeTree(input.fixturePath, input.target);

  const overlay = await readOverlay(input.patchDirectory, input.label);
  for (const name of overlay.include) {
    if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      throw new Error(`${input.label} includes an unsafe patch name ${JSON.stringify(name)}`);
    }
    const sharedDirectory = join(input.sharedPatchesRoot, name);
    if (!(await isDirectory(sharedDirectory))) {
      throw new Error(`${input.label} includes a missing shared patch ${JSON.stringify(name)}`);
    }
    const sharedLabel = `${input.label} include ${JSON.stringify(name)}`;
    const shared = await readOverlay(sharedDirectory, sharedLabel);
    if (shared.include.length > 0) {
      throw new Error(`${sharedLabel} includes further patches, which is not supported`);
    }
    await applyOverlay(sharedDirectory, shared, input.target, sharedLabel);
  }

  await applyOverlay(input.patchDirectory, overlay, input.target, input.label);
}

async function applyOverlay(
  directory: string,
  overlay: PatchOverlay,
  target: string,
  label: string,
): Promise<void> {
  for (const removal of overlay.removals) {
    const removalPath = resolveInside(target, removal, label);
    if (!(await exists(removalPath))) {
      throw new Error(`${label} removes a path the composed copy does not have: ${removal}`);
    }
    await rm(removalPath, { recursive: true });
  }

  const files = join(directory, "files");
  if (await isDirectory(files)) {
    await overlayTree(files, target, label);
  }
}

async function readOverlay(directory: string, label: string): Promise<PatchOverlay> {
  let text: string;
  try {
    text = await readFile(join(directory, "overlay.json"), "utf8");
  } catch (error: unknown) {
    throw new Error(`${label} has no readable overlay.json: ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} has invalid JSON in overlay.json: ${errorMessage(error)}`);
  }

  if (!isRecord(value)) throw new Error(`${label} overlay.json must be a JSON object`);
  const description = value["description"];
  if (typeof description !== "string" || description === "") {
    throw new Error(`${label} overlay.json has no description`);
  }
  return {
    description,
    include: readStringList(value["include"], `${label} overlay.json include`),
    removals: readStringList(value["removals"], `${label} overlay.json removals`),
  };
}

function readStringList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a list of non-empty strings`);
  }

  const entries: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== "string" || entry === "") {
      throw new Error(`${label} must be a list of non-empty strings`);
    }
    entries.push(entry);
  }
  return entries;
}

function resolveInside(target: string, relativePath: string, label: string): string {
  if (relativePath.includes("\0")) {
    throw new Error(`${label} names a path with a NUL byte`);
  }
  if (isAbsolute(relativePath)) {
    throw new Error(`${label} escapes the composed copy with an absolute path: ${relativePath}`);
  }
  const resolved = resolve(target, relativePath);
  if (resolved === target || !isSameOrInside(target, resolved)) {
    throw new Error(`${label} escapes the composed copy: ${relativePath}`);
  }
  return resolved;
}

async function overlayTree(source: string, destination: string, label: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const status = await lstat(from);
    if (status.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link: ${from}`);
    }
    if (status.isDirectory()) {
      await mkdir(to, { recursive: true });
      await overlayTree(from, to, label);
      continue;
    }
    if (!status.isFile()) {
      throw new Error(`${label} contains an unsupported entry: ${from}`);
    }
    await copyFile(from, to);
  }
}

async function listTreeFiles(root: string, label: string, prefix = "", collected: string[] = []): Promise<string[]> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const status = await lstat(join(root, relativePath));
    if (status.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link: ${relativePath}`);
    }
    if (status.isDirectory()) {
      await listTreeFiles(root, label, relativePath, collected);
      continue;
    }
    collected.push(relativePath);
  }
  collected.sort();
  return collected;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const root = await findRepositoryRoot(import.meta.dirname);
  const caseIds = argv.filter((argument) => !argument.startsWith("-"));
  const report = await proveOracles(caseIds.length > 0 ? { root, caseIds } : { root });

  for (const { caseId, assertionId } of report.proven) {
    process.stdout.write(`proved ${caseId} ${assertionId}\n`);
  }
  for (const failure of report.failures) {
    const patch = failure.patch === undefined ? "" : ` (${failure.patch})`;
    process.stdout.write(
      `FAILED ${failure.caseId ?? "-"} ${failure.assertionId ?? "-"}${patch}: ${failure.message}\n`,
    );
  }
  process.stdout.write(
    `proved ${String(report.provenAssertions)} assertion(s), ${String(report.failures.length)} failure(s)\n`,
  );

  if (!(await isDirectory(join(root, privateOracles)))) {
    process.exitCode = 2;
    return;
  }
  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}

async function findRepositoryRoot(start: string): Promise<string> {
  let candidate = start;
  for (;;) {
    if (await isDirectory(join(candidate, "schemas")) && await exists(join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`no repository root above ${start}`);
    }
    candidate = parent;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
