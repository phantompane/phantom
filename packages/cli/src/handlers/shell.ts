import { parseArgs } from "node:util";
import {
  createContext,
  selectWorktreeWithFzf,
  shellInWorktree as shellInWorktreeCore,
  validateWorktreeExists,
  WorktreeNotFoundError,
} from "@phantompane/core";
import { getGitRoot } from "@phantompane/git";
import { getPhantomEnv } from "@phantompane/process";
import { isErr } from "@phantompane/shared";
import { executeTmuxCommand, isInsideTmux } from "@phantompane/tmux";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";

export async function shellHandler(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      fzf: {
        type: "boolean",
        default: false,
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
    },
    strict: true,
    allowPositionals: true,
  });

  const useFzf = values.fzf ?? false;

  // Determine tmux option
  const tmuxOption =
    values.tmux ||
    values["tmux-vertical"] ||
    values["tmux-v"] ||
    values["tmux-horizontal"] ||
    values["tmux-h"];

  let tmuxDirection: "new" | "vertical" | "horizontal" | undefined;
  if (values.tmux) {
    tmuxDirection = "new";
  } else if (values["tmux-vertical"] || values["tmux-v"]) {
    tmuxDirection = "vertical";
  } else if (values["tmux-horizontal"] || values["tmux-h"]) {
    tmuxDirection = "horizontal";
  }

  if (positionals.length === 0 && !useFzf) {
    exitWithError(
      "Usage: phantom shell <worktree-name> or phantom shell --fzf",
      exitCodes.validationError,
    );
  }

  if (positionals.length > 0 && useFzf) {
    exitWithError(
      "Cannot specify both a worktree name and --fzf option",
      exitCodes.validationError,
    );
  }

  let worktreeName: string;

  try {
    const gitRoot = await getGitRoot();
    const context = await createContext(gitRoot);

    if (tmuxOption && !(await isInsideTmux())) {
      exitWithError(
        "The --tmux option can only be used inside a tmux session",
        exitCodes.validationError,
      );
    }

    if (useFzf) {
      const selectResult = await selectWorktreeWithFzf(context.gitRoot);
      if (isErr(selectResult)) {
        exitWithError(selectResult.error.message, exitCodes.generalError);
      }
      if (!selectResult.value) {
        exitWithSuccess();
      }
      worktreeName = selectResult.value.name;
    } else {
      worktreeName = positionals[0];
    }

    // Get worktree path for display
    const validation = await validateWorktreeExists(
      context.gitRoot,
      context.worktreesDirectory,
      worktreeName,
    );
    if (isErr(validation)) {
      exitWithError(validation.error.message, exitCodes.generalError);
    }

    if (tmuxDirection) {
      output.log(
        `Opening worktree '${worktreeName}' in tmux ${
          tmuxDirection === "new" ? "window" : "pane"
        }...`,
      );

      const shell = process.env.SHELL || "/bin/sh";

      const tmuxResult = await executeTmuxCommand({
        direction: tmuxDirection,
        command: shell,
        cwd: validation.value.path,
        env: getPhantomEnv(worktreeName, validation.value.path),
        windowName: tmuxDirection === "new" ? worktreeName : undefined,
      });

      if (isErr(tmuxResult)) {
        output.error(tmuxResult.error.message);
        const exitCode =
          "exitCode" in tmuxResult.error
            ? (tmuxResult.error.exitCode ?? exitCodes.generalError)
            : exitCodes.generalError;
        exitWithError("", exitCode);
      }

      exitWithSuccess();
    }

    output.log(
      `Entering worktree '${worktreeName}' at ${validation.value.path}`,
    );
    output.log("Type 'exit' to return to your original directory\n");

    const result = await shellInWorktreeCore(
      context.gitRoot,
      context.worktreesDirectory,
      worktreeName,
    );

    if (isErr(result)) {
      const exitCode =
        result.error instanceof WorktreeNotFoundError
          ? exitCodes.notFound
          : result.error.exitCode || exitCodes.generalError;
      exitWithError(result.error.message, exitCode);
    }

    return process.exit(result.value.exitCode);
  } catch (error) {
    exitWithError(
      error instanceof Error ? error.message : String(error),
      exitCodes.generalError,
    );
  }
}
