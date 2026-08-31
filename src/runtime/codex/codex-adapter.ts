import { spawn } from "node:child_process";
import { DependencyError } from "../../domain/errors.js";
import type {
  ExhaustionCause,
  RuntimeAdapter,
  RuntimeExecution,
  RuntimeInput,
  TranscriptEvent,
} from "../runtime-adapter.js";
import { buildCodexCommand } from "./build-command.js";
import { CodexHome } from "./codex-home.js";
import { parseCodexLine } from "./parse-events.js";

/** Raise this whenever command building, parsing, or normalization changes what is observed. */
export const codexAdapterVersion = "1.0.0";

const inheritedVariables = ["PATH", "HOME", "TMPDIR", "LANG"] as const;

// A grandchild the runtime spawns (e.g. a sandboxed subprocess) can inherit stdout
// and keep that pipe's write end open long after the direct child has exited, so
// `close` may never fire. This bounds how long we wait for it to arrive once the
// child itself is known to be gone.
const exitDrainMs = 200;

export interface CodexAdapterOptions {
  readonly runtimeVersion: string;
  readonly executable?: string;
  readonly sourceHome?: string;
  readonly tempParent?: string;
  readonly killGraceMs?: number;
  readonly nowMs?: () => number;
}

interface StepResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly threadId: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly unparsedLines: number;
  readonly bytes: number;
  readonly stopped: ExhaustionCause | null;
}

export class CodexAdapter implements RuntimeAdapter {
  public constructor(private readonly options: CodexAdapterOptions) {}

  public async execute(input: RuntimeInput): Promise<RuntimeExecution> {
    const nowMs = this.options.nowMs ?? ((): number => Date.now());
    const startedMs = nowMs();
    const atMs = (): number => nowMs() - startedMs;
    const deadlineMs = startedMs + input.config.limits.wallClockMs;

    const home = await CodexHome.create({
      ...(this.options.sourceHome === undefined ? {} : { sourceHome: this.options.sourceHome }),
      ...(this.options.tempParent === undefined ? {} : { tempParent: this.options.tempParent }),
    });

    const events: TranscriptEvent[] = [Object.freeze({ type: "session_started" as const, atMs: 0 })];
    let threadId: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    let bytes = 0;
    let unparsedLines = 0;
    let exhaustion: ExhaustionCause | null = null;
    let exitCode: number | null = 0;
    let signal: NodeJS.Signals | null = null;

    try {
      for (const [index, step] of input.promptSteps.entries()) {
        events.push(Object.freeze({
          type: "prompt_sent" as const, atMs: atMs(), stepId: step.id, text: step.prompt,
        }));

        const result = await this.runStep({
          command: buildCodexCommand({
            executable: this.options.executable ?? "codex",
            threadId,
            model: input.config.model,
            reasoningEffort: input.config.reasoningEffort,
            sandbox: input.config.sandbox,
            workspace: input.workspace,
          }),
          prompt: step.prompt,
          stepId: step.id,
          workspace: input.workspace,
          environment: input.config.environment,
          homePath: home.path,
          remainingBytes: input.config.limits.outputBytes - bytes,
          timeoutMs: Math.max(0, deadlineMs - nowMs()),
          atMs,
          onEvent: (event) => events.push(event),
          ...(input.onRawLine === undefined ? {} : { onRawLine: input.onRawLine }),
        });

        bytes += result.bytes;
        unparsedLines += result.unparsedLines;
        exitCode = result.exitCode;
        signal = result.signal;
        threadId = result.threadId ?? threadId;
        if (result.usage !== null) {
          sawUsage = true;
          inputTokens += result.usage.inputTokens;
          outputTokens += result.usage.outputTokens;
        }

        // Reaching here means exhaustion is still null: any prior iteration that
        // set it would have broken the loop before looping back around.
        exhaustion = result.stopped;
        if (exhaustion === null && signal !== null) exhaustion = "signal";
        if (exhaustion === null && sawUsage &&
          inputTokens + outputTokens >= input.config.limits.tokenLimit) {
          exhaustion = "token_limit";
        }
        if (exhaustion !== null) break;

        // A step that exited with an error leaves nothing sane to resume from;
        // stop here rather than sending a further prompt into a broken thread.
        if (exitCode !== null && exitCode !== 0) break;

        if (index === 0 && threadId === null) {
          throw new DependencyError(
            "the codex runtime reported no thread identifier; a later step cannot be resumed",
          );
        }

        // Every referenced rule is evaluated exactly once, at its continuation point,
        // with no exception for the last step: skipping it would leave that rule with
        // no outcome and turn a correct run into a reported failure.
        if (step.continuation !== undefined) {
          await input.onContinuation(step, Object.freeze([...events]));
        }
      }
    } finally {
      await home.cleanup();
    }

    events.push(Object.freeze({ type: "session_closed" as const, atMs: atMs() }));

    return Object.freeze({
      events: Object.freeze([...events]),
      process: Object.freeze({ exitCode, signal, timedOut: exhaustion === "wall_clock" }),
      usage: sawUsage ? Object.freeze({ inputTokens, outputTokens }) : null,
      elapsedMs: atMs(),
      exhaustion,
      unparsedLines,
      metadata: Object.freeze({
        runtime: "codex",
        runtimeVersion: this.options.runtimeVersion,
        adapterVersion: codexAdapterVersion,
      }),
    });
  }

