import { parseArgs } from "node:util";
import {
  resolveWorktreeAction,
  runPostCreateWorktree,
  runCreateWorktree,
  runWorktreeAction,
  TmuxSessionRequiredError,
  validateWorktreeAction,
  WorktreeActionConflictError,
  WorktreeAlreadyExistsError,
} from "@phantompane/core";
import { isErr } from "@phantompane/utils";
import {
  exitCodes,
  exitWithError,
  exitWithSuccess,
  getProcessExitCode,
} from "../errors.ts";
import { output } from "../output.ts";

export async function createHandler(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      shell: {
        type: "boolean",
        short: "s",
      },
      exec: {
        type: "string",
        short: "x",
      },
      tmux: {
        type: "boolean",
        short: "t",
      },
      "tmux-vertical": {
        type: "boolean",
      },
      "tmux-v": {
        type: "boolean",
      },
      "tmux-horizontal": {
        type: "boolean",
      },
      "tmux-h": {
        type: "boolean",
      },
      "copy-file": {
        type: "string",
        multiple: true,
      },
      base: {
        type: "string",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  const tmuxDirection = values.tmux
    ? "new"
    : values["tmux-vertical"] || values["tmux-v"]
      ? "vertical"
      : values["tmux-horizontal"] || values["tmux-h"]
        ? "horizontal"
        : undefined;

  const actionResult = resolveWorktreeAction({
    shell: values.shell ?? false,
    exec: values.exec,
    tmuxDirection,
  });
  if (isErr(actionResult)) {
    exitWithError(actionResult.error.message, exitCodes.validationError);
  }

  const actionValidation = await validateWorktreeAction(actionResult.value);
  if (isErr(actionValidation)) {
    exitWithError(actionValidation.error.message, exitCodes.validationError);
  }

  const result = await runCreateWorktree({
    name: positionals[0],
    base: values.base,
    copyFiles: values["copy-file"],
    logger: output,
  });

  if (isErr(result)) {
    const exitCode =
      result.error instanceof WorktreeAlreadyExistsError ||
      result.error instanceof WorktreeActionConflictError ||
      result.error instanceof TmuxSessionRequiredError
        ? exitCodes.validationError
        : (getProcessExitCode(result.error) ?? exitCodes.generalError);
    exitWithError(result.error.message, exitCode);
  }

  let postCreatePromise: ReturnType<typeof runPostCreateWorktree> | undefined;
  const startPostCreate = () => {
    return (postCreatePromise ??= runPostCreateWorktree({
      worktreeName: result.value.name,
      logger: output,
    }));
  };

  const actionRunResult = await runWorktreeAction({
    gitRoot: result.value.gitRoot,
    worktreeDirectory: result.value.worktreesDirectory,
    worktreeName: result.value.name,
    worktreePath: result.value.path,
    action: actionResult.value,
    logger: output,
    exitWithProcessCode: true,
    onStarted: () => {
      void startPostCreate();
    },
  });
  if (isErr(actionRunResult)) {
    if (postCreatePromise) {
      await postCreatePromise.catch(() => undefined);
    }
    exitWithError(
      actionRunResult.error.message,
      getProcessExitCode(actionRunResult.error) ?? exitCodes.generalError,
    );
  }

  const postCreateResult = await startPostCreate();
  if (isErr(postCreateResult)) {
    exitWithError(postCreateResult.error.message, exitCodes.generalError);
  }

  if (actionRunResult.value.exitProcessCode !== undefined) {
    return process.exit(actionRunResult.value.exitProcessCode);
  }

  exitWithSuccess();
}
