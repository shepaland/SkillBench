import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaseManifest, ContentHash, OracleManifest, VariantManifest } from "../domain/model.js";
import { hashTree, hashValue } from "../integrity/content-hash.js";
import { assertOracleCoversAssertions, loadOracleManifest } from "../oracles/oracle-manifest.js";
import { ProjectPaths } from "../paths/project-paths.js";
import { ManifestValidator } from "../schemas/validator.js";

export type CatalogIssueCode =
  | "CHANGE_PATH_OVERLAP"
  | "CONTINUATION_RULE_NOT_FOUND"
  | "DUPLICATE_ASSERTION_ID"
  | "DUPLICATE_CASE_ID"
  | "DUPLICATE_PROMPT_STEP_ID"
  | "DUPLICATE_TRANSCRIPT_RULE_ID"
  | "DUPLICATE_VARIANT_ID"
  | "FIXTURE_HASH_MISMATCH"
  | "FIXTURE_UNAVAILABLE"
  | "JSON_PARSE"
  | "MANIFEST_READ"
  | "MISSING_RUNTIME_DESTINATION"
  | "ORACLE_ASSERTION_MISMATCH"
  | "ORACLE_EMPTY"
  | "ORACLE_MANIFEST_INVALID"
  | "ORACLE_UNAVAILABLE"
  | "SCHEMA_VALIDATION"
  | "TRANSCRIPT_RULE_NOT_FOUND"
  | "TRANSCRIPT_RULE_REUSED"
  | "VARIANT_HASH_MISMATCH"
  | "VARIANT_SOURCE_UNAVAILABLE";

export interface CatalogIssue {
  readonly source: string;
  readonly code: CatalogIssueCode;
  readonly message: string;
}

export interface CatalogCase {
  readonly source: string;
  readonly manifest: CaseManifest;
  readonly fixturePath?: string;
  readonly fixtureHash?: ContentHash;
  readonly oraclePath?: string;
  readonly oracleHash?: ContentHash;
}

export interface CatalogVariant {
  readonly source: string;
  readonly manifest: VariantManifest;
  readonly installSourcePaths: readonly string[];
  readonly materialHash?: ContentHash;
}

export interface Catalog {
  readonly cases: readonly CatalogCase[];
  readonly variants: readonly CatalogVariant[];
  readonly issues: readonly CatalogIssue[];
}

export interface LoadCatalogOptions {
  readonly requirePrivateOracles?: boolean;
}

interface SourcedManifest<T> {
  readonly source: string;
  readonly manifest: T;
}

export async function loadCatalog(
  root: string,
  options: LoadCatalogOptions = {},
): Promise<Catalog> {
  const issues: CatalogIssue[] = [];
  const paths = await ProjectPaths.create(root);
  const validator = await ManifestValidator.create(join(root, "schemas"));
  const [caseSources, variantSources] = await Promise.all([
    discoverManifestSources(root, "cases", "case.json"),
    discoverManifestSources(root, "variants", "variant.json"),
  ]);

  const sourcedCases: SourcedManifest<CaseManifest>[] = [];
  for (const source of caseSources) {
    const manifest = await readManifest(root, source, "case", validator, issues);
    if (manifest !== undefined) {
      sourcedCases.push({ source, manifest });
    }
  }

  const sourcedVariants: SourcedManifest<VariantManifest>[] = [];
  for (const source of variantSources) {
    const manifest = await readManifest(root, source, "variant", validator, issues);
    if (manifest !== undefined) {
      sourcedVariants.push({ source, manifest });
    }
  }

  validateUniqueManifestIds(sourcedCases, "case", issues);
  validateUniqueManifestIds(sourcedVariants, "variant", issues);

  const requirePrivateOracles = options.requirePrivateOracles ?? true;
  const cases: CatalogCase[] = [];
  for (const sourcedCase of sourcedCases) {
    cases.push(await validateCase(sourcedCase, paths, requirePrivateOracles, validator, issues));
  }

  const variants: CatalogVariant[] = [];
  for (const sourcedVariant of sourcedVariants) {
    variants.push(await validateVariant(sourcedVariant, paths, issues));
  }

  issues.sort(compareIssues);
  return { cases, variants, issues };
}

async function discoverManifestSources(
  root: string,
  parent: "cases" | "variants",
  filename: "case.json" | "variant.json",
): Promise<string[]> {
  const parentPath = join(root, parent);
  let entries;
  try {
    entries = await readdir(parentPath, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return [];
    }
    throw error;
  }

  const sources: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const directory = join(parentPath, entry.name);
    const children = await readdir(directory, { withFileTypes: true });
    if (children.some((child) => child.name === filename && child.isFile())) {
      sources.push(`${parent}/${entry.name}/${filename}`);
    }
  }
  sources.sort(compareText);
  return sources;
}

