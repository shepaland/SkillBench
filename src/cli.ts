#!/usr/bin/env node
import { CommanderError } from "commander";
import { pathToFileURL } from "node:url";
import { createProgram } from "./cli/create-program.js";
import type { CommandIo } from "./commands/validate.js";
import { SkillBenchError } from "./domain/errors.js";

export async function main(argv: readonly string[], io: CommandIo = processIo()): Promise<number> {
  const program = createProgram(io);
  program.exitOverride();
  for (const command of program.commands) {
    command.exitOverride();
  }

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error: unknown) {
    if (error instanceof SkillBenchError) {
      io.stderr(`${error.message}\n`);
      return error.exitCode;
    }

    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }

      return 2;
    }

    const message = error instanceof Error ? error.message : "Unexpected error";
    io.stderr(`${message}\n`);
    return 2;
  }
}

function processIo(): CommandIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv);
}
