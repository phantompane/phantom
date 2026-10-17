import { branchExists } from "@phantompane/git";
import { err, ok, type Result } from "@phantompane/utils";
import { getWorktreePathFromDirectory } from "../paths.ts";
import { humanName } from "./human-name.ts";
import {
  validateWorktreeDirectoryExists,
  validateWorktreeName,
} from "./validate.ts";

const MAX_RETRIES = 10;

function generate(): string {
  return humanName();
}

export async function generateUniqueName(
  gitRoot: string,
  worktreesDirectory: string,
  directoryNameSeparator: string,
): Promise<Result<string, Error>> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const name = generate();

    if (!validateWorktreeName(name).ok) {
      continue;
    }

    const worktreePath = getWorktreePathFromDirectory(
      worktreesDirectory,
      name,
      directoryNameSeparator,
    );
    if (await validateWorktreeDirectoryExists(worktreePath)) {
      continue;
    }

    const result = await branchExists(gitRoot, name);
    if (!result.ok) {
      return err(result.error);
    }
    if (result.value) {
      continue;
    }

    return ok(name);
  }

  return err(
    new Error(
      "Failed to generate a unique worktree name after maximum retries",
    ),
  );
}
