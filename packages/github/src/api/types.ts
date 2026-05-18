export interface GitHubPullRequest {
  number: number;
  isFromFork: boolean;
  head: {
    ref: string;
    repo: {
      full_name: string;
    };
  };
  base: {
    repo: {
      full_name: string;
    };
  };
}

export interface GitHubIssue {
  number: number;
  pullRequest?: GitHubPullRequest;
}

export interface GitHubCheckoutTarget {
  author: string | null;
  baseRepoFullName?: string;
  headRef?: string;
  headRepoFullName?: string;
  htmlUrl: string;
  isDraft?: boolean;
  isMerged?: boolean;
  kind: "issue" | "pullRequest";
  number: number;
  state?: "closed" | "open";
  title: string;
  updatedAt: string;
}

export function isPullRequest(
  issue: GitHubIssue,
): issue is GitHubIssue & { pullRequest: GitHubPullRequest } {
  return issue.pullRequest !== undefined;
}
