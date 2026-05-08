import { err, type Result } from "@phantompane/utils";
import {
  fetchIssue,
  getGitHubRepoInfo,
  isPullRequest,
  listGitHubCheckoutTargets as listGitHubCheckoutTargetsFromApi,
  type GitHubCheckoutTarget,
} from "@phantompane/github";
import { checkoutIssue } from "./checkout/issue.ts";
import { type CheckoutResult, checkoutPullRequest } from "./checkout/pr.ts";

export type { CheckoutResult } from "./checkout/pr.ts";
export type { GitHubCheckoutTarget } from "@phantompane/github";

export interface GitHubCheckoutOptions {
  number: string;
  base?: string;
  cwd?: string;
}

export interface ListGitHubCheckoutTargetsOptions {
  cwd?: string;
  limit?: number;
}

export async function githubCheckout(
  options: GitHubCheckoutOptions,
): Promise<Result<CheckoutResult>> {
  const { number, base, cwd } = options;
  const { owner, repo } = cwd
    ? await getGitHubRepoInfo({ cwd })
    : await getGitHubRepoInfo();

  // Always fetch from /issues/:number endpoint first
  const issue = await fetchIssue(owner, repo, number);

  if (!issue) {
    return err(
      new Error(
        `GitHub issue or pull request #${number} not found or you don't have permission to access it.`,
      ),
    );
  }

  // Check if it's a pull request
  if (isPullRequest(issue)) {
    if (base) {
      return err(
        new Error(
          `The --base option cannot be used with pull requests. Pull request #${number} already has a branch '${issue.pullRequest.head.ref}'.`,
        ),
      );
    }
    const result = cwd
      ? await checkoutPullRequest(issue.pullRequest, undefined, { cwd })
      : await checkoutPullRequest(issue.pullRequest);
    return result;
  }

  const result = cwd
    ? await checkoutIssue(issue, base, { cwd })
    : await checkoutIssue(issue, base);
  return result;
}

export async function listGitHubCheckoutTargets(
  options: ListGitHubCheckoutTargetsOptions = {},
): Promise<GitHubCheckoutTarget[]> {
  const { owner, repo } = options.cwd
    ? await getGitHubRepoInfo({ cwd: options.cwd })
    : await getGitHubRepoInfo();
  return listGitHubCheckoutTargetsFromApi(owner, repo, {
    limit: options.limit,
  });
}
