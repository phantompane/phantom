import {
  getPhantomEnv,
  getShellCommand,
  type ProcessError,
  type SpawnSuccess,
  spawnProcess,
} from "@phantompane/process";
import { err, isErr, type Result } from "@phantompane/utils";
import type { WorktreeNotFoundError } from "./worktree/errors.ts";
import { validateWorktreeExists } from "./worktree/validate.ts";

export type ShellInWorktreeSuccess = SpawnSuccess;

export async function shellInWorktree(
  gitRoot: string,
  worktreeDirectory: string,
  worktreeName: string,
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
  const shell = getShellCommand();

  return spawnProcess({
    command: shell.command,
    args: shell.args,
    options: {
      cwd: worktreePath,
      env: {
        ...process.env,
        ...getPhantomEnv(worktreeName, worktreePath),
      },
    },
  });
}
