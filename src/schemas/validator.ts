import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { ValidationError } from "../domain/errors.js";
import type { CaseManifest, OracleManifest, VariantManifest } from "../domain/model.js";

type ManifestKind = "case" | "variant" | "oracle";

export class ManifestValidator {
  private constructor(
    private readonly caseSchema: ValidateFunction,
    private readonly variantSchema: ValidateFunction,
    private readonly oracleSchema: ValidateFunction,
  ) {}

  public static async create(schemaDirectory: string): Promise<ManifestValidator> {
    const [caseSource, variantSource, oracleSource] = await Promise.all([
      readFile(join(schemaDirectory, "case.schema.json"), "utf8"),
      readFile(join(schemaDirectory, "variant.schema.json"), "utf8"),
      readFile(join(schemaDirectory, "oracle.schema.json"), "utf8"),
    ]);
    const caseSchema = parseSchema(caseSource, "case");
    const variantSchema = parseSchema(variantSource, "variant");
    const oracleSchema = parseSchema(oracleSource, "oracle");
    const ajv = new Ajv2020({ allErrors: true, strict: true });

    return new ManifestValidator(ajv.compile(caseSchema), ajv.compile(variantSchema), ajv.compile(oracleSchema));
  }

  public validateCase(value: unknown): CaseManifest {
    return this.validate("case", this.caseSchema, value);
  }

  public validateVariant(value: unknown): VariantManifest {
    return this.validate("variant", this.variantSchema, value);
  }

  public validateOracle(value: unknown): OracleManifest {
    return this.validate("oracle", this.oracleSchema, value);
  }

  private validate(
    kind: "case",
    validator: ValidateFunction,
    value: unknown,
  ): CaseManifest;
  private validate(
    kind: "variant",
    validator: ValidateFunction,
    value: unknown,
  ): VariantManifest;
  private validate(
    kind: "oracle",
    validator: ValidateFunction,
    value: unknown,
  ): OracleManifest;
  private validate(
    kind: ManifestKind,
    validator: ValidateFunction,
    value: unknown,
  ): CaseManifest | VariantManifest | OracleManifest {
    if (!validator(value)) {
      throw new ValidationError(renderErrors(kind, validator.errors ?? []));
    }

    // This is the sole assertion from schema-validated JSON into branded domain types.
    return structuredClone(value) as CaseManifest | VariantManifest | OracleManifest;
  }
}

function parseSchema(source: string, kind: ManifestKind): Record<string, unknown> {
  const schema: unknown = JSON.parse(source);
  if (!isJsonObject(schema)) {
    throw new ValidationError(`${kind} schema must be a JSON object`);
  }
  return schema;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderErrors(kind: ManifestKind, errors: readonly ErrorObject[]): string {
  return [...errors]
    .sort(compareErrors)
    .map((error) => {
      const path = error.instancePath || "/";
      return `${kind} ${path} ${error.keyword}: ${error.message ?? "validation failed"}`;
    })
    .join("\n");
}

function compareErrors(left: ErrorObject, right: ErrorObject): number {
  return compareText(left.instancePath, right.instancePath) || compareText(left.keyword, right.keyword);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
