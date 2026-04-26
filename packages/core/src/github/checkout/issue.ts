import { getGitRoot } from "@phantompane/git";
import { type GitHubIssue, isPullRequest } from "@phantompane/github";
import { err, isErr, ok, type Result } from "@phantompane/utils";
import { createContext } from "../../context.ts";
import { createWorktree as createWorktreeCore } from "../../worktree/create.ts";
import { validateWorktreeExists } from "../../worktree/validate.ts";
import type { CheckoutResult } from "./pr.ts";

export async function checkoutIssue(
  issue: GitHubIssue,
  base?: string,
): Promise<Result<CheckoutResult>> {
  if (isPullRequest(issue)) {
    return err(
      new Error(
        `#${issue.number} is a pull request, not an issue. Cannot checkout as an issue.`,
      ),
    );
  }

  const gitRoot = await getGitRoot();
  const context = await createContext(gitRoot);
  const worktreeName = `issues/${issue.number}`;
  const branchName = `issues/${issue.number}`;

  // Check if worktree already exists before attempting to create
  const existsResult = await validateWorktreeExists(
    context.gitRoot,
    context.worktreesDirectory,
    worktreeName,
  );

  if (!isErr(existsResult)) {
    // Worktree already exists, return its path
    return ok({
      message: `Issue #${issue.number} is already checked out`,
      worktree: worktreeName,
      path: existsResult.value.path,
      alreadyExists: true,
    });
  }

  const result = await createWorktreeCore(
    context.gitRoot,
    context.worktreesDirectory,
    worktreeName,
    {
      branch: branchName,
      base,
    },
    context.config?.postCreate?.copyFiles,
    context.config?.postCreate?.commands,
    context.directoryNameSeparator,
  );

  if (isErr(result)) {
    return err(result.error);
  }

  return ok({
    message: result.value.message,
    worktree: worktreeName,
    path: result.value.path,
  });
}