async function readManifest(
  root: string,
  source: string,
  kind: "case",
  validator: ManifestValidator,
  issues: CatalogIssue[],
): Promise<CaseManifest | undefined>;
async function readManifest(
  root: string,
  source: string,
  kind: "variant",
  validator: ManifestValidator,
  issues: CatalogIssue[],
): Promise<VariantManifest | undefined>;
async function readManifest(
  root: string,
  source: string,
  kind: "case" | "variant",
  validator: ManifestValidator,
  issues: CatalogIssue[],
): Promise<CaseManifest | VariantManifest | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, source), "utf8");
  } catch (error: unknown) {
    addIssue(issues, source, "MANIFEST_READ", `could not read manifest: ${errorMessage(error)}`);
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    addIssue(issues, source, "JSON_PARSE", `invalid JSON: ${errorMessage(error)}`);
    return undefined;
  }

  try {
    return kind === "case" ? validator.validateCase(value) : validator.validateVariant(value);
  } catch (error: unknown) {
    addIssue(
      issues,
      source,
      "SCHEMA_VALIDATION",
      errorMessage(error).replaceAll("\n", "; "),
    );
    return undefined;
  }
}

function validateUniqueManifestIds<T extends { readonly id: string }>(
  manifests: readonly SourcedManifest<T>[],
  kind: "case" | "variant",
  issues: CatalogIssue[],
): void {
  const firstSourceById = new Map<string, string>();
  for (const { source, manifest } of manifests) {
    const firstSource = firstSourceById.get(manifest.id);
    if (firstSource === undefined) {
      firstSourceById.set(manifest.id, source);
      continue;
    }

    addIssue(
      issues,
      source,
      kind === "case" ? "DUPLICATE_CASE_ID" : "DUPLICATE_VARIANT_ID",
      `${kind} ID ${JSON.stringify(manifest.id)} is already declared by ${firstSource}`,
    );
  }
}

async function validateCase(
  sourcedCase: SourcedManifest<CaseManifest>,
  paths: ProjectPaths,
  requirePrivateOracle: boolean,
  validator: ManifestValidator,
  issues: CatalogIssue[],
): Promise<CatalogCase> {
  const { source, manifest } = sourcedCase;
  validateUniqueIds(manifest.assertions, "DUPLICATE_ASSERTION_ID", "assertion", source, issues);
  validateUniqueIds(manifest.promptSteps, "DUPLICATE_PROMPT_STEP_ID", "prompt step", source, issues);
  validateUniqueIds(
    manifest.transcriptRules ?? [],
    "DUPLICATE_TRANSCRIPT_RULE_ID",
    "transcript rule",
    source,
    issues,
  );
  validateTranscriptReferences(manifest, source, issues);
  validateChangePathIntersections(manifest, source, issues);

  let fixturePath: string | undefined;
  let fixtureHash: ContentHash | undefined;
  const misplacedFixture = fixtureLocationIssue(manifest.fixture.path);
  if (misplacedFixture !== undefined) {
    addIssue(issues, source, "FIXTURE_UNAVAILABLE", misplacedFixture);
  } else {
    try {
      fixturePath = await paths.resolveExisting(manifest.fixture.path, "directory");
      fixtureHash = await hashTree(fixturePath);
      if (fixtureHash !== manifest.fixture.contentHash) {
        addIssue(
          issues,
          source,
          "FIXTURE_HASH_MISMATCH",
          `fixture ${JSON.stringify(manifest.fixture.path)} has hash ${fixtureHash}; expected ${manifest.fixture.contentHash}`,
        );
      }
    } catch (error: unknown) {
      addIssue(
        issues,
        source,
        "FIXTURE_UNAVAILABLE",
        `fixture ${JSON.stringify(manifest.fixture.path)} is unavailable: ${errorMessage(error)}`,
      );
    }
  }

  let oraclePath: string | undefined;
  let oracleHash: ContentHash | undefined;
  if (requirePrivateOracle) {
    const relativeOraclePath = `.private/oracles/${manifest.id}`;
    try {
      oraclePath = await paths.resolveExisting(relativeOraclePath, "directory");
      if ((await readdir(oraclePath)).length === 0) {
        addIssue(
          issues,
          source,
          "ORACLE_EMPTY",
          `private oracle directory ${JSON.stringify(relativeOraclePath)} is empty`,
        );
      } else {
        oracleHash = await hashTree(oraclePath);

        let oracleManifest: OracleManifest | undefined;
        try {
          oracleManifest = await loadOracleManifest(oraclePath, validator);
        } catch (error: unknown) {
          addIssue(
            issues,
            source,
            "ORACLE_MANIFEST_INVALID",
            errorMessage(error).replaceAll("\n", "; "),
          );
        }

        if (oracleManifest !== undefined) {
          try {
            assertOracleCoversAssertions(oracleManifest, manifest.assertions);
          } catch (error: unknown) {
            addIssue(
              issues,
              source,
              "ORACLE_ASSERTION_MISMATCH",
              errorMessage(error).replaceAll("\n", "; "),
            );
          }
        }
      }
    } catch (error: unknown) {
      addIssue(
        issues,
        source,
        "ORACLE_UNAVAILABLE",
        `private oracle ${JSON.stringify(relativeOraclePath)} is unavailable: ${errorMessage(error)}`,
      );
    }
  }

  return compactCase({ source, manifest, fixturePath, fixtureHash, oraclePath, oracleHash });
}

