import { getPhantomEnv, type ProcessError } from "@phantompane/process";
import { err, ok, type Result } from "@phantompane/utils";
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
  type WorktreeNotFoundError,
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
  action?: ResolvedWorktreeAction | null;
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
): Result<ResolvedWorktreeAction | null, WorktreeActionConflictError> {
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

  const action = actions[0];
  if (action === undefined) {
    return ok(null);
  }

  return ok(action);
}

export async function validateWorktreeAction(
  action: ResolvedWorktreeAction | null | undefined,
): Promise<Result<true, TmuxSessionRequiredError>> {
  if (action?.kind === "tmux" && !(await isInsideTmux())) {
    return err(new TmuxSessionRequiredError());
  }

  return ok(true);
}

export async function runWorktreeAction(
  options: RunWorktreeActionOptions,
): Promise<
  Result<RunWorktreeActionSuccess, ProcessError | WorktreeNotFoundError>
> {
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
    if (!shellResult.ok) {
      return { ok: false, error: shellResult.error };
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

    const shell = process.env.SHELL || "/bin/sh";
    const execResult = await execInWorktree(
      gitRoot,
      worktreeDirectory,
      worktreeName,
      [shell, "-c", action.command],
      { interactive: true },
    );
    if (!execResult.ok) {
      return { ok: false, error: execResult.error };
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

  const shell = process.env.SHELL || "/bin/sh";
  const tmuxResult = await executeTmuxCommand({
    direction: action.direction,
    command: shell,
    cwd: worktreePath,
    env: getPhantomEnv(worktreeName, worktreePath),
    windowName: action.direction === "new" ? worktreeName : undefined,
  });
  if (!tmuxResult.ok) {
    return err(tmuxResult.error);
  }

  return ok({});
}
