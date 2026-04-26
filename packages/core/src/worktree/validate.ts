import fs from "node:fs/promises";
import { err, isErr, ok, type Result } from "@phantompane/utils";
import { WorktreeAlreadyExistsError, WorktreeNotFoundError } from "./errors.ts";
import { type ListWorktreesOptions, listWorktrees } from "./list.ts";

export interface WorktreeExistsSuccess {
  path: string;
}

export interface ValidateWorktreeExistsOptions extends ListWorktreesOptions {
  expectedPath?: string;
}

export async function validateWorktreeExists(
  gitRoot: string,
  _worktreeDirectory: string,
  name: string,
  options: ValidateWorktreeExistsOptions = {},
): Promise<Result<WorktreeExistsSuccess, WorktreeNotFoundError>> {
  const { expectedPath, ...listOptions } = options;
  const worktreesResult = await listWorktrees(gitRoot, listOptions);

  if (isErr(worktreesResult)) {
    return err(new WorktreeNotFoundError(name));
  }

  const worktree = worktreesResult.value.worktrees.find(
    (wt) => wt.name === name && (!expectedPath || wt.path === expectedPath),
  );

  if (!worktree) {
    return err(new WorktreeNotFoundError(name));
  }

  return ok({ path: worktree.path });
}

export async function validateWorktreeDoesNotExist(
  gitRoot: string,
  _worktreeDirectory: string,
  name: string,
): Promise<Result<void, WorktreeAlreadyExistsError>> {
  const worktreesResult = await listWorktrees(gitRoot);

  if (isErr(worktreesResult)) {
    return err(new WorktreeAlreadyExistsError(name));
  }

  const worktree = worktreesResult.value.worktrees.find(
    (wt) => wt.name === name,
  );

  if (worktree) {
    return err(new WorktreeAlreadyExistsError(name));
  }

  return ok(undefined);
}

export async function validateWorktreeDirectoryExists(
  worktreeDirectory: string,
): Promise<boolean> {
  try {
    await fs.access(worktreeDirectory);
    return true;
  } catch {
    return false;
  }
}

export function validateWorktreeName(name: string): Result<void, Error> {
  if (!name || name.trim() === "") {
    return err(new Error("Phantom name cannot be empty"));
  }

  // Only allow alphanumeric, hyphen, underscore, dot, and slash
  const validNamePattern = /^[a-zA-Z0-9\-_./]+$/;
  if (!validNamePattern.test(name)) {
    return err(
      new Error(
        "Phantom name can only contain letters, numbers, hyphens, underscores, dots, and slashes",
      ),
    );
  }

  if (name.includes("..")) {
    return err(new Error("Phantom name cannot contain consecutive dots"));
  }

  return ok(undefined);
}
