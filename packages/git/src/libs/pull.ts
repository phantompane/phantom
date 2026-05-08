import { err, ok, type Result } from "@phantompane/utils";
import { executeGitCommand } from "../executor.ts";

export interface PullOptions {
  cwd?: string;
  remote?: string;
  branch?: string;
}

export async function pull(options: PullOptions = {}): Promise<Result<void>> {
  const { cwd, remote, branch } = options;
  const args = ["pull"];

  if (remote) {
    args.push(remote);
  }
  if (branch) {
    args.push(branch);
  }

  try {
    await executeGitCommand(args, { cwd });
    return ok(undefined);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return err(new Error(`git pull failed: ${errorMessage}`));
  }
}
