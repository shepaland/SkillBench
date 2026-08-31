import { join, resolve } from "node:path";
import { loadCatalog, type CatalogCase, type CatalogVariant } from "../catalog/load-catalog.js";
import { DependencyError, InvocationError } from "../domain/errors.js";
import { ProjectPaths } from "../paths/project-paths.js";
import { createRunId, defaultRunIdSuffix, freezeRunInputs, type RunConfiguration } from "../runs/freeze-inputs.js";
import { selectAdapter } from "../runtime/select-adapter.js";
import { ManifestValidator } from "../schemas/validator.js";
import type { CommandIo } from "./validate.js";

export interface RunSelectionOptions {
  readonly project: string;
  readonly case: string;
  readonly variant: string;
  readonly runtime: string;
  readonly model: string;
  readonly reasoning: string;
  readonly sandbox: string;
  readonly json: boolean;
}

export interface ResolvedRunTargets {
  readonly projectRoot: string;
  readonly paths: ProjectPaths;
  readonly validator: ManifestValidator;
  readonly catalogCase: CatalogCase;
  readonly variant: CatalogVariant;
  readonly configuration: RunConfiguration;
}

export async function resolveRunTargets(options: RunSelectionOptions): Promise<ResolvedRunTargets> {
  const projectRoot = resolve(options.project);
  const catalog = await loadCatalog(projectRoot, { requirePrivateOracles: true });

  const catalogCase = catalog.cases.find((entry) => entry.manifest.id === options.case);
  if (catalogCase === undefined) {
    throw new InvocationError(`unknown case ${JSON.stringify(options.case)}`);
  }
  const variant = catalog.variants.find((entry) => entry.manifest.id === options.variant);
  if (variant === undefined) {
    throw new InvocationError(`unknown variant ${JSON.stringify(options.variant)}`);
  }

  const relevantIssues = catalog.issues.filter(
    (issue) => issue.source === catalogCase.source || issue.source === variant.source,
  );
  if (relevantIssues.length > 0) {
    throw new DependencyError(
      relevantIssues.map((issue) => `${issue.source}: ${issue.code}: ${issue.message}`).join("\n"),
    );
  }

  const selected = await selectAdapter(options.runtime, catalogCase.manifest);
  return {
    projectRoot,
    paths: await ProjectPaths.create(projectRoot),
    validator: await ManifestValidator.create(join(projectRoot, "schemas")),
    catalogCase,
    variant,
    configuration: {
      runtime: options.runtime,
      model: options.model,
      reasoningEffort: options.reasoning,
      sandbox: options.sandbox,
      runtimeVersion: selected.runtimeVersion,
      adapterVersion: selected.adapterVersion,
    },
  };
}

export async function runDryRun(
  options: RunSelectionOptions,
  io: CommandIo,
  clock: () => Date = () => new Date(),
  suffix: () => string = defaultRunIdSuffix,
): Promise<void> {
  const targets = await resolveRunTargets(options);
  const manifest = freezeRunInputs({
    catalogCase: targets.catalogCase,
    variant: targets.variant,
    configuration: targets.configuration,
    repetitionIndex: 0,
    runId: createRunId(clock(), suffix()),
  });
  const caseManifest = targets.catalogCase.manifest;

  if (options.json) {
    io.stdout(`${JSON.stringify({
      manifest,
      promptSteps: caseManifest.promptSteps,
      allowedChangePaths: caseManifest.allowedChangePaths,
      forbiddenChangePaths: caseManifest.forbiddenChangePaths,
      publicVerification: caseManifest.publicVerification,
      assertions: caseManifest.assertions,
    }, null, 2)}\n`);
    return;
  }

  io.stdout(`Run plan for case ${manifest.caseId} and variant ${manifest.variantId}\n`);
  io.stdout(`  run id: ${manifest.runId}\n`);
  io.stdout(`  runtime: ${manifest.runtime} ${manifest.runtimeVersion} (adapter ${manifest.adapterVersion})\n`);
  io.stdout(`  model: ${manifest.model}  reasoning: ${manifest.reasoningEffort}  sandbox: ${manifest.sandbox}\n`);
  io.stdout(`  limits: wallClockMs=${manifest.limits.wallClockMs.toString()} outputBytes=${manifest.limits.outputBytes.toString()} tokenLimit=${manifest.limits.tokenLimit.toString()}\n`);
  io.stdout(`  case hash: ${manifest.caseHash}\n`);
  io.stdout(`  variant hash: ${manifest.variantHash}\n`);
  io.stdout(`  fixture hash: ${manifest.fixtureHash}\n`);
  io.stdout(`  oracle hash: ${manifest.oracleHash}\n`);

  io.stdout("Prompt steps:\n");
  for (const step of caseManifest.promptSteps) {
    io.stdout(`  ${step.id}: ${step.prompt}\n`);
  }
  io.stdout(`Allowed change paths: ${caseManifest.allowedChangePaths.join(", ")}\n`);
  io.stdout(`Forbidden change paths: ${caseManifest.forbiddenChangePaths.join(", ")}\n`);
  io.stdout("Public verification:\n");
  for (const command of caseManifest.publicVerification) {
    io.stdout(`  ${command.executor} ${command.args.join(" ")}\n`);
  }
  io.stdout("Assertions:\n");
  for (const assertion of caseManifest.assertions) {
    io.stdout(`  ${assertion.id}  ${assertion.dimension}  ${assertion.critical ? "critical" : "diagnostic"}\n`);
  }
  io.stdout("No workspace was created and no agent was started.\n");
}
