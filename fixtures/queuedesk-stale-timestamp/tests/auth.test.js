import test from "node:test";
import assert from "node:assert/strict";
import { assertJobVisible, assertRole, authenticate } from "../src/core/auth.js";

const state = {
  version: 1,
  tenants: {
    acme: { token: "acme-token", role: "admin" },
    globex: { token: "globex-token", role: "worker" },
  },
  jobs: [],
  nextId: 1,
};

test("authenticates a known tenant with the right token", () => {
  assert.deepEqual(authenticate(state, { tenant: "acme", token: "acme-token" }), {
    id: "acme",
    role: "admin",
  });
});

test("rejects an unknown tenant", () => {
  assert.throws(() => authenticate(state, { tenant: "initech", token: "x" }), {
    code: "unknown_tenant",
  });
});

test("rejects a wrong token", () => {
  assert.throws(() => authenticate(state, { tenant: "acme", token: "wrong" }), {
    code: "invalid_token",
  });
});

test("rejects an inherited property used as a tenant name", () => {
  assert.throws(() => authenticate(state, { tenant: "constructor", token: "x" }), {
    code: "unknown_tenant",
  });
});

test("assertRole rejects a worker asking for an admin action", () => {
  const worker = { id: "globex", role: "worker" };
  assert.throws(() => assertRole(worker, "admin"), { code: "forbidden_role" });
  assert.equal(assertRole({ id: "acme", role: "admin" }, "admin"), undefined);
});

test("assertJobVisible rejects a missing job and another tenant's job", () => {
  const actor = { id: "acme", role: "admin" };
  assert.throws(() => assertJobVisible(actor, undefined, "job-0009"), { code: "job_not_visible" });
  assert.throws(
    () => assertJobVisible(actor, { id: "job-0002", tenant: "globex" }, "job-0002"),
    { code: "job_not_visible" },
  );
  assert.equal(assertJobVisible(actor, { id: "job-0001", tenant: "acme" }, "job-0001"), undefined);
});
