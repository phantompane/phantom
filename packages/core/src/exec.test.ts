import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, vi } from "vitest";
import { ProcessExecutionError } from "@phantompane/process";
import { err, isErr, isOk, ok } from "@phantompane/utils";
import { WorktreeNotFoundError } from "./worktree/errors.ts";

const validateMock = vi.fn();
const spawnMock = vi.fn();

vi.doMock("./worktree/validate.ts", () => ({
  validateWorktreeExists: validateMock,
}));

vi.doMock("@phantompane/process", () => ({
  spawnProcess: spawnMock,
}));

const { execInWorktree } = await import("./exec.ts");

describe("execInWorktree", () => {
  it("should execute command successfully when worktree exists", async () => {
    validateMock.mockClear();
    spawnMock.mockClear();
    validateMock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/my-feature" }),
      ),
    );
    spawnMock.mockImplementation(() => Promise.resolve(ok({ exitCode: 0 })));

    const result = await execInWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "my-feature",
      ["npm", "test"],
      {},
    );

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      deepStrictEqual(result.value, { exitCode: 0 });
    }

    deepStrictEqual(spawnMock.mock.calls[0][0], {
      command: "npm",
      args: ["test"],
      options: {
        cwd: "/test/repo/.git/phantom/worktrees/my-feature",
        stdio: ["ignore", "inherit", "inherit"],
      },
    });
  });

  it("should return error when worktree does not exist", async () => {
    validateMock.mockClear();
    spawnMock.mockClear();
    validateMock.mockImplementation(() =>
      Promise.resolve(err(new WorktreeNotFoundError("non-existent"))),
    );

    const result = await execInWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "non-existent",
      ["npm", "test"],
      {},
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof WorktreeNotFoundError, true);
      strictEqual(result.error.message, "Worktree 'non-existent' not found");
    }

    deepStrictEqual(spawnMock.mock.calls.length, 0);
  });

  it("should handle command with single argument", async () => {
    validateMock.mockClear();
    spawnMock.mockClear();
    validateMock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
      ),
    );
    spawnMock.mockImplementation(() => Promise.resolve(ok({ exitCode: 0 })));

    await execInWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      ["ls"],
      {},
    );

    deepStrictEqual(spawnMock.mock.calls[0][0], {
      command: "ls",
      args: [],
      options: {
        cwd: "/test/repo/.git/phantom/worktrees/feature",
        stdio: ["ignore", "inherit", "inherit"],
      },
    });
  });

  it("should use inherit stdio for stdout/stderr when interactive", async () => {
    validateMock.mockClear();
    spawnMock.mockClear();

    validateMock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
      ),
    );

    spawnMock.mockImplementation(() => Promise.resolve(ok({ exitCode: 0 })));

    await execInWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      ["echo", "test"],
      {
        interactive: true,
      },
    );

    deepStrictEqual(spawnMock.mock.calls[0][0], {
      command: "echo",
      args: ["test"],
      options: {
        cwd: "/test/repo/.git/phantom/worktrees/feature",
        stdio: "inherit",
      },
    });
  });

  it("should pass through spawn process errors", async () => {
    validateMock.mockClear();
    spawnMock.mockClear();
    validateMock.mockImplementation(() =>
      Promise.resolve(
        ok({ path: "/test/repo/.git/phantom/worktrees/feature" }),
      ),
    );
    spawnMock.mockImplementation(() =>
      Promise.resolve(err(new ProcessExecutionError("false", 1))),
    );

    const result = await execInWorktree(
      "/test/repo",
      "/test/repo/.git/phantom/worktrees",
      "feature",
      ["false"],
      {},
    );

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof ProcessExecutionError, true);
      if (result.error instanceof ProcessExecutionError) {
        strictEqual(result.error.exitCode, 1);
      }
    }
  });
});
