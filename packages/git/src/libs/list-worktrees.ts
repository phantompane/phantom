import { executeGitCommand } from "../executor.ts";

export interface GitWorktree {
  path: string;
  branch: string;
  head: string;
  isLocked: boolean;
  isPrunable: boolean;
}

export async function listWorktrees(gitRoot: string): Promise<GitWorktree[]> {
  const { stdout } = await executeGitCommand(
    ["worktree", "list", "--porcelain"],
    { cwd: gitRoot },
  );

  const worktrees: GitWorktree[] = [];
  let currentWorktree: Partial<GitWorktree> = {};

  const lines = stdout.split("\n").filter((line) => line.length > 0);

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      if (currentWorktree.path) {
        worktrees.push(currentWorktree as GitWorktree);
      }
      currentWorktree = {
        path: line.substring("worktree ".length),
        isLocked: false,
        isPrunable: false,
      };
    } else if (line.startsWith("HEAD ")) {
      currentWorktree.head = line.substring("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const fullBranch = line.substring("branch ".length);
      currentWorktree.branch = fullBranch.startsWith("refs/heads/")
        ? fullBranch.substring("refs/heads/".length)
        : fullBranch;
    } else if (line === "detached") {
      currentWorktree.branch = "(detached HEAD)";
    } else if (line === "locked") {
      currentWorktree.isLocked = true;
    } else if (line === "prunable") {
      currentWorktree.isPrunable = true;
    }
  }

  if (currentWorktree.path) {
    worktrees.push(currentWorktree as GitWorktree);
  }

  return worktrees;
}
