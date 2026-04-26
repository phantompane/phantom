import { executeGitCommand } from "../executor.ts";

export interface GetRemotesOptions {
  cwd?: string;
}

export async function getRemotes(
  options: GetRemotesOptions = {},
): Promise<string[]> {
  const { stdout } = await executeGitCommand(["remote"], {
    cwd: options.cwd,
  });

  return stdout
    .split("\n")
    .map((remote) => remote.trim())
    .filter((remote) => remote.length > 0);
}
