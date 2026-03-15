import { rejects, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import { WorktreeNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitMock = mock.fn((code) => {
  throw new Error(
    `Exit with code ${code}: ${code === 0 ? "success" : "error"}`,
  );
});
const consoleLogMock = mock.fn();
const consoleErrorMock = mock.fn();
const getGitRootMock = mock.fn();
const execInWorktreeMock = mock.fn();
const validateWorktreeExistsMock = mock.fn();
const selectWorktreeWithFzfMock = mock.fn();
const isInsideTmuxMock = mock.fn();
const executeTmuxCommandMock = mock.fn();
const getPhantomEnvMock = mock.fn();
const exitWithErrorMock = mock.fn((message, code) => {
  consoleErrorMock(`Error: ${message}`);
  exitMock(code);
});
const exitWithSuccessMock = mock.fn(() => {
  exitMock(0);
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
    getPhantomEnv: getPhantomEnvMock,
  },
});

mock.module("@phantompane/core", {
  namedExports: {
    validateWorktreeExists: validateWorktreeExistsMock,
    selectWorktreeWithFzf: selectWorktreeWithFzfMock,
    execInWorktree: execInWorktreeMock,
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
      validationError: 3,
      notFound: 4,
    },
  },
});

const { execHandler } = await import("./exec.ts");

