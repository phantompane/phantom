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
  const [
    { data: issues },
    { data: openPullRequests },
    { data: allPullRequests },
  ] = await Promise.all([
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
    github.pulls
      .list({
        owner,
        repo,
        state: "all",
        sort: "updated",
        direction: "desc",
        per_page: perPage,
      })
      .catch(() => ({ data: [] })),
  ]);
  const pullRequestByNumber = new Map(
    openPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
  );

  const issueTargets = issues.map((item) => {
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
            isDraft: pullRequest.draft,
            isMerged: Boolean(pullRequest.merged_at),
          }
        : {}),
      htmlUrl: item.html_url,
      kind: item.pull_request ? "pullRequest" : "issue",
      number: item.number,
      state: item.state === "closed" ? "closed" : "open",
      title: item.title,
      updatedAt: item.updated_at,
    } satisfies GitHubCheckoutTarget;
  });

  const issueNumbers = new Set(issues.map((issue) => issue.number));
  const closedPullRequestTargets = allPullRequests
    .filter((pullRequest) => !issueNumbers.has(pullRequest.number))
    .map(
      (pullRequest) =>
        ({
          author: pullRequest.user?.login ?? null,
          baseRepoFullName: pullRequest.base.repo.full_name,
          headRef: pullRequest.head.ref,
          headRepoFullName: pullRequest.head.repo?.full_name,
          htmlUrl: pullRequest.html_url,
          isDraft: pullRequest.draft,
          isMerged: Boolean(pullRequest.merged_at),
          kind: "pullRequest",
          number: pullRequest.number,
          state: pullRequest.state === "closed" ? "closed" : "open",
          title: pullRequest.title,
          updatedAt: pullRequest.updated_at,
        }) satisfies GitHubCheckoutTarget,
    );

  return [...issueTargets, ...closedPullRequestTargets].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}
