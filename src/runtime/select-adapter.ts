import { DependencyError } from "../domain/errors.js";
import type { CaseManifest } from "../domain/model.js";
import { codexAdapterVersion, CodexAdapter } from "./codex/codex-adapter.js";
import { readCodexVersion } from "./codex/codex-version.js";
import { FakeAdapter, type FakeScript } from "./fake-adapter.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";

export const supportedRuntimes: readonly string[] = Object.freeze(["codex", "fake"]);

const fakeRuntimeVersion = "1.0.0";
const fakeAdapterVersion = "1.0.0";

export interface SelectedAdapter {
  readonly adapter: RuntimeAdapter;
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
}

export function createFakeScript(caseManifest: CaseManifest): FakeScript {
  return Object.freeze({
    steps: Object.freeze(caseManifest.promptSteps.map((step) => Object.freeze({
      stepId: step.id,
      events: Object.freeze([
        Object.freeze({
          type: "assistant_message" as const,
          afterMs: 10,
          text: `Working on ${step.id}.`,
        }),
        Object.freeze({
          type: "completion_claim" as const,
          afterMs: 10,
          text: `Finished ${step.id}.`,
        }),
      ]),
    }))),
    closeAfterMs: 10,
    process: Object.freeze({ exitCode: 0, signal: null, timedOut: false }),
    usage: Object.freeze({ inputTokens: 100, outputTokens: 100 }),
    metadata: Object.freeze({
      runtimeVersion: fakeRuntimeVersion,
      adapterVersion: fakeAdapterVersion,
    }),
  });
}

export async function selectAdapter(runtime: string, caseManifest: CaseManifest): Promise<SelectedAdapter> {
  if (runtime === "fake") {
    return Object.freeze({
      adapter: new FakeAdapter(createFakeScript(caseManifest)),
      runtimeVersion: fakeRuntimeVersion,
      adapterVersion: fakeAdapterVersion,
    });
  }

  if (runtime === "codex") {
    const runtimeVersion = await readCodexVersion();
    return Object.freeze({
      adapter: new CodexAdapter({ runtimeVersion }),
      runtimeVersion,
      adapterVersion: codexAdapterVersion,
    });
  }

  throw new DependencyError(
    `runtime ${runtime} is not available in this build; supported runtimes: ${supportedRuntimes.join(", ")}`,
  );
}
