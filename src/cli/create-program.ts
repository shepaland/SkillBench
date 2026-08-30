import { Command } from "commander";
import { runDryRun, type RunSelectionOptions } from "../commands/dry-run.js";
import { runList, type ListOptions } from "../commands/list.js";
import { runRun, type RunCommandOptions } from "../commands/run.js";
import { runValidate, type CommandIo, type ValidateOptions } from "../commands/validate.js";
import { InvocationError } from "../domain/errors.js";

const unavailableCommands = ["compare", "report"] as const;

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

  program
    .command("dry-run")
    .description("Freeze run inputs and print the execution plan without starting an agent")
    .requiredOption("--case <id>", "case identifier")
    .requiredOption("--variant <id>", "variant identifier")
    .option("--project <path>", "SkillBench project root", ".")
    .option("--runtime <id>", "runtime adapter", "fake")
    .option("--model <id>", "model identifier", "fake-model")
    .option("--reasoning <effort>", "reasoning effort", "medium")
    .option("--sandbox <mode>", "sandbox mode", "workspace-write")
    .option("--json", "emit machine-readable JSON", false)
    .action(async (options: RunSelectionOptions) => runDryRun(options, io));

  program
    .command("run")
    .description("Execute one or more benchmark runs for a case and variant")
    .requiredOption("--case <id>", "case identifier")
    .requiredOption("--variant <id>", "variant identifier")
    .option("--project <path>", "SkillBench project root", ".")
    .option("--runs <count>", "number of repetitions", "1")
    .option("--runtime <id>", "runtime adapter", "fake")
    .option("--model <id>", "model identifier", "fake-model")
    .option("--reasoning <effort>", "reasoning effort", "medium")
    .option("--sandbox <mode>", "sandbox mode", "workspace-write")
    .option("--keep-workspace", "preserve the workspace for investigation", false)
    .option("--json", "emit machine-readable JSON", false)
    .action(async (options: RunCommandOptions) => runRun(options, io));

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
