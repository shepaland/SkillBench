import { ValidationError } from "../domain/errors.js";

export function canonicalJson(value: unknown): string {
  return serialize(value, new WeakSet<object>());
}

function serialize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new ValidationError("canonical JSON does not support non-finite numbers");
      }
      return JSON.stringify(value);
    case "undefined":
      throw new ValidationError("canonical JSON does not support undefined values");
    case "bigint":
      throw new ValidationError("canonical JSON does not support bigint values");
    case "function":
      throw new ValidationError("canonical JSON does not support function values");
    case "symbol":
      throw new ValidationError("canonical JSON does not support symbol values");
    case "object":
      return serializeObject(value, ancestors);
    default:
      throw new ValidationError("canonical JSON does not support this value");
  }
}

function serializeObject(value: object, ancestors: WeakSet<object>): string {
  if (ancestors.has(value)) {
    throw new ValidationError("canonical JSON does not support cyclic values");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => serialize(entry, ancestors)).join(",")}]`;
    }

    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ValidationError("canonical JSON only supports plain objects");
    }

    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(object[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
