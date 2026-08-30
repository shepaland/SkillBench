import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import type { CaseManifest, VariantManifest } from "../../src/domain/model.js";
import { hashTree, hashValue } from "../../src/integrity/content-hash.js";

export interface TempProject {
  readonly root: string;
  readonly caseDirectory: string;
  readonly fixtureDirectory: string;
  readonly controlVariantDirectory: string;
  readonly exampleVariantDirectory: string;
  readonly exampleInstallDirectory: string;
  readonly schemaDirectory: string;
  readonly oracleDirectory: string;
  readonly oracleManifestPath: string;
  readonly caseManifestPath: string;
  readonly controlManifestPath: string;
  readonly exampleManifestPath: string;
  readonly caseManifest: CaseManifest;
  readonly controlManifest: VariantManifest;
  readonly exampleManifest: VariantManifest;
}

export async function createTempProject(): Promise<TempProject> {
  const root = await mkdtemp(join(tmpdir(), "skillbench-catalog-"));
  const caseDirectory = join(root, "cases/F01");
  const fixtureDirectory = join(root, "fixtures/queuedesk");
  const controlVariantDirectory = join(root, "variants/control");
  const exampleVariantDirectory = join(root, "variants/example");
  const exampleInstallDirectory = join(exampleVariantDirectory, "skill");
  const schemaDirectory = join(root, "schemas");
  const oracleDirectory = join(root, ".private/oracles/F01");

  await Promise.all([
    mkdir(caseDirectory, { recursive: true }),
    mkdir(fixtureDirectory, { recursive: true }),
    mkdir(controlVariantDirectory, { recursive: true }),
    mkdir(exampleInstallDirectory, { recursive: true }),
    mkdir(schemaDirectory, { recursive: true }),
    mkdir(oracleDirectory, { recursive: true }),
  ]);

  const oracleManifestPath = join(oracleDirectory, "oracle.json");

  const publishedSchemas = join(import.meta.dirname, "../../schemas");
  await Promise.all([
    copyFile(join(publishedSchemas, "case.schema.json"), join(schemaDirectory, "case.schema.json")),
    copyFile(join(publishedSchemas, "variant.schema.json"), join(schemaDirectory, "variant.schema.json")),
    copyFile(join(publishedSchemas, "oracle.schema.json"), join(schemaDirectory, "oracle.schema.json")),
    writeFile(join(fixtureDirectory, "index.js"), "export const queued = [];\n"),
    writeFile(join(exampleInstallDirectory, "SKILL.md"), "# Example skill\n"),
    writeFile(join(oracleDirectory, "assertions.js"), "export const assertions = ['functional'];\n"),
  ]);

  await mkdir(join(oracleDirectory, "checks"), { recursive: true });
  await writeFile(
    join(oracleDirectory, "checks/assert-1.js"),
    "process.exit(0);\n",
  );
  await writeFile(
    oracleManifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      caseId: "F01",
      checks: [
        {
          assertionId: "assert-1",
          command: { executor: "node", args: ["assert-1.js"] },
          workingDirectory: "checks",
          timeoutMs: 10_000,
        },
      ],
    }, null, 2)}\n`,
  );

  const caseManifest: CaseManifest = {
    schemaVersion: 1,
    id: "F01",
    title: "Implement QueueDesk behavior",
    categories: ["implementation"],
    fixture: {
      path: "fixtures/queuedesk",
      contentHash: await hashTree(fixtureDirectory),
    },
    promptSteps: [
      {
        id: "step-1",
        prompt: "Implement the requested behavior.",
        continuation: { eventRuleIds: ["rule-1"] },
      },
    ],
    publicVerification: [{ executor: "npm", args: ["test"] }],
    limits: { wallClockMs: 1_000, outputBytes: 10_000, tokenLimit: 1_000 },
    allowedChangePaths: ["src"],
    forbiddenChangePaths: ["secrets"],
    assertions: [{ id: "assert-1", dimension: "functional", critical: true }],
    transcriptRules: [{ id: "rule-1", event: "question", beforeStepId: "step-1" }],
  };

  const controlManifest: VariantManifest = {
    schemaVersion: 1,
    id: "control",
    displayName: "Control",
    compatibleRuntimes: ["codex", "fake"],
    installs: [],
    claimedCategories: ["implementation"],
    environment: {},
    contentHash: hashValue([]),
  };

  const installSource = "variants/example/skill";
  const exampleManifest: VariantManifest = {
    schemaVersion: 1,
    id: "example",
    displayName: "Example",
    compatibleRuntimes: ["codex", "fake"],
    installs: [
      {
        source: installSource,
        destinations: { codex: ".codex/skills/example", fake: ".agent/skills/example" },
      },
    ],
    claimedCategories: ["implementation"],
    environment: { SKILLBENCH_EXAMPLE: "enabled" },
    contentHash: hashValue([
      { source: installSource, contentHash: await hashTree(exampleInstallDirectory) },
    ]),
  };

  const caseManifestPath = join(caseDirectory, "case.json");
  const controlManifestPath = join(controlVariantDirectory, "variant.json");
  const exampleManifestPath = join(exampleVariantDirectory, "variant.json");
  await Promise.all([
    writeJson(caseManifestPath, caseManifest),
    writeJson(controlManifestPath, controlManifest),
    writeJson(exampleManifestPath, exampleManifest),
  ]);

  return {
    root,
    caseDirectory,
    fixtureDirectory,
    controlVariantDirectory,
    exampleVariantDirectory,
    exampleInstallDirectory,
    schemaDirectory,
    oracleDirectory,
    oracleManifestPath,
    caseManifestPath,
    controlManifestPath,
    exampleManifestPath,
    caseManifest,
    controlManifest,
    exampleManifest,
  };
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
