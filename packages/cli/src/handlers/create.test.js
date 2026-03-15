import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";
import {
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  WorktreeAlreadyExistsError,
} from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const consoleWarnMock = vi.fn();
const getGitRootMock = vi.fn();
const createWorktreeMock = vi.fn();
const execInWorktreeMock = vi.fn();
const shellInWorktreeMock = vi.fn();
const loadConfigMock = vi.fn();
const createContextMock = vi.fn();
const executePostCreateCommandsMock = vi.fn();
const isInsideTmuxMock = vi.fn();
const executeTmuxCommandMock = vi.fn();
const getPhantomEnvMock = vi.fn();
const exitWithErrorMock = vi.fn((message, code) => {
  if (message) consoleErrorMock(`Error: ${message}`);
  exitMock(code);
  throw new Error(`Exit with code ${code}: ${message}`);
});
const exitWithSuccessMock = vi.fn(() => {
  exitMock(0);
  throw new Error("Exit with code 0");
});

// Mock process module
const processEnvMock = {};
const originalProcessExit = process.exit;
const originalProcessEnv = process.env;

process.exit = (code) => {
  exitMock(code);
};
process.env = processEnvMock;

afterAll(() => {
  process.exit = originalProcessExit;
  process.env = originalProcessEnv;
});

vi.doMock("@phantompane/git", () => ({
  getGitRoot: getGitRootMock,
}));

const generateUniqueNameMock = vi.fn(() =>
  Promise.resolve({ ok: true, value: "fuzzy-cats-dance" }),
);

vi.doMock("@phantompane/core", () => ({
  createWorktree: createWorktreeMock,
  execInWorktree: execInWorktreeMock,
  shellInWorktree: shellInWorktreeMock,
  loadConfig: loadConfigMock,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  WorktreeAlreadyExistsError,
  createContext: createContextMock,
  executePostCreateCommands: executePostCreateCommandsMock,
  generateUniqueName: generateUniqueNameMock,
  getWorktreesDirectory: vi.fn((gitRoot, worktreesDirectory) => {
    return worktreesDirectory || `${gitRoot}/.git/phantom/worktrees`;
  }),
}));

vi.doMock("@phantompane/process", () => ({
  isInsideTmux: isInsideTmuxMock,
  executeTmuxCommand: executeTmuxCommandMock,
  getPhantomEnv: getPhantomEnvMock,
}));

vi.doMock("../output.ts", () => ({
  output: {
    log: consoleLogMock,
    error: consoleErrorMock,
    warn: consoleWarnMock,
  },
}));

vi.doMock("../errors.ts", () => ({
  exitCodes: {
    generalError: 1,
    validationError: 2,
    success: 0,
  },
  exitWithError: exitWithErrorMock,
  exitWithSuccess: exitWithSuccessMock,
}));

const { createHandler } = await import("./create.ts");

