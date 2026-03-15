import { parseArgs } from "node:util";
import {
  attachWorktreeCore,
  BranchNotFoundError,
  createContext,
  execInWorktree,
  shellInWorktree,
  WorktreeAlreadyExistsError,
} from "@phantompane/core";
import { getGitRoot } from "@phantompane/git";
import {
  executeTmuxCommand,
  getPhantomEnv,
  isInsideTmux,
} from "@phantompane/process";
import { isErr } from "@phantompane/shared";
import { exitCodes, exitWithError } from "../errors.ts";
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

  if (positionals.length === 0) {
    exitWithError(
      "Missing required argument: branch name",
      exitCodes.validationError,
    );
  }

  const [branchName] = positionals;

  const tmuxOption =
    values.tmux ||
    values["tmux-vertical"] ||
    values["tmux-v"] ||
    values["tmux-horizontal"] ||
    values["tmux-h"];

  const copyFileOptions = values["copy-file"];

  const tmuxDirection: "new" | "vertical" | "horizontal" | undefined =
    values.tmux
      ? "new"
      : values["tmux-vertical"] || values["tmux-v"]
        ? "vertical"
        : values["tmux-horizontal"] || values["tmux-h"]
          ? "horizontal"
          : undefined;

  if ([values.shell, values.exec, tmuxOption].filter(Boolean).length > 1) {
    exitWithError(
      "Cannot use --shell, --exec, and --tmux options together",
      exitCodes.validationError,
    );
  }

  const gitRoot = await getGitRoot();
  const context = await createContext(gitRoot);
  const directoryNameSeparator =
    context.preferences?.directoryNameSeparator ??
    context.config?.directoryNameSeparator;

  let copyFiles = context.config?.postCreate?.copyFiles ?? [];

  if (copyFileOptions && copyFileOptions.length > 0) {
    const cliCopyFiles = Array.isArray(copyFileOptions)
      ? copyFileOptions
      : [copyFileOptions];
    copyFiles = [...new Set([...copyFiles, ...cliCopyFiles])];
  }

  const postCreateCopyFiles = copyFiles.length > 0 ? copyFiles : undefined;

  if (tmuxOption && !(await isInsideTmux())) {
    exitWithError(
      "The --tmux option can only be used inside a tmux session",
      exitCodes.validationError,
    );
  }

  const result = await attachWorktreeCore(
    context.gitRoot,
    context.worktreesDirectory,
    branchName,
    postCreateCopyFiles,
    context.config?.postCreate?.commands,
    directoryNameSeparator,
  );

  if (isErr(result)) {
    const error = result.error;
    if (error instanceof WorktreeAlreadyExistsError) {
      exitWithError(error.message, exitCodes.validationError);
    }
    if (error instanceof BranchNotFoundError) {
      exitWithError(error.message, exitCodes.notFound);
    }
    exitWithError(error.message, exitCodes.generalError);
  }

  output.log(`Attached phantom: ${branchName}`);

  const worktreePath = result.value;

  if (values.shell) {
    const shellResult = await shellInWorktree(
      context.gitRoot,
      context.worktreesDirectory,
      branchName,
    );
    if (isErr(shellResult)) {
      exitWithError(shellResult.error.message, exitCodes.generalError);
    }
  } else if (values.exec) {
    const shell = process.env.SHELL || "/bin/sh";
    const execResult = await execInWorktree(
      context.gitRoot,
      context.worktreesDirectory,
      branchName,
      [shell, "-c", values.exec],
      { interactive: true },
    );
    if (isErr(execResult)) {
      exitWithError(execResult.error.message, exitCodes.generalError);
    }
  } else if (tmuxDirection) {
    output.log(
      `Opening worktree '${branchName}' in tmux ${
        tmuxDirection === "new" ? "window" : "pane"
      }...`,
    );

    const shell = process.env.SHELL || "/bin/sh";

    const tmuxResult = await executeTmuxCommand({
      direction: tmuxDirection,
      command: shell,
      cwd: worktreePath,
      env: getPhantomEnv(branchName, worktreePath),
      windowName: tmuxDirection === "new" ? branchName : undefined,
    });

    if (isErr(tmuxResult)) {
      exitWithError(tmuxResult.error.message, exitCodes.generalError);
    }
  }
}
