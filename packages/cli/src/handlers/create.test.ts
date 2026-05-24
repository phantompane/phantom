import { rejects, strictEqual } from "node:assert";
import { afterAll, describe, it, vi } from "vitest";
import {
  TmuxSessionRequiredError,
  WorktreeActionConflictError,
  WorktreeAlreadyExistsError,
} from "@phantompane/core";
import { err, ok } from "@phantompane/utils";

const exitMock = vi.fn();
const resolveWorktreeActionMock = vi.fn();
const validateWorktreeActionMock = vi.fn();
const runCreateWorktreeMock = vi.fn();
const runWorktreeActionMock = vi.fn();
const runPostCreateWorktreeMock = vi.fn();
const exitWithErrorMock = vi.fn((message, code) => {
  throw new Error(`Exit with code ${code}: ${message}`);
});
const exitWithSuccessMock = vi.fn(() => {
  throw new Error("Exit with code 0");
});
const outputMock = {
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

const originalProcessExit = process.exit;
process.exit = (code): never => {
  exitMock(code);
  return undefined as never;
};

afterAll(() => {
  process.exit = originalProcessExit;
});

vi.doMock("@phantompane/core", () => ({
  resolveWorktreeAction: resolveWorktreeActionMock,
  runCreateWorktree: runCreateWorktreeMock,
  runWorktreeAction: runWorktreeActionMock,
  runPostCreateWorktree: runPostCreateWorktreeMock,
  TmuxSessionRequiredError,
  validateWorktreeAction: validateWorktreeActionMock,
  WorktreeActionConflictError,
  WorktreeAlreadyExistsError,
}));

vi.doMock("../errors.ts", () => ({
  exitCodes: {
    generalError: 1,
    validationError: 2,
    success: 0,
  },
  exitWithError: exitWithErrorMock,
  exitWithSuccess: exitWithSuccessMock,
  getProcessExitCode: (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
      ? error.exitCode
      : undefined,
}));

vi.doMock("../output.ts", () => ({
  output: outputMock,
}));

const { createHandler } = await import("./create.ts");

describe("createHandler", () => {
  const resetMocks = () => {
    exitMock.mockReset();
    resolveWorktreeActionMock.mockReset();
    resolveWorktreeActionMock.mockImplementation((options) => {
      if (options.shell && options.exec !== undefined) {
        return err(new WorktreeActionConflictError());
      }
      if (options.shell) {
        return ok({ kind: "shell" });
      }
      if (options.exec !== undefined) {
        return ok({ kind: "exec", command: options.exec });
      }
      if (options.tmuxDirection) {
        return ok({ kind: "tmux", direction: options.tmuxDirection });
      }
      return ok(undefined);
    });
    validateWorktreeActionMock.mockReset();
    validateWorktreeActionMock.mockResolvedValue(ok(undefined));
    runCreateWorktreeMock.mockReset();
    runWorktreeActionMock.mockReset();
    runWorktreeActionMock.mockImplementation((options) => {
      options.onStarted?.();
      return Promise.resolve(ok({}));
    });
    runPostCreateWorktreeMock.mockReset();
    runPostCreateWorktreeMock.mockResolvedValue(ok({ executedCommands: [] }));
    exitWithErrorMock.mockReset();
    exitWithSuccessMock.mockReset();
    outputMock.log.mockReset();
    outputMock.error.mockReset();
    outputMock.warn.mockReset();
  };

  it("passes parsed options to core", async () => {
    resetMocks();
    runCreateWorktreeMock.mockResolvedValue(
      ok({
        gitRoot: "/repo",
        worktreesDirectory: "/repo/.git/phantom/worktrees",
        name: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
        message: "Created worktree",
      }),
    );

    await rejects(
      async () =>
        await createHandler([
          "feature",
          "--base",
          "main",
          "--copy-file",
          ".env",
          "--tmux-vertical",
        ]),
      /Exit with code 0/,
    );

    strictEqual(runCreateWorktreeMock.mock.calls.length, 1);
    strictEqual(runCreateWorktreeMock.mock.calls[0][0].name, "feature");
    strictEqual(runCreateWorktreeMock.mock.calls[0][0].base, "main");
    strictEqual(runCreateWorktreeMock.mock.calls[0][0].copyFiles[0], ".env");
    strictEqual(runCreateWorktreeMock.mock.calls[0][0].logger, outputMock);
    strictEqual(
      runWorktreeActionMock.mock.calls[0][0].action.direction,
      "vertical",
    );
    strictEqual(runCreateWorktreeMock.mock.calls[0][0].postCreate, undefined);
    strictEqual(runWorktreeActionMock.mock.calls[0][0].logger, outputMock);
    strictEqual(runPostCreateWorktreeMock.mock.calls.length, 1);
    strictEqual(
      runPostCreateWorktreeMock.mock.calls[0][0].worktreeName,
      "feature",
    );
    strictEqual(runPostCreateWorktreeMock.mock.calls[0][0].logger, outputMock);
  });

  it("maps validation errors to validation exit codes", async () => {
    resetMocks();

    await rejects(
      async () => await createHandler(["feature", "--shell", "--exec", "ls"]),
      /Exit with code 2/,
    );

    strictEqual(
      exitWithErrorMock.mock.calls[0][0],
      new WorktreeActionConflictError().message,
    );
    strictEqual(exitWithErrorMock.mock.calls[0][1], 2);
    strictEqual(runCreateWorktreeMock.mock.calls.length, 0);
    strictEqual(runPostCreateWorktreeMock.mock.calls.length, 0);
  });

  it("exits with the propagated process exit code when core requests it", async () => {
    resetMocks();
    runCreateWorktreeMock.mockResolvedValue(
      ok({
        gitRoot: "/repo",
        worktreesDirectory: "/repo/.git/phantom/worktrees",
        name: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
        message: "Created worktree",
      }),
    );
    runWorktreeActionMock.mockImplementation((options) => {
      options.onStarted?.();
      return Promise.resolve(ok({ exitProcessCode: 0 }));
    });

    await createHandler(["feature", "--exec", "echo hello"]);

    strictEqual(runPostCreateWorktreeMock.mock.calls.length, 1);
    strictEqual(exitMock.mock.calls[0][0], 0);
    strictEqual(exitWithSuccessMock.mock.calls.length, 0);
  });

  it("starts post-create when the requested action starts", async () => {
    resetMocks();
    let resolveAction!: (result: unknown) => void;
    runCreateWorktreeMock.mockResolvedValue(
      ok({
        gitRoot: "/repo",
        worktreesDirectory: "/repo/.git/phantom/worktrees",
        name: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
        message: "Created worktree",
      }),
    );
    runWorktreeActionMock.mockImplementation((options) => {
      options.onStarted?.();
      return new Promise((resolve) => {
        resolveAction = resolve;
      });
    });

    const handler = createHandler(["feature", "--shell"]);

    await vi.waitFor(() => {
      strictEqual(runPostCreateWorktreeMock.mock.calls.length, 1);
    });
    strictEqual(exitWithSuccessMock.mock.calls.length, 0);

    resolveAction(ok({}));
    await rejects(async () => await handler, /Exit with code 0/);
  });

  it("preserves process error exit codes from core actions", async () => {
    resetMocks();
    runCreateWorktreeMock.mockResolvedValue(
      ok({
        gitRoot: "/repo",
        worktreesDirectory: "/repo/.git/phantom/worktrees",
        name: "feature",
        path: "/repo/.git/phantom/worktrees/feature",
        message: "Created worktree",
      }),
    );
    runWorktreeActionMock.mockResolvedValue(
      err(
        Object.assign(
          new Error("Command '/bin/sh' failed with exit code 127"),
          {
            exitCode: 127,
          },
        ),
      ),
    );

    await rejects(
      async () => await createHandler(["feature", "--exec", "missing-command"]),
      /Exit with code 127/,
    );

    strictEqual(exitWithErrorMock.mock.calls[0][1], 127);
  });
});
