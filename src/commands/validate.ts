import { resolve } from "node:path";
import { loadCatalog } from "../catalog/load-catalog.js";
import { FindingError } from "../domain/errors.js";

export interface CommandIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface ValidateOptions {
  readonly project: string;
  readonly publicOnly: boolean;
}

export async function runValidate(options: ValidateOptions, io: CommandIo): Promise<void> {
  const projectRoot = resolve(options.project);
  const catalog = await loadCatalog(projectRoot, {
    requirePrivateOracles: !options.publicOnly,
  });

  for (const issue of catalog.issues) {
    io.stderr(`${issue.source}: ${issue.code}: ${issue.message}\n`);
  }

  if (catalog.issues.length > 0) {
    throw new FindingError(`Validation found ${catalog.issues.length.toString()} finding(s).`);
  }

  io.stdout(
    `Validated ${catalog.cases.length.toString()} ${countNoun(catalog.cases.length, "case")} and ${catalog.variants.length.toString()} ${countNoun(catalog.variants.length, "variant")}.\n`,
  );
}

function countNoun(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
