import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";
import { err, ok } from "@phantompane/shared";

const exitMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const getGitRootMock = vi.fn();
const listWorktreesCoreMock = vi.fn();
const selectWorktreeWithFzfMock = vi.fn();
const loadConfigMock = vi.fn();
const exitWithErrorMock = vi.fn((message, code) => {
  if (message) consoleErrorMock(`Error: ${message}`);
  try {
    exitMock(code);
  } catch {
    // Re-throw a deterministic error below.
  }
  throw new Error(`Exit with code ${code}: ${message}`);
});

// Mock process module
const originalProcessExit = process.exit;
const originalProcessEnv = process.env;

process.exit = (code) => {
  exitMock(code);
};

afterAll(() => {
  process.exit = originalProcessExit;
  process.env = originalProcessEnv;
});

vi.doMock("@phantompane/git", () => ({
  getGitRoot: getGitRootMock,
}));

vi.doMock("@phantompane/core", () => ({
  listWorktrees: listWorktreesCoreMock,
  selectWorktreeWithFzf: selectWorktreeWithFzfMock,
  loadConfig: loadConfigMock,
  createContext: vi.fn((gitRoot) =>
    Promise.resolve({
      gitRoot,
      worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
    }),
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
  },
  exitWithError: exitWithErrorMock,
}));

const mockCwd = () =>
  vi.spyOn(process, "cwd").mockImplementation(() => "/test/repo");

const { listHandler } = await import("./list.ts");

