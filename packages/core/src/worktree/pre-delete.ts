import { err, isErr, ok, type Result } from "@phantompane/utils";
import { execInWorktree } from "../exec.ts";
import { getShellCommand } from "@phantompane/process";

export interface PreDeleteExecutionOptions {
  gitRoot: string;
  worktreesDirectory: string;
  worktreeName: string;
  commands: string[];
}

export interface PreDeleteExecutionResult {
  executedCommands: string[];
}

export async function executePreDeleteCommands(
  options: PreDeleteExecutionOptions,
): Promise<Result<PreDeleteExecutionResult>> {
  const { gitRoot, worktreesDirectory, worktreeName, commands } = options;

  const executedCommands: string[] = [];

  for (const command of commands) {
    console.log(`Executing pre-delete command: ${command}`);
    const shell = getShellCommand(process.env.SHELL);
    const cmdResult = await execInWorktree(
      gitRoot,
      worktreesDirectory,
      worktreeName,
      [shell.command, ...shell.args, "-c", command],
    );

    if (isErr(cmdResult)) {
      const errorMessage =
        cmdResult.error instanceof Error
          ? cmdResult.error.message
          : String(cmdResult.error);
      return err(
        new Error(
          `Failed to execute pre-delete command "${command}": ${errorMessage}`,
        ),
      );
    }

    // Check exit code
    if (cmdResult.value.exitCode !== 0) {
      return err(
        new Error(
          `Pre-delete command failed with exit code ${cmdResult.value.exitCode}: ${command}`,
        ),
      );
    }

    executedCommands.push(command);
  }

  return ok({ executedCommands });
}
