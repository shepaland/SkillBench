import { Command } from "commander";
import { runList, type ListOptions } from "../commands/list.js";
import { runValidate, type CommandIo, type ValidateOptions } from "../commands/validate.js";
import { InvocationError } from "../domain/errors.js";

const unavailableCommands = ["dry-run", "run", "compare", "report"] as const;

export function createProgram(io: CommandIo = processIo()): Command {
  const program = new Command()
    .name("skillbench")
    .description("Evaluate coding skills against repeatable benchmarks.")
    .version("0.1.0")
    .showHelpAfterError()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command("validate")
    .description("Validate schemas, references, hashes, paths, and oracle availability")
    .option("--project <path>", "SkillBench project root", ".")
    .option("--public-only", "do not require private oracle availability", false)
    .action(async (options: ValidateOptions) => runValidate(options, io));

  program
    .command("list")
    .description("List benchmark cases and variants")
    .argument("[target]", "cases or variants")
    .option("--project <path>", "SkillBench project root", ".")
    .option("--json", "emit machine-readable JSON", false)
    .action(async (target: string | undefined, options: ListOptions) => runList(target, options, io));

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
