import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ValidationError } from "../../src/domain/errors.js";
import { ManifestValidator } from "../../src/schemas/validator.js";

const schemaDirectory = join(import.meta.dirname, "../../schemas");
const hash = `sha256:${"0".repeat(64)}`;

function validCase() {
  return {
    schemaVersion: 1,
    id: "F01",
    title: "Implement the requested behavior",
    categories: ["implementation"],
    fixture: { path: "fixtures/base", contentHash: hash },
    promptSteps: [
      {
        id: "step-1",
        prompt: "Implement the change.",
        continuation: { eventRuleIds: ["rule-1"] },
      },
    ],
    publicVerification: [{ executor: "npm", args: ["test"] }],
    limits: { wallClockMs: 1, outputBytes: 1, tokenLimit: 1 },
    allowedChangePaths: ["src"],
    forbiddenChangePaths: ["secrets"],
    assertions: [{ id: "assert-1", dimension: "functional", critical: true }],
    transcriptRules: [{ id: "rule-1", check: "no_file_change" }],
  };
}

const baseCase = validCase();

function validVariant() {
  return {
    schemaVersion: 1,
    id: "future-variant",
    displayName: "Future Variant",
    compatibleRuntimes: ["codex"],
    installs: [],
    claimedCategories: ["implementation"],
    environment: {},
    contentHash: hash,
  };
}

function withoutProperty(value: Record<string, unknown>, omitted: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([property]) => property !== omitted));
}

const validator = await ManifestValidator.create(schemaDirectory);

test("valid manifests are returned as independent deep clones without mutating inputs", () => {
  const caseInput = validCase();
  const caseSnapshot = structuredClone(caseInput);
  const variantInput = validVariant();

  const returnedCase = validator.validateCase(caseInput);
  const returnedVariant = validator.validateVariant(variantInput);

  assert.deepEqual(returnedCase, caseInput);
  assert.deepEqual(returnedVariant, variantInput);
  assert.notStrictEqual(returnedCase, caseInput);
  assert.notStrictEqual(returnedCase.fixture, caseInput.fixture);
  assert.notStrictEqual(returnedVariant, variantInput);
  assert.deepEqual(caseInput, caseSnapshot);
});

test("transcript rules are the only optional case manifest property", () => {
  const withoutTranscriptRules = withoutProperty(validCase(), "transcriptRules");
  assert.deepEqual(validator.validateCase(withoutTranscriptRules), withoutTranscriptRules);

  const requiredProperties = [
    "schemaVersion",
    "id",
    "title",
    "categories",
    "fixture",
    "promptSteps",
    "publicVerification",
    "limits",
    "allowedChangePaths",
    "forbiddenChangePaths",
    "assertions",
  ] as const;

  for (const property of requiredProperties) {
    const missing = withoutProperty(validCase(), property);
    assert.throws(() => validator.validateCase(missing), /required/);
  }
});

test("all variant manifest properties are required", () => {
  const requiredProperties = [
    "schemaVersion",
    "id",
    "displayName",
    "compatibleRuntimes",
    "installs",
    "claimedCategories",
    "environment",
    "contentHash",
  ] as const;

  for (const property of requiredProperties) {
    const missing = withoutProperty(validVariant(), property);
    assert.throws(() => validator.validateVariant(missing), /required/);
  }
});

test("case schemas reject unknown properties and unsafe identifiers", () => {
  assert.throws(
    () => validator.validateCase({ ...validCase(), extra: true }),
    /additional properties/,
  );
  assert.throws(
    () => validator.validateCase({ ...validCase(), id: "../F01" }),
    /must match pattern/,
  );
  assert.throws(
    () =>
      validator.validateCase({
        ...validCase(),
        fixture: { ...validCase().fixture, extra: true },
      }),
    /additional properties/,
  );
  assert.throws(
    () =>
      validator.validateCase({
        ...validCase(),
        promptSteps: [
          {
            id: "step-1",
            prompt: "Implement the change.",
            continuation: { eventRuleIds: ["rule-1"], extra: true },
          },
        ],
      }),
    /additional properties/,
  );
});

test("case schemas constrain assertion dimensions and command executors", () => {
  assert.throws(
    () =>
      validator.validateCase({
        ...validCase(),
        assertions: [{ id: "x", dimension: "unknown", critical: true }],
      }),
    /dimension/,
  );
  assert.throws(
    () =>
      validator.validateCase({
        ...validCase(),
        publicVerification: [{ executor: "sh", args: ["-c", "echo unsafe"] }],
      }),
    /executor/,
  );
});

