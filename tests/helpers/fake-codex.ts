import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCodexStep {
  /** Lines printed to stdout, in order. */
  readonly lines: readonly string[];
  /** Milliseconds to stay alive after printing, before exiting. */
  readonly lingerMs?: number;
  readonly exitCode?: number;
}

/**
 * Writes an executable that impersonates `codex`. It reads the prompt from stdin,
 * prints the scripted lines for the current invocation, and exits. Invocations are
 * counted in a file next to the script, so successive steps get successive scripts.
 */
export async function createFakeCodex(steps: readonly FakeCodexStep[]): Promise<{
  readonly executable: string;
  readonly directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const executable = join(directory, "fake-codex.mjs");
  const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const steps = ${JSON.stringify(steps)};
const counterPath = ${JSON.stringify(join(directory, "invocations"))};
const index = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
writeFileSync(counterPath, String(index + 1));

// Drain stdin so the parent's write always completes.
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const step = steps[index] ?? { lines: [], exitCode: 0 };
  for (const line of step.lines) process.stdout.write(line + "\\n");
  const linger = step.lingerMs ?? 0;
  if (linger > 0) {
    setTimeout(() => process.exit(step.exitCode ?? 0), linger);
  } else {
    process.exit(step.exitCode ?? 0);
  }
});
`;
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  return { executable, directory };
}

export function threadLine(threadId: string): string {
  return JSON.stringify({ type: "thread.started", thread_id: threadId });
}

export function messageLine(text: string): string {
  return JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text } });
}

export function changeLine(absolutePath: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { id: "c", type: "file_change", changes: [{ path: absolutePath, kind: "update" }], status: "completed" },
  });
}

export function usageLine(inputTokens: number, outputTokens: number): string {
  return JSON.stringify({ type: "turn.completed", usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
}
