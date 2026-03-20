import { parseArgs } from "node:util";
import {
  BranchNotFoundError,
  runAttachWorktree,
  TmuxSessionRequiredError,
  WorktreeActionConflictError,
  WorktreeAlreadyExistsError,
} from "@phantompane/core";
import { isErr } from "@phantompane/shared";
import { exitCodes, exitWithError, getProcessExitCode } from "../errors.ts";
import { output } from "../output.ts";

export async function attachHandler(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
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
    },
  });

  const [branchName] = positionals;
  if (!branchName) {
    exitWithError(
      "Missing required argument: branch name",
      exitCodes.validationError,
    );
  }

  const tmuxDirection = values.tmux
    ? "new"
    : values["tmux-vertical"] || values["tmux-v"]
      ? "vertical"
      : values["tmux-horizontal"] || values["tmux-h"]
        ? "horizontal"
        : undefined;

  const result = await runAttachWorktree({
    name: branchName,
    copyFiles: values["copy-file"],
    action: {
      shell: values.shell ?? false,
      exec: values.exec,
      tmuxDirection,
    },
    logger: output,
  });

  if (isErr(result)) {
    if (
      result.error instanceof WorktreeAlreadyExistsError ||
      result.error instanceof WorktreeActionConflictError ||
      result.error instanceof TmuxSessionRequiredError
    ) {
      exitWithError(result.error.message, exitCodes.validationError);
    }
    if (result.error instanceof BranchNotFoundError) {
      exitWithError(result.error.message, exitCodes.notFound);
    }
    exitWithError(
      result.error.message,
      getProcessExitCode(result.error) ?? exitCodes.generalError,
    );
  }
}
