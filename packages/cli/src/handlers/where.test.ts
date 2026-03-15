import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";
import { WorktreeNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const getGitRootMock = vi.fn();
const whereWorktreeMock = vi.fn();
const selectWorktreeWithFzfMock = vi.fn();
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
}));

vi.doMock("@phantompane/core", () => ({
  whereWorktree: whereWorktreeMock,
  selectWorktreeWithFzf: selectWorktreeWithFzfMock,
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
  exitWithError: exitWithErrorMock,
  exitWithSuccess: exitWithSuccessMock,
  exitCodes: {
    success: 0,
    generalError: 1,
    notFound: 2,
    validationError: 3,
  },
}));

const { whereHandler } = await import("./where.ts");

describe("whereHandler", () => {
  it("should error when no worktree name and no --fzf flag provided", async () => {
    exitMock.mockClear();
    consoleErrorMock.mockClear();

    await rejects(
      async () => await whereHandler([]),
      /Exit with code 3: Usage: phantom where <worktree-name> or phantom where --fzf/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Usage: phantom where <worktree-name> or phantom where --fzf",
    );
    strictEqual(exitMock.mock.calls[0][0], 3); // validationError
  });

  it("should error when both worktree name and --fzf flag are provided", async () => {
    exitMock.mockClear();
    consoleErrorMock.mockClear();

    await rejects(
      async () => await whereHandler(["feature", "--fzf"]),
      /Exit with code 3: Cannot specify both a worktree name and --fzf option/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Cannot specify both a worktree name and --fzf option",
    );
    strictEqual(exitMock.mock.calls[0][0], 3); // validationError
  });

  it("should output path for specified worktree", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    whereWorktreeMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    whereWorktreeMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    exitMock.mockImplementation((code) => {
      throw new Error(`Process exit with code ${code}`);
    });

    await rejects(
      async () => await whereHandler(["feature"]),
      /Process exit with code 0/,
    );

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(whereWorktreeMock.mock.calls.length, 1);
    strictEqual(whereWorktreeMock.mock.calls[0][0], "/repo");
    strictEqual(
      whereWorktreeMock.mock.calls[0][1],
      "/repo/.git/phantom/worktrees",
    );
    strictEqual(whereWorktreeMock.mock.calls[0][2], "feature");
    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "/repo/.git/phantom/worktrees/feature",
    );
  });

  it("should output path with fzf selection", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    selectWorktreeWithFzfMock.mockClear();
    whereWorktreeMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    selectWorktreeWithFzfMock.mockImplementation(() =>
      ok({
        name: "feature-fzf",
        branch: "feature-fzf",
        isClean: true,
      }),
    );
    whereWorktreeMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature-fzf" }),
    );
    exitMock.mockImplementation((code) => {
      throw new Error(`Process exit with code ${code}`);
    });

    await rejects(
      async () => await whereHandler(["--fzf"]),
      /Process exit with code 0/,
    );

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls[0][0], "/repo");
    strictEqual(whereWorktreeMock.mock.calls.length, 1);
    strictEqual(whereWorktreeMock.mock.calls[0][0], "/repo");
    strictEqual(
      whereWorktreeMock.mock.calls[0][1],
      "/repo/.git/phantom/worktrees",
    );
    strictEqual(whereWorktreeMock.mock.calls[0][2], "feature-fzf");
    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "/repo/.git/phantom/worktrees/feature-fzf",
    );
  });

  it("should exit gracefully when fzf selection is cancelled", async () => {
    exitMock.mockClear();
    getGitRootMock.mockClear();
    selectWorktreeWithFzfMock.mockClear();
    exitWithSuccessMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    selectWorktreeWithFzfMock.mockImplementation(() => ok(null));

    await rejects(
      async () => await whereHandler(["--fzf"]),
      /Process exit with code 0/,
    );

    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(exitWithSuccessMock.mock.calls.length, 1);
  });

  it("should handle fzf selection error", async () => {
    exitMock.mockClear();
    consoleErrorMock.mockClear();
    getGitRootMock.mockClear();
    selectWorktreeWithFzfMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    selectWorktreeWithFzfMock.mockImplementation(() =>
      err(new Error("fzf not found")),
    );

    await rejects(
      async () => await whereHandler(["--fzf"]),
      /Process exit with code 1/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(consoleErrorMock.mock.calls[0][0], "Error: fzf not found");
    strictEqual(exitMock.mock.calls[0][0], 1); // generalError
  });

  it("should error when worktree not found", async () => {
    exitMock.mockClear();
    consoleErrorMock.mockClear();
    getGitRootMock.mockClear();
    whereWorktreeMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    whereWorktreeMock.mockImplementation(() =>
      err(new WorktreeNotFoundError("nonexistent")),
    );

    await rejects(
      async () => await whereHandler(["nonexistent"]),
      /Process exit with code 2/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Worktree 'nonexistent' not found",
    );
    strictEqual(exitMock.mock.calls[0][0], 2); // notFound
  });
});
