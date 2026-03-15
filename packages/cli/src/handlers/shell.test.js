import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";
import { WorktreeNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const getGitRootMock = vi.fn();
const shellInWorktreeMock = vi.fn();
const validateWorktreeExistsMock = vi.fn();
const selectWorktreeWithFzfMock = vi.fn();
const isInsideTmuxMock = vi.fn();
const executeTmuxCommandMock = vi.fn();
const exitWithErrorMock = vi.fn((message, code) => {
  consoleErrorMock(`Error: ${message}`);
  try {
    exitMock(code);
  } catch {
    // Re-throw a deterministic error below.
  }
  throw new Error(`Exit with code ${code}: ${message}`);
});
const exitWithSuccessMock = vi.fn(() => {
  try {
    exitMock(0);
  } catch {
    // Re-throw a deterministic error below.
  }
  throw new Error("Exit with code 0: success");
});

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

vi.doMock("@phantompane/process", () => ({
  isInsideTmux: isInsideTmuxMock,
  executeTmuxCommand: executeTmuxCommandMock,
  getPhantomEnv: vi.fn((name, path) => ({
    PHANTOM: "1",
    PHANTOM_NAME: name,
    PHANTOM_PATH: path,
  })),
}));

vi.doMock("@phantompane/core", () => ({
  validateWorktreeExists: validateWorktreeExistsMock,
  selectWorktreeWithFzf: selectWorktreeWithFzfMock,
  shellInWorktree: shellInWorktreeMock,
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

const { shellHandler } = await import("./shell.ts");

describe("shellHandler", () => {
  it("should error when no worktree name and no --fzf flag provided", async () => {
    exitMock.mockClear();
    consoleErrorMock.mockClear();

    await rejects(
      async () => await shellHandler([]),
      /Exit with code 3: Usage: phantom shell <worktree-name> or phantom shell --fzf/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Usage: phantom shell <worktree-name> or phantom shell --fzf",
    );
    strictEqual(exitMock.mock.calls[0][0], 3); // validationError
  });

  it("should error when both worktree name and --fzf flag are provided", async () => {
    exitMock.mockClear();
    consoleErrorMock.mockClear();

    await rejects(
      async () => await shellHandler(["feature", "--fzf"]),
      /Exit with code 3: Cannot specify both a worktree name and --fzf option/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Cannot specify both a worktree name and --fzf option",
    );
    strictEqual(exitMock.mock.calls[0][0], 3); // validationError
  });

  it("should open shell for specified worktree", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    shellInWorktreeMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    shellInWorktreeMock.mockImplementation(() => ok({ exitCode: 0 }));

    await shellHandler(["feature"]);

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(validateWorktreeExistsMock.mock.calls.length, 1);
    strictEqual(validateWorktreeExistsMock.mock.calls[0][0], "/repo");
    strictEqual(
      validateWorktreeExistsMock.mock.calls[0][1],
      "/repo/.git/phantom/worktrees",
    );
    strictEqual(validateWorktreeExistsMock.mock.calls[0][2], "feature");
    strictEqual(shellInWorktreeMock.mock.calls.length, 1);
    strictEqual(shellInWorktreeMock.mock.calls[0][0], "/repo");
    strictEqual(
      shellInWorktreeMock.mock.calls[0][1],
      "/repo/.git/phantom/worktrees",
    );
    strictEqual(shellInWorktreeMock.mock.calls[0][2], "feature");
    strictEqual(consoleLogMock.mock.calls.length, 2);
    strictEqual(exitMock.mock.calls[0][0], 0);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Entering worktree 'feature' at /repo/.git/phantom/worktrees/feature",
    );
  });

  it("should open shell with fzf selection", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    selectWorktreeWithFzfMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    shellInWorktreeMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    selectWorktreeWithFzfMock.mockImplementation(() =>
      ok({
        name: "feature-fzf",
        path: "/repo/.git/phantom/worktrees/feature-fzf",
        branch: "feature-fzf",
        isCurrentWorktree: false,
        isDirty: false,
      }),
    );
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature-fzf" }),
    );
    shellInWorktreeMock.mockImplementation(() => ok({ exitCode: 0 }));

    await shellHandler(["--fzf"]);

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls[0][0], "/repo");
    strictEqual(validateWorktreeExistsMock.mock.calls.length, 1);
    strictEqual(
      validateWorktreeExistsMock.mock.calls[0][1],
      "/repo/.git/phantom/worktrees",
    );
    strictEqual(validateWorktreeExistsMock.mock.calls[0][2], "feature-fzf");
    strictEqual(shellInWorktreeMock.mock.calls.length, 1);
    strictEqual(shellInWorktreeMock.mock.calls[0][0], "/repo");
    strictEqual(
      shellInWorktreeMock.mock.calls[0][1],
      "/repo/.git/phantom/worktrees",
    );
    strictEqual(shellInWorktreeMock.mock.calls[0][2], "feature-fzf");
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should exit gracefully when fzf selection is cancelled", async () => {
    exitMock.mockClear();
    getGitRootMock.mockClear();
    selectWorktreeWithFzfMock.mockClear();
    exitWithSuccessMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    selectWorktreeWithFzfMock.mockImplementation(() => ok(null));

    await rejects(
      async () => await shellHandler(["--fzf"]),
      /Exit with code 0: success/,
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
      async () => await shellHandler(["--fzf"]),
      /Exit with code 1: fzf not found/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 2);
    strictEqual(consoleErrorMock.mock.calls[0][0], "Error: fzf not found");
    strictEqual(exitMock.mock.calls[0][0], 1); // generalError
  });

  it("should error when worktree not found", async () => {
    exitMock.mockClear();
    consoleErrorMock.mockClear();
    getGitRootMock.mockClear();
    validateWorktreeExistsMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    validateWorktreeExistsMock.mockImplementation(() =>
      err(new WorktreeNotFoundError("nonexistent")),
    );

    await rejects(
      async () => await shellHandler(["nonexistent"]),
      /Exit with code 1: Worktree 'nonexistent' not found/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 2);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Worktree 'nonexistent' not found",
    );
  });

  it("should error when tmux option used outside tmux", async () => {
    exitMock.mockClear();
    consoleErrorMock.mockClear();
    getGitRootMock.mockClear();
    isInsideTmuxMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => false);

    await rejects(
      async () => await shellHandler(["feature", "--tmux"]),
      /Exit with code 3: The --tmux option can only be used inside a tmux session/,
    );

    strictEqual(isInsideTmuxMock.mock.calls.length, 1);
    strictEqual(consoleErrorMock.mock.calls.length, 2);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: The --tmux option can only be used inside a tmux session",
    );
  });

  it("should open shell in new tmux window", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    isInsideTmuxMock.mockClear();
    executeTmuxCommandMock.mockClear();
    exitWithSuccessMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => true);
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mockImplementation(() => ok({ exitCode: 0 }));

    await rejects(
      async () => await shellHandler(["feature", "--tmux"]),
      /Exit with code 0: success/,
    );

    strictEqual(isInsideTmuxMock.mock.calls.length, 1);
    strictEqual(executeTmuxCommandMock.mock.calls.length, 1);
    const tmuxCall = executeTmuxCommandMock.mock.calls[0][0];
    strictEqual(tmuxCall.direction, "new");
    strictEqual(tmuxCall.cwd, "/repo/.git/phantom/worktrees/feature");
    strictEqual(tmuxCall.windowName, "feature");
    strictEqual(tmuxCall.env.PHANTOM, "1");
    strictEqual(tmuxCall.env.PHANTOM_NAME, "feature");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Opening worktree 'feature' in tmux window...",
    );
  });

  it("should open shell in vertical tmux pane", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    isInsideTmuxMock.mockClear();
    executeTmuxCommandMock.mockClear();
    exitWithSuccessMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => true);
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mockImplementation(() => ok({ exitCode: 0 }));

    await rejects(
      async () => await shellHandler(["feature", "--tmux-v"]),
      /Exit with code 0: success/,
    );

    const tmuxCall = executeTmuxCommandMock.mock.calls[0][0];
    strictEqual(tmuxCall.direction, "vertical");
    strictEqual(tmuxCall.windowName, undefined);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Opening worktree 'feature' in tmux pane...",
    );
  });

  it("should open shell in horizontal tmux pane", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    isInsideTmuxMock.mockClear();
    executeTmuxCommandMock.mockClear();
    exitWithSuccessMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => true);
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mockImplementation(() => ok({ exitCode: 0 }));

    await rejects(
      async () => await shellHandler(["feature", "--tmux-horizontal"]),
      /Exit with code 0: success/,
    );

    const tmuxCall = executeTmuxCommandMock.mock.calls[0][0];
    strictEqual(tmuxCall.direction, "horizontal");
    strictEqual(tmuxCall.windowName, undefined);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Opening worktree 'feature' in tmux pane...",
    );
  });

  it("should handle tmux command error", async () => {
    exitMock.mockClear();
    consoleErrorMock.mockClear();
    getGitRootMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    isInsideTmuxMock.mockClear();
    executeTmuxCommandMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => true);
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mockImplementation(() =>
      err(new Error("tmux command failed")),
    );

    await rejects(
      async () => await shellHandler(["feature", "--tmux"]),
      /Exit with code 1:/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 3);
    strictEqual(consoleErrorMock.mock.calls[0][0], "tmux command failed");
  });

  it("should open shell with --fzf and tmux options combined", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    selectWorktreeWithFzfMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    isInsideTmuxMock.mockClear();
    executeTmuxCommandMock.mockClear();
    exitWithSuccessMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => true);
    selectWorktreeWithFzfMock.mockImplementation(() =>
      ok({
        name: "selected-feature",
        path: "/repo/.git/phantom/worktrees/selected-feature",
        branch: "selected-feature",
        isCurrentWorktree: false,
        isDirty: false,
      }),
    );
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/selected-feature" }),
    );
    executeTmuxCommandMock.mockImplementation(() => ok({ exitCode: 0 }));

    await rejects(
      async () => await shellHandler(["--fzf", "--tmux"]),
      /Exit with code 0: success/,
    );

    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(executeTmuxCommandMock.mock.calls.length, 1);
    const tmuxCall = executeTmuxCommandMock.mock.calls[0][0];
    strictEqual(tmuxCall.direction, "new");
    strictEqual(tmuxCall.cwd, "/repo/.git/phantom/worktrees/selected-feature");
    strictEqual(tmuxCall.windowName, "selected-feature");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Opening worktree 'selected-feature' in tmux window...",
    );
  });
});
