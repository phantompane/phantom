import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { isErr, isOk } from "@phantompane/utils";

const getGitHubRepoInfoMock = vi.fn();
const fetchIssueMock = vi.fn();
const isPullRequestMock = vi.fn();
const checkoutPullRequestMock = vi.fn();
const checkoutIssueMock = vi.fn();

vi.doMock("@phantompane/github", () => ({
  getGitHubRepoInfo: getGitHubRepoInfoMock,
  fetchIssue: fetchIssueMock,
  isPullRequest: isPullRequestMock,
}));

vi.doMock("./checkout/pr.ts", () => ({
  checkoutPullRequest: checkoutPullRequestMock,
}));

vi.doMock("./checkout/issue.ts", () => ({
  checkoutIssue: checkoutIssueMock,
}));

const { githubCheckout } = await import("./checkout.ts");

describe("githubCheckout", () => {
  const resetMocks = () => {
    getGitHubRepoInfoMock.mockClear();
    fetchIssueMock.mockClear();
    isPullRequestMock.mockClear();
    checkoutPullRequestMock.mockClear();
    checkoutIssueMock.mockClear();
  };

  it("should export githubCheckout function", () => {
    equal(typeof githubCheckout, "function");
  });

  it("should have correct function signature", () => {
    // Check function accepts 1 parameter
    equal(githubCheckout.length, 1);
  });

  it("should return error when issue/PR not found", async () => {
    resetMocks();
    getGitHubRepoInfoMock.mockImplementation(async () => ({
      owner: "test-owner",
      repo: "test-repo",
    }));
    fetchIssueMock.mockImplementation(async () => null);

    const result = await githubCheckout({ number: "123" });

    ok(isErr(result));
    if (isErr(result)) {
      equal(
        result.error.message,
        "GitHub issue or pull request #123 not found or you don't have permission to access it.",
      );
    }

    // Verify API calls
    equal(fetchIssueMock.mock.calls.length, 1);
    deepEqual(fetchIssueMock.mock.calls[0], ["test-owner", "test-repo", "123"]);
  });

  it("should checkout pull request successfully", async () => {
    resetMocks();
    const mockPR = {
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
    };
    const mockIssue = {
      number: 123,
      pullRequest: mockPR,
    };

    getGitHubRepoInfoMock.mockImplementation(async () => ({
      owner: "test-owner",
      repo: "test-repo",
    }));
    fetchIssueMock.mockImplementation(async () => mockIssue);
    isPullRequestMock.mockImplementation(() => true);
    checkoutPullRequestMock.mockImplementation(async () => ({
      ok: true,
      value: { message: "Checked out PR #123" },
    }));

    const result = await githubCheckout({ number: "123" });

    ok(isOk(result));
    if (isOk(result)) {
      equal(result.value.message, "Checked out PR #123");
    }

    // Verify calls
    equal(checkoutPullRequestMock.mock.calls.length, 1);
    equal(checkoutPullRequestMock.mock.calls[0][0], mockPR);
    equal(checkoutIssueMock.mock.calls.length, 0);
  });

  it("should error when using --base with pull request", async () => {
    resetMocks();
    const mockPR = {
      number: 456,
      isFromFork: false,
      head: {
        ref: "pr-branch",
        repo: {
          full_name: "owner/repo",
        },
      },
      base: {
        repo: {
          full_name: "owner/repo",
        },
      },
    };
    const mockIssue = {
      number: 456,
      pullRequest: mockPR,
    };

    getGitHubRepoInfoMock.mockImplementation(async () => ({
      owner: "test-owner",
      repo: "test-repo",
    }));
    fetchIssueMock.mockImplementation(async () => mockIssue);
    isPullRequestMock.mockImplementation(() => true);

    const result = await githubCheckout({ number: "456", base: "develop" });

    ok(isErr(result));
    if (isErr(result)) {
      equal(
        result.error.message,
        "The --base option cannot be used with pull requests. Pull request #456 already has a branch 'pr-branch'.",
      );
    }

    // Should not call checkout functions
    equal(checkoutPullRequestMock.mock.calls.length, 0);
    equal(checkoutIssueMock.mock.calls.length, 0);
  });

  it("should checkout issue successfully without base", async () => {
    resetMocks();
    const mockIssue = {
      number: 789,
    };

    getGitHubRepoInfoMock.mockImplementation(async () => ({
      owner: "test-owner",
      repo: "test-repo",
    }));
    fetchIssueMock.mockImplementation(async () => mockIssue);
    isPullRequestMock.mockImplementation(() => false);
    checkoutIssueMock.mockImplementation(async () => ({
      ok: true,
      value: { message: "Checked out issue #789" },
    }));

    const result = await githubCheckout({ number: "789" });

    ok(isOk(result));
    if (isOk(result)) {
      equal(result.value.message, "Checked out issue #789");
    }

    // Verify calls
    equal(checkoutIssueMock.mock.calls.length, 1);
    deepEqual(checkoutIssueMock.mock.calls[0], [mockIssue, undefined]);
    equal(checkoutPullRequestMock.mock.calls.length, 0);
  });

  it("should checkout issue with custom base branch", async () => {
    resetMocks();
    const mockIssue = {
      number: 999,
    };

    getGitHubRepoInfoMock.mockImplementation(async () => ({
      owner: "test-owner",
      repo: "test-repo",
    }));
    fetchIssueMock.mockImplementation(async () => mockIssue);
    isPullRequestMock.mockImplementation(() => false);
    checkoutIssueMock.mockImplementation(async () => ({
      ok: true,
      value: { message: "Checked out issue #999 from develop" },
    }));

    const result = await githubCheckout({ number: "999", base: "develop" });

    ok(isOk(result));
    if (isOk(result)) {
      equal(result.value.message, "Checked out issue #999 from develop");
    }

    // Verify calls
    equal(checkoutIssueMock.mock.calls.length, 1);
    deepEqual(checkoutIssueMock.mock.calls[0], [mockIssue, "develop"]);
  });

  it("should pass through errors from checkoutPullRequest", async () => {
    resetMocks();
    const mockPR = {
      number: 111,
      isFromFork: false,
      head: {
        ref: "error-branch",
        repo: {
          full_name: "owner/repo",
        },
      },
      base: {
        repo: {
          full_name: "owner/repo",
        },
      },
    };
    const mockIssue = {
      number: 111,
      pullRequest: mockPR,
    };
    const expectedError = new Error("Git error");

    getGitHubRepoInfoMock.mockImplementation(async () => ({
      owner: "test-owner",
      repo: "test-repo",
    }));
    fetchIssueMock.mockImplementation(async () => mockIssue);
    isPullRequestMock.mockImplementation(() => true);
    checkoutPullRequestMock.mockImplementation(async () => ({
      ok: false,
      error: expectedError,
    }));

    const result = await githubCheckout({ number: "111" });

    ok(isErr(result));
    if (isErr(result)) {
      equal(result.error, expectedError);
    }
  });

  it("should pass through errors from checkoutIssue", async () => {
    resetMocks();
    const mockIssue = {
      number: 222,
    };
    const expectedError = new Error("Permission denied");

    getGitHubRepoInfoMock.mockImplementation(async () => ({
      owner: "test-owner",
      repo: "test-repo",
    }));
    fetchIssueMock.mockImplementation(async () => mockIssue);
    isPullRequestMock.mockImplementation(() => false);
    checkoutIssueMock.mockImplementation(async () => ({
      ok: false,
      error: expectedError,
    }));

    const result = await githubCheckout({ number: "222" });

    ok(isErr(result));
    if (isErr(result)) {
      equal(result.error, expectedError);
    }
  });
});
