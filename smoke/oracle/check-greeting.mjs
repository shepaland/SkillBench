import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.env.SKILLBENCH_WORKSPACE;
if (workspace === undefined) {
  console.error("SKILLBENCH_WORKSPACE is not set");
  process.exit(2);
}

const { greet } = await import(pathToFileURL(join(workspace, "app.js")).href);
const actual = greet("ann");
if (actual !== "hello ann") {
  console.error(`greet("ann") returned ${JSON.stringify(actual)}`);
  process.exit(1);
}
