import { parseArgs } from "node:util";
import {
  runCreateWorktree,
  TmuxSessionRequiredError,
  WorktreeActionConflictError,
  WorktreeAlreadyExistsError,
} from "@phantompane/core";
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

  const createOptions: Parameters<typeof runCreateWorktree>[0] = {
    logger: output,
    action: {
      shell: values.shell ?? false,
    },
  };
  const name = positionals[0];
  if (name !== undefined) {
    createOptions.name = name;
  }
  if (values.base !== undefined) {
    createOptions.base = values.base;
  }
  if (values["copy-file"] !== undefined) {
    createOptions.copyFiles = values["copy-file"];
  }
  if (values.exec !== undefined && createOptions.action) {
    createOptions.action.exec = values.exec;
  }
  if (tmuxDirection !== undefined && createOptions.action) {
    createOptions.action.tmuxDirection = tmuxDirection;
  }
  const result = await runCreateWorktree(createOptions);

  if (!result.ok) {
    const exitCode =
      result.error instanceof WorktreeAlreadyExistsError ||
      result.error instanceof WorktreeActionConflictError ||
      result.error instanceof TmuxSessionRequiredError
        ? exitCodes.validationError
        : (getProcessExitCode(result.error) ?? exitCodes.generalError);
    exitWithError(result.error.message, exitCode);
  }

  if (result.value.exitProcessCode !== undefined) {
    return process.exit(result.value.exitProcessCode);
  }

  exitWithSuccess();
}
