import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it, mock } from "node:test";

const getGitRootMock = mock.fn();
const createWorktreeCoreMock = mock.fn();
const isPullRequestMock = mock.fn();
const createContextMock = mock.fn();
const getWorktreePathFromDirectoryMock = mock.fn();
const validateWorktreeExistsMock = mock.fn();

// Mock the WorktreeAlreadyExistsError class
class MockWorktreeAlreadyExistsError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorktreeAlreadyExistsError";
  }
}

mock.module("@phantompane/git", {
  namedExports: {
    getGitRoot: getGitRootMock,
  },
});

mock.module("@phantompane/core", {
  namedExports: {
    createWorktree: createWorktreeCoreMock,
    WorktreeAlreadyExistsError: MockWorktreeAlreadyExistsError,
    createContext: createContextMock,
    getWorktreePathFromDirectory: getWorktreePathFromDirectoryMock,
    validateWorktreeExists: validateWorktreeExistsMock,
  },
});

mock.module("../api/index.ts", {
  namedExports: {
    isPullRequest: isPullRequestMock,
  },
});

const { checkoutIssue } = await import("./issue.ts");

describe("checkoutIssue", () => {
  const resetMocks = () => {
    getGitRootMock.mock.resetCalls();
    createWorktreeCoreMock.mock.resetCalls();
    isPullRequestMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
  };

  it("should export checkoutIssue function", () => {
    equal(typeof checkoutIssue, "function");
  });

  it("should have correct function signature", () => {
    // Takes 2 parameters: issue, base (optional)
    equal(checkoutIssue.length, 2);
  });

  it("should reject pull requests", async () => {
    resetMocks();
    const mockIssue = {
      number: 123,
      pullRequest: {
        number: 123,
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
      },
    };

    isPullRequestMock.mock.mockImplementation(() => true);

    const result = await checkoutIssue(mockIssue);

    ok(result.error);
    equal(
      result.error.message,
      "#123 is a pull request, not an issue. Cannot checkout as an issue.",
    );

    // Should not call other functions
    equal(getGitRootMock.mock.calls.length, 0);
    equal(createWorktreeCoreMock.mock.calls.length, 0);
  });

  it("should checkout issue successfully without base", async () => {
    resetMocks();
    const mockGitRoot = "/path/to/repo";
    const mockIssue = {
      number: 456,
    };

    isPullRequestMock.mock.mockImplementation(() => false);
    getGitRootMock.mock.mockImplementation(async () => mockGitRoot);
    createContextMock.mock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree doesn't exist
    validateWorktreeExistsMock.mock.mockImplementation(async () => ({
      ok: false,
      error: new Error("Worktree not found"),
    }));
    createWorktreeCoreMock.mock.mockImplementation(async () => ({
      ok: true,
      value: {
        message:
          "Created worktree issues/456 and checked out branch issues/456",
        path: "/path/to/repo/.git/phantom/worktrees/issues/456",
      },
    }));

    const result = await checkoutIssue(mockIssue);

    ok(result.value);
    equal(
      result.value.message,
      "Created worktree issues/456 and checked out branch issues/456",
    );
    equal(result.value.alreadyExists, undefined);

    // Verify mocks were called correctly
    equal(isPullRequestMock.mock.calls.length, 1);
    equal(isPullRequestMock.mock.calls[0].arguments[0], mockIssue);

    equal(getGitRootMock.mock.calls.length, 1);
    equal(createWorktreeCoreMock.mock.calls.length, 1);

    const [gitRoot, worktreeDirectory, worktreeName, options] =
      createWorktreeCoreMock.mock.calls[0].arguments;
    equal(gitRoot, mockGitRoot);
    equal(worktreeDirectory, "/path/to/repo/.git/phantom/worktrees");
    equal(worktreeName, "issues/456");
    deepEqual(options, {
      branch: "issues/456",
      base: undefined,
    });
  });

  it("should checkout issue with custom base branch", async () => {
    resetMocks();
    const mockGitRoot = "/path/to/repo";
    const mockIssue = {
      number: 789,
    };
    const customBase = "develop";

    isPullRequestMock.mock.mockImplementation(() => false);
    getGitRootMock.mock.mockImplementation(async () => mockGitRoot);
    createContextMock.mock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree doesn't exist
    validateWorktreeExistsMock.mock.mockImplementation(async () => ({
      ok: false,
      error: new Error("Worktree not found"),
    }));
    createWorktreeCoreMock.mock.mockImplementation(async () => ({
      ok: true,
      value: {
        message: "Created worktree issues/789 from develop",
        path: "/path/to/repo/.git/phantom/worktrees/issues/789",
      },
    }));

    const result = await checkoutIssue(mockIssue, customBase);

    ok(result.value);
    equal(result.value.message, "Created worktree issues/789 from develop");

    const [, , , options] = createWorktreeCoreMock.mock.calls[0].arguments;
    deepEqual(options, {
      branch: "issues/789",
      base: "develop",
    });
  });

  it("should handle when worktree already exists", async () => {
    resetMocks();
    const mockGitRoot = "/path/to/repo";
    const mockIssue = {
      number: 111,
    };

    isPullRequestMock.mock.mockImplementation(() => false);
    getGitRootMock.mock.mockImplementation(async () => mockGitRoot);
    createContextMock.mock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree already exists
    validateWorktreeExistsMock.mock.mockImplementation(async () => ({
      ok: true,
      value: { path: `${mockGitRoot}/.git/phantom/worktrees/issues/111` },
    }));

    const result = await checkoutIssue(mockIssue);

    ok(result.value);
    equal(result.value.message, "Issue #111 is already checked out");
    equal(result.value.alreadyExists, true);
    equal(
      result.value.path,
      `${mockGitRoot}/.git/phantom/worktrees/issues/111`,
    );

    // Verify that createWorktreeCore was not called
    equal(createWorktreeCoreMock.mock.calls.length, 0);
  });

  it("should pass through other errors", async () => {
    resetMocks();
    const mockGitRoot = "/path/to/repo";
    const mockIssue = {
      number: 222,
    };

    isPullRequestMock.mock.mockImplementation(() => false);
    getGitRootMock.mock.mockImplementation(async () => mockGitRoot);
    createContextMock.mock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree doesn't exist
    validateWorktreeExistsMock.mock.mockImplementation(async () => ({
      ok: false,
      error: new Error("Worktree not found"),
    }));
    const expectedError = new Error("Permission denied");
    createWorktreeCoreMock.mock.mockImplementation(async () => ({
      ok: false,
      error: expectedError,
    }));

    const result = await checkoutIssue(mockIssue);

    ok(result.error);
    equal(result.error, expectedError);
  });

  it("should use correct worktree and branch naming", async () => {
    resetMocks();
    const mockGitRoot = "/path/to/repo";
    const mockIssue = {
      number: 333,
    };

    isPullRequestMock.mock.mockImplementation(() => false);
    getGitRootMock.mock.mockImplementation(async () => mockGitRoot);
    createContextMock.mock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree doesn't exist
    validateWorktreeExistsMock.mock.mockImplementation(async () => ({
      ok: false,
      error: new Error("Worktree not found"),
    }));
    createWorktreeCoreMock.mock.mockImplementation(async () => ({
      ok: true,
      value: {
        message: "Success",
      },
    }));

    await checkoutIssue(mockIssue);

    const [, worktreeDirectory, worktreeName, options] =
      createWorktreeCoreMock.mock.calls[0].arguments;
    equal(worktreeDirectory, "/path/to/repo/.git/phantom/worktrees");
    equal(worktreeName, "issues/333");
    equal(options.branch, "issues/333");
  });
});
