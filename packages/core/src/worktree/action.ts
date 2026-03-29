import { getPhantomEnv, getShellCommand } from "@phantompane/process";
import { err, isErr, ok, type Result } from "@phantompane/utils";
import {
  executeTmuxCommand,
  isInsideTmux,
  type TmuxSplitDirection,
} from "@phantompane/tmux";
import { execInWorktree } from "../exec.ts";
import { shellInWorktree } from "../shell.ts";
import {
  TmuxSessionRequiredError,
  WorktreeActionConflictError,
} from "./errors.ts";

export interface WorktreeLogger {
  log(message: string): void;
  warn?(message: string): void;
}

export interface WorktreeActionOptions {
  shell?: boolean;
  exec?: string;
  tmuxDirection?: TmuxSplitDirection;
}

export type ResolvedWorktreeAction =
  | { kind: "shell" }
  | { kind: "exec"; command: string }
  | { kind: "tmux"; direction: TmuxSplitDirection };

export interface RunWorktreeActionOptions {
  gitRoot: string;
  worktreeDirectory: string;
  worktreeName: string;
  worktreePath: string;
  action?: ResolvedWorktreeAction;
  logger?: WorktreeLogger;
  exitWithProcessCode?: boolean;
}

export interface RunWorktreeActionSuccess {
  exitProcessCode?: number;
}

export function mergeWorktreeCopyFiles(
  configuredFiles: string[] | undefined,
  requestedFiles: string[] | undefined,
): string[] | undefined {
  const files = [
    ...new Set([...(configuredFiles ?? []), ...(requestedFiles ?? [])]),
  ];

  return files.length > 0 ? files : undefined;
}

export function resolveWorktreeAction(
  options: WorktreeActionOptions | undefined,
): Result<ResolvedWorktreeAction | undefined, WorktreeActionConflictError> {
  const actions: ResolvedWorktreeAction[] = [];

  if (options?.shell) {
    actions.push({ kind: "shell" });
  }

  if (options?.exec !== undefined) {
    actions.push({ kind: "exec", command: options.exec });
  }

  if (options?.tmuxDirection) {
    actions.push({ kind: "tmux", direction: options.tmuxDirection });
  }

  if (actions.length > 1) {
    return err(new WorktreeActionConflictError());
  }

  return ok(actions[0]);
}

export async function validateWorktreeAction(
  action: ResolvedWorktreeAction | undefined,
): Promise<Result<void, TmuxSessionRequiredError>> {
  if (action?.kind === "tmux" && !(await isInsideTmux())) {
    return err(new TmuxSessionRequiredError());
  }

  return ok(undefined);
}

export async function runWorktreeAction(
  options: RunWorktreeActionOptions,
): Promise<Result<RunWorktreeActionSuccess>> {
  const {
    gitRoot,
    worktreeDirectory,
    worktreeName,
    worktreePath,
    action,
    logger,
    exitWithProcessCode = false,
  } = options;

  if (!action) {
    return ok({});
  }

  if (action.kind === "shell") {
    logger?.log(`\nEntering worktree '${worktreeName}' at ${worktreePath}`);
    logger?.log("Type 'exit' to return to your original directory\n");

    const shellResult = await shellInWorktree(
      gitRoot,
      worktreeDirectory,
      worktreeName,
    );
    if (isErr(shellResult)) {
      return err(shellResult.error);
    }

    return ok({
      exitProcessCode: exitWithProcessCode
        ? (shellResult.value.exitCode ?? 0)
        : undefined,
    });
  }

  if (action.kind === "exec") {
    logger?.log(
      `\nExecuting command in worktree '${worktreeName}': ${action.command}`,
    );

    const shell = getShellCommand(process.env.SHELL);
    const execResult = await execInWorktree(
      gitRoot,
      worktreeDirectory,
      worktreeName,
      [shell.command, ...shell.args, "-c", action.command],
      { interactive: true },
    );
    if (isErr(execResult)) {
      return err(execResult.error);
    }

    return ok({
      exitProcessCode: exitWithProcessCode
        ? (execResult.value.exitCode ?? 0)
        : undefined,
    });
  }

  logger?.log(
    `\nOpening worktree '${worktreeName}' in tmux ${
      action.direction === "new" ? "window" : "pane"
    }...`,
  );

  const shell = getShellCommand(process.env.SHELL);
  const tmuxResult = await executeTmuxCommand({
    direction: action.direction,
    command: shell.command,
    args: shell.args,
    cwd: worktreePath,
    env: getPhantomEnv(worktreeName, worktreePath),
    windowName: action.direction === "new" ? worktreeName : undefined,
  });
  if (isErr(tmuxResult)) {
    return err(tmuxResult.error);
  }

  return ok({});
}
