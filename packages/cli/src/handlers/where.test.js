import { rejects, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import { WorktreeNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitMock = mock.fn();
const consoleLogMock = mock.fn();
const consoleErrorMock = mock.fn();
const getGitRootMock = mock.fn();
const whereWorktreeMock = mock.fn();
const selectWorktreeWithFzfMock = mock.fn();
const exitWithErrorMock = mock.fn((message, code) => {
  consoleErrorMock(`Error: ${message}`);
  exitMock(code);
  throw new Error(`Exit with code ${code}: ${message}`);
});
const exitWithSuccessMock = mock.fn(() => {
  exitMock(0);
  throw new Error("Exit with code 0: success");
});

mock.module("node:process", {
  namedExports: {
    exit: exitMock,
  },
});

mock.module("@phantompane/git", {
  namedExports: {
    getGitRoot: getGitRootMock,
  },
});

mock.module("@phantompane/core", {
  namedExports: {
    whereWorktree: whereWorktreeMock,
    selectWorktreeWithFzf: selectWorktreeWithFzfMock,
    WorktreeNotFoundError,
    createContext: mock.fn((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
      }),
    ),
    loadConfig: mock.fn(() =>
      Promise.resolve({ ok: false, error: new Error("Config not found") }),
    ),
    getWorktreesDirectory: mock.fn((gitRoot, worktreesDirectory) => {
      return worktreesDirectory || `${gitRoot}/.git/phantom/worktrees`;
    }),
  },
});

mock.module("../output.ts", {
  namedExports: {
    output: {
      log: consoleLogMock,
      error: consoleErrorMock,
    },
  },
});

mock.module("../errors.ts", {
  namedExports: {
    exitWithError: exitWithErrorMock,
    exitWithSuccess: exitWithSuccessMock,
    exitCodes: {
      success: 0,
      generalError: 1,
      notFound: 2,
      validationError: 3,
    },
  },
});

const { whereHandler } = await import("./where.ts");

describe("whereHandler", () => {
  it("should error when no worktree name and no --fzf flag provided", async () => {
    exitMock.mock.resetCalls();
    consoleErrorMock.mock.resetCalls();

    await rejects(
      async () => await whereHandler([]),
      /Exit with code 3: Usage: phantom where <worktree-name> or phantom where --fzf/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "Error: Usage: phantom where <worktree-name> or phantom where --fzf",
    );
    strictEqual(exitMock.mock.calls[0].arguments[0], 3); // validationError
  });

  it("should error when both worktree name and --fzf flag are provided", async () => {
    exitMock.mock.resetCalls();
    consoleErrorMock.mock.resetCalls();

    await rejects(
      async () => await whereHandler(["feature", "--fzf"]),
      /Exit with code 3: Cannot specify both a worktree name and --fzf option/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "Error: Cannot specify both a worktree name and --fzf option",
    );
    strictEqual(exitMock.mock.calls[0].arguments[0], 3); // validationError
  });

  it("should output path for specified worktree", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    whereWorktreeMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    whereWorktreeMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    exitMock.mock.mockImplementation((code) => {
      throw new Error(`Process exit with code ${code}`);
    });

    await rejects(
      async () => await whereHandler(["feature"]),
      /Process exit with code 0/,
    );

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(whereWorktreeMock.mock.calls.length, 1);
    strictEqual(whereWorktreeMock.mock.calls[0].arguments[0], "/repo");
    strictEqual(
      whereWorktreeMock.mock.calls[0].arguments[1],
      "/repo/.git/phantom/worktrees",
    );
    strictEqual(whereWorktreeMock.mock.calls[0].arguments[2], "feature");
    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "/repo/.git/phantom/worktrees/feature",
    );
  });

  it("should output path with fzf selection", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    selectWorktreeWithFzfMock.mock.resetCalls();
    whereWorktreeMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    selectWorktreeWithFzfMock.mock.mockImplementation(() =>
      ok({
        name: "feature-fzf",
        branch: "feature-fzf",
        isClean: true,
      }),
    );
    whereWorktreeMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature-fzf" }),
    );
    exitMock.mock.mockImplementation((code) => {
      throw new Error(`Process exit with code ${code}`);
    });

    await rejects(
      async () => await whereHandler(["--fzf"]),
      /Process exit with code 0/,
    );

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls[0].arguments[0], "/repo");
    strictEqual(whereWorktreeMock.mock.calls.length, 1);
    strictEqual(whereWorktreeMock.mock.calls[0].arguments[0], "/repo");
    strictEqual(
      whereWorktreeMock.mock.calls[0].arguments[1],
      "/repo/.git/phantom/worktrees",
    );
    strictEqual(whereWorktreeMock.mock.calls[0].arguments[2], "feature-fzf");
    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "/repo/.git/phantom/worktrees/feature-fzf",
    );
  });

  it("should exit gracefully when fzf selection is cancelled", async () => {
    exitMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    selectWorktreeWithFzfMock.mock.resetCalls();
    exitWithSuccessMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    selectWorktreeWithFzfMock.mock.mockImplementation(() => ok(null));

    await rejects(
      async () => await whereHandler(["--fzf"]),
      /Process exit with code 0/,
    );

    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(exitWithSuccessMock.mock.calls.length, 1);
  });

  it("should handle fzf selection error", async () => {
    exitMock.mock.resetCalls();
    consoleErrorMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    selectWorktreeWithFzfMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    selectWorktreeWithFzfMock.mock.mockImplementation(() =>
      err(new Error("fzf not found")),
    );

    await rejects(
      async () => await whereHandler(["--fzf"]),
      /Process exit with code 1/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "Error: fzf not found",
    );
    strictEqual(exitMock.mock.calls[0].arguments[0], 1); // generalError
  });

  it("should error when worktree not found", async () => {
    exitMock.mock.resetCalls();
    consoleErrorMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    whereWorktreeMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    whereWorktreeMock.mock.mockImplementation(() =>
      err(new WorktreeNotFoundError("nonexistent")),
    );

    await rejects(
      async () => await whereHandler(["nonexistent"]),
      /Process exit with code 2/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "Error: Worktree 'nonexistent' not found",
    );
    strictEqual(exitMock.mock.calls[0].arguments[0], 2); // notFound
  });
});
