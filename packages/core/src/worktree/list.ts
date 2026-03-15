import { relative } from "node:path";
import {
  executeGitCommandInDirectory,
  listWorktrees as gitListWorktrees,
} from "@phantompane/git";
import { ok, type Result } from "@phantompane/shared";
import { getWorktreePathFromDirectory } from "../paths.ts";

export interface WorktreeInfo {
  name: string;
  path: string;
  pathToDisplay: string;
  branch: string;
  isClean: boolean;
}

export interface ListWorktreesSuccess {
  worktrees: WorktreeInfo[];
  message?: string;
}

export interface ListWorktreesOptions {
  excludeDefault?: boolean;
}

export async function getWorktreeBranch(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await executeGitCommandInDirectory(worktreePath, [
      "branch",
      "--show-current",
    ]);
    return stdout || "(detached HEAD)";
  } catch {
    return "unknown";
  }
}

export async function getWorktreeStatus(
  worktreePath: string,
): Promise<boolean> {
  try {
    const { stdout } = await executeGitCommandInDirectory(worktreePath, [
      "status",
      "--porcelain",
    ]);
    return !stdout; // Clean if no output
  } catch {
    // If git status fails, assume clean
    return true;
  }
}

export async function getWorktreeInfo(
  _gitRoot: string,
  worktreeDirectory: string,
  name: string,
): Promise<WorktreeInfo> {
  const worktreePath = getWorktreePathFromDirectory(worktreeDirectory, name);

  const [branch, isClean] = await Promise.all([
    getWorktreeBranch(worktreePath),
    getWorktreeStatus(worktreePath),
  ]);

  return {
    name,
    path: worktreePath,
    pathToDisplay: relative(process.cwd(), worktreePath) || ".",
    branch,
    isClean,
  };
}

export async function listWorktrees(
  gitRoot: string,
  options: ListWorktreesOptions = {},
): Promise<Result<ListWorktreesSuccess, never>> {
  try {
    const gitWorktrees = await gitListWorktrees(gitRoot);
    const excludeDefault = options.excludeDefault ?? false;
    const filteredWorktrees = excludeDefault
      ? gitWorktrees.filter((worktree) => worktree.path !== gitRoot)
      : gitWorktrees;

    if (filteredWorktrees.length === 0) {
      const message =
        excludeDefault && gitWorktrees.length > 0
          ? "No sub worktrees found"
          : "No worktrees found";
      return ok({
        worktrees: [],
        message,
      });
    }

    const worktrees = await Promise.all(
      filteredWorktrees.map(async (gitWorktree) => {
        const shortHead = gitWorktree.head?.slice(0, 7) ?? "HEAD";
        const branchName =
          gitWorktree.branch && gitWorktree.branch !== "(detached HEAD)"
            ? gitWorktree.branch
            : shortHead;
        const isClean = await getWorktreeStatus(gitWorktree.path);
        const pathToDisplay = relative(process.cwd(), gitWorktree.path) || ".";

        return {
          name: branchName,
          path: gitWorktree.path,
          pathToDisplay,
          branch: branchName,
          isClean,
        };
      }),
    );

    return ok({
      worktrees,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to list worktrees: ${errorMessage}`);
  }
}
