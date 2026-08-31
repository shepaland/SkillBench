#!/usr/bin/env node
// Usage:
//   1. npm run build              (this script imports the compiled CLI's hash helpers)
//   2. Codex must be installed and authenticated (`codex --version` succeeds)
//   3. SKILLBENCH_LIVE=1 npm run smoke:codex
// This spends the operator's real Codex credits. Run it once, not in a loop.
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.SKILLBENCH_LIVE !== "1") {
  console.error("Refusing to start a live agent. Set SKILLBENCH_LIVE=1 to run this check.");
  console.error("Before that: run `npm run build`, and make sure Codex is installed and authenticated.");
  console.error("This spends real Codex credits — run it once, not in a loop.");
  process.exit(2);
}

// Imported behind the opt-in guard, and only now: on a machine that has not
// run `npm run build` yet, this module does not exist, and importing it at
// the top of the file would fail before the refusal message above could
// ever print.
let hashTree;
let hashValue;
try {
  ({ hashTree, hashValue } = await import("../dist/src/integrity/content-hash.js"));
} catch (error) {
  console.error("Could not load dist/src/integrity/content-hash.js. Run `npm run build` first.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// Last-resort default when SKILLBENCH_MODEL is unset and the operator's own
// ~/.codex/config.toml (or $CODEX_HOME/config.toml) names no model either.
// It is not guaranteed to be valid for every account: it exists only so the
// script has something to try on a machine with no Codex configuration yet.
const documentedFallbackModel = "gpt-5-codex";

async function configuredModel() {
  const configPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return null;
  }
  // TOML top-level keys only appear before the first [table] header, so stop
  // looking once one is reached — nothing after it is a top-level "model".
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      break;
    }
    const match = /^model\s*=\s*"([^"]*)"/.exec(trimmed);
    if (match) {
      return match[1];
    }
  }
  return null;
}

const model = process.env.SKILLBENCH_MODEL ?? (await configuredModel()) ?? documentedFallbackModel;
console.log(`model: ${model}`);

// fileURLToPath, not .pathname: a repository path with non-ASCII characters
// comes back percent-encoded from .pathname and resolves to nothing.
const repository = fileURLToPath(new URL("..", import.meta.url));
const project = await mkdtemp(join(tmpdir(), "skillbench-smoke-"));

await cp(join(repository, "schemas"), join(project, "schemas"), { recursive: true });
await cp(join(repository, "smoke/fixture"), join(project, "fixtures/smoke"), { recursive: true });
await mkdir(join(project, "cases/smoke"), { recursive: true });
await mkdir(join(project, "variants/control"), { recursive: true });
await cp(join(repository, "smoke/oracle"), join(project, ".private/oracles/SMOKE"), { recursive: true });

const caseManifest = JSON.parse(await readFile(join(repository, "smoke/case.json"), "utf8"));
caseManifest.fixture.contentHash = await hashTree(join(project, "fixtures/smoke"));
await writeFile(join(project, "cases/smoke/case.json"), `${JSON.stringify(caseManifest, null, 2)}\n`, "utf8");

const variantManifest = JSON.parse(await readFile(join(repository, "smoke/variant/variant.json"), "utf8"));
variantManifest.contentHash = hashValue([]);
await writeFile(join(project, "variants/control/variant.json"), `${JSON.stringify(variantManifest, null, 2)}\n`, "utf8");

const result = spawnSync(process.execPath, [
  join(repository, "dist/src/cli.js"), "run",
  "--project", project,
  "--case", "SMOKE",
  "--variant", "control",
  "--runtime", "codex",
  "--model", model,
  "--reasoning", "low",
  "--sandbox", "workspace-write",
  "--runs", "1",
  "--json",
], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

if (result.error) {
  console.error(`Failed to start the CLI: ${result.error.message}`);
  process.exit(1);
}

process.stdout.write(result.stdout ?? "");

let report;
try {
  // result.stdout is "" (not null/undefined) whenever the CLI exits before
  // ever printing its JSON summary, e.g. a DependencyError thrown before any
  // run starts — "" is not nullish, so a plain ?? fallback would not catch
  // it and JSON.parse("") would throw a raw syntax error instead of the
  // actionable message below.
  report = JSON.parse(result.stdout || "{}");
} catch (error) {
  console.error(`The CLI's stdout was not valid JSON (exit code ${String(result.status)}).`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const runs = report.runs ?? [];
const [run] = runs;
if (run === undefined) {
  console.error(`The CLI produced no run report (exit code ${String(result.status)}).`);
  process.exit(1);
}

const resultPath = join(project, "runs/SMOKE/control", run.runId, "result.json");
const evidence = JSON.parse(await readFile(resultPath, "utf8"));
const stopped = evidence.transcriptRuleOutcomes.find((outcome) => outcome.ruleId === "stopped_first");

console.log(`run directory: ${join(project, "runs/SMOKE/control", run.runId)}`);
for (const assertion of evidence.assertions) {
  console.log(`  ${assertion.assertionId}: ${assertion.outcome} (${assertion.source})`);
}
console.log(`  stop rule evaluated: ${stopped === undefined ? "no" : "yes"}, satisfied: ${stopped?.satisfied}`);

// The whole point of this check is to catch a regression in oracle grading.
// A critical assertion that did not pass must fail the script, not just get
// printed above and forgotten.
const failedCritical = evidence.assertions.filter(
  (assertion) => assertion.critical === true && assertion.outcome !== "passed",
);
if (failedCritical.length > 0) {
  for (const assertion of failedCritical) {
    const detail = assertion.detail ? ` — ${assertion.detail}` : "";
    console.error(`critical assertion ${assertion.assertionId} did not pass: outcome=${assertion.outcome}${detail}`);
  }
  process.exit(1);
}

if (stopped === undefined) {
  console.error("The continuation gate never ran: the second step was sent without evaluating the rule.");
  process.exit(1);
}
for (const stepId of ["s1", "s2"]) {
  await readFile(join(project, "runs/SMOKE/control", run.runId, "raw", `step-${stepId}.jsonl`), "utf8");
}
