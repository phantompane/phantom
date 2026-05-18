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
              draft: true,
              html_url: "https://github.com/owner/repo/pull/42",
              merged_at: null,
              state: "open",
              title: "Fix checkout",
              updated_at: "2026-05-04T00:00:00Z",
              user: { login: "alice" },
            },
            {
              number: 11,
              head: {
                ref: "feat/done",
                repo: { full_name: "owner/repo" },
              },
              base: {
                repo: { full_name: "owner/repo" },
              },
              draft: false,
              html_url: "https://github.com/owner/repo/pull/11",
              merged_at: "2026-05-05T00:00:00Z",
              state: "closed",
              title: "Ship done work",
              updated_at: "2026-05-05T00:00:00Z",
              user: { login: "bob" },
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
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: 10,
    });
    deepStrictEqual(targets, [
      {
        author: "bob",
        baseRepoFullName: "owner/repo",
        headRef: "feat/done",
        headRepoFullName: "owner/repo",
        htmlUrl: "https://github.com/owner/repo/pull/11",
        isDraft: false,
        isMerged: true,
        kind: "pullRequest",
        number: 11,
        state: "closed",
        title: "Ship done work",
        updatedAt: "2026-05-05T00:00:00Z",
      },
      {
        author: "alice",
        baseRepoFullName: "owner/repo",
        headRef: "fix/checkout",
        headRepoFullName: "owner/repo",
        htmlUrl: "https://github.com/owner/repo/pull/42",
        isDraft: true,
        isMerged: false,
        kind: "pullRequest",
        number: 42,
        state: "open",
        title: "Fix checkout",
        updatedAt: "2026-05-04T00:00:00Z",
      },
      {
        author: null,
        htmlUrl: "https://github.com/owner/repo/issues/7",
        kind: "issue",
        number: 7,
        state: "open",
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

  it("keeps checkout targets when pull request metadata is unavailable", async () => {
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
        list: vi.fn(async () => {
          throw new Error("pull request metadata unavailable");
        }),
      },
    };
    createGitHubClientMock.mockImplementation(async () => mockOctokit!);

    const targets = await listGitHubCheckoutTargets("owner", "repo");

    deepStrictEqual(targets, [
      {
        author: "alice",
        htmlUrl: "https://github.com/owner/repo/pull/42",
        kind: "pullRequest",
        number: 42,
        state: "open",
        title: "Fix checkout",
        updatedAt: "2026-05-04T00:00:00Z",
      },
      {
        author: null,
        htmlUrl: "https://github.com/owner/repo/issues/7",
        kind: "issue",
        number: 7,
        state: "open",
        title: "Support issue checkout",
        updatedAt: "2026-05-03T00:00:00Z",
      },
    ]);
  });
});
