import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";
import { WorktreeNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const getGitRootMock = vi.fn();
const validateWorktreeExistsMock = vi.fn();
const createContextMock = vi.fn();
const getPhantomEnvMock = vi.fn();
const spawnMock = vi.fn();
const exitWithErrorMock = vi.fn((message, code) => {
  consoleErrorMock(`Error: ${message}`);
  try {
    exitMock(code);
  } catch {
    // Let the formatted exit message surface below.
  }
  throw new Error(`Exit with code ${code}: ${message}`);
});

const _originalEditor = process.env.EDITOR;

const originalProcessExit = process.exit;
const originalProcessEnv = process.env;

process.exit = (code) => {
  exitMock(code);
};

afterAll(() => {
  process.exit = originalProcessExit;
  process.env = originalProcessEnv;
});

vi.doMock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.doMock("@phantompane/git", () => ({
  getGitRoot: getGitRootMock,
}));

vi.doMock("@phantompane/process", () => ({
  getPhantomEnv: getPhantomEnvMock,
}));

vi.doMock("@phantompane/core", () => ({
  validateWorktreeExists: validateWorktreeExistsMock,
  createContext: createContextMock,
  WorktreeNotFoundError,
}));

vi.doMock("../output.ts", () => ({
  output: {
    log: consoleLogMock,
    error: consoleErrorMock,
  },
}));

vi.doMock("../errors.ts", () => ({
  exitWithError: exitWithErrorMock,
  exitCodes: {
    success: 0,
    generalError: 1,
    notFound: 2,
    validationError: 3,
  },
}));

const { editHandler } = await import("./edit.ts");

function resetMocks() {
  exitMock.mockClear();
  consoleLogMock.mockClear();
  consoleErrorMock.mockClear();
  getGitRootMock.mockClear();
  validateWorktreeExistsMock.mockClear();
  createContextMock.mockClear();
  getPhantomEnvMock.mockClear();
  spawnMock.mockClear();
}

describe.sequential("editHandler", () => {
  it("should error when no worktree name is provided", async () => {
    resetMocks();
    process.env.EDITOR = "vim";
    await rejects(
      async () => await editHandler([]),
      /Exit with code 3: Usage: phantom edit <worktree-name> \[path\]/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Usage: phantom edit <worktree-name> [path]",
    );
  });

  it("should error when neither phantom.editor nor EDITOR is set", async () => {
    resetMocks();
    delete process.env.EDITOR;
    getGitRootMock.mockImplementation(async () => "/repo");
    createContextMock.mockImplementation(async () => ({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
    }));

    await rejects(
      async () => await editHandler(["feature"]),
      /Exit with code 3: Editor is not configured/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Editor is not configured. Run 'phantom preferences set editor <command>' or set the EDITOR env var.",
    );
  });

  it("should exit with not found when worktree does not exist", async () => {
    resetMocks();
    process.env.EDITOR = "vim";
    getGitRootMock.mockImplementation(() => "/repo");
    createContextMock.mockImplementation(async (gitRoot) => ({
      gitRoot,
      worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
      preferences: {},
    }));
    validateWorktreeExistsMock.mockImplementation(() =>
      err(new WorktreeNotFoundError("missing")),
    );

    await rejects(
      async () => await editHandler(["missing"]),
      /Exit with code 2: Worktree 'missing' not found/,
    );

    strictEqual(exitMock.mock.calls[0][0], 2);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Worktree 'missing' not found",
    );
  });

  it("should open the configured EDITOR in the worktree root", async () => {
    resetMocks();
    process.env.EDITOR = "vim";
    getGitRootMock.mockImplementation(() => "/repo");
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        preferences: {},
      }),
    );
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    getPhantomEnvMock.mockImplementation(() => ({
      PHANTOM: "1",
    }));
    spawnMock.mockImplementation(() => ({
      on: (event, handler) => {
        if (event === "exit") {
          queueMicrotask(() => handler(0, null));
        }
      },
    }));

    await editHandler(["feature"]);

    strictEqual(getGitRootMock.mock.calls.length, 1);
    strictEqual(validateWorktreeExistsMock.mock.calls.length, 1);
    const spawnCall = spawnMock.mock.calls[0];
    strictEqual(spawnCall[0], "vim");
    strictEqual(spawnCall[1][0], ".");
    strictEqual(spawnCall[2].cwd, "/repo/.git/phantom/worktrees/feature");
    strictEqual(spawnCall[2].shell, true);
    strictEqual(spawnCall[2].stdio, "inherit");
    strictEqual(spawnCall[2].env.PHANTOM, "1");
    strictEqual(exitMock.mock.calls[0][0], 0);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Opening editor in worktree 'feature'...",
    );
  });

  it("should open EDITOR with the provided path", async () => {
    resetMocks();
    process.env.EDITOR = "vim";
    getGitRootMock.mockImplementation(() => "/repo");
    createContextMock.mockImplementation(async (gitRoot) => ({
      gitRoot,
      worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
      preferences: {},
    }));
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/docs" }),
    );
    getPhantomEnvMock.mockImplementation(() => ({
      PHANTOM: "1",
    }));
    spawnMock.mockImplementation(() => ({
      on: (event, handler) => {
        if (event === "exit") {
          queueMicrotask(() => handler(0, null));
        }
      },
    }));

    await editHandler(["docs", "README.md"]);

    const spawnCall = spawnMock.mock.calls[0];
    strictEqual(spawnCall[0], "vim");
    strictEqual(spawnCall[1][0], "README.md");
    strictEqual(spawnCall[2].cwd, "/repo/.git/phantom/worktrees/docs");
    strictEqual(exitMock.mock.calls[0][0], 0);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Opening editor in worktree 'docs'...",
    );
  });

  it("should prefer phantom.editor over EDITOR env", async () => {
    resetMocks();
    process.env.EDITOR = "env-editor";
    getGitRootMock.mockImplementation(async () => "/repo");
    createContextMock.mockImplementation(async () => ({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: { editor: "pref-editor" },
    }));
    validateWorktreeExistsMock.mockImplementation(() =>
      ok({ path: "/repo/.git/phantom/worktrees/feature" }),
    );
    getPhantomEnvMock.mockImplementation(() => ({
      PHANTOM: "1",
    }));
    spawnMock.mockImplementation(() => ({
      on: (event, handler) => {
        if (event === "exit") {
          queueMicrotask(() => handler(0, null));
        }
      },
    }));

    await editHandler(["feature"]);

    const spawnCall = spawnMock.mock.calls[0];
    strictEqual(spawnCall[0], "pref-editor");
    strictEqual(exitMock.mock.calls[0][0], 0);
  });
});

afterAll(() => {
  process.env.EDITOR = _originalEditor;
});
