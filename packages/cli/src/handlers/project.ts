import { projectHelp } from "../help/project.ts";
import { helpFormatter } from "../help.ts";

export async function projectHandler(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.log(helpFormatter.formatCommandHelp(projectHelp));
    return;
  }

  throw new Error(`Unknown project subcommand: ${args[0]}`);
}
