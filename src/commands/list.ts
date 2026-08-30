import { resolve } from "node:path";
import { loadCatalog, type Catalog } from "../catalog/load-catalog.js";
import { FindingError, InvocationError } from "../domain/errors.js";
import type { CommandIo } from "./validate.js";

export interface ListOptions {
  readonly project: string;
  readonly json: boolean;
}

export async function runList(
  target: string | undefined,
  options: ListOptions,
  io: CommandIo,
): Promise<void> {
  if (target !== undefined && target !== "cases" && target !== "variants") {
    throw new InvocationError(`unknown list target ${JSON.stringify(target)}; expected cases or variants`);
  }

  const catalog = await loadCatalog(resolve(options.project), { requirePrivateOracles: true });
  const blockingIssues = catalog.issues.filter((issue) => !issue.code.startsWith("ORACLE_"));
  for (const issue of blockingIssues) {
    io.stderr(`${issue.source}: ${issue.code}: ${issue.message}\n`);
  }
  if (blockingIssues.length > 0) {
    throw new FindingError(`Listing found ${blockingIssues.length.toString()} finding(s).`);
  }

  if (options.json) {
    io.stdout(`${JSON.stringify(toJson(catalog, target), null, 2)}\n`);
    return;
  }

  if (target !== "variants") {
    io.stdout("Cases:\n");
    for (const entry of catalog.cases) {
      io.stdout(
        `  ${entry.manifest.id}  ${entry.manifest.title}  [${entry.manifest.categories.join(", ")}]  assertions=${entry.manifest.assertions.length.toString()}  oracle=${entry.oracleHash === undefined ? "missing" : "available"}\n`,
      );
    }
  }
  if (target !== "cases") {
    io.stdout("Variants:\n");
    for (const entry of catalog.variants) {
      io.stdout(
        `  ${entry.manifest.id}  ${entry.manifest.displayName}  [${entry.manifest.claimedCategories.join(", ")}]  runtimes=${entry.manifest.compatibleRuntimes.join(", ")}\n`,
      );
    }
  }
}

function toJson(catalog: Catalog, target: string | undefined): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  if (target !== "variants") {
    document["cases"] = catalog.cases.map((entry) => ({
      id: entry.manifest.id,
      title: entry.manifest.title,
      categories: entry.manifest.categories,
      assertionCount: entry.manifest.assertions.length,
      oracleAvailable: entry.oracleHash !== undefined,
    }));
  }
  if (target !== "cases") {
    document["variants"] = catalog.variants.map((entry) => ({
      id: entry.manifest.id,
      displayName: entry.manifest.displayName,
      claimedCategories: entry.manifest.claimedCategories,
      compatibleRuntimes: entry.manifest.compatibleRuntimes,
    }));
  }
  return document;
}