  private runStep(options: {
    readonly command: { readonly executable: string; readonly args: readonly string[] };
    readonly prompt: string;
    readonly stepId: string;
    readonly workspace: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly homePath: string;
    readonly remainingBytes: number;
    readonly timeoutMs: number;
    readonly atMs: () => number;
    readonly onEvent: (event: TranscriptEvent) => void;
    readonly onRawLine?: (stepId: string, line: string) => void;
  }): Promise<StepResult> {
    const killGraceMs = this.options.killGraceMs ?? 5000;

    return new Promise<StepResult>((resolve, reject) => {
      const child = spawn(options.command.executable, [...options.command.args], {
        cwd: options.workspace,
        env: buildEnvironment(options.homePath, options.environment),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      let bytes = 0;
      let unparsed = 0;
      let buffer = "";
      let threadId: string | null = null;
      let usage: { readonly inputTokens: number; readonly outputTokens: number } | null = null;
      let stopped: ExhaustionCause | null = null;
      let settled = false;

      // A process that exits before draining stdin (a rejected flag, an auth
      // failure, a prompt larger than the pipe buffer) makes the write end emit
      // EPIPE/ECONNRESET. Without a listener that surfaces as an uncaught
      // exception; here it is silently absorbed and `close` reports the exit code.
      child.stdin.on("error", () => {});

      const stop = (cause: ExhaustionCause): void => {
        if (stopped !== null) return;
        stopped = cause;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), killGraceMs).unref();
      };

      // `exitCode`/`signal` are tied to whichever event fired; every other field is
      // read fresh from the closure below, after the leftover-buffer flush, so a
      // stream cut mid-line is reflected in `unparsedLines` no matter which event
      // resolves the step.
      const settle = (exitCode: number | null, exitSignal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A stream cut mid-line still becomes evidence: it is counted, never dropped.
        handleLine(buffer);
        const result = Object.freeze({
          exitCode, signal: exitSignal, threadId, usage,
          unparsedLines: unparsed, bytes, stopped,
        });
        // A surviving grandchild that inherited these streams can keep writing
        // after this step has settled. Destroy both here so nothing more reaches
        // `handleLine`/`onRawLine`/`onEvent`: a settled step's bytes must stop
        // counting against the budget, and its lines must never splice into a
        // later step's region of the shared transcript.
        child.stdout.destroy();
        child.stderr.destroy();
        resolve(result);
      };

      const handleLine = (line: string): void => {
        if (line === "") return;
        options.onRawLine?.(options.stepId, line);
        const parsed = parseCodexLine(line, { atMs: options.atMs(), workspace: options.workspace });
        if (!parsed.recognized) unparsed += 1;
        for (const event of parsed.events) options.onEvent(event);
        threadId = parsed.threadId ?? threadId;
        usage = parsed.usage ?? usage;
      };

      const count = (chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > options.remainingBytes) stop("output_bytes");
      };

      const timer = setTimeout(() => { stop("wall_clock"); }, options.timeoutMs);
      timer.unref();

      child.stderr.on("data", count);
      child.stdout.on("data", (chunk: Buffer) => {
        count(chunk);
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;
          handleLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      });

      child.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(new DependencyError(`could not start the codex runtime: ${error.message}`));
      });

      child.once("close", (code: number | null, closeSignal: NodeJS.Signals | null) => {
        settle(code, closeSignal);
      });

      // `close` waits for every stdio stream to close, but a grandchild that
      // inherited stdout can hold its write end open indefinitely, so `close` is
      // not safe to wait on alone. `exit` fires as soon as this process itself has
      // terminated; give any already-buffered stdio a brief window to arrive, then
      // resolve regardless of whether `close` ever does. In the ordinary case
      // `close` fires first and this callback is a no-op via the `settled` guard.
      child.once("exit", (code: number | null, exitSignal: NodeJS.Signals | null) => {
        // Safe to `.unref()`: if any stdio handle is still open (the grandchild
        // case this timer exists for), that handle alone keeps the event loop
        // alive long enough for this timer to fire regardless of its ref state.
        // If every stdio stream had already closed, `close` would have settled
        // the step already and this callback would be a no-op via `settled`.
        setTimeout(() => { settle(code, exitSignal); }, exitDrainMs).unref();
      });

      child.stdin.end(options.prompt, "utf8");
    });
  }
}

function buildEnvironment(
  homePath: string,
  declared: Readonly<Record<string, string>>,
): Record<string, string> {
  // The parent environment is never inherited wholesale. Declared variables are
  // applied first so they can never override the run's own isolation: a variant
  // that declares CODEX_HOME or PATH must not be able to redirect the private
  // runtime home or the resolved binary.
  const environment: Record<string, string> = { ...declared };
  for (const key of inheritedVariables) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment["CODEX_HOME"] = homePath;
  return environment;
}