describe("createHandler", () => {
  const resetMocks = () => {
    // Reset all mocks
    exitMock.mockClear();
    consoleLogMock.mockClear();
    consoleErrorMock.mockClear();
    consoleWarnMock.mockClear();
    getGitRootMock.mockClear();
    createWorktreeMock.mockClear();
    execInWorktreeMock.mockClear();
    shellInWorktreeMock.mockClear();
    loadConfigMock.mockClear();
    createContextMock.mockClear();
    executePostCreateCommandsMock.mockClear();
    isInsideTmuxMock.mockClear();
    executeTmuxCommandMock.mockClear();
    getPhantomEnvMock.mockClear();
    generateUniqueNameMock.mockClear();
    exitWithErrorMock.mockClear();
    exitWithSuccessMock.mockClear();

    // Clear process env
    for (const key in processEnvMock) {
      delete processEnvMock[key];
    }
  };

  it("should create worktree and execute command with --exec option", async () => {
    resetMocks();
    processEnvMock.SHELL = "/bin/bash";
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Created worktree 'feature' at /test/repo/.git/phantom/worktrees/feature",
          path: "/test/repo/.git/phantom/worktrees/feature",
        }),
      ),
    );
    execInWorktreeMock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0 })),
    );

    await createHandler(["feature", "--exec", "echo hello"]);

    strictEqual(createWorktreeMock.mock.calls.length, 1);
    strictEqual(createWorktreeMock.mock.calls[0][0], "/test/repo");
    strictEqual(
      createWorktreeMock.mock.calls[0][1],
      "/test/repo/.git/phantom/worktrees",
    );
    strictEqual(createWorktreeMock.mock.calls[0][2], "feature");

    strictEqual(execInWorktreeMock.mock.calls.length, 1);
    strictEqual(execInWorktreeMock.mock.calls[0][0], "/test/repo");
    strictEqual(
      execInWorktreeMock.mock.calls[0][1],
      "/test/repo/.git/phantom/worktrees",
    );
    strictEqual(execInWorktreeMock.mock.calls[0][2], "feature");
    const execArgs = execInWorktreeMock.mock.calls[0][3];
    strictEqual(execArgs[0], "/bin/bash");
    strictEqual(execArgs[1], "-c");
    strictEqual(execArgs[2], "echo hello");

    strictEqual(consoleLogMock.mock.calls.length, 2);
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Created worktree 'feature' at /test/repo/.git/phantom/worktrees/feature",
    );
    strictEqual(
      consoleLogMock.mock.calls[1][0],
      "\nExecuting command in worktree 'feature': echo hello",
    );

    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should handle exec command failure", async () => {
    resetMocks();
    processEnvMock.SHELL = "/bin/bash";
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Created worktree 'feature' at /test/repo/.git/phantom/worktrees/feature",
          path: "/test/repo/.git/phantom/worktrees/feature",
        }),
      ),
    );
    execInWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        err({
          message: "Command failed",
          exitCode: 1,
        }),
      ),
    );

    await rejects(
      async () => await createHandler(["feature", "--exec", "false"]),
      /Exit with code 1/,
    );

    strictEqual(createWorktreeMock.mock.calls.length, 1);
    strictEqual(execInWorktreeMock.mock.calls.length, 1);
    strictEqual(consoleErrorMock.mock.calls[0][0], "Command failed");
    strictEqual(exitMock.mock.calls[0][0], 1);
  });

  it("should prefer preferences directoryNameSeparator over config", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        directoryNameSeparator: "_",
        config: {
          directoryNameSeparator: "-",
        },
      }),
    );
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Created worktree 'feature/test' at /test/repo/.git/phantom/worktrees/feature_test",
          path: "/test/repo/.git/phantom/worktrees/feature_test",
        }),
      ),
    );

    await rejects(
      async () => await createHandler(["feature/test"]),
      /Exit with code 0/,
    );

    strictEqual(createWorktreeMock.mock.calls[0][6], "_");
  });

  it("should error when --shell and --exec are used together", async () => {
    resetMocks();
    await rejects(
      async () =>
        await createHandler(["feature", "--shell", "--exec", "echo hello"]),
      /Exit with code 2/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Cannot use --shell, --exec, and --tmux options together",
    );
    strictEqual(exitMock.mock.calls[0][0], 2);
  });

  it("should use /bin/sh when SHELL env var is not set", async () => {
    resetMocks();
    // No SHELL env var set
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Created worktree 'feature' at /test/repo/.git/phantom/worktrees/feature",
          path: "/test/repo/.git/phantom/worktrees/feature",
        }),
      ),
    );
    execInWorktreeMock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0 })),
    );

    await createHandler(["feature", "--exec", "echo hello"]);

    const execArgs = execInWorktreeMock.mock.calls[0][3];
    strictEqual(execArgs[0], "/bin/sh");
  });

  it("should error when --tmux is used outside tmux session", async () => {
    resetMocks();
    isInsideTmuxMock.mockImplementation(() => Promise.resolve(false));

    await rejects(
      async () => await createHandler(["feature", "--tmux"]),
      /Exit with code 2/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: The --tmux option can only be used inside a tmux session",
    );
    strictEqual(exitMock.mock.calls[0][0], 2);
  });

  it("should create worktree and open in tmux window", async () => {
    resetMocks();
    processEnvMock.SHELL = "/bin/bash";
    processEnvMock.TMUX = "/tmp/tmux-1000/default,12345,0";
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Created worktree 'feature' at /test/repo/.git/phantom/worktrees/feature",
          path: "/test/repo/.git/phantom/worktrees/feature",
        }),
      ),
    );
    isInsideTmuxMock.mockImplementation(() => Promise.resolve(true));
    executeTmuxCommandMock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0 })),
    );
    getPhantomEnvMock.mockImplementation((name, path) => ({
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    }));

    await rejects(
      async () => await createHandler(["feature", "--tmux"]),
      /Exit with code 0/,
    );

    strictEqual(createWorktreeMock.mock.calls.length, 1);
    strictEqual(executeTmuxCommandMock.mock.calls.length, 1);

    // Verify tmux command was called with correct arguments
    const tmuxArgs = executeTmuxCommandMock.mock.calls[0][0];
    strictEqual(tmuxArgs.direction, "new");
    strictEqual(tmuxArgs.cwd, "/test/repo/.git/phantom/worktrees/feature");
    strictEqual(tmuxArgs.windowName, "feature");

    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Created worktree 'feature' at /test/repo/.git/phantom/worktrees/feature",
    );
    strictEqual(
      consoleLogMock.mock.calls[1][0],
      "\nOpening worktree 'feature' in tmux window...",
    );

    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should create worktree and open in tmux pane with vertical split", async () => {
    resetMocks();
    processEnvMock.SHELL = "/bin/bash";
    processEnvMock.TMUX = "/tmp/tmux-1000/default,12345,0";
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Created worktree 'feature' at /test/repo/.git/phantom/worktrees/feature",
          path: "/test/repo/.git/phantom/worktrees/feature",
        }),
      ),
    );
    isInsideTmuxMock.mockImplementation(() => Promise.resolve(true));
    executeTmuxCommandMock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0 })),
    );
    getPhantomEnvMock.mockImplementation((name, path) => ({
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    }));

    await rejects(
      async () => await createHandler(["feature", "--tmux-vertical"]),
      /Exit with code 0/,
    );

    strictEqual(createWorktreeMock.mock.calls.length, 1);
    strictEqual(executeTmuxCommandMock.mock.calls.length, 1);

    // Verify tmux command was called with correct arguments
    const tmuxArgs = executeTmuxCommandMock.mock.calls[0][0];
    strictEqual(tmuxArgs.direction, "vertical");
    strictEqual(tmuxArgs.cwd, "/test/repo/.git/phantom/worktrees/feature");
    strictEqual(tmuxArgs.windowName, undefined);

    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Created worktree 'feature' at /test/repo/.git/phantom/worktrees/feature",
    );
    strictEqual(
      consoleLogMock.mock.calls[1][0],
      "\nOpening worktree 'feature' in tmux pane...",
    );

    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should error when multiple action options are used together", async () => {
    resetMocks();
    await rejects(
      async () => await createHandler(["feature", "--shell", "--tmux"]),
      /Exit with code 2/,
    );

    strictEqual(consoleErrorMock.mock.calls.length, 1);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Cannot use --shell, --exec, and --tmux options together",
    );
    strictEqual(exitMock.mock.calls[0][0], 2);
  });

  it("should create worktree from specified base branch", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Created worktree 'feature' at /test/repo/.git/phantom/worktrees/feature",
          path: "/test/repo/.git/phantom/worktrees/feature",
        }),
      ),
    );

    await rejects(
      async () => await createHandler(["feature", "--base", "main"]),
      /Exit with code 0/,
    );

    strictEqual(createWorktreeMock.mock.calls.length, 1);
    strictEqual(createWorktreeMock.mock.calls[0][0], "/test/repo");
    strictEqual(
      createWorktreeMock.mock.calls[0][1],
      "/test/repo/.git/phantom/worktrees",
    );
    strictEqual(createWorktreeMock.mock.calls[0][2], "feature");
    strictEqual(createWorktreeMock.mock.calls[0][3].base, "main");

    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Created worktree 'feature' at /test/repo/.git/phantom/worktrees/feature",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should create worktree from remote branch", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Created worktree 'hotfix' at /test/repo/.git/phantom/worktrees/hotfix",
          path: "/test/repo/.git/phantom/worktrees/hotfix",
        }),
      ),
    );

    await rejects(
      async () =>
        await createHandler(["hotfix", "--base", "origin/production"]),
      /Exit with code 0/,
    );

    strictEqual(createWorktreeMock.mock.calls.length, 1);
    strictEqual(createWorktreeMock.mock.calls[0][0], "/test/repo");
    strictEqual(
      createWorktreeMock.mock.calls[0][1],
      "/test/repo/.git/phantom/worktrees",
    );
    strictEqual(createWorktreeMock.mock.calls[0][2], "hotfix");
    strictEqual(createWorktreeMock.mock.calls[0][3].base, "origin/production");

    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Created worktree 'hotfix' at /test/repo/.git/phantom/worktrees/hotfix",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should create worktree from commit hash", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Created worktree 'experiment' at /test/repo/.git/phantom/worktrees/experiment",
          path: "/test/repo/.git/phantom/worktrees/experiment",
        }),
      ),
    );

    await rejects(
      async () => await createHandler(["experiment", "--base", "abc123"]),
      /Exit with code 0/,
    );

    strictEqual(createWorktreeMock.mock.calls.length, 1);
    strictEqual(createWorktreeMock.mock.calls[0][0], "/test/repo");
    strictEqual(
      createWorktreeMock.mock.calls[0][1],
      "/test/repo/.git/phantom/worktrees",
    );
    strictEqual(createWorktreeMock.mock.calls[0][2], "experiment");
    strictEqual(createWorktreeMock.mock.calls[0][3].base, "abc123");

    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Created worktree 'experiment' at /test/repo/.git/phantom/worktrees/experiment",
    );
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should auto-generate name when no name is provided", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    generateUniqueNameMock.mockImplementation(() =>
      Promise.resolve({ ok: true, value: "fuzzy-cats-dance" }),
    );
    createWorktreeMock.mockImplementation(() =>
      Promise.resolve(
        ok({
          message:
            "Created worktree 'fuzzy-cats-dance' at /test/repo/.git/phantom/worktrees/fuzzy-cats-dance",
          path: "/test/repo/.git/phantom/worktrees/fuzzy-cats-dance",
        }),
      ),
    );

    await rejects(async () => await createHandler([]), /Exit with code 0/);

    strictEqual(generateUniqueNameMock.mock.calls.length, 1);
    strictEqual(generateUniqueNameMock.mock.calls[0][0], "/test/repo");
    strictEqual(
      generateUniqueNameMock.mock.calls[0][1],
      "/test/repo/.git/phantom/worktrees",
    );
    strictEqual(createWorktreeMock.mock.calls.length, 1);
    strictEqual(createWorktreeMock.mock.calls[0][2], "fuzzy-cats-dance");
    strictEqual(exitMock.mock.calls[0][0], 0);
  });

  it("should exit with error when name generation fails", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(() => Promise.resolve("/test/repo"));
    createContextMock.mockImplementation((gitRoot) =>
      Promise.resolve({
        gitRoot,
        worktreesDirectory: `${gitRoot}/.git/phantom/worktrees`,
        config: null,
      }),
    );
    generateUniqueNameMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        error: new Error(
          "Failed to generate a unique worktree name after maximum retries",
        ),
      }),
    );

    await rejects(async () => await createHandler([]), /Exit with code 1/);

    strictEqual(generateUniqueNameMock.mock.calls.length, 1);
    strictEqual(createWorktreeMock.mock.calls.length, 0);
    strictEqual(
      consoleErrorMock.mock.calls[0][0],
      "Error: Failed to generate a unique worktree name after maximum retries",
    );
    strictEqual(exitMock.mock.calls[0][0], 1);
  });
});
