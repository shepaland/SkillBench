import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseCodexLine } from "../../../src/runtime/codex/parse-events.js";
import type { TranscriptEvent } from "../../../src/runtime/runtime-adapter.js";

const workspace = "/workspace";

async function parseSample(name: string): Promise<{
  readonly events: readonly TranscriptEvent[];
  readonly threadId: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly unrecognized: number;
}> {
  const path = fileURLToPath(new URL(`../../data/codex/${name}`, import.meta.url));
  const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");

  const events: TranscriptEvent[] = [];
  let threadId: string | null = null;
  let usage: { readonly inputTokens: number; readonly outputTokens: number } | null = null;
  let unrecognized = 0;

  for (const [index, line] of lines.entries()) {
    const parsed = parseCodexLine(line, { atMs: index, workspace });
    events.push(...parsed.events);
    threadId = parsed.threadId ?? threadId;
    usage = parsed.usage ?? usage;
    if (!parsed.recognized) unrecognized += 1;
  }

  return { events, threadId, usage, unrecognized };
}

test("parses the captured first step", async () => {
  const { events, threadId, usage } = await parseSample("sample-first-step.jsonl");

  assert.equal(threadId, "01a05672-40b8-7db1-823a-39a2fc5a735f");
  assert.deepEqual(usage, { inputTokens: 31504, outputTokens: 80 });
  assert.deepEqual(events.map((event) => event.type), [
    "assistant_message",
    "file_change",
    "assistant_message",
    "completion_claim",
  ]);

  const change = events.find((event) => event.type === "file_change");
  assert.deepEqual(change?.type === "file_change" ? change.paths : null, ["note.txt"]);
  assert.deepEqual(change?.type === "file_change" ? change.outsidePaths : null, []);
});

test("parses the captured resumed step, including commands", async () => {
  const { events, threadId } = await parseSample("sample-resumed-step.jsonl");

  assert.equal(threadId, "01a05672-40b8-7db1-823a-39a2fc5a735f");
  const commands = events.filter((event) => event.type === "command");
  assert.equal(commands.length, 2);
  assert.equal(commands[0]?.type === "command" ? commands[0].executor : null, "sed");
  assert.equal(commands[1]?.type === "command" ? commands[1].executor : null, "od");
});

test("ignores item.started so items are not counted twice", () => {
  const line = JSON.stringify({
    type: "item.started",
    item: { id: "item_1", type: "file_change", changes: [{ path: "/workspace/a.js", kind: "update" }], status: "in_progress" },
  });
  const parsed = parseCodexLine(line, { atMs: 0, workspace });
  assert.deepEqual(parsed.events, []);
  assert.equal(parsed.recognized, true);
});

test("keeps a path outside the workspace verbatim", () => {
  const line = JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "file_change", changes: [{ path: "/etc/hosts", kind: "update" }], status: "completed" },
  });
  const [event] = parseCodexLine(line, { atMs: 0, workspace }).events;
  assert.deepEqual(event?.type === "file_change" ? event.paths : null, []);
  assert.deepEqual(event?.type === "file_change" ? event.outsidePaths : null, ["/etc/hosts"]);
});

test("reports an unrecognized line without throwing", () => {
  const parsed = parseCodexLine("not json at all", { atMs: 0, workspace });
  assert.equal(parsed.recognized, false);
  assert.deepEqual(parsed.events, []);
  assert.equal(parsed.threadId, null);
});
