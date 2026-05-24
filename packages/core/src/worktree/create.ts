import fs from "node:fs/promises";
import { getGitRoot, addWorktree } from "@phantompane/git";
import { err, isErr, isOk, ok, type Result } from "@phantompane/utils";
import { createContext } from "../context.ts";
import { getWorktreePathFromDirectory } from "../paths.ts";
import {
  executePostCreateCommands,
  type PostCreateExecutionResult,
} from "./post-create.ts";
import {
  mergeWorktreeCopyFiles,
  resolveWorktreeAction,
  runWorktreeAction,
  validateWorktreeAction,
  type WorktreeActionOptions,
  type WorktreeLogger,
} from "./action.ts";
import { copyFiles } from "./file-copier.ts";
import { type WorktreeAlreadyExistsError, WorktreeError } from "./errors.ts";
import { generateUniqueName } from "./generate-name.ts";
import {
  validateWorktreeDoesNotExist,
  validateWorktreeName,
} from "./validate.ts";

export interface CreateWorktreeOptions {
  branch?: string;
  base?: string;
  copyFiles?: string[];
  logger?: WorktreeLogger;
}

export interface CreateWorktreeSuccess {
  message: string;
  path: string;
  copiedFiles?: string[];
  skippedFiles?: string[];
  copyError?: string;
}

export type RunCreateWorktreePostCreateMode =
  | "afterAction"
  | "beforeAction"
  | "skip";

export interface WorktreePostCreateTask {
  gitRoot: string;
  worktreesDirectory: string;
  worktreeName: string;
  commands: string[];
}

export interface RunPostCreateWorktreeOptions extends WorktreePostCreateTask {
  logger?: WorktreeLogger;
}

export interface RunCreateWorktreeOptions {
  name?: string;
  gitRoot?: string;
  base?: string;
  copyFiles?: string[];
  action?: WorktreeActionOptions;
  logger?: WorktreeLogger;
  postCreate?: RunCreateWorktreePostCreateMode;
}

export interface RunCreateWorktreeSuccess {
  name: string;
  path: string;
  message: string;
  copyError?: string;
  exitProcessCode?: number;
  postCreate?: WorktreePostCreateTask;
}

export async function createWorktree(
  gitRoot: string,
  worktreeDirectory: string,
  name: string,
  options: CreateWorktreeOptions,
  postCreateCopyFiles: string[] | undefined,
  postCreateCommands: string[] | undefined,
  directoryNameSeparator: string,
): Promise<
  Result<CreateWorktreeSuccess, WorktreeAlreadyExistsError | WorktreeError>
