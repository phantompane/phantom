import { getGitRoot } from "@phantompane/git";
import { err, isErr, ok, type Result } from "@phantompane/utils";
import { createContext } from "../context.ts";
import { execInWorktree } from "../exec.ts";
import type { WorktreeLogger } from "./action.ts";
import { WorktreeError } from "./errors.ts";

export interface RunPostCreateWorktreeOptions {
  gitRoot?: string;
  worktreeName: string;
  commands?: string[];
  logger?: WorktreeLogger;
}

export interface HasPostCreateWorktreeCommandsOptions {
  gitRoot?: string;
}

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

export async function hasPostCreateWorktreeCommands(
  options: HasPostCreateWorktreeCommandsOptions = {},
): Promise<Result<boolean, WorktreeError>> {
  try {
    const gitRoot = options.gitRoot ?? (await getGitRoot());
    const context = await createContext(gitRoot);
    return ok((context.config?.postCreate?.commands?.length ?? 0) > 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new WorktreeError(message));
  }
}

export async function runPostCreateWorktree(
  options: RunPostCreateWorktreeOptions,
): Promise<Result<PostCreateExecutionResult, WorktreeError>> {
  try {
    const gitRoot = options.gitRoot ?? (await getGitRoot());
    const context = await createContext(gitRoot);
    const commands = options.commands ?? context.config?.postCreate?.commands;

    if (!commands || commands.length === 0) {
      return ok({ executedCommands: [] });
    }

    options.logger?.log?.("\nRunning post-create commands...");
    const commandsResult = await executePostCreateCommands({
      gitRoot: context.gitRoot,
      worktreesDirectory: context.worktreesDirectory,
      worktreeName: options.worktreeName,
      commands,
      logger: options.logger,
    });
    if (isErr(commandsResult)) {
      return err(new WorktreeError(commandsResult.error.message));
    }

    return commandsResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new WorktreeError(message));
  }
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
