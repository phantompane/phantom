import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";

const createGitHubClientMock = vi.fn();

interface MockCheckoutTargetOctokit {
  issues: {
    listForRepo: ReturnType<typeof vi.fn>;
  };
  pulls: {
    list: ReturnType<typeof vi.fn>;
  };
}

let mockOctokit: MockCheckoutTargetOctokit | undefined;

vi.doMock("../client.ts", () => ({
  createGitHubClient: createGitHubClientMock,
}));

const { listGitHubCheckoutTargets } = await import("./checkout-target.ts");

describe("listGitHubCheckoutTargets", () => {
  const resetMocks = () => {
    createGitHubClientMock.mockClear();
    mockOctokit = undefined;
  };

  it("maps open issues and pull requests to checkout targets", async () => {
    resetMocks();
    mockOctokit = {
      issues: {
        listForRepo: vi.fn(async () => ({
          data: [
            {
              number: 42,
              title: "Fix checkout",
              html_url: "https://github.com/owner/repo/pull/42",
              updated_at: "2026-05-04T00:00:00Z",
              user: { login: "alice" },
              pull_request: {},
            },
            {
              number: 7,
              title: "Support issue checkout",
              html_url: "https://github.com/owner/repo/issues/7",
              updated_at: "2026-05-03T00:00:00Z",
              user: null,
            },
          ],
        })),
      },
      pulls: {
        list: vi.fn(async () => ({
          data: [
            {
              number: 42,
              head: {
                ref: "fix/checkout",
                repo: { full_name: "owner/repo" },
              },
              base: {
                repo: { full_name: "owner/repo" },
              },
            },
          ],
        })),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit!);

    const targets = await listGitHubCheckoutTargets("owner", "repo", {
      limit: 10,
    });

    deepStrictEqual(mockOctokit!.issues.listForRepo.mock.calls[0]?.[0], {
      owner: "owner",
      repo: "repo",
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 10,
    });
    deepStrictEqual(mockOctokit!.pulls.list.mock.calls[0]?.[0], {
      owner: "owner",
      repo: "repo",
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 10,
    });
    deepStrictEqual(targets, [
      {
        author: "alice",
        baseRepoFullName: "owner/repo",
        headRef: "fix/checkout",
        headRepoFullName: "owner/repo",
        htmlUrl: "https://github.com/owner/repo/pull/42",
        kind: "pullRequest",
        number: 42,
        title: "Fix checkout",
        updatedAt: "2026-05-04T00:00:00Z",
      },
      {
        author: null,
        htmlUrl: "https://github.com/owner/repo/issues/7",
        kind: "issue",
        number: 7,
        title: "Support issue checkout",
        updatedAt: "2026-05-03T00:00:00Z",
      },
    ]);
  });

  it("uses a compact default limit", async () => {
    resetMocks();
    mockOctokit = {
      issues: {
        listForRepo: vi.fn(async () => ({
          data: [],
        })),
      },
      pulls: {
        list: vi.fn(async () => ({
          data: [],
        })),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit!);

    await listGitHubCheckoutTargets("owner", "repo");

    strictEqual(
      mockOctokit!.issues.listForRepo.mock.calls[0]?.[0].per_page,
      30,
    );
  });
});
