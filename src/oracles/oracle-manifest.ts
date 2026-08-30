import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../domain/errors.js";
import type { AssertionDeclaration, OracleManifest } from "../domain/model.js";
import type { ManifestValidator } from "../schemas/validator.js";

export const oracleManifestFilename = "oracle.json";

export async function loadOracleManifest(
  gradingPath: string,
  validator: ManifestValidator,
): Promise<OracleManifest> {
  let text: string;
  try {
    text = await readFile(join(gradingPath, oracleManifestFilename), "utf8");
  } catch (cause: unknown) {
    throw new ValidationError(`could not read ${oracleManifestFilename}: ${errorMessage(cause)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause: unknown) {
    throw new ValidationError(`invalid JSON in ${oracleManifestFilename}: ${errorMessage(cause)}`);
  }

  return validator.validateOracle(value);
}

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

  const declaredIds = new Set(assertions.map(({ id }) => id));
  const missing = [...declaredIds].filter((id) => !checkIds.has(id)).sort();
  const extra = [...checkIds].filter((id) => !declaredIds.has(id)).sort();

  if (extra.length > 0) {
    throw new ValidationError(`oracle declares check(s) for undeclared assertion(s): ${extra.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new ValidationError(`oracle has no check for declared assertion(s): ${missing.join(", ")}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
