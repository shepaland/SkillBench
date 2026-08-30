import assert from "node:assert/strict";
import { execFile as executeFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createTempProject } from "../helpers/temp-project.js";

const execFile = promisify(executeFile);
const packagedCli = fileURLToPath(new URL("../../dist/src/cli.js", import.meta.url));

test("packaged skillbench executable validates a project", async () => {
  await execFile(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
  const project = await createTempProject();
  const command = process.platform === "win32" ? process.execPath : packagedCli;
  const args = process.platform === "win32"
    ? [packagedCli, "validate", "--project", project.root]
    : ["validate", "--project", project.root];

  const result = await run(command, args);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "Validated 1 case and 2 variants.\n");
});

function run(command: string, args: readonly string[]): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}
