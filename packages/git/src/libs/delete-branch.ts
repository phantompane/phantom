import { executeGitCommand } from "../executor.ts";

export interface DeleteBranchOptions {
  gitRoot: string;
  branch: string;
  force?: boolean;
}

export async function deleteBranch(
  options: DeleteBranchOptions,
): Promise<void> {
  const { gitRoot, branch, force = true } = options;

  const args = ["branch", force ? "-D" : "-d", branch];
  await executeGitCommand(args, { cwd: gitRoot });
}
