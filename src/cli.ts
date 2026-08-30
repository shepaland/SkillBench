import { CommanderError } from "commander";
import { pathToFileURL } from "node:url";
import { createProgram } from "./cli/create-program.js";
import { SkillBenchError } from "./domain/errors.js";

export async function main(argv: readonly string[]): Promise<number> {
  const program = createProgram();
  program.exitOverride();

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error: unknown) {
    if (error instanceof SkillBenchError) {
      process.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }

    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }

      process.stderr.write(`${error.message}\n`);
      return 2;
    }

    const message = error instanceof Error ? error.message : "Unexpected error";
    process.stderr.write(`${message}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv);
}
