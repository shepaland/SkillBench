import { Command } from "commander";
import { InvocationError } from "../domain/errors.js";

const unavailableCommands = ["list", "dry-run", "run", "compare", "report"] as const;

export function createProgram(): Command {
  const program = new Command()
    .name("skillbench")
    .description("Evaluate coding skills against repeatable benchmarks.")
    .version("0.1.0")
    .showHelpAfterError();

  program.command("validate").description("Validate a skill for benchmark readiness.");

  for (const name of unavailableCommands) {
    program
      .command(name)
      .description(`Run the ${name} workflow.`)
      .action(() => {
        throw new InvocationError(`${name} is not available in this build`);
      });
  }

  return program;
}
