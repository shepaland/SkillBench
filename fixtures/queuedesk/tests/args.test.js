import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/args.js";

const credentials = ["--tenant", "acme", "--token", "acme-token"];

test("parses create with a title and the default priority", () => {
  const options = parseArgs(["create", ...credentials, "--title", "Ship the release notes"]);
  assert.equal(options.command, "create");
  assert.equal(options.tenant, "acme");
  assert.equal(options.token, "acme-token");
  assert.equal(options.title, "Ship the release notes");
  assert.equal(options.priority, "normal");
  assert.equal(options.json, false);
  assert.equal(options.dataPath, null);
});

test("parses list with a state filter, all tenants, and json output", () => {
  const options = parseArgs(["list", ...credentials, "--state", "queued", "--all-tenants", "--json"]);
  assert.equal(options.state, "queued");
  assert.equal(options.allTenants, true);
  assert.equal(options.json, true);
});

test("parses complete with a job identifier and a note", () => {
  const options = parseArgs(["complete", "job-0007", ...credentials, "--note", "done early"]);
  assert.equal(options.jobId, "job-0007");
  assert.equal(options.note, "done early");
});

test("rejects an unknown command", () => {
  assert.throws(() => parseArgs(["archive", ...credentials]), { code: "unknown_command" });
});

test("rejects a missing command", () => {
  assert.throws(() => parseArgs([]), { code: "unknown_command" });
});

test("rejects a missing tenant", () => {
  assert.throws(() => parseArgs(["list", "--token", "acme-token"]), { code: "missing_flag" });
});

test("rejects a flag without a value", () => {
  assert.throws(() => parseArgs(["list", ...credentials, "--state"]), { code: "missing_flag" });
});

test("rejects an unknown flag", () => {
  assert.throws(() => parseArgs(["list", ...credentials, "--verbose"]), { code: "invalid_flag" });
});

test("rejects an unsupported priority", () => {
  assert.throws(
    () => parseArgs(["create", ...credentials, "--title", "x", "--priority", "urgent"]),
    { code: "invalid_flag" },
  );
});

test("rejects a malformed job identifier", () => {
  assert.throws(() => parseArgs(["complete", "7", ...credentials]), { code: "invalid_job_id" });
});
