#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashTree, hashValue } from "../dist/src/integrity/content-hash.js";

if (process.env.SKILLBENCH_LIVE !== "1") {
  console.error("Refusing to start a live agent. Set SKILLBENCH_LIVE=1 to run this check.");
  process.exit(2);
}

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
  "--model", process.env.SKILLBENCH_MODEL ?? "gpt-5-codex",
  "--reasoning", "low",
  "--sandbox", "workspace-write",
  "--runs", "1",
  "--json",
], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

process.stdout.write(result.stdout ?? "");

const runs = JSON.parse(result.stdout ?? "{}").runs ?? [];
const [run] = runs;
if (run === undefined) {
  console.error("The CLI produced no run report.");
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

if (stopped === undefined) {
  console.error("The continuation gate never ran: the second step was sent without evaluating the rule.");
  process.exit(1);
}
for (const stepId of ["s1", "s2"]) {
  await readFile(join(project, "runs/SMOKE/control", run.runId, "raw", `step-${stepId}.jsonl`), "utf8");
}
