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
  const { data } = await github.issues.listForRepo({
    owner,
    repo,
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: options.limit ?? 30,
  });

  return data.map((item) => ({
    author: item.user?.login ?? null,
    htmlUrl: item.html_url,
    kind: item.pull_request ? "pullRequest" : "issue",
    number: item.number,
    title: item.title,
    updatedAt: item.updated_at,
  }));
}
