import { parseArgs } from "node:util";
import { githubCheckout } from "@phantompane/github";
import {
  executeTmuxCommand,
  getPhantomEnv,
  isInsideTmux,
} from "@phantompane/process";
import { isErr } from "@phantompane/shared";
import { exitCodes, exitWithError } from "../errors.ts";
import { output } from "../output.ts";

export async function githubCheckoutHandler(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    options: {
      base: {
        type: "string",
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
    allowPositionals: true,
  });

  const [number] = positionals;

  if (!number) {
    exitWithError(
      "Please specify a PR or issue number",
      exitCodes.validationError,
    );
  }

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

  if (tmuxOption && !(await isInsideTmux())) {
    exitWithError(
      "The --tmux option can only be used inside a tmux session",
      exitCodes.validationError,
    );
  }

  const result = await githubCheckout({ number, base: values.base });

  if (isErr(result)) {
    exitWithError(result.error.message, exitCodes.generalError);
  }

  // Output the success message
  output.log(result.value.message);

  if (tmuxDirection) {
    output.log(
      `\nOpening worktree '${result.value.worktree}' in tmux ${
        tmuxDirection === "new" ? "window" : "pane"
      }...`,
    );

    const shell = process.env.SHELL || "/bin/sh";

    const tmuxResult = await executeTmuxCommand({
      direction: tmuxDirection,
      command: shell,
      cwd: result.value.path,
      env: getPhantomEnv(result.value.worktree, result.value.path),
      windowName: tmuxDirection === "new" ? result.value.worktree : undefined,
    });

    if (isErr(tmuxResult)) {
      output.error(tmuxResult.error.message);
      const exitCode =
        "exitCode" in tmuxResult.error
          ? (tmuxResult.error.exitCode ?? exitCodes.generalError)
          : exitCodes.generalError;
      exitWithError("", exitCode);
    }
  }
}
