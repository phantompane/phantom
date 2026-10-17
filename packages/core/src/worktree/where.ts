import { err, ok, type Result } from "@phantompane/utils";
import type { WorktreeNotFoundError } from "./errors.ts";
import { validateWorktreeExists } from "./validate.ts";

export interface WhereWorktreeSuccess {
  path: string;
}

export async function whereWorktree(
  gitRoot: string,
  worktreeDirectory: string,
  name: string,
): Promise<Result<WhereWorktreeSuccess, WorktreeNotFoundError>> {
  const validation = await validateWorktreeExists(
    gitRoot,
    worktreeDirectory,
    name,
  );

  if (!validation.ok) {
    return err(validation.error);
  }

  return ok({
    path: validation.value.path,
  });
}
