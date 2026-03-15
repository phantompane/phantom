import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it, vi } from "vitest";

const getGitRootMock = vi.fn();
const createWorktreeCoreMock = vi.fn();
const isPullRequestMock = vi.fn();
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
}));

vi.doMock("@phantompane/core", () => ({
  createWorktree: createWorktreeCoreMock,
  WorktreeAlreadyExistsError: MockWorktreeAlreadyExistsError,
  createContext: createContextMock,
  getWorktreePathFromDirectory: getWorktreePathFromDirectoryMock,
  validateWorktreeExists: validateWorktreeExistsMock,
}));

vi.doMock("../api/index.ts", () => ({
  isPullRequest: isPullRequestMock,
}));

const { checkoutIssue } = await import("./issue.ts");

describe("checkoutIssue", () => {
  const resetMocks = () => {
    getGitRootMock.mockClear();
    createWorktreeCoreMock.mockClear();
    isPullRequestMock.mockClear();
    validateWorktreeExistsMock.mockClear();
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

    isPullRequestMock.mockImplementation(() => true);

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

    isPullRequestMock.mockImplementation(() => false);
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
    createWorktreeCoreMock.mockImplementation(async () => ({
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
    equal(isPullRequestMock.mock.calls[0][0], mockIssue);

    equal(getGitRootMock.mock.calls.length, 1);
    equal(createWorktreeCoreMock.mock.calls.length, 1);

    const [gitRoot, worktreeDirectory, worktreeName, options] =
      createWorktreeCoreMock.mock.calls[0];
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

    isPullRequestMock.mockImplementation(() => false);
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
    createWorktreeCoreMock.mockImplementation(async () => ({
      ok: true,
      value: {
        message: "Created worktree issues/789 from develop",
        path: "/path/to/repo/.git/phantom/worktrees/issues/789",
      },
    }));

    const result = await checkoutIssue(mockIssue, customBase);

    ok(result.value);
    equal(result.value.message, "Created worktree issues/789 from develop");

    const [, , , options] = createWorktreeCoreMock.mock.calls[0];
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

    isPullRequestMock.mockImplementation(() => false);
    getGitRootMock.mockImplementation(async () => mockGitRoot);
    createContextMock.mockImplementation(async () => ({
      gitRoot: mockGitRoot,
      worktreesDirectory: `${mockGitRoot}/.git/phantom/worktrees`,
    }));
    // Mock that worktree already exists
    validateWorktreeExistsMock.mockImplementation(async () => ({
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

    isPullRequestMock.mockImplementation(() => false);
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
    const expectedError = new Error("Permission denied");
    createWorktreeCoreMock.mockImplementation(async () => ({
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

    isPullRequestMock.mockImplementation(() => false);
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
    createWorktreeCoreMock.mockImplementation(async () => ({
      ok: true,
      value: {
        message: "Success",
      },
    }));

    await checkoutIssue(mockIssue);

    const [, worktreeDirectory, worktreeName, options] =
      createWorktreeCoreMock.mock.calls[0];
    equal(worktreeDirectory, "/path/to/repo/.git/phantom/worktrees");
    equal(worktreeName, "issues/333");
    equal(options.branch, "issues/333");
  });
});
