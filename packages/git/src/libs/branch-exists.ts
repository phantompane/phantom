import { err, ok, type Result } from "@phantompane/shared";
import { executeGitCommand } from "../executor.ts";

export async function branchExists(
  gitRoot: string,
  branchName: string,
): Promise<Result<boolean, Error>> {
  try {
    const result = await executeGitCommand(["branch", "--list", branchName], {
      cwd: gitRoot,
    });
    return ok(result.stdout.trim() !== "");
  } catch (error) {
    return err(
      new Error(
        `Failed to check branch existence: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
}
