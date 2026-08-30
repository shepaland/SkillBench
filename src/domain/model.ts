export type ContentHash = string & { readonly __contentHash: unique symbol };

export type CommandExecutor = "node" | "npm" | "git";

export interface TypedCommand {
  readonly executor: CommandExecutor;
  readonly args: readonly string[];
}

export interface RuntimeLimits {
  readonly wallClockMs: number;
  readonly outputBytes: number;
  readonly tokenLimit: number;
}

export interface PromptStep {
  readonly id: string;
  readonly prompt: string;
  readonly continuation?: { readonly eventRuleIds: readonly string[] };
}

export interface AssertionDeclaration {
  readonly id: string;
  readonly dimension: "functional" | "regression" | "security" | "scope" | "process";
  readonly critical: boolean;
}

export interface CaseManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly categories: readonly string[];
  readonly fixture: { readonly path: string; readonly contentHash: ContentHash };
  readonly promptSteps: readonly PromptStep[];
  readonly publicVerification: readonly TypedCommand[];
  readonly limits: RuntimeLimits;
  readonly allowedChangePaths: readonly string[];
  readonly forbiddenChangePaths: readonly string[];
  readonly assertions: readonly AssertionDeclaration[];
  readonly transcriptRules?: readonly {
    readonly id: string;
    readonly event: string;
    readonly beforeStepId?: string;
  }[];
}

export interface VariantManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly compatibleRuntimes: readonly string[];
  readonly installs: readonly {
    readonly source: string;
    readonly destinations: Readonly<Record<string, string>>;
  }[];
  readonly claimedCategories: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly contentHash: ContentHash;
}

export interface RunManifest {
  readonly caseHash: ContentHash;
  readonly variantHash: ContentHash;
  readonly fixtureHash: ContentHash;
  readonly oracleHash: ContentHash;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sandbox: string;
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
  readonly limits: RuntimeLimits;
  readonly repetitionIndex: number;
}
