import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCodexStep {
  /** Lines printed to stdout, in order. */
  readonly lines: readonly string[];
  /** Milliseconds to stay alive after printing, before exiting. */
  readonly lingerMs?: number;
  readonly exitCode?: number;
  /**
   * Written last, without a trailing newline, so it never reaches the ordinary
   * per-line handler and can only be observed through the leftover-buffer flush
   * that runs when the stream closes. Simulates a stream cut mid-line.
   */
  readonly trailingPartial?: string;
  /**
   * Spawns a detached grandchild that inherits this process's stdout and keeps
   * that pipe's write end open for roughly this many milliseconds after this
   * process exits, regardless of whether the adapter has already killed it.
   */
  readonly spawnGrandchildMs?: number;
  /** Environment variable keys whose live value (as seen by the fake) is echoed back as a JSON line. */
  readonly probeEnvKeys?: readonly string[];
}

/**
 * Writes an executable that impersonates `codex`. It reads the prompt from stdin,
 * prints the scripted lines for the current invocation, and exits. Invocations are
 * counted in a file next to the script, so successive steps get successive scripts.
 * Every invocation's arguments are also appended to a sidecar file so tests can
 * verify what a later, resumed invocation was actually called with.
 */
export async function createFakeCodex(steps: readonly FakeCodexStep[]): Promise<{
  readonly executable: string;
  readonly directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const executable = join(directory, "fake-codex.mjs");
  const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const steps = ${JSON.stringify(steps)};
const counterPath = ${JSON.stringify(join(directory, "invocations"))};
const argvPath = ${JSON.stringify(join(directory, "argv.log"))};
const index = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
writeFileSync(counterPath, String(index + 1));
writeFileSync(argvPath, JSON.stringify(process.argv.slice(2)) + "\\n", { flag: "a" });

// Drain stdin so the parent's write always completes.
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const step = steps[index] ?? { lines: [], exitCode: 0 };
  for (const key of step.probeEnvKeys ?? []) {
    process.stdout.write(JSON.stringify({ type: "env.probe", key, value: process.env[key] ?? null }) + "\\n");
  }
  for (const line of step.lines) process.stdout.write(line + "\\n");
  if (step.trailingPartial !== undefined) process.stdout.write(step.trailingPartial);
  if (step.spawnGrandchildMs) {
    const grandchild = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, " + Number(step.spawnGrandchildMs) + ");"],
      { stdio: ["ignore", "inherit", "ignore"], detached: true },
    );
    grandchild.unref();
  }
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

/** Reads back the argument list (excluding node and the script path) from every invocation, in order. */
export async function readInvocationArgs(directory: string): Promise<readonly (readonly string[])[]> {
  const content = await readFile(join(directory, "argv.log"), "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as readonly string[]);
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