describe("listHandler", () => {
  const resetMocks = () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    consoleErrorMock.mockClear();
    getGitRootMock.mockClear();
    listWorktreesCoreMock.mockClear();
    selectWorktreeWithFzfMock.mockClear();
    loadConfigMock.mockClear();
    exitWithErrorMock.mockClear();
  };

  it("should list worktrees in default format", async () => {
    resetMocks();
    const cwdMock = mockCwd();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    loadConfigMock.mockImplementation(() =>
      Promise.resolve(err(new Error("Config not found"))),
    );
    listWorktreesCoreMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          worktrees: [
            {
              name: "main",
              path: "/test/repo",
              pathToDisplay: ".",
              branch: "main",
              isClean: true,
            },
            {
              name: "feature-1",
              path: "/test/repo/.git/phantom/worktrees/feature-1",
              pathToDisplay: ".git/phantom/worktrees/feature-1",
              branch: "feature-1",
              isClean: true,
            },
            {
              name: "feature-2",
              path: "/test/repo/.git/phantom/worktrees/feature-2",
              pathToDisplay: ".git/phantom/worktrees/feature-2",
              branch: "feature-2",
              isClean: false,
            },
          ],
        }),
      ),
    );

    await listHandler([]);

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls[0][0], "/test/repo");
    strictEqual(consoleLogMock.mock.calls.length, 3);
    strictEqual(consoleLogMock.mock.calls[0][0], "main (.)");
    strictEqual(
      consoleLogMock.mock.calls[1][0],
      "feature-1 (.git/phantom/worktrees/feature-1)",
    );
    strictEqual(
      consoleLogMock.mock.calls[2][0],
      "feature-2 (.git/phantom/worktrees/feature-2) [dirty]",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
    cwdMock.mockRestore();
  });

  it("should exclude default worktree with --no-default", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    listWorktreesCoreMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          worktrees: [
            {
              name: "feature-1",
              path: "/test/repo/.git/phantom/worktrees/feature-1",
              pathToDisplay: ".git/phantom/worktrees/feature-1",
              branch: "feature-1",
              isClean: true,
            },
          ],
        }),
      ),
    );

    await listHandler(["--no-default"]);

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls[0][1]?.excludeDefault, true);
    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "feature-1 (.git/phantom/worktrees/feature-1)",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should output message when no sub worktrees are found", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    listWorktreesCoreMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          worktrees: [],
          message: "No sub worktrees found",
        }),
      ),
    );

    await listHandler(["--no-default"]);

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls[0][1]?.excludeDefault, true);
    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(consoleLogMock.mock.calls[0][0], "No sub worktrees found");
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should list only worktree names with --names option", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    listWorktreesCoreMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          worktrees: [
            {
              name: "main",
              path: "/test/repo",
              pathToDisplay: ".",
              branch: "main",
              isClean: true,
            },
            {
              name: "feature-1",
              path: "/test/repo/.git/phantom/worktrees/feature-1",
              pathToDisplay: ".git/phantom/worktrees/feature-1",
              branch: "feature-1",
              isClean: true,
            },
            {
              name: "feature-2",
              path: "/test/repo/.git/phantom/worktrees/feature-2",
              pathToDisplay: ".git/phantom/worktrees/feature-2",
              branch: "feature-2",
              isClean: false,
            },
            {
              name: "bugfix-3",
              path: "/test/repo/.git/phantom/worktrees/bugfix-3",
              pathToDisplay: ".git/phantom/worktrees/bugfix-3",
              branch: "bugfix-3",
              isClean: true,
            },
          ],
        }),
      ),
    );

    await listHandler(["--names"]);

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls[0][0], "/test/repo");
    strictEqual(consoleLogMock.mock.calls.length, 4);
    strictEqual(consoleLogMock.mock.calls[0][0], "main");
    strictEqual(consoleLogMock.mock.calls[1][0], "feature-1");
    strictEqual(consoleLogMock.mock.calls[2][0], "feature-2");
    strictEqual(consoleLogMock.mock.calls[3][0], "bugfix-3");
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should handle empty worktree list with default format", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    listWorktreesCoreMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          worktrees: [],
          message: "No worktrees found",
        }),
      ),
    );

    await listHandler([]);

    strictEqual(listWorktreesCoreMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls[0][0], "/test/repo");
    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(consoleLogMock.mock.calls[0][0], "No worktrees found");
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should output nothing for empty worktree list with --names option", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    listWorktreesCoreMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          worktrees: [],
          message: "No worktrees found",
        }),
      ),
    );

    await listHandler(["--names"]);

    strictEqual(listWorktreesCoreMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls[0][0], "/test/repo");
    strictEqual(consoleLogMock.mock.calls.length, 0);
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should handle fzf selection", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    selectWorktreeWithFzfMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          name: "feature-1",
          path: "/test/repo/.git/phantom/worktrees/feature-1",
          branch: "feature-1",
          isClean: true,
        }),
      ),
    );

    await listHandler(["--fzf"]);

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls.length, 0);
    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(consoleLogMock.mock.calls[0][0], "feature-1");
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should pass --no-default to fzf selection", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    selectWorktreeWithFzfMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          name: "feature-1",
          path: "/test/repo/.git/phantom/worktrees/feature-1",
          branch: "feature-1",
          isClean: true,
        }),
      ),
    );

    await listHandler(["--fzf", "--no-default"]);

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls[0][0], "/test/repo");
    strictEqual(
      selectWorktreeWithFzfMock.mock.calls[0][1]?.excludeDefault,
      true,
    );
    strictEqual(listWorktreesCoreMock.mock.calls.length, 0);
    strictEqual(consoleLogMock.mock.calls.length, 1);
    strictEqual(consoleLogMock.mock.calls[0][0], "feature-1");
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should handle fzf selection error", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    selectWorktreeWithFzfMock.mockImplementation(() =>
      Promise.resolve(err({ message: "fzf not found" })),
    );

    await rejects(
      async () => await listHandler(["--fzf"]),
      /Exit with code 1: fzf not found/,
    );

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(consoleErrorMock.mock.calls.length, 2);
    strictEqual(consoleErrorMock.mock.calls[0][0], "Error: fzf not found");
    strictEqual(exitMock.mock.calls[0][0], 1);
  });

  it("should handle listWorktrees error", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    listWorktreesCoreMock.mockImplementation(() =>
      Promise.resolve(err({ message: "Failed to list worktrees" })),
    );

    await rejects(
      async () => await listHandler([]),
      /Exit with code 1: Failed to list worktrees/,
    );

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls.length, 1);
    strictEqual(listWorktreesCoreMock.mock.calls[0][0], "/test/repo");
    strictEqual(consoleErrorMock.mock.calls.length, 2);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Failed to list worktrees",
    );
    strictEqual(exitMock.mock.calls[0][0], 1);
  });

  it("should handle fzf selection with no result", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    selectWorktreeWithFzfMock.mockImplementation(() =>
      Promise.resolve(ok(null)),
    );

    await listHandler(["--fzf"]);

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(consoleLogMock.mock.calls.length, 0);
    strictEqual(exitMock.mock.calls[0][0], 0);
  });
});
