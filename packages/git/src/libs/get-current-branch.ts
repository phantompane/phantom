import { executeGitCommand } from "../executor.ts";

export interface GetCurrentBranchOptions {
  cwd?: string;
}

export async function getCurrentBranch(
  options: GetCurrentBranchOptions = {},
): Promise<string> {
  const { stdout } = await executeGitCommand(["branch", "--show-current"], {
    cwd: options.cwd,
  });
  return stdout;
}
