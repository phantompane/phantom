import { type CommandHelp, helpFormatter } from "./help.ts";

export interface Command {
  name: string;
  description: string;
  subcommands?: Command[];
  handler?: (args: string[]) => void;
  help?: CommandHelp;
}

export async function runCli(commands: Command[]): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printHelp(commands);
    process.exit(0);
  }

  if (args[0] === "--version" || args[0] === "-v") {
    const version = commands.find((command) => command.name === "version");
    if (version?.handler) {
      await version.handler([]);
      return;
    }
  }

  const { command, remainingArgs } = findCommand(args, commands);

  if (!command || !command.handler) {
    console.error(`Error: Unknown command '${args.join(" ")}'\n`);
    printHelp(commands);
    process.exit(1);
  }

  if (remainingArgs.includes("--help") || remainingArgs.includes("-h")) {
    if (command.help) {
      console.log(helpFormatter.formatCommandHelp(command.help));
    } else {
      console.log(`Help not available for command '${command.name}'`);
    }
    process.exit(0);
  }

  try {
    await command.handler(remainingArgs);
  } catch (error) {
    console.error(
      "Error:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}

function printHelp(commands: Command[]) {
  const simpleCommands = commands.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
  }));
  console.log(helpFormatter.formatMainHelp(simpleCommands));
}

function findCommand(
  args: string[],
  commands: Command[],
): { command: Command | null; remainingArgs: string[] } {
  if (args.length === 0) {
    return { command: null, remainingArgs: [] };
  }

  const [cmdName, ...rest] = args;
  const command = commands.find((cmd) => cmd.name === cmdName);

  if (!command) {
    return { command: null, remainingArgs: args };
  }

  if (command.subcommands && rest.length > 0) {
    const { command: subcommand, remainingArgs } = findCommand(
      rest,
      command.subcommands,
    );
    if (subcommand) {
      return { command: subcommand, remainingArgs };
    }
  }

  return { command, remainingArgs: rest };
}
