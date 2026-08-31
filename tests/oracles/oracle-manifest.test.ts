import assert from "node:assert/strict";
import test from "node:test";
import type { OracleCheck } from "../../src/domain/model.js";
import { assertOracleCoversAssertions } from "../../src/oracles/oracle-manifest.js";

function oracleCheck(assertionId: string): OracleCheck {
  return {
    assertionId,
    command: { executor: "node", args: ["check.js"] },
    workingDirectory: "checks",
    timeoutMs: 1_000,
  };
}

test("a transcript-graded assertion needs no oracle check", () => {
  assert.doesNotThrow(() => {
    assertOracleCoversAssertions(
      { schemaVersion: 1, caseId: "C1", checks: [oracleCheck("A1")] },
      [
        { id: "A1", dimension: "functional", critical: true },
        { id: "A2", dimension: "process", critical: false, transcriptRuleId: "stopped" },
      ],
    );
  });
});

test("the oracle must not cover a transcript-graded assertion", () => {
  assert.throws(
    () => {
      assertOracleCoversAssertions(
        { schemaVersion: 1, caseId: "C1", checks: [oracleCheck("A1"), oracleCheck("A2")] },
        [
          { id: "A1", dimension: "functional", critical: true },
          { id: "A2", dimension: "process", critical: false, transcriptRuleId: "stopped" },
        ],
      );
    },
    /graded from the transcript/,
  );
});
