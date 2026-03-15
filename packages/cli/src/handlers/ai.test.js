import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";
import { WorktreeNotFoundError } from "@phantompane/core";
import { err, ok } from "@phantompane/shared";

const exitMock = vi.fn((code) => {
  throw new Error(`Process exit with code ${code}`);
});
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
    // Ignore to surface the formatted exit message below.
  }
  throw new Error(`Exit with code ${code}: ${message}`);
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
  getPhantomEnv: getPhantomEnvMock,
}));

vi.doMock("node:child_process", () => ({
  spawn: spawnMock,
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

const { aiHandler } = await import("./ai.ts");

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

describe.sequential("aiHandler", () => {
  it("errors when worktree name is missing", async () => {
    resetMocks();

    await rejects(
      async () => await aiHandler([]),
      /Exit with code 3: Usage: phantom ai <worktree-name>/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
  });

  it("errors when ai preference is not set", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(async () => "/repo");
    createContextMock.mockImplementation(async () => ({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: {},
    }));

    await rejects(
      async () => await aiHandler(["feature"]),
      /Exit with code 3: AI assistant is not configured/,
    );

    strictEqual(exitMock.mock.calls[0][0], 3);
  });

  it("returns not found when worktree validation fails", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(async () => "/repo");
    createContextMock.mockImplementation(async () => ({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: { ai: "claude" },
    }));
    validateWorktreeExistsMock.mockImplementation(() =>
      err(new WorktreeNotFoundError("missing")),
    );

    await rejects(
      async () => await aiHandler(["missing"]),
      /Exit with code 2: Worktree 'missing' not found/,
    );

    strictEqual(exitMock.mock.calls[0][0], 2);
  });

  it("launches the configured ai command inside the worktree", async () => {
    resetMocks();
    getGitRootMock.mockImplementation(async () => "/repo");
    createContextMock.mockImplementation(async () => ({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      preferences: { ai: "codex --full-auto" },
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

    await rejects(
      async () => await aiHandler(["feature"]),
      /Process exit with code 0/,
    );

    strictEqual(spawnMock.mock.calls.length, 1);
    const [command, args, options] = spawnMock.mock.calls[0];
    strictEqual(command, "codex --full-auto");
    strictEqual(args.length, 0);
    strictEqual(options.cwd, "/repo/.git/phantom/worktrees/feature");
    strictEqual(options.env.PHANTOM, "1");
    strictEqual(
      consoleLogMock.mock.calls[0][0],
      "Launching AI assistant in worktree 'feature'...",
    );
  });
});
