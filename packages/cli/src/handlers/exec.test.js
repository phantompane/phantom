import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";
import { WorktreeNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitMock = vi.fn((code) => {
  throw new Error(
    `Exit with code ${code}: ${code === 0 ? "success" : "error"}`,
  );
});
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const getGitRootMock = vi.fn();
const execInWorktreeMock = vi.fn();
const validateWorktreeExistsMock = vi.fn();
const selectWorktreeWithFzfMock = vi.fn();
const isInsideTmuxMock = vi.fn();
const executeTmuxCommandMock = vi.fn();
const getPhantomEnvMock = vi.fn();
const exitWithErrorMock = vi.fn((message, code) => {
  consoleErrorMock(`Error: ${message}`);
  try {
    exitMock(code);
  } catch {
    // Re-throw a deterministic error below.
  }
  throw new Error(`Exit with code ${code}: ${message || "error"}`);
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
  throw new Error(`Exit with code ${code ?? 0}`);
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
  getPhantomEnv: getPhantomEnvMock,
}));

vi.doMock("@phantompane/core", () => ({
  validateWorktreeExists: validateWorktreeExistsMock,
  selectWorktreeWithFzf: selectWorktreeWithFzfMock,
  execInWorktree: execInWorktreeMock,
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
    validationError: 3,
    notFound: 4,
  },
}));

const { execHandler } = await import("./exec.ts");

describe("execHandler", () => {
  it("should error when tmux option used outside tmux", async () => {
    exitMock.mockClear();
    consoleErrorMock.mockClear();
    getGitRootMock.mockClear();
    isInsideTmuxMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => false);

    await rejects(
      async () => await execHandler(["feature", "npm", "test", "--tmux"]),
      /Exit with code 3: The --tmux option can only be used inside a tmux session/,
    );

    strictEqual(isInsideTmuxMock.mock.calls.length, 1);
    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: The --tmux option can only be used inside a tmux session",
    );
  });

  it("should execute command in new tmux window", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    isInsideTmuxMock.mockClear();
    executeTmuxCommandMock.mockClear();
    getPhantomEnvMock.mockClear();
    exitWithSuccessMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => true);
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mockImplementation(() => ok({ exitCode: 0 }));
    getPhantomEnvMock.mockImplementation((name, path) => ({
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
    const tmuxCall = executeTmuxCommandMock.mock.calls[0][0];
    strictEqual(tmuxCall.direction, "new");
    strictEqual(tmuxCall.command, "npm");
    strictEqual(tmuxCall.args.length, 1);
    strictEqual(tmuxCall.args[0], "test");
    strictEqual(tmuxCall.cwd, "/repo/.git/phantom/worktrees/feature");
    strictEqual(tmuxCall.windowName, "feature");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Executing command in worktree 'feature' in tmux window...",
    );
  });

  it("should execute command in vertical tmux pane", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    isInsideTmuxMock.mockClear();
    executeTmuxCommandMock.mockClear();
    getPhantomEnvMock.mockClear();
    exitWithSuccessMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => true);
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mockImplementation(() => ok({ exitCode: 0 }));
    getPhantomEnvMock.mockImplementation((name, path) => ({
      PHANTOM: "1",
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    }));

    await rejects(
      async () =>
        await execHandler(["feature", "npm", "run", "dev", "--tmux-v"]),
      /Exit with code 0: success/,
    );

    const tmuxCall = executeTmuxCommandMock.mock.calls[0][0];
    strictEqual(tmuxCall.direction, "vertical");
    strictEqual(tmuxCall.command, "npm");
    strictEqual(tmuxCall.args.length, 2);
    strictEqual(tmuxCall.args[0], "run");
    strictEqual(tmuxCall.args[1], "dev");
    strictEqual(tmuxCall.windowName, undefined);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Executing command in worktree 'feature' in tmux pane...",
    );
  });

  it("should execute command in horizontal tmux pane", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    isInsideTmuxMock.mockClear();
    executeTmuxCommandMock.mockClear();
    getPhantomEnvMock.mockClear();
    exitWithSuccessMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => true);
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mockImplementation(() => ok({ exitCode: 0 }));
    getPhantomEnvMock.mockImplementation((name, path) => ({
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

    const tmuxCall = executeTmuxCommandMock.mock.calls[0][0];
    strictEqual(tmuxCall.direction, "horizontal");
    strictEqual(tmuxCall.command, "npm");
    strictEqual(tmuxCall.args.length, 2);
    strictEqual(tmuxCall.args[0], "run");
    strictEqual(tmuxCall.args[1], "watch");
    strictEqual(tmuxCall.windowName, undefined);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Executing command in worktree 'feature' in tmux pane...",
    );
  });

  it("should handle tmux command error", async () => {
    exitMock.mockClear();
    consoleErrorMock.mockClear();
    getGitRootMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    isInsideTmuxMock.mockClear();
    executeTmuxCommandMock.mockClear();
    getPhantomEnvMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => true);
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    executeTmuxCommandMock.mockImplementation(() =>
      err(new Error("tmux command failed")),
    );
    getPhantomEnvMock.mockImplementation((name, path) => ({
      PHANTOM: "1",
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    }));

    await rejects(
      async () => await execHandler(["feature", "npm", "test", "--tmux"]),
      /Exit with code 1:/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 2);
    strictEqual(consoleErrorMock.mock.calls[0][0], "tmux command failed");
  });

  it("should execute command with --fzf and tmux options combined", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    selectWorktreeWithFzfMock.mockClear();
    validateWorktreeExistsMock.mockClear();
    isInsideTmuxMock.mockClear();
    executeTmuxCommandMock.mockClear();
    getPhantomEnvMock.mockClear();
    exitWithSuccessMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    isInsideTmuxMock.mockImplementation(() => true);
    selectWorktreeWithFzfMock.mockImplementation(() =>
      ok({
        name: "selected-feature",
        path: "/repo/.git/phantom/worktrees/selected-feature",
      }),
    );
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/selected-feature" }),
    );
    executeTmuxCommandMock.mockImplementation(() => ok({ exitCode: 0 }));
    getPhantomEnvMock.mockImplementation((name, path) => ({
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
    const tmuxCall = executeTmuxCommandMock.mock.calls[0][0];
    strictEqual(tmuxCall.command, "npm");
    strictEqual(tmuxCall.args.length, 1);
    strictEqual(tmuxCall.args[0], "test");
    strictEqual(tmuxCall.cwd, "/repo/.git/phantom/worktrees/selected-feature");
  });

  it("should execute command normally without tmux options", async () => {
    exitMock.mockClear();
    consoleLogMock.mockClear();
    getGitRootMock.mockClear();
    execInWorktreeMock.mockClear();
    validateWorktreeExistsMock.mockClear();

    getGitRootMock.mockImplementation(() => "/repo");
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    execInWorktreeMock.mockImplementation(() => ok({ exitCode: 0 }));

    await rejects(
      async () => await execHandler(["feature", "npm", "test"]),
      /Exit with code 0: success/,
    );

    strictEqual(execInWorktreeMock.mock.calls.length, 1);
    const execCall = execInWorktreeMock.mock.calls[0];
    strictEqual(execCall[0], "/repo");
    strictEqual(execCall[1], "/repo/.git/phantom/worktrees");
    strictEqual(execCall[2], "feature");
    strictEqual(execCall[3].join(" "), "npm test");
  });
});