/**
 * A fixture must name a directory inside `fixtures/` before anything resolves or hashes
 * it. Path parsing drops "." segments, so `"."` and `"fixtures/."` resolve to a real
 * directory that is no fixture — and hashing the project root walks `.private/` and
 * `node_modules/` before the hash mismatch is reported. `materializeWorkspace` refuses
 * such a path independently; this keeps `validate` from walking it in the first place.
 */
function fixtureLocationIssue(path: string): string | undefined {
  const segments = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.length < 2 || segments[0] !== "fixtures") {
    return `fixture ${JSON.stringify(path)} must name a directory inside fixtures/`;
  }
  return undefined;
}

function validateUniqueIds(
  values: readonly { readonly id: string }[],
  code: "DUPLICATE_ASSERTION_ID" | "DUPLICATE_PROMPT_STEP_ID" | "DUPLICATE_TRANSCRIPT_RULE_ID",
  label: string,
  source: string,
  issues: CatalogIssue[],
): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id) && !reported.has(value.id)) {
      addIssue(issues, source, code, `${label} ID ${JSON.stringify(value.id)} is duplicated`);
      reported.add(value.id);
    }
    seen.add(value.id);
  }
}

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

function validateChangePathIntersections(
  manifest: CaseManifest,
  source: string,
  issues: CatalogIssue[],
): void {
  for (const allowedPath of manifest.allowedChangePaths) {
    for (const forbiddenPath of manifest.forbiddenChangePaths) {
      if (pathsIntersect(allowedPath, forbiddenPath)) {
        addIssue(
          issues,
          source,
          "CHANGE_PATH_OVERLAP",
          `allowed path ${JSON.stringify(allowedPath)} overlaps forbidden path ${JSON.stringify(forbiddenPath)}`,
        );
      }
    }
  }
}

function pathsIntersect(left: string, right: string): boolean {
  const normalizedLeft = normalizeChangePath(left);
  const normalizedRight = normalizeChangePath(right);
  return normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`);
}

function normalizeChangePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

async function validateVariant(
  sourcedVariant: SourcedManifest<VariantManifest>,
  paths: ProjectPaths,
  issues: CatalogIssue[],
): Promise<CatalogVariant> {
  const { source, manifest } = sourcedVariant;
  for (const install of manifest.installs) {
    for (const runtime of manifest.compatibleRuntimes) {
      if (!Object.hasOwn(install.destinations, runtime)) {
        addIssue(
          issues,
          source,
          "MISSING_RUNTIME_DESTINATION",
          `install source ${JSON.stringify(install.source)} has no destination for compatible runtime ${JSON.stringify(runtime)}`,
        );
      }
    }
  }

  const installSourcePaths: string[] = [];
  const material: { source: string; contentHash: ContentHash }[] = [];
  let allSourcesAvailable = true;
  for (const install of manifest.installs) {
    try {
      const installSourcePath = await paths.resolveExisting(install.source, "directory");
      installSourcePaths.push(installSourcePath);
      material.push({ source: install.source, contentHash: await hashTree(installSourcePath) });
    } catch (error: unknown) {
      allSourcesAvailable = false;
      addIssue(
        issues,
        source,
        "VARIANT_SOURCE_UNAVAILABLE",
        `install source ${JSON.stringify(install.source)} is unavailable: ${errorMessage(error)}`,
      );
    }
  }

  let materialHash: ContentHash | undefined;
  if (allSourcesAvailable) {
    materialHash = hashValue(material);
    if (materialHash !== manifest.contentHash) {
      addIssue(
        issues,
        source,
        "VARIANT_HASH_MISMATCH",
        `installed material has hash ${materialHash}; expected ${manifest.contentHash}`,
      );
    }
  }

  if (materialHash === undefined) {
    return { source, manifest, installSourcePaths };
  }
  return { source, manifest, installSourcePaths, materialHash };
}

function compactCase(value: {
  readonly source: string;
  readonly manifest: CaseManifest;
  readonly fixturePath: string | undefined;
  readonly fixtureHash: ContentHash | undefined;
  readonly oraclePath: string | undefined;
  readonly oracleHash: ContentHash | undefined;
}): CatalogCase {
  const catalogCase: {
    source: string;
    manifest: CaseManifest;
    fixturePath?: string;
    fixtureHash?: ContentHash;
    oraclePath?: string;
    oracleHash?: ContentHash;
  } = { source: value.source, manifest: value.manifest };
  if (value.fixturePath !== undefined) catalogCase.fixturePath = value.fixturePath;
  if (value.fixtureHash !== undefined) catalogCase.fixtureHash = value.fixtureHash;
  if (value.oraclePath !== undefined) catalogCase.oraclePath = value.oraclePath;
  if (value.oracleHash !== undefined) catalogCase.oracleHash = value.oracleHash;
  return catalogCase;
}

function addIssue(
  issues: CatalogIssue[],
  source: string,
  code: CatalogIssueCode,
  message: string,
): void {
  issues.push({ source, code, message });
}

function compareIssues(left: CatalogIssue, right: CatalogIssue): number {
  return compareText(left.source, right.source) ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
