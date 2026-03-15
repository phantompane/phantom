import { parseArgs } from "node:util";
import {
  createContext,
  createWorktree as createWorktreeCore,
  execInWorktree,
  generateUniqueName,
  shellInWorktree,
  WorktreeAlreadyExistsError,
} from "@phantompane/core";
import { getGitRoot } from "@phantompane/git";
import {
  executeTmuxCommand,
  getPhantomEnv,
  isInsideTmux,
} from "@phantompane/process";
import { isErr, isOk } from "@phantompane/shared";
import { exitCodes, exitWithError, exitWithSuccess } from "../errors.ts";
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

  let worktreeName = positionals[0];
  const openShell = values.shell ?? false;
  const execCommand = values.exec;
  const copyFileOptions = values["copy-file"];
  const baseOption = values.base;

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

  if (
    [openShell, execCommand !== undefined, tmuxOption].filter(Boolean).length >
    1
  ) {
    exitWithError(
      "Cannot use --shell, --exec, and --tmux options together",
      exitCodes.validationError,
    );
  }

  if (tmuxOption && !(await isInsideTmux())) {
    exitWithError(
      "The --tmux option can only be used inside a tmux session",
      exitCodes.validationError,
    );
  }

  try {
    const gitRoot = await getGitRoot();
    const context = await createContext(gitRoot);
    const directoryNameSeparator =
      context.preferences?.directoryNameSeparator ??
      context.config?.directoryNameSeparator;

    if (!worktreeName) {
      const nameResult = await generateUniqueName(
        gitRoot,
        context.worktreesDirectory,
        directoryNameSeparator,
      );
      if (isErr(nameResult)) {
        exitWithError(nameResult.error.message, exitCodes.generalError);
      }
      worktreeName = nameResult.value;
    }

    let filesToCopy: string[] = [];

    // Load files from config
    if (context.config?.postCreate?.copyFiles) {
      filesToCopy = [...context.config.postCreate.copyFiles];
    }

    // Add files from CLI options
    if (copyFileOptions && copyFileOptions.length > 0) {
      const cliFiles = Array.isArray(copyFileOptions)
        ? copyFileOptions
        : [copyFileOptions];
      // Merge with config files, removing duplicates
      filesToCopy = [...new Set([...filesToCopy, ...cliFiles])];
    }

    const result = await createWorktreeCore(
      context.gitRoot,
      context.worktreesDirectory,
      worktreeName,
      {
        copyFiles: filesToCopy.length > 0 ? filesToCopy : undefined,
        base: baseOption,
      },
      filesToCopy.length > 0 ? filesToCopy : undefined,
      context.config?.postCreate?.commands,
      directoryNameSeparator,
    );

    if (isErr(result)) {
      const exitCode =
        result.error instanceof WorktreeAlreadyExistsError
          ? exitCodes.validationError
          : exitCodes.generalError;
      exitWithError(result.error.message, exitCode);
    }

    output.log(result.value.message);

    if (result.value.copyError) {
      output.error(
        `\nWarning: Failed to copy some files: ${result.value.copyError}`,
      );
    }

    if (execCommand && isOk(result)) {
      output.log(
        `\nExecuting command in worktree '${worktreeName}': ${execCommand}`,
      );

      const shell = process.env.SHELL || "/bin/sh";
      const execResult = await execInWorktree(
        context.gitRoot,
        context.worktreesDirectory,
        worktreeName,
        [shell, "-c", execCommand],
        { interactive: true },
      );

      if (isErr(execResult)) {
        output.error(execResult.error.message);
        const exitCode =
          "exitCode" in execResult.error
            ? (execResult.error.exitCode ?? exitCodes.generalError)
            : exitCodes.generalError;
        exitWithError("", exitCode);
      }

      process.exit(execResult.value.exitCode ?? 0);
    }

    if (openShell && isOk(result)) {
      output.log(
        `\nEntering worktree '${worktreeName}' at ${result.value.path}`,
      );
      output.log("Type 'exit' to return to your original directory\n");

      const shellResult = await shellInWorktree(
        context.gitRoot,
        context.worktreesDirectory,
        worktreeName,
      );

      if (isErr(shellResult)) {
        output.error(shellResult.error.message);
        const exitCode =
          "exitCode" in shellResult.error
            ? (shellResult.error.exitCode ?? exitCodes.generalError)
            : exitCodes.generalError;
        exitWithError("", exitCode);
      }

      process.exit(shellResult.value.exitCode ?? 0);
    }

    if (tmuxDirection && isOk(result)) {
      output.log(
        `\nOpening worktree '${worktreeName}' in tmux ${
          tmuxDirection === "new" ? "window" : "pane"
        }...`,
      );

      const shell = process.env.SHELL || "/bin/sh";

      const tmuxResult = await executeTmuxCommand({
        direction: tmuxDirection,
        command: shell,
        cwd: result.value.path,
        env: getPhantomEnv(worktreeName, result.value.path),
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
    }

    exitWithSuccess();
  } catch (error) {
    exitWithError(
      error instanceof Error ? error.message : String(error),
      exitCodes.generalError,
    );
  }
}
