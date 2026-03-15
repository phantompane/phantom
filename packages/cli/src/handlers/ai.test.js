import { rejects, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
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
    // Ignore to surface the formatted exit message below.
  }
  throw new Error(`Exit with code ${code}: ${message}`);
});

mock.module("node:process", {
  namedExports: {
    exit: exitMock,
    env: process.env,
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

mock.module("node:child_process", {
  namedExports: {
    spawn: spawnMock,
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

const { aiHandler } = await import("./ai.ts");

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
  "aiHandler",
  {
    concurrency: false,
  },
  () => {
    it("errors when worktree name is missing", async () => {
      resetMocks();

      await rejects(
        async () => await aiHandler([]),
        /Exit with code 3: Usage: phantom ai <worktree-name>/,
      );

      strictEqual(exitMock.mock.calls[0].arguments[0], 3);
    });

    it("errors when ai preference is not set", async () => {
      resetMocks();
      getGitRootMock.mock.mockImplementation(async () => "/repo");
      createContextMock.mock.mockImplementation(async () => ({
        gitRoot: "/repo",
        worktreesDirectory: "/repo/.git/phantom/worktrees",
        preferences: {},
      }));

      await rejects(
        async () => await aiHandler(["feature"]),
        /Exit with code 3: AI assistant is not configured/,
      );

      strictEqual(exitMock.mock.calls[0].arguments[0], 3);
    });

    it("returns not found when worktree validation fails", async () => {
      resetMocks();
      getGitRootMock.mock.mockImplementation(async () => "/repo");
      createContextMock.mock.mockImplementation(async () => ({
        gitRoot: "/repo",
        worktreesDirectory: "/repo/.git/phantom/worktrees",
        preferences: { ai: "claude" },
      }));
      validateWorktreeExistsMock.mock.mockImplementation(() =>
        err(new WorktreeNotFoundError("missing")),
      );

      await rejects(
        async () => await aiHandler(["missing"]),
        /Exit with code 2: Worktree 'missing' not found/,
      );

      strictEqual(exitMock.mock.calls[0].arguments[0], 2);
    });

    it("launches the configured ai command inside the worktree", async () => {
      resetMocks();
      getGitRootMock.mock.mockImplementation(async () => "/repo");
      createContextMock.mock.mockImplementation(async () => ({
        gitRoot: "/repo",
        worktreesDirectory: "/repo/.git/phantom/worktrees",
        preferences: { ai: "codex --full-auto" },
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
        async () => await aiHandler(["feature"]),
        /Process exit with code 0/,
      );

      strictEqual(spawnMock.mock.calls.length, 1);
      const [command, args, options] = spawnMock.mock.calls[0].arguments;
      strictEqual(command, "codex --full-auto");
      strictEqual(args.length, 0);
      strictEqual(options.cwd, "/repo/.git/phantom/worktrees/feature");
      strictEqual(options.env.PHANTOM, "1");
      strictEqual(
        consoleLogMock.mock.calls[0].arguments[0],
        "Launching AI assistant in worktree 'feature'...",
      );
    });
  },
);
