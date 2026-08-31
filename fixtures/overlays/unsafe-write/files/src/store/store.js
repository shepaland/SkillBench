import { readFile, writeFile } from "node:fs/promises";
import { fail } from "../core/errors.js";

export const STORE_VERSION = 1;
export const DEFAULT_DATA_PATH = "queuedesk.json";

export function resolveDataPath(dataFlag, env) {
  if (typeof dataFlag === "string" && dataFlag !== "") {
    return dataFlag;
  }
  const fromEnvironment = env.QUEUEDESK_DATA;
  if (typeof fromEnvironment === "string" && fromEnvironment !== "") {
    return fromEnvironment;
  }
  return DEFAULT_DATA_PATH;
}

export async function loadState(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw fail("storage_unreadable", `cannot read data file ${path}: ${cause.code ?? "unknown error"}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail("storage_unreadable", `data file ${path} is not valid JSON`);
  }

  if (parsed === null || typeof parsed !== "object") {
    throw fail("storage_unreadable", `data file ${path} is not an object`);
  }
  if (parsed.version !== STORE_VERSION) {
    throw fail(
      "storage_unsupported_version",
      `data file ${path} has version ${String(parsed.version)}; this build supports ${STORE_VERSION}`,
    );
  }
  if (parsed.tenants === null || typeof parsed.tenants !== "object" || Array.isArray(parsed.tenants)) {
    throw fail("storage_unreadable", `data file ${path} has no tenant table`);
  }
  if (!Array.isArray(parsed.jobs)) {
    throw fail("storage_unreadable", `data file ${path} has no job list`);
  }
  if (!Number.isInteger(parsed.nextId) || parsed.nextId < 1) {
    throw fail("storage_unreadable", `data file ${path} has no valid next identifier`);
  }

  return parsed;
}

export async function saveState(path, state) {
  try {
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch (cause) {
    throw fail("storage_write_failed", `cannot write data file ${path}: ${cause.code ?? "unknown error"}`);
  }
}
