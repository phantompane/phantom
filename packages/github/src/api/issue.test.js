import { deepEqual, equal } from "node:assert/strict";
import { describe, it, vi } from "vitest";

const createGitHubClientMock = vi.fn();
const fetchPullRequestMock = vi.fn();
let mockOctokit;

vi.doMock("../client.ts", () => ({
  createGitHubClient: createGitHubClientMock,
}));

vi.doMock("./pull-request.ts", () => ({
  fetchPullRequest: fetchPullRequestMock,
}));

const { fetchIssue } = await import("./issue.ts");

describe("fetchIssue", () => {
  const resetMocks = () => {
    createGitHubClientMock.mockClear();
    fetchPullRequestMock.mockClear();
    mockOctokit = undefined;
  };

  it("should export fetchIssue function", () => {
    equal(typeof fetchIssue, "function");
  });

  it("should have correct function signature", () => {
    // Takes 3 parameters: owner, repo, number
    equal(fetchIssue.length, 3);
  });

  it("should fetch issue without pull request", async () => {
    resetMocks();
    mockOctokit = {
      issues: {
        get: vi.fn(async () => ({
          data: {
            number: 123,
            // No pull_request field
          },
        })),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit);

    const result = await fetchIssue("owner", "repo", "123");
    deepEqual(result, {
      number: 123,
      pullRequest: undefined,
    });

    equal(mockOctokit.issues.get.mock.calls.length, 1);
    deepEqual(mockOctokit.issues.get.mock.calls[0][0], {
      owner: "owner",
      repo: "repo",
      issue_number: 123,
    });
  });

  it("should fetch issue with pull request", async () => {
    resetMocks();
    mockOctokit = {
      issues: {
        get: vi.fn(async () => ({
          data: {
            number: 123,
            pull_request: {
              url: "https://api.github.com/repos/owner/repo/pulls/123",
            },
          },
        })),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit);
    fetchPullRequestMock.mockImplementation(async () => ({
      number: 123,
      isFromFork: false,
      head: {
        ref: "feature-branch",
        repo: {
          full_name: "owner/repo",
        },
      },
      base: {
        repo: {
          full_name: "owner/repo",
        },
      },
    }));

    const result = await fetchIssue("owner", "repo", "123");
    deepEqual(result, {
      number: 123,
      pullRequest: {
        number: 123,
        isFromFork: false,
        head: {
          ref: "feature-branch",
          repo: {
            full_name: "owner/repo",
          },
        },
        base: {
          repo: {
            full_name: "owner/repo",
          },
        },
      },
    });

    equal(fetchPullRequestMock.mock.calls.length, 1);
    deepEqual(fetchPullRequestMock.mock.calls[0], ["owner", "repo", "123"]);
  });

  it("should return null when issue not found", async () => {
    resetMocks();
    mockOctokit = {
      issues: {
        get: vi.fn(async () => {
          const error = new Error("Not found");
          error.status = 404;
          throw error;
        }),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit);

    const result = await fetchIssue("owner", "repo", "123");
    equal(result, null);
  });

  it("should throw error for non-404 errors", async () => {
    resetMocks();
    mockOctokit = {
      issues: {
        get: vi.fn(async () => {
          throw new Error("API Error");
        }),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit);

    try {
      await fetchIssue("owner", "repo", "123");
      throw new Error("Should have thrown");
    } catch (error) {
      equal(error.message, "API Error");
    }
  });

  it("should handle pull request fetch returning null", async () => {
    resetMocks();
    mockOctokit = {
      issues: {
        get: vi.fn(async () => ({
          data: {
            number: 123,
            pull_request: {
              url: "https://api.github.com/repos/owner/repo/pulls/123",
            },
          },
        })),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit);
    fetchPullRequestMock.mockImplementation(async () => null);

    const result = await fetchIssue("owner", "repo", "123");
    deepEqual(result, {
      number: 123,
      pullRequest: undefined,
    });
  });
});
