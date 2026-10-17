import { access, mkdir } from "node:fs/promises";
import { getGitRoot, addWorktree } from "@phantompane/git";
import { type ProcessError } from "@phantompane/process";
import { err, ok, type Result } from "@phantompane/utils";
import { createContext } from "../context.ts";
import { getWorktreePathFromDirectory } from "../paths.ts";
import { executePostCreateCommands } from "./post-create.ts";
import {
  mergeWorktreeCopyFiles,
  resolveWorktreeAction,
  runWorktreeAction,
  validateWorktreeAction,
  type WorktreeActionOptions,
  type WorktreeLogger,
} from "./action.ts";
import { copyFiles } from "./file-copier.ts";
import {
  TmuxSessionRequiredError,
  WorktreeActionConflictError,
  type WorktreeAlreadyExistsError,
  WorktreeError,
  type WorktreeNotFoundError,
} from "./errors.ts";
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

export interface RunCreateWorktreeOptions {
  name?: string;
  gitRoot?: string;
  base?: string;
  copyFiles?: string[];
  action?: WorktreeActionOptions;
  logger?: WorktreeLogger;
}

export interface RunCreateWorktreeSuccess {
  name: string;
  path: string;
  message: string;
  copyError?: string;
  exitProcessCode?: number;
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
  if (!nameValidation.ok) {
    return err(new WorktreeError(nameValidation.error.message));
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
    await access(worktreeDirectory);
  } catch {
    await mkdir(worktreeDirectory, { recursive: true });
  }

  const validation = await validateWorktreeDoesNotExist(
    gitRoot,
    worktreeDirectory,
    name,
  );
  if (!validation.ok) {
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

      if (copyResult.ok) {
        copiedFiles = copyResult.value.copiedFiles;
        skippedFiles = copyResult.value.skippedFiles;
      } else {
        copyError = copyResult.error.message;
      }
    }

    if (postCreateCommands && postCreateCommands.length > 0) {
      logger?.log?.("\nRunning post-create commands...");
      const commandsResult = await executePostCreateCommands({
        gitRoot,
        worktreesDirectory: worktreeDirectory,
        worktreeName: name,
        commands: postCreateCommands,
        logger,
      });
      if (!commandsResult.ok) {
        return err(new WorktreeError(commandsResult.error.message));
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

export async function runCreateWorktree(
  options: RunCreateWorktreeOptions,
): Promise<
  Result<
    RunCreateWorktreeSuccess,
    | WorktreeAlreadyExistsError
    | WorktreeError
    | WorktreeActionConflictError
    | TmuxSessionRequiredError
    | ProcessError
    | WorktreeNotFoundError
    | Error
  >
> {
  const actionResult = resolveWorktreeAction(options.action);
  if (!actionResult.ok) {
    return actionResult;
  }

  const actionValidation = await validateWorktreeAction(actionResult.value);
  if (!actionValidation.ok) {
    return actionValidation;
  }

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
      if (!nameResult.ok) {
        return err(nameResult.error);
      }
      worktreeName = nameResult.value;
    }

    const filesToCopy = mergeWorktreeCopyFiles(
      context.config?.postCreate?.copyFiles,
      options.copyFiles,
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
      context.config?.postCreate?.commands,
      context.directoryNameSeparator,
    );
    if (!createResult.ok) {
      return { ok: false, error: createResult.error };
    }

    options.logger?.log(createResult.value.message);

    if (createResult.value.copyError) {
      options.logger?.warn?.(
        `\nWarning: Failed to copy some files: ${createResult.value.copyError}`,
      );
    }

    const worktreeActionResult = await runWorktreeAction({
      gitRoot: context.gitRoot,
      worktreeDirectory: context.worktreesDirectory,
      worktreeName,
      worktreePath: createResult.value.path,
      action: actionResult.value,
      logger: options.logger,
      exitWithProcessCode: true,
    });
    if (!worktreeActionResult.ok) {
      return { ok: false, error: worktreeActionResult.error };
    }

    const name = worktreeName;
    const path = createResult.value.path;
    const message = createResult.value.message;
    const copyError = createResult.value.copyError;
    const exitProcessCode = worktreeActionResult.value.exitProcessCode;
    if (copyError !== undefined && exitProcessCode !== undefined) {
      return ok({ name, path, message, copyError, exitProcessCode });
    }
    if (copyError !== undefined) {
      return ok({ name, path, message, copyError });
    }
    if (exitProcessCode !== undefined) {
      return ok({ name, path, message, exitProcessCode });
    }
    return ok({ name, path, message });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
