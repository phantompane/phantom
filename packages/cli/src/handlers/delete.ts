import { parseArgs } from "node:util";
import {
  createContext,
  deleteWorktree as deleteWorktreeCore,
  selectWorktreeWithFzf,
  WorktreeError,
  WorktreeNotFoundError,
} from "@phantompane/core";
import { getCurrentWorktree, getGitRoot } from "@phantompane/git";
import { isErr } from "@phantompane/shared";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
import { output } from "../output.ts";

export async function deleteHandler(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      force: {
        type: "boolean",
        short: "f",
      },
      current: {
        type: "boolean",
      },
      fzf: {
        type: "boolean",
        default: false,
      },
    },
    strict: true,
    allowPositionals: true,
  });

  const deleteCurrent = values.current ?? false;
  const useFzf = values.fzf ?? false;

  if (positionals.length === 0 && !deleteCurrent && !useFzf) {
    exitWithError(
      "Please provide at least one worktree name to delete, use --current to delete the current worktree, or use --fzf for interactive selection",
      exitCodes.validationError,
    );
  }

  if ((positionals.length > 0 || useFzf) && deleteCurrent) {
    exitWithError(
      "Cannot specify --current with a worktree name or --fzf option",
      exitCodes.validationError,
    );
  }

  if (positionals.length > 0 && useFzf) {
    exitWithError(
      "Cannot specify both a worktree name and --fzf option",
      exitCodes.validationError,
    );
  }

  const forceDelete = values.force ?? false;

  try {
    const gitRoot = await getGitRoot();
    const context = await createContext(gitRoot);

    const worktreeNames: string[] = [];
    if (deleteCurrent) {
      const currentWorktree = await getCurrentWorktree(gitRoot);
      if (!currentWorktree) {
        exitWithError(
          "Not in a worktree directory. The --current option can only be used from within a worktree.",
          exitCodes.validationError,
        );
      }
      worktreeNames.push(currentWorktree);
    } else if (useFzf) {
      const selectResult = await selectWorktreeWithFzf(context.gitRoot);
      if (isErr(selectResult)) {
        exitWithError(selectResult.error.message, exitCodes.generalError);
      }
      if (!selectResult.value) {
        exitWithSuccess();
      }
      worktreeNames.push(selectResult.value.name);
    } else {
      worktreeNames.push(...positionals);
    }

    for (const worktreeName of worktreeNames) {
      const result = await deleteWorktreeCore(
        context.gitRoot,
        context.worktreesDirectory,
        worktreeName,
        {
          force: forceDelete,
        },
        context.config?.preDelete?.commands,
      );

      if (isErr(result)) {
        const exitCode =
          result.error instanceof WorktreeNotFoundError
            ? exitCodes.validationError
            : result.error instanceof WorktreeError &&
                result.error.message.includes("uncommitted changes")
              ? exitCodes.validationError
              : exitCodes.generalError;
        exitWithError(result.error.message, exitCode);
      }

      output.log(result.value.message);
    }
    exitWithSuccess();
  } catch (error) {
    exitWithError(
      error instanceof Error ? error.message : String(error),
      exitCodes.generalError,
    );
  }
}
