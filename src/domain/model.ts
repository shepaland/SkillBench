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
  /** When set, SkillBench grades this assertion from the named rule and the oracle must not cover it. */
  readonly transcriptRuleId?: string;
}

export interface CommandMatcher {
  readonly executor: string;
  readonly argsPrefix: readonly string[];
}

export type TranscriptRule =
  | { readonly id: string; readonly check: "no_file_change"; readonly expect?: boolean }
  | { readonly id: string; readonly check: "assistant_message"; readonly expect?: boolean }
  | ({ readonly id: string; readonly check: "command_ran"; readonly expect?: boolean } & CommandMatcher)
  | ({ readonly id: string; readonly check: "command_before_file_change"; readonly expect?: boolean } & CommandMatcher)
  | ({ readonly id: string; readonly check: "command_after_file_change"; readonly expect?: boolean } & CommandMatcher);

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
  readonly transcriptRules?: readonly TranscriptRule[];
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

export interface FrozenRunManifest extends RunManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly caseId: string;
  readonly variantId: string;
  readonly runtime: string;
}

export interface OracleCheck {
  readonly assertionId: string;
  readonly command: TypedCommand;
  readonly workingDirectory: string;
  readonly timeoutMs: number;
}

export interface OracleManifest {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly checks: readonly OracleCheck[];
}
