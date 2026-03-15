import {
  executeGitCommand,
  executeGitCommandInDirectory,
} from "@phantompane/git";
import { err, isErr, isOk, ok, type Result } from "@phantompane/shared";
import { WorktreeError, type WorktreeNotFoundError } from "./errors.ts";
import { executePreDeleteCommands } from "./pre-delete.ts";
import { validateWorktreeExists } from "./validate.ts";

export interface DeleteWorktreeOptions {
  force?: boolean;
}

export interface DeleteWorktreeSuccess {
  message: string;
  hasUncommittedChanges?: boolean;
  changedFiles?: number;
}

export interface WorktreeStatus {
  hasUncommittedChanges: boolean;
  changedFiles: number;
}

export async function getWorktreeChangesStatus(
  worktreePath: string,
): Promise<WorktreeStatus> {
  try {
    const { stdout } = await executeGitCommandInDirectory(worktreePath, [
      "status",
      "--porcelain",
    ]);
    if (stdout) {
      return {
        hasUncommittedChanges: true,
        changedFiles: stdout.split("\n").length,
      };
    }
  } catch {
    // If git status fails, assume no changes
  }
  return {
    hasUncommittedChanges: false,
    changedFiles: 0,
  };
}

export async function removeWorktree(
  gitRoot: string,
  worktreePath: string,
  force = false,
): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) {
    args.push("--force");
  }
  args.push(worktreePath);

  await executeGitCommand(args, {
    cwd: gitRoot,
  });
}

export async function deleteBranch(
  gitRoot: string,
  branchName: string,
): Promise<Result<boolean, WorktreeError>> {
  try {
    await executeGitCommand(["branch", "-D", branchName], { cwd: gitRoot });
    return ok(true);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return err(new WorktreeError(`branch delete failed: ${errorMessage}`));
  }
}

export async function deleteWorktree(
  gitRoot: string,
  worktreeDirectory: string,
  name: string,
  options: DeleteWorktreeOptions,
  preDeleteCommands: string[] | undefined,
): Promise<
  Result<DeleteWorktreeSuccess, WorktreeNotFoundError | WorktreeError>
> {
  const { force = false } = options || {};

  const validation = await validateWorktreeExists(
    gitRoot,
    worktreeDirectory,
    name,
    { excludeDefault: true },
  );
  if (isErr(validation)) {
    return err(validation.error);
  }

  const worktreePath = validation.value.path;

  const status = await getWorktreeChangesStatus(worktreePath);

  if (status.hasUncommittedChanges && !force) {
    return err(
      new WorktreeError(
        `Worktree '${name}' has uncommitted changes (${status.changedFiles} files). Use --force to delete anyway.`,
      ),
    );
  }

  // Execute pre-delete commands if provided
  if (preDeleteCommands && preDeleteCommands.length > 0) {
    console.log("\nRunning pre-delete commands...");
    const preDeleteResult = await executePreDeleteCommands({
      gitRoot,
      worktreesDirectory: worktreeDirectory,
      worktreeName: name,
      commands: preDeleteCommands,
    });

    if (isErr(preDeleteResult)) {
      return err(new WorktreeError(preDeleteResult.error.message));
    }
  }

  try {
    await removeWorktree(gitRoot, worktreePath, force);

    const branchName = name;
    const branchResult = await deleteBranch(gitRoot, branchName);

    let message: string;
    if (isOk(branchResult)) {
      message = `Deleted worktree '${name}' and its branch '${branchName}'`;
    } else {
      message = `Deleted worktree '${name}'`;
      message += `\nNote: Branch '${branchName}' could not be deleted: ${branchResult.error.message}`;
    }

    if (status.hasUncommittedChanges) {
      message = `Warning: Worktree '${name}' had uncommitted changes (${status.changedFiles} files)\n${message}`;
    }

    return ok({
      message,
      hasUncommittedChanges: status.hasUncommittedChanges,
      changedFiles: status.hasUncommittedChanges
        ? status.changedFiles
        : undefined,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return err(new WorktreeError(`worktree remove failed: ${errorMessage}`));
  }
}
