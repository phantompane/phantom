import { err, ok, type Result } from "@phantompane/utils";
import { executeGitCommand } from "../executor.ts";

export async function setUpstreamBranch(
  gitRoot: string,
  branch: string,
  upstream: string,
): Promise<Result<void, Error>> {
  try {
    await executeGitCommand(["branch", "--set-upstream-to", upstream, branch], {
      cwd: gitRoot,
    });
    return ok(undefined);
  } catch (error) {
    return err(
      error instanceof Error
        ? error
        : new Error(`Failed to set upstream branch: ${String(error)}`),
    );
  }
}