describe("execHandler", () => {
  it("should error when tmux option used outside tmux", async () => {
    exitMock.mock.resetCalls();
    consoleErrorMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => false);

    await rejects(
      async () => await execHandler(["feature", "npm", "test", "--tmux"]),
      /Exit with code 3: The --tmux option can only be used inside a tmux session/,
    );

    strictEqual(isInsideTmuxMock.mock.calls.length, 1);
    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "Error: The --tmux option can only be used inside a tmux session",
    );
  });

  it("should execute command in new tmux window", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();
    executeTmuxCommandMock.mock.resetCalls();
    getPhantomEnvMock.mock.resetCalls();
    exitWithSuccessMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => true);
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mock.mockImplementation(() => ok({ exitCode: 0 }));
    getPhantomEnvMock.mock.mockImplementation((name, path) => ({
      PHANTOM: "1",
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    }));

    await rejects(
      async () => await execHandler(["feature", "npm", "test", "--tmux"]),
      /Exit with code 0: success/,
    );

    strictEqual(isInsideTmuxMock.mock.calls.length, 1);
    strictEqual(executeTmuxCommandMock.mock.calls.length, 1);
    const tmuxCall = executeTmuxCommandMock.mock.calls[0].arguments[0];
    strictEqual(tmuxCall.direction, "new");
    strictEqual(tmuxCall.command, "npm");
    strictEqual(tmuxCall.args.length, 1);
    strictEqual(tmuxCall.args[0], "test");
    strictEqual(tmuxCall.cwd, "/repo/.git/phantom/worktrees/feature");
    strictEqual(tmuxCall.windowName, "feature");
    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Executing command in worktree 'feature' in tmux window...",
    );
  });

  it("should execute command in vertical tmux pane", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();
    executeTmuxCommandMock.mock.resetCalls();
    getPhantomEnvMock.mock.resetCalls();
    exitWithSuccessMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => true);
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mock.mockImplementation(() => ok({ exitCode: 0 }));
    getPhantomEnvMock.mock.mockImplementation((name, path) => ({
      PHANTOM: "1",
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    }));

    await rejects(
      async () =>
        await execHandler(["feature", "npm", "run", "dev", "--tmux-v"]),
      /Exit with code 0: success/,
    );

    const tmuxCall = executeTmuxCommandMock.mock.calls[0].arguments[0];
    strictEqual(tmuxCall.direction, "vertical");
    strictEqual(tmuxCall.command, "npm");
    strictEqual(tmuxCall.args.length, 2);
    strictEqual(tmuxCall.args[0], "run");
    strictEqual(tmuxCall.args[1], "dev");
    strictEqual(tmuxCall.windowName, undefined);
    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Executing command in worktree 'feature' in tmux pane...",
    );
  });

  it("should execute command in horizontal tmux pane", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();
    executeTmuxCommandMock.mock.resetCalls();
    getPhantomEnvMock.mock.resetCalls();
    exitWithSuccessMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => true);
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mock.mockImplementation(() => ok({ exitCode: 0 }));
    getPhantomEnvMock.mock.mockImplementation((name, path) => ({
      PHANTOM: "1",
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    }));

    await rejects(
      async () =>
        await execHandler([
          "feature",
          "npm",
          "run",
          "watch",
          "--tmux-horizontal",
        ]),
      /Exit with code 0: success/,
    );

    const tmuxCall = executeTmuxCommandMock.mock.calls[0].arguments[0];
    strictEqual(tmuxCall.direction, "horizontal");
    strictEqual(tmuxCall.command, "npm");
    strictEqual(tmuxCall.args.length, 2);
    strictEqual(tmuxCall.args[0], "run");
    strictEqual(tmuxCall.args[1], "watch");
    strictEqual(tmuxCall.windowName, undefined);
    strictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Executing command in worktree 'feature' in tmux pane...",
    );
  });

  it("should handle tmux command error", async () => {
    exitMock.mock.resetCalls();
    consoleErrorMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();
    executeTmuxCommandMock.mock.resetCalls();
    getPhantomEnvMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => true);
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mock.mockImplementation(() =>
      err(new Error("tmux command failed")),
    );
    getPhantomEnvMock.mock.mockImplementation((name, path) => ({
      PHANTOM: "1",
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    }));

    await rejects(
      async () => await execHandler(["feature", "npm", "test", "--tmux"]),
      /Exit with code 1:/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 2);
    strictEqual(
      consoleErrorMock.mock.calls[0].arguments[0],
      "tmux command failed",
    );
  });

  it("should execute command with --fzf and tmux options combined", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    selectWorktreeWithFzfMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();
    isInsideTmuxMock.mock.resetCalls();
    executeTmuxCommandMock.mock.resetCalls();
    getPhantomEnvMock.mock.resetCalls();
    exitWithSuccessMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mock.mockImplementation(() => true);
    selectWorktreeWithFzfMock.mock.mockImplementation(() =>
      ok({
        name: "selected-feature",
        path: "/repo/.git/phantom/worktrees/selected-feature",
      }),
    );
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/selected-feature" }),
    );
    executeTmuxCommandMock.mock.mockImplementation(() => ok({ exitCode: 0 }));
    getPhantomEnvMock.mock.mockImplementation((name, path) => ({
      PHANTOM: "1",
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    }));

    await rejects(
      async () => await execHandler(["--fzf", "npm", "test", "--tmux"]),
      /Exit with code 0: success/,
    );

    strictEqual(selectWorktreeWithFzfMock.mock.calls.length, 1);
    strictEqual(executeTmuxCommandMock.mock.calls.length, 1);
    const tmuxCall = executeTmuxCommandMock.mock.calls[0].arguments[0];
    strictEqual(tmuxCall.command, "npm");
    strictEqual(tmuxCall.args.length, 1);
    strictEqual(tmuxCall.args[0], "test");
    strictEqual(tmuxCall.cwd, "/repo/.git/phantom/worktrees/selected-feature");
  });

  it("should execute command normally without tmux options", async () => {
    exitMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    getGitRootMock.mock.resetCalls();
    execInWorktreeMock.mock.resetCalls();
    validateWorktreeExistsMock.mock.resetCalls();

    getGitRootMock.mock.mockImplementation(() => "/repo");
    validateWorktreeExistsMock.mock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    execInWorktreeMock.mock.mockImplementation(() => ok({ exitCode: 0 }));

    await rejects(
      async () => await execHandler(["feature", "npm", "test"]),
      /Exit with code 0: success/,
    );

    strictEqual(execInWorktreeMock.mock.calls.length, 1);
    const execCall = execInWorktreeMock.mock.calls[0];
    strictEqual(execCall.arguments[0], "/repo");
    strictEqual(execCall.arguments[1], "/repo/.git/phantom/worktrees");
    strictEqual(execCall.arguments[2], "feature");
    strictEqual(execCall.arguments[3].join(" "), "npm test");
  });
});
