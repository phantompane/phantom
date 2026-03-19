import { existsSync } from "node:fs";
import { getGitRoot, addWorktree, branchExists } from "@phantompane/git";
import { err, isErr, ok, type Result } from "@phantompane/shared";
import { createContext } from "../context.ts";
import { getWorktreePathFromDirectory } from "../paths.ts";
import {
  mergeWorktreeCopyFiles,
  resolveWorktreeAction,
  runWorktreeAction,
  validateWorktreeAction,
  type WorktreeActionOptions,
  type WorktreeLogger,
} from "./action.ts";
import {
  BranchNotFoundError,
  WorktreeAlreadyExistsError,
  WorktreeError,
} from "./errors.ts";
import {
  copyFilesToWorktree,
  executePostCreateCommands,
} from "./post-create.ts";
import { validateWorktreeName } from "./validate.ts";

export interface RunAttachWorktreeOptions {
  name: string;
  copyFiles?: string[];
  action?: WorktreeActionOptions;
  logger?: WorktreeLogger;
}

export interface RunAttachWorktreeSuccess {
  name: string;
  path: string;
}

export async function attachWorktreeCore(
  gitRoot: string,
  worktreeDirectory: string,
  name: string,
  postCreateCopyFiles: string[] | undefined,
  postCreateCommands: string[] | undefined,
  directoryNameSeparator: string,
): Promise<Result<string, Error>> {
  const validation = validateWorktreeName(name);
  if (isErr(validation)) {
    return validation;
  }

  const worktreePath = getWorktreePathFromDirectory(
    worktreeDirectory,
    name,
    directoryNameSeparator,
  );
  if (existsSync(worktreePath)) {
    return err(new WorktreeAlreadyExistsError(name));
  }

  const branchCheckResult = await branchExists(gitRoot, name);
  if (isErr(branchCheckResult)) {
    return err(branchCheckResult.error);
  }

  if (!branchCheckResult.value) {
    return err(new BranchNotFoundError(name));
  }

  try {
    await addWorktree({
      path: worktreePath,
      branch: name,
      createBranch: false,
      cwd: gitRoot,
    });
  } catch (error) {
    return err(
      error instanceof Error
        ? error
        : new Error(`Failed to attach worktree: ${String(error)}`),
    );
  }

  if (postCreateCopyFiles && postCreateCopyFiles.length > 0) {
    const copyResult = await copyFilesToWorktree(
      gitRoot,
      worktreeDirectory,
      name,
      postCreateCopyFiles,
      directoryNameSeparator,
    );
    if (isErr(copyResult)) {
      console.warn(
        `Warning: Failed to copy some files: ${copyResult.error.message}`,
      );
    }
  }

  if (postCreateCommands && postCreateCommands.length > 0) {
    console.log("\nRunning post-create commands...");
    const commandsResult = await executePostCreateCommands({
      gitRoot,
      worktreesDirectory: worktreeDirectory,
      worktreeName: name,
      commands: postCreateCommands,
    });
    if (isErr(commandsResult)) {
      return err(new WorktreeError(commandsResult.error.message));
    }
  }

  return ok(worktreePath);
}

export async function runAttachWorktree(
  options: RunAttachWorktreeOptions,
): Promise<Result<RunAttachWorktreeSuccess>> {
  const actionResult = resolveWorktreeAction(options.action);
  if (isErr(actionResult)) {
    return actionResult;
  }

  const actionValidation = await validateWorktreeAction(actionResult.value);
  if (isErr(actionValidation)) {
    return actionValidation;
  }

  try {
    const gitRoot = await getGitRoot();
    const context = await createContext(gitRoot);

    const filesToCopy = mergeWorktreeCopyFiles(
      context.config?.postCreate?.copyFiles,
      options.copyFiles,
    );

    const attachResult = await attachWorktreeCore(
      context.gitRoot,
      context.worktreesDirectory,
      options.name,
      filesToCopy,
      context.config?.postCreate?.commands,
      context.directoryNameSeparator,
    );
    if (isErr(attachResult)) {
      return err(attachResult.error);
    }

    options.logger?.log(`Attached phantom: ${options.name}`);

    const worktreeActionResult = await runWorktreeAction({
      gitRoot: context.gitRoot,
      worktreeDirectory: context.worktreesDirectory,
      worktreeName: options.name,
      worktreePath: attachResult.value,
      action: actionResult.value,
      logger: options.logger,
    });
    if (isErr(worktreeActionResult)) {
      return err(worktreeActionResult.error);
    }

    return ok({
      name: options.name,
      path: attachResult.value,
    });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
