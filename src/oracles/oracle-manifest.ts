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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
