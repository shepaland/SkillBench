import test from "node:test";
import assert from "node:assert/strict";
import { renderError, renderErrorJson, renderJob, renderJobList, renderJson } from "../src/format/output.js";
import { fail } from "../src/core/errors.js";

const first = {
  id: "job-0001",
  tenant: "acme",
  title: "Ship the release notes",
  priority: "normal",
  state: "queued",
};
const second = { ...first, id: "job-0002", title: "Rotate the key" };

test("renders a single job on one line", () => {
  assert.equal(renderJob(first), "job-0001  queued  normal  Ship the release notes");
});

test("renders a table with a header and a plural footer", () => {
  assert.equal(
    renderJobList([first, second]),
    [
      "ID        STATE   PRIORITY  TITLE",
      "job-0001  queued  normal    Ship the release notes",
      "job-0002  queued  normal    Rotate the key",
      "2 jobs",
    ].join("\n"),
  );
});

test("uses the singular footer for one job", () => {
  assert.match(renderJobList([first]), /\n1 job$/u);
});

test("renders an empty list without a table", () => {
  assert.equal(renderJobList([]), "no jobs");
});

test("renders indented JSON", () => {
  assert.equal(renderJson({ id: "job-0001" }), '{\n  "id": "job-0001"\n}');
});

test("renders errors as a prefixed line and as JSON", () => {
  const error = fail("invalid_token", "invalid token for tenant acme");
  assert.equal(renderError(error), "queuedesk: invalid token for tenant acme");
  assert.deepEqual(JSON.parse(renderErrorJson(error)), {
    error: { code: "invalid_token", message: "invalid token for tenant acme" },
  });
});
