import { dirname, resolve } from "node:path";
import { executeGitCommand } from "../executor.ts";

export interface GetGitRootOptions {
  cwd?: string;
}

export async function getGitRoot(
  options: GetGitRootOptions = {},
): Promise<string> {
  const { cwd = process.cwd() } = options;
  const { stdout } = await executeGitCommand(
    ["rev-parse", "--git-common-dir"],
    {
      cwd,
    },
  );

  if (stdout.endsWith("/.git") || stdout === ".git") {
    return resolve(cwd, dirname(stdout));
  }

  const { stdout: toplevel } = await executeGitCommand(
    ["rev-parse", "--show-toplevel"],
    { cwd },
  );
  return toplevel;
}
