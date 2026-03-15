import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import { ProcessSpawnError } from "@phantompane/process";
import { err, isErr, isOk, ok } from "@phantompane/shared";
import { WorktreeNotFoundError } from "./worktree/errors.ts";

const validateMock = mock.fn();
const spawnMock = mock.fn();

mock.module("./worktree/validate.ts", {
  namedExports: {
    validateWorktreeExists: validateMock,
  },
});

mock.module("@phantompane/process", {
  namedExports: {
    spawnProcess: spawnMock,
    getPhantomEnv: mock.fn((name, path) => ({
      PHANTOM: "1",
      PHANTOM_NAME: name,
      PHANTOM_PATH: path,
    })),
  },
});

const { shellInWorktree } = await import("./shell.ts");

describe("shellInWorktree", () => {
  let originalShell;

  const resetMocks = () => {
    validateMock.mock.resetCalls();
    spawnMock.mock.resetCalls();
    originalShell = process.env.SHELL;
  };

  it("should spawn shell successfully when worktree exists", async () => {
    resetMocks();
    process.env.SHELL = "/bin/bash";
    validateMock.mock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/my-feature" }),
      ),
    );
    spawnMock.mock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0 })),
    );

    const result = await shellInWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "my-feature",
    );

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      deepStrictEqual(result.value, { exitCode: 0 });
    }

    const spawnCall = spawnMock.mock.calls[0].arguments[0];
    deepStrictEqual(spawnCall.command, "/bin/bash");
    deepStrictEqual(spawnCall.args, []);
    deepStrictEqual(
      spawnCall.options?.cwd,
      "/test/repo/.git/phantom/worktrees/my-feature",
    );
    const env = spawnCall.options?.env;
    deepStrictEqual(env.PHANTOM, "1");
    deepStrictEqual(env.PHANTOM_NAME, "my-feature");
    deepStrictEqual(
      env.PHANTOM_PATH,
      "/test/repo/.git/phantom/worktrees/my-feature",
    );

    // Restore original shell
    if (originalShell !== undefined) {
      process.env.SHELL = originalShell;
    } else {
      Reflect.deleteProperty(process.env, "SHELL");
    }
  });

  it("should use /bin/sh when SHELL env var is not set", async () => {
    resetMocks();
    Reflect.deleteProperty(process.env, "SHELL");
    validateMock.mock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
      ),
    );
    spawnMock.mock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0 })),
    );

    await shellInWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
    );

    deepStrictEqual(spawnMock.mock.calls[0].arguments[0].command, "/bin/sh");

    // Restore original shell
    if (originalShell !== undefined) {
      process.env.SHELL = originalShell;
    } else {
      Reflect.deleteProperty(process.env, "SHELL");
    }
  });

  it("should return error when worktree does not exist", async () => {
    resetMocks();
    validateMock.mock.mockImplementation(() =>
      Promise.resolve(err(new WorktreeNotFoundError("non-existent"))),
    );

    const result = await shellInWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "non-existent",
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof WorktreeNotFoundError, true);
      strictEqual(result.error.message, "Worktree 'non-existent' not found");
    }

    deepStrictEqual(spawnMock.mock.calls.length, 0);
  });

  it("should pass through spawn process errors", async () => {
    resetMocks();
    validateMock.mock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
      ),
    );
    spawnMock.mock.mockImplementation(() =>
      Promise.resolve(err(new ProcessSpawnError("/bin/sh", "Shell not found"))),
    );

    const result = await shellInWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof ProcessSpawnError, true);
      strictEqual(
        result.error.message,
        "Error executing command '/bin/sh': Shell not found",
      );
    }
  });
});
