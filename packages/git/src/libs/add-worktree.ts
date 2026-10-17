import { executeGitCommand } from "../executor.ts";

export interface AddWorktreeOptions {
  path: string;
  branch: string;
  base?: string;
  createBranch?: boolean;
  cwd?: string;
}

export async function addWorktree(options: AddWorktreeOptions): Promise<void> {
  const { path, branch, base = "HEAD", createBranch = true, cwd } = options;

  const args = ["worktree", "add", path];

  if (createBranch) {
    args.push("-b", branch, base);
  } else {
    args.push(branch);
  }

  if (cwd !== undefined) {
    await executeGitCommand(args, { cwd });
    return;
  }
  await executeGitCommand(args);
}
