import { relative, isAbsolute } from "node:path";
import type { TranscriptEvent } from "../runtime-adapter.js";
import { normalizeCommand } from "./normalize-command.js";

export interface ParseContext {
  readonly atMs: number;
  readonly workspace: string;
}

export interface ParsedLine {
  readonly events: readonly TranscriptEvent[];
  readonly threadId: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  /** False when the line is not JSON or carries no shape this adapter knows. */
  readonly recognized: boolean;
}

const nothing: ParsedLine = Object.freeze({
  events: Object.freeze([]),
  threadId: null,
  usage: null,
  recognized: true,
});

const unrecognized: ParsedLine = Object.freeze({ ...nothing, recognized: false });

export function parseCodexLine(line: string, context: ParseContext): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return unrecognized;
  }
  if (!isRecord(value) || typeof value["type"] !== "string") return unrecognized;

  switch (value["type"]) {
    case "thread.started":
      return typeof value["thread_id"] === "string"
        ? Object.freeze({ ...nothing, threadId: value["thread_id"] })
        : unrecognized;
    case "turn.started":
      return nothing;
    case "turn.completed":
      return Object.freeze({
        ...nothing,
        events: Object.freeze([
          Object.freeze({ type: "completion_claim" as const, atMs: context.atMs, text: "" }),
        ]),
        usage: readUsage(value["usage"]),
      });
    case "item.started":
      return nothing;
    case "item.completed":
      return parseItem(value["item"], context);
    default:
      return unrecognized;
  }
}

function parseItem(item: unknown, context: ParseContext): ParsedLine {
  if (!isRecord(item) || typeof item["type"] !== "string") return unrecognized;

  switch (item["type"]) {
    case "agent_message":
      return typeof item["text"] === "string"
        ? withEvents([Object.freeze({ type: "assistant_message" as const, atMs: context.atMs, text: item["text"] })])
        : unrecognized;
    case "command_execution":
      return typeof item["command"] === "string"
        ? withEvents(normalizeCommand(item["command"]).map((record) => Object.freeze({
            type: "command" as const,
            atMs: context.atMs,
            executor: record.executor,
            args: Object.freeze([...record.args]),
            exitCode: typeof item["exit_code"] === "number" ? item["exit_code"] : 0,
          })))
        : unrecognized;
    case "file_change":
      return withEvents([buildFileChange(item["changes"], context)]);
    default:
      return unrecognized;
  }
}

function buildFileChange(changes: unknown, context: ParseContext): TranscriptEvent {
  const paths: string[] = [];
  const outsidePaths: string[] = [];

  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (!isRecord(change) || typeof change["path"] !== "string") continue;
      const absolute = change["path"];
      const relativePath = relative(context.workspace, absolute);
      if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
        outsidePaths.push(absolute);
      } else {
        paths.push(relativePath.replaceAll("\\", "/"));
      }
    }
  }

  paths.sort();
  outsidePaths.sort();
  return Object.freeze({
    type: "file_change",
    atMs: context.atMs,
    paths: Object.freeze(paths),
    outsidePaths: Object.freeze(outsidePaths),
  });
}

function readUsage(usage: unknown): { readonly inputTokens: number; readonly outputTokens: number } | null {
  if (!isRecord(usage)) return null;
  const inputTokens = usage["input_tokens"];
  const outputTokens = usage["output_tokens"];
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  return Object.freeze({ inputTokens, outputTokens });
}

function withEvents(events: readonly TranscriptEvent[]): ParsedLine {
  return Object.freeze({ ...nothing, events: Object.freeze([...events]) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
