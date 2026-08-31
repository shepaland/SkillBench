#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./args.js";
import { runClaim } from "./commands/claim.js";
import { runComplete } from "./commands/complete.js";
import { runCreate } from "./commands/create.js";
import { runList } from "./commands/list.js";
import { QueueDeskError } from "./core/errors.js";
import {
  renderError,
  renderErrorJson,
  renderJob,
  renderJobList,
  renderJson,
} from "./format/output.js";
import { resolveDataPath } from "./store/store.js";

const RUNNERS = {
  create: runCreate,
  list: runList,
  claim: runClaim,
  complete: runComplete,
};

export async function main(argv, io) {
  let json = argv.includes("--json");
  try {
    const options = parseArgs(argv);
    json = options.json;
    const dataPath = resolveDataPath(options.dataPath, io.env);
    const result = await RUNNERS[options.command](options, { dataPath, now: io.now });
    io.stdout.write(`${render(result, json)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof QueueDeskError)) {
      throw error;
    }
    io.stderr.write(`${json ? renderErrorJson(error) : renderError(error)}\n`);
    return error.exitCode;
  }
}

function render(result, json) {
  if (result.kind === "jobs") {
    return json ? renderJson(result.jobs) : renderJobList(result.jobs);
  }
  return json ? renderJson(result.job) : renderJob(result.job);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    now: () => new Date().toISOString(),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`queuedesk: unexpected failure: ${error.message}\n`);
      process.exitCode = 1;
    });
}
