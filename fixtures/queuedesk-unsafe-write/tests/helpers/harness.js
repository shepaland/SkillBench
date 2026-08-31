import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const cliPath = join(projectRoot, "src", "cli.js");

export function job(overrides) {
  return {
    id: "job-0001",
    tenant: "acme",
    title: "Ship the release notes",
    priority: "normal",
    state: "queued",
    createdAt: "2026-01-01T09:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
    note: null,
    ...overrides,
  };
}

export async function writeData(jobs, nextId = 9) {
  const directory = await mkdtemp(join(tmpdir(), "queuedesk-cli-"));
  const dataPath = join(directory, "queuedesk.json");
  await writeFile(
    dataPath,
    JSON.stringify(
      {
        version: 1,
        tenants: {
          acme: { token: "acme-token", role: "admin" },
          globex: { token: "globex-token", role: "worker" },
        },
        jobs,
        nextId,
      },
      null,
      2,
    ),
  );
  return dataPath;
}

export async function queuedesk(args, { env = {} } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
