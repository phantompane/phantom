import { createGitHubClient } from "../client.ts";
import type { GitHubCheckoutTarget } from "./types.ts";

export interface ListGitHubCheckoutTargetsOptions {
  limit?: number;
}

export async function listGitHubCheckoutTargets(
  owner: string,
  repo: string,
  options: ListGitHubCheckoutTargetsOptions = {},
): Promise<GitHubCheckoutTarget[]> {
  const github = await createGitHubClient();
  const perPage = options.limit ?? 30;
  const [{ data: issues }, { data: pullRequests }] = await Promise.all([
    github.issues.listForRepo({
      owner,
      repo,
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: perPage,
    }),
    github.pulls
      .list({
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: perPage,
      })
      .catch(() => ({ data: [] })),
  ]);
  const pullRequestByNumber = new Map(
    pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
  );

  return issues.map((item) => {
    const pullRequest = item.pull_request
      ? pullRequestByNumber.get(item.number)
      : undefined;

    return {
      author: item.user?.login ?? null,
      ...(pullRequest
        ? {
            baseRepoFullName: pullRequest.base.repo.full_name,
            headRef: pullRequest.head.ref,
            headRepoFullName: pullRequest.head.repo?.full_name,
          }
        : {}),
      htmlUrl: item.html_url,
      kind: item.pull_request ? "pullRequest" : "issue",
      number: item.number,
      title: item.title,
      updatedAt: item.updated_at,
    };
  });
}
