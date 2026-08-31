import assert from "node:assert/strict";
import test from "node:test";
import { DependencyError } from "../../../src/domain/errors.js";
import { buildCodexCommand, mapSandbox } from "../../../src/runtime/codex/build-command.js";

const base = {
  executable: "codex",
  model: "gpt-5-codex",
  reasoningEffort: "medium",
  sandbox: "workspace-write",
  workspace: "/tmp/ws",
};

test("builds the first step with the workspace and both overrides", () => {
  assert.deepEqual(buildCodexCommand({ ...base, threadId: null }), {
    executable: "codex",
    args: [
      "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
      "-C", "/tmp/ws", "-m", "gpt-5-codex",
      "-c", "model_reasoning_effort=medium",
      "-c", "sandbox_mode=workspace-write",
      "-",
    ],
  });
});

test("builds a resumed step without the rejected options and with the same overrides", () => {
  assert.deepEqual(buildCodexCommand({ ...base, threadId: "thread-1" }), {
    executable: "codex",
    args: [
      "exec", "resume", "thread-1", "--json", "--skip-git-repo-check", "--ignore-user-config",
      "-m", "gpt-5-codex",
      "-c", "model_reasoning_effort=medium",
      "-c", "sandbox_mode=workspace-write",
      "-",
    ],
  });
});

test("maps every supported sandbox name", () => {
  assert.equal(mapSandbox("read-only"), "read-only");
  assert.equal(mapSandbox("workspace-write"), "workspace-write");
  assert.equal(mapSandbox("danger-full-access"), "danger-full-access");
});

test("rejects an unmapped sandbox name before anything is spawned", () => {
  assert.throws(() => mapSandbox("wide-open"), DependencyError);
});
