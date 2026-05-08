import { executeGitCommand } from "../executor.ts";

export interface GetUpstreamBranchOptions {
  cwd: string;
}

export async function getUpstreamBranch(
  options: GetUpstreamBranchOptions,
): Promise<string | null> {
  try {
    const { stdout } = await executeGitCommand(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { cwd: options.cwd },
    );
    const upstream = stdout.trim();
    return upstream || null;
  } catch {
    return null;
  }
}
