import { parseArgs } from "node:util";
import {
  listWorktrees as listWorktreesCore,
  selectWorktreeWithFzf,
} from "@phantompane/core";
import { getGitRoot } from "@phantompane/git";
import { isErr } from "@phantompane/shared";
import { exitCodes, exitWithError } from "../errors.ts";
import { isExitSignal } from "../exit-signal.ts";
import { output } from "../output.ts";

export async function listHandler(args: string[] = []): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      fzf: {
        type: "boolean",
        default: false,
      },
      "no-default": {
        type: "boolean",
        default: false,
      },
      names: {
        type: "boolean",
        default: false,
      },
    },
    strict: true,
    allowPositionals: false,
  });
  try {
    const gitRoot = await getGitRoot();

    const excludeDefault = values["no-default"] ?? false;

    if (values.fzf) {
      const selectResult = await selectWorktreeWithFzf(gitRoot, {
        excludeDefault,
      });

      if (isErr(selectResult)) {
        exitWithError(selectResult.error.message, exitCodes.generalError);
      }

      if (selectResult.value) {
        output.log(selectResult.value.name);
      }
    } else {
      const result = await listWorktreesCore(gitRoot, { excludeDefault });

      if (isErr(result)) {
        exitWithError("Failed to list worktrees", exitCodes.generalError);
      }

      const { worktrees, message } = result.value;

      if (worktrees.length === 0) {
        if (!values.names) {
          const fallbackMessage = excludeDefault
            ? "No sub worktrees found."
            : "No worktrees found.";
          output.log(message || fallbackMessage);
        }
        process.exit(exitCodes.success);
      }

      if (values.names) {
        for (const worktree of worktrees) {
          output.log(worktree.name);
        }
      } else {
        for (const worktree of worktrees) {
          const status = !worktree.isClean ? " [dirty]" : "";

          output.log(`${worktree.name} (${worktree.pathToDisplay})${status}`);
        }
      }
    }

    process.exit(exitCodes.success);
  } catch (error) {
    if (isExitSignal(error)) {
      throw error;
    }
    exitWithError(
      error instanceof Error ? error.message : String(error),
      exitCodes.generalError,
    );
  }
}
