import type { StdioOptions } from "node:child_process";
import {
  type ProcessError,
  type SpawnSuccess,
  spawnProcess,
} from "@phantompane/process";
import { err, isErr, type Result } from "@phantompane/shared";
import type { WorktreeNotFoundError } from "./worktree/errors.ts";
import { validateWorktreeExists } from "./worktree/validate.ts";

export type ExecInWorktreeSuccess = SpawnSuccess;

export interface ExecInWorktreeOptions {
  interactive?: boolean;
}

export async function execInWorktree(
  gitRoot: string,
  worktreeDirectory: string,
  worktreeName: string,
  command: string[],
  options?: ExecInWorktreeOptions,
): Promise<
  Result<ExecInWorktreeSuccess, WorktreeNotFoundError | ProcessError>
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
  const [cmd, ...args] = command;

  const stdio: StdioOptions = options?.interactive
    ? "inherit"
    : ["ignore", "inherit", "inherit"];

  return spawnProcess({
    command: cmd,
    args,
    options: {
      cwd: worktreePath,
      stdio,
    },
  });
}
