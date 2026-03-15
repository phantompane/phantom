import { branchExists } from "@phantompane/git";
import { err, isErr, ok, type Result } from "@phantompane/shared";
import { humanId } from "human-id";
import { getWorktreePathFromDirectory } from "../paths.ts";
import {
  validateWorktreeDirectoryExists,
  validateWorktreeName,
} from "./validate.ts";

const MAX_RETRIES = 10;

function generate(): string {
  return humanId({ separator: "-", capitalize: false });
}

export async function generateUniqueName(
  gitRoot: string,
  worktreesDirectory: string,
  directoryNameSeparator: string,
): Promise<Result<string, Error>> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const name = generate();

    if (isErr(validateWorktreeName(name))) {
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
    if (isErr(result)) {
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
