import { executeGitCommand } from "../executor.ts";

export interface RemoveWorktreeOptions {
  gitRoot: string;
  path: string;
  force?: boolean;
}

export async function removeWorktree(
  options: RemoveWorktreeOptions,
): Promise<void> {
  const { gitRoot, path, force = false } = options;

  const args = ["worktree", "remove"];
  if (force) {
    args.push("--force");
  }
  args.push(path);

  await executeGitCommand(args, { cwd: gitRoot });
}
