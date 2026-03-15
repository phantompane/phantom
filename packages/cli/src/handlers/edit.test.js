import { rejects, strictEqual } from "node:assert";
import { after, describe, it, mock } from "node:test";
import { WorktreeNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitMock = mock.fn((code) => {
  throw new Error(`Process exit with code ${code}`);
});
const consoleLogMock = mock.fn();
const consoleErrorMock = mock.fn();
const getGitRootMock = mock.fn();
const validateWorktreeExistsMock = mock.fn();
const createContextMock = mock.fn();
const getPhantomEnvMock = mock.fn();
const spawnMock = mock.fn();
const exitWithErrorMock = mock.fn((message, code) => {
  consoleErrorMock(`Error: ${message}`);
  try {
    exitMock(code);
  } catch (_error) {
    // Let the formatted exit message surface below.
  }
  throw new Error(`Exit with code ${code}: ${message}`);
});

const _originalEditor = process.env.EDITOR;

mock.module("node:process", {
  namedExports: {
    exit: exitMock,
    env: process.env,
  },
});

mock.module("node:child_process", {
  namedExports: {
    spawn: spawnMock,
  },
});

mock.module("@phantompane/git", {
  namedExports: {
    getGitRoot: getGitRootMock,
  },
});

mock.module("@phantompane/process", {
  namedExports: {
    getPhantomEnv: getPhantomEnvMock,
  },
});

mock.module("@phantompane/core", {
  namedExports: {
    validateWorktreeExists: validateWorktreeExistsMock,
    createContext: createContextMock,
    WorktreeNotFoundError,
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
    exitCodes: {
      success: 0,
      generalError: 1,
      notFound: 2,
      validationError: 3,
    },
  },
});

const { editHandler } = await import("./edit.ts");

function resetMocks() {
  exitMock.mock.resetCalls();
  consoleLogMock.mock.resetCalls();
  consoleErrorMock.mock.resetCalls();
  getGitRootMock.mock.resetCalls();
  validateWorktreeExistsMock.mock.resetCalls();
  createContextMock.mock.resetCalls();
  getPhantomEnvMock.mock.resetCalls();
  spawnMock.mock.resetCalls();
}

describe(
  "editHandler",
  {
    concurrency: false,
  },
  () => {
    it("should error when no worktree name is provided", async () => {
      resetMocks();
      process.env.EDITOR = "vim";
      await rejects(
        async () => await editHandler([]),
        /Exit with code 3: Usage: phantom edit <worktree-name> \[path\]/,
      );

      strictEqual(exitMock.mock.calls[0].arguments[0], 3);
      strictEqual(
        consoleErrorMock.mock.calls[0].arguments[0],
        "Error: Usage: phantom edit <worktree-name> [path]",
      );
    });

    it("should error when neither phantom.editor nor EDITOR is set", async () => {
      resetMocks();
      process.env.EDITOR = undefined;
      getGitRootMock.mock.mockImplementation(async () => "/repo");
      createContextMock.mock.mockImplementation(async () => ({
        gitRoot: "/repo",
        worktreesDirectory: "/repo/.git/phantom/worktrees",
        preferences: {},
      }));

      await rejects(
        async () => await editHandler(["feature"]),
        /Exit with code 3: Editor is not configured/,
      );

      strictEqual(exitMock.mock.calls[0].arguments[0], 3);
      strictEqual(
        consoleErrorMock.mock.calls[0].arguments[0],
        "Error: Editor is not configured. Run 'phantom preferences set editor <command>' or set the EDITOR env var.",
      );
    });

    it("should exit with not found when worktree does not exist", async () => {
      resetMocks();
      process.env.EDITOR = "vim";
      getGitRootMock.mock.mockImplementation(() => "/repo");
      createContextMock.mock.mockImplementation(async (gitRoot) => ({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        preferences: {},
      }));
      validateWorktreeExistsMock.mock.mockImplementation(() =>
        err(new WorktreeNotFoundError("missing")),
      );

      await rejects(
        async () => await editHandler(["missing"]),
        /Exit with code 2: Worktree 'missing' not found/,
      );

      strictEqual(exitMock.mock.calls[0].arguments[0], 2);
      strictEqual(
        consoleErrorMock.mock.calls[0].arguments[0],
        "Error: Worktree 'missing' not found",
      );
    });

    it("should open the configured EDITOR in the worktree root", async () => {
      resetMocks();
      process.env.EDITOR = "vim";
      getGitRootMock.mock.mockImplementation(() => "/repo");
      createContextMock.mock.mockImplementation((gitRoot) =>
        Promise.resolve({
          gitRoot,
          worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
          preferences: {},
        }),
      );
      validateWorktreeExistsMock.mock.mockImplementation(() =>
        ok({ path: "/repo/.git/phantom/worktrees/feature" }),
      );
      getPhantomEnvMock.mock.mockImplementation(() => ({
        PHANTOM: "1",
      }));
      spawnMock.mock.mockImplementation(() => ({
        on: (event, handler) => {
          if (event === "exit") {
            queueMicrotask(() => handler(0, null));
          }
        },
      }));

      await rejects(
        async () => await editHandler(["feature"]),
        /Process exit with code 0/,
      );

      strictEqual(getGitRootMock.mock.calls.length, 1);
      strictEqual(validateWorktreeExistsMock.mock.calls.length, 1);
      const spawnCall = spawnMock.mock.calls[0].arguments;
      strictEqual(spawnCall[0], "vim");
      strictEqual(spawnCall[1][0], ".");
      strictEqual(spawnCall[2].cwd, "/repo/.git/phantom/worktrees/feature");
      strictEqual(spawnCall[2].shell, true);
      strictEqual(spawnCall[2].stdio, "inherit");
      strictEqual(spawnCall[2].env.PHANTOM, "1");
      strictEqual(
        consoleLogMock.mock.calls[0].arguments[0],
        "Opening editor in worktree 'feature'...",
      );
    });

    it("should open EDITOR with the provided path", async () => {
      resetMocks();
      process.env.EDITOR = "vim";
      getGitRootMock.mock.mockImplementation(() => "/repo");
      createContextMock.mock.mockImplementation(async (gitRoot) => ({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        preferences: {},
      }));
      validateWorktreeExistsMock.mock.mockImplementation(() =>
        ok({ path: "/repo/.git/phantom/worktrees/docs" }),
      );
      getPhantomEnvMock.mock.mockImplementation(() => ({
        PHANTOM: "1",
      }));
      spawnMock.mock.mockImplementation(() => ({
        on: (event, handler) => {
          if (event === "exit") {
            queueMicrotask(() => handler(0, null));
          }
        },
      }));

      await rejects(
        async () => await editHandler(["docs", "README.md"]),
        /Process exit with code 0/,
      );

      const spawnCall = spawnMock.mock.calls[0].arguments;
      strictEqual(spawnCall[0], "vim");
      strictEqual(spawnCall[1][0], "README.md");
      strictEqual(spawnCall[2].cwd, "/repo/.git/phantom/worktrees/docs");
      strictEqual(
        consoleLogMock.mock.calls[0].arguments[0],
        "Opening editor in worktree 'docs'...",
      );
    });

    it("should prefer phantom.editor over EDITOR env", async () => {
      resetMocks();
      process.env.EDITOR = "env-editor";
      getGitRootMock.mock.mockImplementation(async () => "/repo");
      createContextMock.mock.mockImplementation(async () => ({
        gitRoot: "/repo",
        worktreesDirectory: "/repo/.git/phantom/worktrees",
        preferences: { editor: "pref-editor" },
      }));
      validateWorktreeExistsMock.mock.mockImplementation(() =>
        ok({ path: "/repo/.git/phantom/worktrees/feature" }),
      );
      getPhantomEnvMock.mock.mockImplementation(() => ({
        PHANTOM: "1",
      }));
      spawnMock.mock.mockImplementation(() => ({
        on: (event, handler) => {
          if (event === "exit") {
            queueMicrotask(() => handler(0, null));
          }
        },
      }));

      await rejects(
        async () => await editHandler(["feature"]),
        /Process exit with code 0/,
      );

      const spawnCall = spawnMock.mock.calls[0].arguments;
      strictEqual(spawnCall[0], "pref-editor");
    });
  },
);

after(() => {
  process.env.EDITOR = _originalEditor;
});
