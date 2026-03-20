import { parseArgs } from "node:util";
import {
  runCreateWorktree,
  TmuxSessionRequiredError,
  WorktreeActionConflictError,
  WorktreeAlreadyExistsError,
} from "@phantompane/core";
import { isErr } from "@phantompane/shared";
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

  const result = await runCreateWorktree({
    name: positionals[0],
    base: values.base,
    copyFiles: values["copy-file"],
    action: {
      shell: values.shell ?? false,
      exec: values.exec,
      tmuxDirection,
    },
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

  if (result.value.exitProcessCode !== undefined) {
    return process.exit(result.value.exitProcessCode);
  }

  exitWithSuccess();
}
