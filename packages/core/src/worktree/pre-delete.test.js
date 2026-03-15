import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import { isErr, isOk } from "@phantompane/shared";

const execInWorktreeMock = mock.fn();

mock.module("../exec.ts", {
  namedExports: {
    execInWorktree: execInWorktreeMock,
  },
});

const { executePreDeleteCommands } = await import("./pre-delete.ts");
const { ok, err } = await import("@phantompane/shared");

describe("executePreDeleteCommands", () => {
  const resetPreDeleteMocks = () => {
    execInWorktreeMock.mock.resetCalls();
  };

  it("should execute pre-delete commands successfully", async () => {
    resetPreDeleteMocks();
    execInWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0, stdout: "", stderr: "" })),
    );

    const result = await executePreDeleteCommands({
      gitRoot: "/test/repo",
      worktreesDirectory: "/test/repo/.git/phantom/worktrees",
      worktreeName: "feature",
      commands: ["docker compose down", "rm -rf temp"],
    });

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      deepStrictEqual(result.value.executedCommands, [
        "docker compose down",
        "rm -rf temp",
      ]);
    }
    strictEqual(execInWorktreeMock.mock.calls.length, 2);
  });

  it("should handle command execution failure", async () => {
    resetPreDeleteMocks();
    execInWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(err(new Error("Command failed"))),
    );

    const result = await executePreDeleteCommands({
      gitRoot: "/test/repo",
      worktreesDirectory: "/test/repo/.git/phantom/worktrees",
      worktreeName: "feature",
      commands: ["docker compose down"],
    });

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(
        result.error.message,
        'Failed to execute pre-delete command "docker compose down": Command failed',
      );
    }
    strictEqual(execInWorktreeMock.mock.calls.length, 1);
  });

  it("should handle command exit code failure", async () => {
    resetPreDeleteMocks();
    execInWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 1, stdout: "", stderr: "Error" })),
    );

    const result = await executePreDeleteCommands({
      gitRoot: "/test/repo",
      worktreesDirectory: "/test/repo/.git/phantom/worktrees",
      worktreeName: "feature",
      commands: ["docker compose down"],
    });

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(
        result.error.message,
        "Pre-delete command failed with exit code 1: docker compose down",
      );
    }
    strictEqual(execInWorktreeMock.mock.calls.length, 1);
  });

  it("should stop execution on first command failure", async () => {
    resetPreDeleteMocks();
    execInWorktreeMock.mock.mockImplementationOnce(() =>
      Promise.resolve(ok({ exitCode: 1, stdout: "", stderr: "Error" })),
    );

    const result = await executePreDeleteCommands({
      gitRoot: "/test/repo",
      worktreesDirectory: "/test/repo/.git/phantom/worktrees",
      worktreeName: "feature",
      commands: ["echo 'first'", "exit 1", "echo 'should not run'"],
    });

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(
        result.error.message,
        "Pre-delete command failed with exit code 1: echo 'first'",
      );
    }
    strictEqual(execInWorktreeMock.mock.calls.length, 1);
  });
});
