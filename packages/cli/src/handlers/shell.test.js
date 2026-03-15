import { rejects, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import { WorktreeNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitMock = mock.fn();
const consoleLogMock = mock.fn();
const consoleErrorMock = mock.fn();
const getGitRootMock = mock.fn();
const shellInWorktreeMock = mock.fn();
const validateWorktreeExistsMock = mock.fn();
const selectWorktreeWithFzfMock = mock.fn();
const isInsideTmuxMock = mock.fn();
const executeTmuxCommandMock = mock.fn();
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

mock.module("@phantompane/process", {
  namedExports: {
    isInsideTmux: isInsideTmuxMock,
    executeTmuxCommand: executeTmuxCommandMock,
    getPhantomEnv: mock.fn((name, path) => ({
      PHANTOM: "1",
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    })),
  },
});

mock.module("@phantompane/core", {
  namedExports: {
    validateWorktreeExists: validateWorktreeExistsMock,
    selectWorktreeWithFzf: selectWorktreeWithFzfMock,
    shellInWorktree: shellInWorktreeMock,
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

const { shellHandler } = await import("./shell.ts");

describe("shellHandler", () => {
  it("should error when no worktree name and no --fzf flag provided", async () => {
    exitMock.mock.resetCalls();
    consoleErrorMock.mock.resetCalls();

    await rejects(
      async () => await shellHandler([]),
      /Exit with code 3: Usage: phantom shell <worktree-name> or phantom shell --fzf/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "Error: Usage: phantom shell <worktree-name> or phantom shell --fzf",
    );
    strictEqual(exitMock.mock.calls[0].arguments[0], 3); // validationError
  });

  it("should error when both worktree name and --fzf flag are provided", async () => {
    exitMock.mock.resetCalls();
    consoleErrorMock.mock.resetCalls();

    await rejects(
      async () => await shellHandler(["feature", "--fzf"]),
      /Exit with code 3: Cannot specify both a worktree name and --fzf option/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "Error: Cannot specify both a worktree name and --fzf option",
    );
    strictEqual(exitMock.mock.calls[0].arguments[0], 3); // validationError
  });

  it("should open shell for specified worktree", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    shellInWorktreeMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    shellInWorktreeMock.mock.mockImplementation(() => ok({ exitCode: 0 }));
    exitMock.mock.mockImplementation((code) => {
      throw new Error(`Process exit with code ${code}`);
    });

    await rejects(
      async () => await shellHandler(["feature"]),
      /Process exit with code 0/,
    );

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(validateWorktreeExistsMock.mock.calls.length, 1);
    strictEqual(validateWorktreeExistsMock.mock.calls[0].arguments[0], "/repo");
    strictEqual(
      validateWorktreeExistsMock.mock.calls[0].arguments[1],
      "feature",
    );
    strictEqual(shellInWorktreeMock.mock.calls.length, 1);
    strictEqual(shellInWorktreeMock.mock.calls[0].arguments[0], "/repo");
    strictEqual(
      shellInWorktreeMock.mock.calls[0].arguments[1],
      "/repo/.git/phantom/worktrees",
    );
    strictEqual(shellInWorktreeMock.mock.calls[0].arguments[2], "feature");
    strictEqual(consoleLogMock.mock.calls.length, 2);
    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Entering worktree 'feature' at /repo/.git/phantom/worktrees/feature",
    );
  });

  it("should open shell with fzf selection", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    selectWorktreeWithFzfMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    shellInWorktreeMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    selectWorktreeWithFzfMock.mock.mockImplementation(() =>
      ok({
        name: "feature-fzf",
        path: "/repo/.git/phantom/worktrees/feature-fzf",
        branch: "feature-fzf",
        isCurrentWorktree: false,
        isDirty: false,
      }),
    );
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature-fzf" }),
    );
    shellInWorktreeMock.mock.mockImplementation(() => ok({ exitCode: 0 }));
    exitMock.mock.mockImplementation((code) => {
      throw new Error(`Process exit with code ${code}`);
    });

    await rejects(
      async () => await shellHandler(["--fzf"]),
      /Process exit with code 0/,
    );

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(selectWorktreeWithFzfMock.mock.calls[0].arguments[0], "/repo");
    strictEqual(validateWorktreeExistsMock.mock.calls.length, 1);
    strictEqual(
      validateWorktreeExistsMock.mock.calls[0].arguments[1],
      "feature-fzf",
    );
    strictEqual(shellInWorktreeMock.mock.calls.length, 1);
    strictEqual(shellInWorktreeMock.mock.calls[0].arguments[0], "/repo");
    strictEqual(
      shellInWorktreeMock.mock.calls[0].arguments[1],
      "/repo/.git/phantom/worktrees",
    );
    strictEqual(shellInWorktreeMock.mock.calls[0].arguments[2], "feature-fzf");
  });

  it("should exit gracefully when fzf selection is cancelled", async () => {
    exitMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    selectWorktreeWithFzfMock.mock.resetCalls();
    exitWithSuccessMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    selectWorktreeWithFzfMock.mock.mockImplementation(() => ok(null));

    await rejects(
      async () => await shellHandler(["--fzf"]),
      /Exit with code 0: success/,
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
      async () => await shellHandler(["--fzf"]),
      /Exit with code 1: fzf not found/,
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
    validateWorktreeExistsMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      err(new WorktreeNotFoundError("nonexistent")),
    );

    await rejects(
      async () => await shellHandler(["nonexistent"]),
      /Exit with code 1: Worktree 'nonexistent' not found/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "Error: Worktree 'nonexistent' not found",
    );
  });

  it("should error when tmux option used outside tmux", async () => {
    exitMock.mock.resetCalls();
    consoleErrorMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => false);

    await rejects(
      async () => await shellHandler(["feature", "--tmux"]),
      /Exit with code 3: The --tmux option can only be used inside a tmux session/,
    );

    strictEqual(isInsideTmuxMock.mock.calls.length, 1);
    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "Error: The --tmux option can only be used inside a tmux session",
    );
  });

  it("should open shell in new tmux window", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();
    executeTmuxCommandMock.mock.resetCalls();
    exitWithSuccessMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => true);
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mock.mockImplementation(() => ok({ exitCode: 0 }));

    await rejects(
      async () => await shellHandler(["feature", "--tmux"]),
      /Exit with code 0: success/,
    );

    strictEqual(isInsideTmuxMock.mock.calls.length, 1);
    strictEqual(executeTmuxCommandMock.mock.calls.length, 1);
    const tmuxCall = executeTmuxCommandMock.mock.calls[0].arguments[0];
    strictEqual(tmuxCall.direction, "new");
    strictEqual(tmuxCall.cwd, "/repo/.git/phantom/worktrees/feature");
    strictEqual(tmuxCall.windowName, "feature");
    strictEqual(tmuxCall.env.PHANTOM, "1");
    strictEqual(tmuxCall.env.PHANTOM_NAME, "feature");
    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Opening worktree 'feature' in tmux window...",
    );
  });

  it("should open shell in vertical tmux pane", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();
    executeTmuxCommandMock.mock.resetCalls();
    exitWithSuccessMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => true);
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mock.mockImplementation(() => ok({ exitCode: 0 }));

    await rejects(
      async () => await shellHandler(["feature", "--tmux-v"]),
      /Exit with code 0: success/,
    );

    const tmuxCall = executeTmuxCommandMock.mock.calls[0].arguments[0];
    strictEqual(tmuxCall.direction, "vertical");
    strictEqual(tmuxCall.windowName, undefined);
    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Opening worktree 'feature' in tmux pane...",
    );
  });

  it("should open shell in horizontal tmux pane", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();
    executeTmuxCommandMock.mock.resetCalls();
    exitWithSuccessMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => true);
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mock.mockImplementation(() => ok({ exitCode: 0 }));

    await rejects(
      async () => await shellHandler(["feature", "--tmux-horizontal"]),
      /Exit with code 0: success/,
    );

    const tmuxCall = executeTmuxCommandMock.mock.calls[0].arguments[0];
    strictEqual(tmuxCall.direction, "horizontal");
    strictEqual(tmuxCall.windowName, undefined);
    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Opening worktree 'feature' in tmux pane...",
    );
  });

  it("should handle tmux command error", async () => {
    exitMock.mock.resetCalls();
    consoleErrorMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();
    executeTmuxCommandMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => true);
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mock.mockImplementation(() =>
      err(new Error("tmux command failed")),
    );

    await rejects(
      async () => await shellHandler(["feature", "--tmux"]),
      /Exit with code 1:/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 2);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "tmux command failed",
    );
  });

  it("should open shell with --fzf and tmux options combined", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    selectWorktreeWithFzfMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();
    executeTmuxCommandMock.mock.resetCalls();
    exitWithSuccessMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => true);
    selectWorktreeWithFzfMock.mock.mockImplementation(() =>
      ok({
        name: "selected-feature",
        path: "/repo/.git/phantom/worktrees/selected-feature",
        branch: "selected-feature",
        isCurrentWorktree: false,
        isDirty: false,
      }),
    );
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/selected-feature" }),
    );
    executeTmuxCommandMock.mock.mockImplementation(() => ok({ exitCode: 0 }));

    await rejects(
      async () => await shellHandler(["--fzf", "--tmux"]),
      /Exit with code 0: success/,
    );

    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(executeTmuxCommandMock.mock.calls.length, 1);
    const tmuxCall = executeTmuxCommandMock.mock.calls[0].arguments[0];
    strictEqual(tmuxCall.direction, "new");
    strictEqual(tmuxCall.cwd, "/repo/.git/phantom/worktrees/selected-feature");
    strictEqual(tmuxCall.windowName, "selected-feature");
    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Opening worktree 'selected-feature' in tmux window...",
    );
  });
});
