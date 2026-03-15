import { equal, ok } from "node:assert/strict";
import { describe, it, vi } from "vitest";

const getGitRootMock = vi.fn();
const fetchMock = vi.fn();
const attachWorktreeCoreMock = vi.fn();
const setUpstreamBranchMock = vi.fn();
const createContextMock = vi.fn();
const getWorktreePathFromDirectoryMock = vi.fn();
const validateWorktreeExistsMock = vi.fn();

// Mock the WorktreeAlreadyExistsError class
class MockWorktreeAlreadyExistsError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorktreeAlreadyExistsError";
  }
}

vi.doMock("@phantompane/git", () => ({
  getGitRoot: getGitRootMock,
  fetch: fetchMock,
  setUpstreamBranch: setUpstreamBranchMock,
}));

vi.doMock("@phantompane/core", () => ({
  attachWorktreeCore: attachWorktreeCoreMock,
  WorktreeAlreadyExistsError: MockWorktreeAlreadyExistsError,
  createContext: createContextMock,
  getWorktreePathFromDirectory: getWorktreePathFromDirectoryMock,
  validateWorktreeExists: validateWorktreeExistsMock,
}));

const { checkoutPullRequest } = await import("./pr.ts");

describe("checkoutPullRequest", () => {
  const resetMocks = () => {
    getGitRootMock.mockClear();
    fetchMock.mockClear();
    attachWorktreeCoreMock.mockClear();
    setUpstreamBranchMock.mockClear();
    validateWorktreeExistsMock.mockClear();
  };

  it("should export checkoutPullRequest function", () => {
    equal(typeof checkoutPullRequest, "function");
  });

  it("should have correct function signature", () => {
    // Takes 1 parameter: pullRequest
    equal(checkoutPullRequest.length, 1);
  });

  it("should checkout pull request successfully", async () => {
    resetMocks();
    const mockGitRoot = "/path/to/repo";
    const mockPullRequest = {
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

    getGitRootMock.mockImplementation(async () => mockGitRoot);
    createContextMock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree doesn't exist
    validateWorktreeExistsMock.mockImplementation(async () => ({
      ok: false,
      error: new Error("Worktree not found"),
    }));
    fetchMock.mockImplementation(async () => ({
      ok: true,
      value: undefined,
    }));
    attachWorktreeCoreMock.mockImplementation(async () => ({
      ok: true,
      value: "/path/to/repo/.git/phantom/worktrees/feature-branch",
    }));
    setUpstreamBranchMock.mockImplementation(async () => ({
      ok: true,
      value: undefined,
    }));

    const result = await checkoutPullRequest(mockPullRequest);

    ok(result.value);
    equal(
      result.value.message,
      "Checked out PR #123 from branch feature-branch",
    );
    equal(result.value.alreadyExists, undefined);

    // Verify mocks were called correctly
    equal(getGitRootMock.mock.calls.length, 1);
    equal(fetchMock.mock.calls.length, 1);
    equal(attachWorktreeCoreMock.mock.calls.length, 1);
    equal(setUpstreamBranchMock.mock.calls.length, 1);

    // Verify fetch was called with correct refspec (same-repo PR)
    const fetchOptions = fetchMock.mock.calls[0][0];
    equal(fetchOptions.refspec, "feature-branch:feature-branch");

    // Verify upstream was set correctly for same-repo PR
    const upstreamArgs = setUpstreamBranchMock.mock.calls[0];
    equal(upstreamArgs[0], mockGitRoot);
    equal(upstreamArgs[1], "feature-branch");
    equal(upstreamArgs[2], "origin/feature-branch");

    // Verify attach was called with correct parameters
    const [gitRoot, worktreeDirectory, worktreeName] =
      attachWorktreeCoreMock.mock.calls[0];
    equal(gitRoot, mockGitRoot);
    equal(worktreeDirectory, "/path/to/repo/.git/phantom/worktrees");
    equal(worktreeName, "feature-branch");
  });

  it("should handle when worktree already exists", async () => {
    resetMocks();
    const mockGitRoot = "/path/to/repo";
    const mockPullRequest = {
      number: 456,
      isFromFork: false,
      head: {
        ref: "existing-branch",
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

    getGitRootMock.mockImplementation(async () => mockGitRoot);
    createContextMock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree already exists
    validateWorktreeExistsMock.mockImplementation(async () => ({
      ok: true,
      value: { path: `${mockGitRoot}/.git/phantom/worktrees/existing-branch` },
    }));

    const result = await checkoutPullRequest(mockPullRequest);

    ok(result.value);
    equal(result.value.message, "PR #456 is already checked out");
    equal(result.value.alreadyExists, true);
    equal(
      result.value.path,
      `${mockGitRoot}/.git/phantom/worktrees/existing-branch`,
    );

    // Verify that fetch was not called when worktree already exists
    equal(fetchMock.mock.calls.length, 0);
    // Verify that attachWorktreeCore was not called
    equal(attachWorktreeCoreMock.mock.calls.length, 0);
    // Verify that setUpstreamBranch was not called
    equal(setUpstreamBranchMock.mock.calls.length, 0);
  });

  it("should pass through other errors", async () => {
    resetMocks();
    const mockGitRoot = "/path/to/repo";
    const mockPullRequest = {
      number: 789,
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

    getGitRootMock.mockImplementation(async () => mockGitRoot);
    createContextMock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree doesn't exist
    validateWorktreeExistsMock.mockImplementation(async () => ({
      ok: false,
      error: new Error("Worktree not found"),
    }));
    fetchMock.mockImplementation(async () => ({
      ok: true,
      value: undefined,
    }));
    const expectedError = new Error("Some git error");
    attachWorktreeCoreMock.mockImplementation(async () => ({
      ok: false,
      error: expectedError,
    }));
    setUpstreamBranchMock.mockImplementation(async () => ({
      ok: true,
      value: undefined,
    }));

    const result = await checkoutPullRequest(mockPullRequest);

    ok(result.error);
    equal(result.error, expectedError);

    // Verify upstream function was called even when attach fails
    // (since fetch succeeded and upstream is set before attach)
    equal(setUpstreamBranchMock.mock.calls.length, 1);
  });

  it("should use correct worktree naming", async () => {
    resetMocks();
    const mockGitRoot = "/path/to/repo";
    const mockPullRequest = {
      number: 999,
      isFromFork: false,
      head: {
        ref: "test-branch",
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

    getGitRootMock.mockImplementation(async () => mockGitRoot);
    createContextMock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree doesn't exist
    validateWorktreeExistsMock.mockImplementation(async () => ({
      ok: false,
      error: new Error("Worktree not found"),
    }));
    fetchMock.mockImplementation(async () => ({
      ok: true,
      value: undefined,
    }));
    attachWorktreeCoreMock.mockImplementation(async () => ({
      ok: true,
      value: "/path/to/repo/.git/phantom/worktrees/test-branch",
    }));
    setUpstreamBranchMock.mockImplementation(async () => ({
      ok: true,
      value: undefined,
    }));

    await checkoutPullRequest(mockPullRequest);

    const [, worktreeDirectory, worktreeName] =
      attachWorktreeCoreMock.mock.calls[0];
    equal(worktreeDirectory, "/path/to/repo/.git/phantom/worktrees");
    equal(worktreeName, "test-branch");
  });

  it("should handle forked pull requests", async () => {
    resetMocks();
    const mockGitRoot = "/path/to/repo";
    const mockPullRequest = {
      number: 1234,
      isFromFork: true,
      head: {
        ref: "fork-feature",
        repo: {
          full_name: "contributor/fork-repo",
        },
      },
      base: {
        repo: {
          full_name: "owner/original-repo",
        },
      },
    };

    getGitRootMock.mockImplementation(async () => mockGitRoot);
    createContextMock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree doesn't exist
    validateWorktreeExistsMock.mockImplementation(async () => ({
      ok: false,
      error: new Error("Worktree not found"),
    }));
    fetchMock.mockImplementation(async () => ({
      ok: true,
      value: undefined,
    }));
    attachWorktreeCoreMock.mockImplementation(async () => ({
      ok: true,
      value: "/path/to/repo/.git/phantom/worktrees/contributor/fork-feature",
    }));
    setUpstreamBranchMock.mockImplementation(async () => ({
      ok: true,
      value: undefined,
    }));

    const result = await checkoutPullRequest(mockPullRequest);

    ok(result.value);
    equal(
      result.value.message,
      "Checked out PR #1234 from fork contributor/fork-repo",
    );

    // Verify it uses the same refspec for forked PRs
    const fetchOptions = fetchMock.mock.calls[0][0];
    equal(fetchOptions.refspec, "pull/1234/head:contributor/fork-feature");

    const [, worktreeDirectory, worktreeName] =
      attachWorktreeCoreMock.mock.calls[0];
    equal(worktreeDirectory, "/path/to/repo/.git/phantom/worktrees");
    equal(worktreeName, "contributor/fork-feature");

    // Verify upstream was set correctly for forked PR
    const upstreamArgs = setUpstreamBranchMock.mock.calls[0];
    equal(upstreamArgs[0], mockGitRoot);
    equal(upstreamArgs[1], "contributor/fork-feature");
    equal(upstreamArgs[2], "origin/pull/1234/head");
  });

  it("should handle fetch errors", async () => {
    resetMocks();
    const mockGitRoot = "/path/to/repo";
    const mockPullRequest = {
      number: 555,
      isFromFork: false,
      head: {
        ref: "missing-branch",
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

    getGitRootMock.mockImplementation(async () => mockGitRoot);
    createContextMock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree doesn't exist
    validateWorktreeExistsMock.mockImplementation(async () => ({
      ok: false,
      error: new Error("Worktree not found"),
    }));
    fetchMock.mockImplementation(async () => ({
      ok: false,
      error: new Error("Could not find remote ref"),
    }));
    setUpstreamBranchMock.mockImplementation(async () => ({
      ok: true,
      value: undefined,
    }));

    const result = await checkoutPullRequest(mockPullRequest);

    ok(result.error);
    ok(result.error.message.includes("Failed to fetch PR #555"));
    ok(result.error.message.includes("Could not find remote ref"));

    // Verify upstream function was not called when fetch fails
    equal(setUpstreamBranchMock.mock.calls.length, 0);
  });
});
