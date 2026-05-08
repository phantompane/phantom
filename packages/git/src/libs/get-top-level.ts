import { executeGitCommand } from "../executor.ts";

export interface GetTopLevelOptions {
  cwd?: string;
}

export async function getTopLevel(
  options: GetTopLevelOptions = {},
): Promise<string> {
  const { stdout } = await executeGitCommand(["rev-parse", "--show-toplevel"], {
    cwd: options.cwd,
  });

  return stdout;
}