> {
  const nameValidation = validateWorktreeName(name);
  if (isErr(nameValidation)) {
    return nameValidation;
  }

  const {
    branch = name,
    base = "HEAD",
    copyFiles: requestedCopyFiles,
    logger,
  } = options;

  const worktreePath = getWorktreePathFromDirectory(
    worktreeDirectory,
    name,
    directoryNameSeparator,
  );

  try {
    await fs.access(worktreeDirectory);
  } catch {
    await fs.mkdir(worktreeDirectory, { recursive: true });
  }

  const validation = await validateWorktreeDoesNotExist(
    gitRoot,
    worktreeDirectory,
    name,
  );
  if (isErr(validation)) {
    return err(validation.error);
  }

  try {
    await addWorktree({
      path: worktreePath,
      branch,
      base,
      cwd: gitRoot,
    });

    let copiedFiles: string[] | undefined;
    let skippedFiles: string[] | undefined;
    let copyError: string | undefined;

    const filesToCopy = mergeWorktreeCopyFiles(
      requestedCopyFiles,
      postCreateCopyFiles,
    );

    if (filesToCopy) {
      const copyResult = await copyFiles(gitRoot, worktreePath, filesToCopy);

      if (isOk(copyResult)) {
        copiedFiles = copyResult.value.copiedFiles;
        skippedFiles = copyResult.value.skippedFiles;
      } else {
        copyError = copyResult.error.message;
      }
    }

    if (postCreateCommands && postCreateCommands.length > 0) {
      const commandsResult = await runPostCreateWorktree({
        gitRoot,
        worktreesDirectory: worktreeDirectory,
        worktreeName: name,
        commands: postCreateCommands,
        logger,
      });
      if (isErr(commandsResult)) {
        return err(commandsResult.error);
      }
    }

    return ok({
      message: `Created worktree '${name}' at ${worktreePath}`,
      path: worktreePath,
      copiedFiles,
      skippedFiles,
      copyError,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return err(new WorktreeError(`worktree add failed: ${errorMessage}`));
  }
}

export async function runPostCreateWorktree(
  options: RunPostCreateWorktreeOptions,
): Promise<Result<PostCreateExecutionResult, WorktreeError>> {
  if (options.commands.length === 0) {
    return ok({ executedCommands: [] });
  }

  options.logger?.log?.("\nRunning post-create commands...");
  const commandsResult = await executePostCreateCommands({
    gitRoot: options.gitRoot,
    worktreesDirectory: options.worktreesDirectory,
    worktreeName: options.worktreeName,
    commands: options.commands,
    logger: options.logger,
  });
  if (isErr(commandsResult)) {
    return err(new WorktreeError(commandsResult.error.message));
  }

  return commandsResult;
}

export function createWorktreePostCreateTask(
  gitRoot: string,
  worktreesDirectory: string,
  worktreeName: string,
  commands: string[] | undefined,
): WorktreePostCreateTask | undefined {
  if (!commands || commands.length === 0) {
    return undefined;
  }

  return {
    gitRoot,
    worktreesDirectory,
    worktreeName,
    commands,
  };
}

export async function runCreateWorktree(
  options: RunCreateWorktreeOptions,
): Promise<Result<RunCreateWorktreeSuccess>> {
  const actionResult = resolveWorktreeAction(options.action);
  if (isErr(actionResult)) {
    return actionResult;
  }

  const actionValidation = await validateWorktreeAction(actionResult.value);
  if (isErr(actionValidation)) {
    return actionValidation;
  }

  const postCreateMode = options.postCreate ?? "afterAction";

  try {
    const gitRoot = options.gitRoot ?? (await getGitRoot());
    const context = await createContext(gitRoot);

    let worktreeName = options.name;
    if (!worktreeName) {
      const nameResult = await generateUniqueName(
        context.gitRoot,
        context.worktreesDirectory,
        context.directoryNameSeparator,
      );
      if (isErr(nameResult)) {
        return err(nameResult.error);
      }
      worktreeName = nameResult.value;
    }

    const filesToCopy = mergeWorktreeCopyFiles(
      context.config?.postCreate?.copyFiles,
      options.copyFiles,
    );

    const postCreateTask = createWorktreePostCreateTask(
      context.gitRoot,
      context.worktreesDirectory,
      worktreeName,
      context.config?.postCreate?.commands,
    );

    const createResult = await createWorktree(
      context.gitRoot,
      context.worktreesDirectory,
      worktreeName,
      {
        base: options.base,
        copyFiles: filesToCopy,
        logger: options.logger,
      },
      undefined,
      postCreateMode === "beforeAction" ? postCreateTask?.commands : undefined,
      context.directoryNameSeparator,
    );
    if (isErr(createResult)) {
      return err(createResult.error);
    }

    options.logger?.log(createResult.value.message);

    if (createResult.value.copyError) {
      options.logger?.warn?.(
        `\nWarning: Failed to copy some files: ${createResult.value.copyError}`,
      );
    }

    if (postCreateMode === "skip") {
      return ok({
        name: worktreeName,
        path: createResult.value.path,
        message: createResult.value.message,
        copyError: createResult.value.copyError,
        postCreate: postCreateTask,
      });
    }

    let postCreatePromise:
      | Promise<Result<PostCreateExecutionResult, WorktreeError>>
      | undefined;
    const startPostCreate = () => {
      if (!postCreateTask) {
        return undefined;
      }
      postCreatePromise ??= runPostCreateWorktree({
        ...postCreateTask,
        logger: options.logger,
      });
      return postCreatePromise;
    };
    const schedulePostCreate = () => {
      if (!postCreateTask) {
        return undefined;
      }
      postCreatePromise ??= Promise.resolve().then(() =>
        runPostCreateWorktree({
          ...postCreateTask,
          logger: options.logger,
        }),
      );
      return postCreatePromise;
    };

    const worktreeActionResult = await runWorktreeAction({
      gitRoot: context.gitRoot,
      worktreeDirectory: context.worktreesDirectory,
      worktreeName,
      worktreePath: createResult.value.path,
      action: actionResult.value,
      logger: options.logger,
      exitWithProcessCode: true,
      onStarted:
        postCreateMode === "afterAction" ? schedulePostCreate : undefined,
    });

    const postCreateResult =
      postCreateMode === "afterAction"
        ? await (postCreatePromise ?? startPostCreate())
        : undefined;
    if (isErr(worktreeActionResult)) {
      return err(worktreeActionResult.error);
    }
    if (postCreateResult && isErr(postCreateResult)) {
      return err(postCreateResult.error);
    }

    return ok({
      name: worktreeName,
      path: createResult.value.path,
      message: createResult.value.message,
      copyError: createResult.value.copyError,
      exitProcessCode: worktreeActionResult.value.exitProcessCode,
    });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
