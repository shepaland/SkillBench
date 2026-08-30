import { randomBytes } from "node:crypto";
import type { CatalogCase, CatalogVariant } from "../catalog/load-catalog.js";
import { DependencyError } from "../domain/errors.js";
import type { FrozenRunManifest } from "../domain/model.js";
import { hashValue } from "../integrity/content-hash.js";

export interface RunConfiguration {
  readonly runtime: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sandbox: string;
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
}

export interface FreezeRunInputsInput {
  readonly catalogCase: CatalogCase;
  readonly variant: CatalogVariant;
  readonly configuration: RunConfiguration;
  readonly repetitionIndex: number;
  readonly runId: string;
}

const runIdPattern = /^\d{8}T\d{6}Z-[0-9a-z]{6}$/u;

export function createRunId(now: Date, suffix: string): string {
  if (!/^[0-9a-z]{6}$/u.test(suffix)) {
    throw new DependencyError(`run identifier suffix must be six lowercase alphanumerics: ${suffix}`);
  }
  const instant = now.toISOString();
  const compact = `${instant.slice(0, 4)}${instant.slice(5, 7)}${instant.slice(8, 10)}T${instant.slice(11, 13)}${instant.slice(14, 16)}${instant.slice(17, 19)}Z`;
  return `${compact}-${suffix}`;
}

export function defaultRunIdSuffix(): string {
  return randomBytes(4).toString("hex").slice(0, 6);
}

export function freezeRunInputs(input: FreezeRunInputsInput): FrozenRunManifest {
  const { catalogCase, variant, configuration } = input;

  if (!runIdPattern.test(input.runId)) {
    throw new DependencyError(`run identifier is malformed: ${input.runId}`);
  }
  if (!Number.isSafeInteger(input.repetitionIndex) || input.repetitionIndex < 0) {
    throw new DependencyError("repetition index must be a non-negative safe integer");
  }
  if (!variant.manifest.compatibleRuntimes.includes(configuration.runtime)) {
    throw new DependencyError(
      `variant ${variant.manifest.id} is not compatible with runtime ${configuration.runtime}`,
    );
  }
  if (catalogCase.fixtureHash === undefined) {
    throw new DependencyError(`fixture hash is unavailable for case ${catalogCase.manifest.id}`);
  }
  if (catalogCase.oracleHash === undefined) {
    throw new DependencyError(`private oracle hash is unavailable for case ${catalogCase.manifest.id}`);
  }
  if (variant.materialHash === undefined) {
    throw new DependencyError(`variant material hash is unavailable for variant ${variant.manifest.id}`);
  }

  return Object.freeze({
    schemaVersion: 1,
    runId: input.runId,
    caseId: catalogCase.manifest.id,
    variantId: variant.manifest.id,
    runtime: configuration.runtime,
    caseHash: hashValue(catalogCase.manifest),
    variantHash: variant.manifest.contentHash,
    fixtureHash: catalogCase.fixtureHash,
    oracleHash: catalogCase.oracleHash,
    model: configuration.model,
    reasoningEffort: configuration.reasoningEffort,
    sandbox: configuration.sandbox,
    runtimeVersion: configuration.runtimeVersion,
    adapterVersion: configuration.adapterVersion,
    limits: Object.freeze({ ...catalogCase.manifest.limits }),
    repetitionIndex: input.repetitionIndex,
  });
}

export function runDirectory(manifest: FrozenRunManifest): string {
  return `runs/${manifest.caseId}/${manifest.variantId}/${manifest.runId}`;
}
