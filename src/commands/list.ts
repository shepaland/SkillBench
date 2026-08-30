import { resolve } from "node:path";
import { loadCatalog, type Catalog, type CatalogCase, type CatalogIssue } from "../catalog/load-catalog.js";
import { DependencyError, InvocationError } from "../domain/errors.js";
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
    throw new DependencyError(`Listing found ${blockingIssues.length.toString()} blocking catalog issue(s).`);
  }

  if (options.json) {
    io.stdout(`${JSON.stringify(toJson(catalog, target), null, 2)}\n`);
    return;
  }

  if (target !== "variants") {
    io.stdout("Cases:\n");
    for (const entry of catalog.cases) {
      io.stdout(
        `  ${entry.manifest.id}  ${entry.manifest.title}  [${entry.manifest.categories.join(", ")}]  assertions=${entry.manifest.assertions.length.toString()}  oracle=${oracleState(entry, catalog.issues)}\n`,
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

export type OracleState = "available" | "invalid" | "missing";

function oracleState(entry: CatalogCase, issues: readonly CatalogIssue[]): OracleState {
  if (entry.oracleHash === undefined) return "missing";
  const broken = issues.some((issue) =>
    issue.source === entry.source &&
    (issue.code === "ORACLE_MANIFEST_INVALID" || issue.code === "ORACLE_ASSERTION_MISMATCH"));
  return broken ? "invalid" : "available";
}

function toJson(catalog: Catalog, target: string | undefined): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  if (target !== "variants") {
    document["cases"] = catalog.cases.map((entry) => ({
      id: entry.manifest.id,
      title: entry.manifest.title,
      categories: entry.manifest.categories,
      assertionCount: entry.manifest.assertions.length,
      oracle: oracleState(entry, catalog.issues),
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
