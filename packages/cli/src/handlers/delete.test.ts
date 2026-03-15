import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";
import { WorktreeError, WorktreeNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const getGitRootMock = vi.fn();
const deleteWorktreeMock = vi.fn();
const selectWorktreeWithFzfMock = vi.fn();
const getCurrentWorktreeMock = vi.fn();
const exitWithErrorMock = vi.fn((message, code) => {
  consoleErrorMock(`Error: ${message}`);
  exitMock(code);
  throw new Error(`Exit with code ${code}: ${message}`);
});
const exitWithSuccessMock = vi.fn(() => {
  exitMock(0);
  throw new Error("Exit with code 0: success");
});

const originalProcessExit = process.exit;
const originalProcessEnv = process.env;

process.exit = (code) => {
  exitMock(code);
  throw new Error(`Exit with code ${code ?? 0}`);
};

afterAll(() => {
  process.exit = originalProcessExit;
  process.env = originalProcessEnv;
});

vi.doMock("@phantompane/git", () => ({
  getGitRoot: getGitRootMock,
  getCurrentWorktree: getCurrentWorktreeMock,
}));

vi.doMock("@phantompane/core", () => ({
  deleteWorktree: deleteWorktreeMock,
  selectWorktreeWithFzf: selectWorktreeWithFzfMock,
  WorktreeError,
  WorktreeNotFoundError,
  createContext: vi.fn((gitRoot) =>
    Promise.resolve({
      gitRoot,
      worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
    }),
  ),
  loadConfig: vi.fn(() =>
    Promise.resolve({ ok: false, error: new Error("Config not found") }),
  ),
  getWorktreesDirectory: vi.fn((gitRoot, worktreesDirectory) => {
    return worktreesDirectory || `${gitRoot}/.git/phantom/worktrees`;
  }),
}));

vi.doMock("../output.ts", () => ({
  output: {
    log: consoleLogMock,
    error: consoleErrorMock,
  },
}));

vi.doMock("../errors.ts", () => ({
  exitCodes: {
    success: 0,
    generalError: 1,
    notFound: 2,
    validationError: 3,
  },
  exitWithError: exitWithErrorMock,
  exitWithSuccess: exitWithSuccessMock,
}));

const { deleteHandler } = await import("./delete.ts");

describe("deleteHandler", () => {
  const resetMocks = () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    consoleErrorMock.mockClear();
    getGitRootMock.mockClear();
    deleteWorktreeMock.mockClear();
    selectWorktreeWithFzfMock.mockClear();
    getCurrentWorktreeMock.mockClear();
    exitWithErrorMock.mockClear();
    exitWithSuccessMock.mockClear();
  };

  it("should delete worktree by name", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    deleteWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message: "Deleted worktree 'feature' and its branch 'feature'",
        }),
      ),
    );

    await rejects(
      async () => await deleteHandler(["feature"]),
      /Exit with code 0: success/,
    );

    strictEqual(deleteWorktreeMock.mock.calls.length, 1);
    strictEqual(deleteWorktreeMock.mock.calls[0][0], "/test/repo");
    strictEqual(
      deleteWorktreeMock.mock.calls[0][1],
      "/test/repo/.git/phantom/worktrees",
    );
    strictEqual(deleteWorktreeMock.mock.calls[0][2], "feature");
    const deleteOptions = deleteWorktreeMock.mock.calls[0][3];
    strictEqual(deleteOptions.force, false);

    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Deleted worktree 'feature' and its branch 'feature'",
    );

    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should delete multiple worktrees by name", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    deleteWorktreeMock.mockImplementation((gitRoot, _worktreesDir, name) =>
      Promise.resolve(
        ok({
          message: `Deleted worktree '${name}' and its branch '${name}'`,
        }),
      ),
    );

    await rejects(
      async () => await deleteHandler(["feature-a", "feature-b", "feature-c"]),
      /Exit with code 0: success/,
    );

    strictEqual(deleteWorktreeMock.mock.calls.length, 3);
    for (const call of deleteWorktreeMock.mock.calls) {
      strictEqual(call[0], "/test/repo");
      strictEqual(call[1], "/test/repo/.git/phantom/worktrees");
      const deleteOptions = call[3];
      strictEqual(deleteOptions.force, false);
    }
    strictEqual(
      deleteWorktreeMock.mock.calls.map((call) => call[2]).join(","),
      "feature-a,feature-b,feature-c",
    );

    strictEqual(consoleLogMock.mock.calls.length, 3);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Deleted worktree 'feature-a' and its branch 'feature-a'",
    );
    strictEqual(
      consoleLogMock.mock.calls[1][0],
      "Deleted worktree 'feature-b' and its branch 'feature-b'",
    );
    strictEqual(
      consoleLogMock.mock.calls[2][0],
      "Deleted worktree 'feature-c' and its branch 'feature-c'",
    );

    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should delete current worktree with --current option", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    getCurrentWorktreeMock.mockImplementation(() =>
      Promise.resolve("issues/93"),
    );
    deleteWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message: "Deleted worktree 'issues/93' and its branch 'issues/93'",
        }),
      ),
    );

    await rejects(
      async () => await deleteHandler(["--current"]),
      /Exit with code 0: success/,
    );

    strictEqual(getCurrentWorktreeMock.mock.calls.length, 1);
    strictEqual(getCurrentWorktreeMock.mock.calls[0][0], "/test/repo");

    strictEqual(deleteWorktreeMock.mock.calls.length, 1);
    strictEqual(deleteWorktreeMock.mock.calls[0][0], "/test/repo");
    strictEqual(
      deleteWorktreeMock.mock.calls[0][1],
      "/test/repo/.git/phantom/worktrees",
    );
    strictEqual(deleteWorktreeMock.mock.calls[0][2], "issues/93");
    const deleteOptions = deleteWorktreeMock.mock.calls[0][3];
    strictEqual(deleteOptions.force, false);

    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Deleted worktree 'issues/93' and its branch 'issues/93'",
    );

    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should error when --current is used outside a worktree", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    getCurrentWorktreeMock.mockImplementation(() => Promise.resolve(null));

    await rejects(
      async () => await deleteHandler(["--current"]),
      /Exit with code 3: Not in a worktree directory/,
    );

    strictEqual(getCurrentWorktreeMock.mock.calls.length, 1);
    strictEqual(consoleErrorMock.mock.calls.length, 2); // exitWithError is called twice - once in the handler, once in the catch block
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Not in a worktree directory. The --current option can only be used from within a worktree.",
    );
    strictEqual(
      consoleErrorMock.mock.calls[1][0],
      "Error: Exit with code 3: Not in a worktree directory. The --current option can only be used from within a worktree.",
    );
    strictEqual(exitMock.mock.calls.length, 2);
    strictEqual(exitMock.mock.calls[0][0], 3); // first call with validationError
    strictEqual(exitMock.mock.calls[1][0], 1); // second call with generalError
  });

  it("should error when both name and --current are provided", async () => {
    resetMocks();

    await rejects(
      async () => await deleteHandler(["feature", "--current"]),
      /Exit with code 3: Cannot specify --current with a worktree name or --fzf option/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Cannot specify --current with a worktree name or --fzf option",
    );
    strictEqual(exitMock.mock.calls[0][0], 3); // validationError
  });

  it("should error when no arguments are provided", async () => {
    resetMocks();

    await rejects(
      async () => await deleteHandler([]),
      /Exit with code 3: Please provide at least one worktree name to delete, use --current to delete the current worktree, or use --fzf for interactive selection/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Please provide at least one worktree name to delete, use --current to delete the current worktree, or use --fzf for interactive selection",
    );
    strictEqual(exitMock.mock.calls[0][0], 3); // validationError
  });

  it("should handle force deletion with --current", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    getCurrentWorktreeMock.mockImplementation(() => Promise.resolve("feature"));
    deleteWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Warning: Worktree 'feature' had uncommitted changes (2 files)\nDeleted worktree 'feature' and its branch 'feature'",
          hasUncommittedChanges: true,
          changedFiles: 2,
        }),
      ),
    );

    await rejects(
      async () => await deleteHandler(["--current", "--force"]),
      /Exit with code 0: success/,
    );

    strictEqual(deleteWorktreeMock.mock.calls.length, 1);
    const deleteOptions = deleteWorktreeMock.mock.calls[0][3];
    strictEqual(deleteOptions.force, true);

    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should handle worktree not found error", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    deleteWorktreeMock.mockImplementation(() =>
      Promise.resolve(err(new WorktreeNotFoundError("feature"))),
    );

    await rejects(
      async () => await deleteHandler(["feature"]),
      /Exit with code 3: Worktree 'feature' not found/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 2); // exitWithError is called twice
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Worktree 'feature' not found",
    );
    strictEqual(
      consoleErrorMock.mock.calls[1][0],
      "Error: Exit with code 3: Worktree 'feature' not found",
    );
    strictEqual(exitMock.mock.calls.length, 2);
    strictEqual(exitMock.mock.calls[0][0], 3); // first call with validationError
    strictEqual(exitMock.mock.calls[1][0], 1); // second call with generalError
  });
});