test("manifest hashes require the branded lowercase sha256 representation", () => {
  const invalidHashes = [
    "0".repeat(64),
    `sha256:${"A".repeat(64)}`,
    `sha256:${"0".repeat(63)}`,
  ];

  for (const contentHash of invalidHashes) {
    assert.throws(
      () =>
        validator.validateCase({
          ...validCase(),
          fixture: { ...validCase().fixture, contentHash },
        }),
      /contentHash/,
    );
    assert.throws(
      () => validator.validateVariant({ ...validVariant(), contentHash }),
      /contentHash/,
    );
  }
});

test("case schemas reject unsafe relative paths and non-positive runtime limits", () => {
  for (const path of ["../fixture", "/fixture", "C:/fixture", "nested/../fixture", "bad\0path"]) {
    assert.throws(
      () =>
        validator.validateCase({
          ...validCase(),
          fixture: { ...validCase().fixture, path },
        }),
      /path/,
    );
  }

  for (const limit of [0, -1, 1.5]) {
    assert.throws(
      () =>
        validator.validateCase({
          ...validCase(),
          limits: { ...validCase().limits, wallClockMs: limit },
        }),
      /wallClockMs/,
    );
  }
});

test("variant schemas allow empty installs for every valid variant identifier", () => {
  for (const id of ["control", "future-variant", "Z9_custom"]) {
    const manifest = { ...validVariant(), id, installs: [] };
    assert.deepEqual(validator.validateVariant(manifest), manifest);
  }
});

test("variant schemas allow an install with an empty destinations record", () => {
  const manifest = {
    ...validVariant(),
    installs: [{ source: "skills/example", destinations: {} }],
  };

  assert.deepEqual(validator.validateVariant(manifest), manifest);
});

test("variant schemas reject unsafe environment keys, paths, and nested extras", () => {
  assert.throws(
    () => validator.validateVariant({ ...validVariant(), environment: { PATH: "/tmp/bin" } }),
    /property name/,
  );

  const install = {
    source: "skills/example",
    destinations: { codex: ".codex/skills/example" },
  };
  const withInstall = {
    ...validVariant(),
    installs: [install],
  };
  assert.deepEqual(validator.validateVariant(withInstall), withInstall);
  assert.throws(
    () =>
      validator.validateVariant({
        ...withInstall,
        installs: [{ ...install, source: "../outside" }],
      }),
    /source/,
  );
  assert.throws(
    () =>
      validator.validateVariant({
        ...withInstall,
        installs: [{ ...install, extra: true }],
      }),
    /additional properties/,
  );
});

test("validation failures use ValidationError and deterministic path-keyword ordering", () => {
  const invalid = { ...validCase(), id: "../F01", extra: true };

  assert.throws(
    () => validator.validateCase(invalid),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      const lines = error.message.split("\n");
      assert.match(lines[0] ?? "", /^case \/ additionalProperties:/);
      assert.match(lines[1] ?? "", /^case \/id pattern:/);
      return true;
    },
  );
});

test("rejects the removed free-form transcript rule shape", async () => {
  const validator = await ManifestValidator.create(schemaDirectory);
  assert.throws(
    () => validator.validateCase({
      ...baseCase,
      transcriptRules: [{ id: "stopped", event: "assistant_message", beforeStepId: "s2" }],
    }),
    /oneOf/,
  );
});

test("rejects a command rule without a matcher", async () => {
  const validator = await ManifestValidator.create(schemaDirectory);
  assert.throws(
    () => validator.validateCase({
      ...baseCase,
      transcriptRules: [{ id: "tested", check: "command_ran" }],
    }),
    /oneOf/,
  );
});

test("accepts typed transcript rules and a transcript-graded assertion", async () => {
  const validator = await ManifestValidator.create(schemaDirectory);
  const manifest = validator.validateCase({
    ...baseCase,
    promptSteps: [
      { id: "s1", prompt: "ask first", continuation: { eventRuleIds: ["stopped"] } },
      { id: "s2", prompt: "now do it" },
    ],
    transcriptRules: [
      { id: "stopped", check: "no_file_change" },
      { id: "tested", check: "command_before_file_change", executor: "node", argsPrefix: ["--test"] },
    ],
    assertions: [
      { id: "A1", dimension: "functional", critical: true },
      { id: "A2", dimension: "process", critical: false, transcriptRuleId: "stopped" },
    ],
  });

  assert.equal(manifest.transcriptRules?.[0]?.check, "no_file_change");
  assert.equal(manifest.assertions[1]?.transcriptRuleId, "stopped");
});

test("rejects an unknown field on an assertion", async () => {
  const validator = await ManifestValidator.create(schemaDirectory);
  assert.throws(
    () => validator.validateCase({
      ...baseCase,
      assertions: [{ id: "A1", dimension: "functional", critical: true, gradedBy: "transcript" }],
    }),
    /additionalProperties/,
  );
});
