import { fail } from "./core/errors.js";

const COMMANDS = new Set(["create", "list", "claim", "complete"]);
const PRIORITIES = new Set(["high", "normal", "low"]);
const STATES = new Set(["queued", "claimed", "done"]);
const JOB_ID = /^job-\d{4,}$/u;

const VALUE_FLAGS = new Map([
  ["--tenant", "tenant"],
  ["--token", "token"],
  ["--data", "dataPath"],
  ["--title", "title"],
  ["--note", "note"],
  ["--priority", "priority"],
  ["--state", "state"],
]);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) {
    throw fail("unknown_command", "missing command; expected create, list, claim, or complete");
  }
  if (!COMMANDS.has(command)) {
    throw fail("unknown_command", `unknown command: ${command}`);
  }

  const options = {
    command,
    tenant: null,
    token: null,
    dataPath: null,
    json: false,
    title: null,
    note: null,
    priority: "normal",
    state: null,
    allTenants: false,
    jobId: null,
  };
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const field = VALUE_FLAGS.get(argument);
    if (field !== undefined) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw fail("missing_flag", `flag ${argument} needs a value`);
      }
      options[field] = value;
      index += 1;
      continue;
    }
    if (argument === "--all-tenants") {
      options.allTenants = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument.startsWith("--")) {
      throw fail("invalid_flag", `unknown flag: ${argument}`);
    }
    positional.push(argument);
  }

  if (options.tenant === null) {
    throw fail("missing_flag", "flag --tenant is required");
  }
  if (options.token === null) {
    throw fail("missing_flag", "flag --token is required");
  }
  if (!PRIORITIES.has(options.priority)) {
    throw fail("invalid_flag", `unsupported priority: ${options.priority}`);
  }
  if (options.state !== null && !STATES.has(options.state)) {
    throw fail("invalid_flag", `unsupported state: ${options.state}`);
  }

  if (command === "create" && options.title === null) {
    throw fail("missing_flag", "flag --title is required for create");
  }
  if (command === "complete") {
    const [jobId, ...extra] = positional;
    if (jobId === undefined) {
      throw fail("missing_flag", "complete needs a job identifier");
    }
    if (extra.length > 0) {
      throw fail("invalid_flag", `unexpected argument: ${extra[0]}`);
    }
    if (!JOB_ID.test(jobId)) {
      throw fail("invalid_job_id", `malformed job identifier: ${jobId}`);
    }
    options.jobId = jobId;
  } else if (positional.length > 0) {
    throw fail("invalid_flag", `unexpected argument: ${positional[0]}`);
  }

  return options;
}
