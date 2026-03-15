import { deepEqual, equal } from "node:assert/strict";
import { describe, it, vi } from "vitest";

const createGitHubClientMock = vi.fn();

interface MockPullRequestOctokit {
  pulls: {
    get: ReturnType<typeof vi.fn>;
  };
}

let mockOctokit: MockPullRequestOctokit | undefined;

vi.doMock("../client.ts", () => ({
  createGitHubClient: createGitHubClientMock,
}));

const { fetchPullRequest } = await import("./pull-request.ts");

describe("fetchPullRequest", () => {
  const resetMocks = () => {
    createGitHubClientMock.mockClear();
    mockOctokit = undefined;
  };

  it("should export fetchPullRequest function", () => {
    equal(typeof fetchPullRequest, "function");
  });

  it("should have correct function signature", () => {
    // Takes 3 parameters: owner, repo, number
    equal(fetchPullRequest.length, 3);
  });

  it("should fetch pull request successfully", async () => {
    resetMocks();
    mockOctokit = {
      pulls: {
        get: vi.fn(async () => ({
          data: {
            number: 123,
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
        })),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit!);

    const result = await fetchPullRequest("owner", "repo", "123");
    deepEqual(result, {
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
    });

    equal(mockOctokit!.pulls.get.mock.calls.length, 1);
    deepEqual(mockOctokit!.pulls.get.mock.calls[0]?.[0], {
      owner: "owner",
      repo: "repo",
      pull_number: 123,
    });
  });

  it("should return null when pull request not found", async () => {
    resetMocks();
    mockOctokit = {
      pulls: {
        get: vi.fn(async () => {
          const error = new Error("Not found") as Error & { status?: number };
          error.status = 404;
          throw error;
        }),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit!);

    const result = await fetchPullRequest("owner", "repo", "123");
    equal(result, null);
  });

  it("should throw error for non-404 errors", async () => {
    resetMocks();
    mockOctokit = {
      pulls: {
        get: vi.fn(async () => {
          throw new Error("API Error");
        }),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit!);

    try {
      await fetchPullRequest("owner", "repo", "123");
      throw new Error("Should have thrown");
    } catch (error) {
      equal(error instanceof Error, true);
      if (!(error instanceof Error)) {
        throw error;
      }
      equal(error.message, "API Error");
    }
  });

  it("should parse string number to integer", async () => {
    resetMocks();
    mockOctokit = {
      pulls: {
        get: vi.fn(async () => ({
          data: {
            number: 123,
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
        })),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit!);

    await fetchPullRequest("owner", "repo", "123");

    deepEqual(mockOctokit!.pulls.get.mock.calls[0]?.[0], {
      owner: "owner",
      repo: "repo",
      pull_number: 123, // Should be parsed to integer
    });
  });

  it("should detect forked pull requests", async () => {
    resetMocks();
    mockOctokit = {
      pulls: {
        get: vi.fn(async () => ({
          data: {
            number: 456,
            head: {
              ref: "feature-branch",
              repo: {
                full_name: "contributor/fork-repo",
              },
            },
            base: {
              repo: {
                full_name: "owner/original-repo",
              },
            },
          },
        })),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit!);

    const result = await fetchPullRequest("owner", "original-repo", "456");
    deepEqual(result, {
      number: 456,
      isFromFork: true,
      head: {
        ref: "feature-branch",
        repo: {
          full_name: "contributor/fork-repo",
        },
      },
      base: {
        repo: {
          full_name: "owner/original-repo",
        },
      },
    });
  });
});
