import {
  getPhantomEnv,
  type ProcessError,
  type SpawnSuccess,
  spawnProcess,
} from "@phantompane/process";
import { err, isErr, type Result } from "@phantompane/utils";
import type { WorktreeNotFoundError } from "./worktree/errors.ts";
import { validateWorktreeExists } from "./worktree/validate.ts";

export type ShellInWorktreeSuccess = SpawnSuccess;

export interface ShellInWorktreeOptions {
  onStarted?: () => void;
}

export async function shellInWorktree(
  gitRoot: string,
  worktreeDirectory: string,
  worktreeName: string,
  options?: ShellInWorktreeOptions,
): Promise<
  Result<ShellInWorktreeSuccess, WorktreeNotFoundError | ProcessError>
> {
  const validation = await validateWorktreeExists(
    gitRoot,
    worktreeDirectory,
    worktreeName,
  );
  if (isErr(validation)) {
    return err(validation.error);
  }

  const worktreePath = validation.value.path;
  const shell = process.env.SHELL || "/bin/sh";
  const onSpawned = options?.onStarted;

  return spawnProcess({
    command: shell,
    args: [],
    options: {
      cwd: worktreePath,
      env: {
        ...process.env,
        ...getPhantomEnv(worktreeName, worktreePath),
      },
    },
    ...(onSpawned ? { onSpawned } : {}),
  });
}
