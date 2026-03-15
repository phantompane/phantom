import { err, isErr, ok, type Result } from "@phantompane/shared";
import { execInWorktree } from "../exec.ts";
import { getWorktreePathFromDirectory } from "../paths.ts";
import { copyFiles } from "./file-copier.ts";

export interface PostCreateExecutionOptions {
  gitRoot: string;
  worktreesDirectory: string;
  worktreeName: string;
  commands: string[];
}

export interface PostCreateExecutionResult {
  executedCommands: string[];
}

export async function executePostCreateCommands(
  options: PostCreateExecutionOptions,
): Promise<Result<PostCreateExecutionResult>> {
  const { gitRoot, worktreesDirectory, worktreeName, commands } = options;

  const executedCommands: string[] = [];

  for (const command of commands) {
    console.log(`Executing: ${command}`);
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

export async function copyFilesToWorktree(
  gitRoot: string,
  worktreesDirectory: string,
  worktreeName: string,
  filesToCopy: string[],
): Promise<Result<void>> {
  const worktreePath = getWorktreePathFromDirectory(
    worktreesDirectory,
    worktreeName,
  );
  const copyResult = await copyFiles(gitRoot, worktreePath, filesToCopy);

  if (isErr(copyResult)) {
    return err(copyResult.error);
  }

  return ok(undefined);
}
