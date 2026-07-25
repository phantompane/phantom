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

  const commonDirectory = resolve(cwd, stdout);
  const { stdout: isBareRepository } = await executeGitCommand(
    ["rev-parse", "--is-bare-repository"],
    { cwd: commonDirectory },
  );
  if (isBareRepository === "true") {
    return commonDirectory;
  }

  const { stdout: toplevel } = await executeGitCommand(
    ["rev-parse", "--show-toplevel"],
    { cwd },
  );
  return toplevel;
}
