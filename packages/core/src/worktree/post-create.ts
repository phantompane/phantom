import { err, isErr, ok, type Result } from "@phantompane/shared";
import { execInWorktree } from "../exec.ts";
import type { WorktreeLogger } from "./action.ts";

export interface PostCreateExecutionOptions {
  gitRoot: string;
  worktreesDirectory: string;
  worktreeName: string;
  commands: string[];
  logger?: WorktreeLogger;
}

export interface PostCreateExecutionResult {
  executedCommands: string[];
}

export async function executePostCreateCommands(
  options: PostCreateExecutionOptions,
): Promise<Result<PostCreateExecutionResult>> {
  const { gitRoot, worktreesDirectory, worktreeName, commands, logger } =
    options;

  const executedCommands: string[] = [];

  for (const command of commands) {
    logger?.log(`Executing: ${command}`);
    const shell = process.env.SHELL || "/bin/sh";
    const cmdResult = await execInWorktree(
      gitRoot,
      worktreesDirectory,
      worktreeName,
      [shell, "-c", command],
    );

    if (isErr(cmdResult)) {
      const errorMessage =
        cmdResult.error instanceof Error
          ? cmdResult.error.message
          : String(cmdResult.error);
      return err(
        new Error(
          `Failed to execute post-create command "${command}": ${errorMessage}`,
        ),
      );
    }

    // Check exit code
    if (cmdResult.value.exitCode !== 0) {
      return err(
        new Error(
          `Post-create command failed with exit code ${cmdResult.value.exitCode}: ${command}`,
        ),
      );
    }

    executedCommands.push(command);
  }

  return ok({ executedCommands });
}
