import { deepStrictEqual } from "node:assert";
import { describe, it, vi } from "vitest";
import { err, isErr, isOk, ok } from "@phantompane/shared";

const execInWorktreeMock = vi.fn();
const logger = {
  log: vi.fn(),
};

vi.doMock("../exec.ts", () => ({
  execInWorktree: execInWorktreeMock,
}));

const { executePostCreateCommands } = await import("./post-create.ts");

describe("executePostCreateCommands", () => {
  it("should execute commands successfully", async () => {
    execInWorktreeMock.mockClear();
    logger.log.mockClear();
    execInWorktreeMock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0, stdout: "", stderr: "" })),
    );

    const result = await executePostCreateCommands({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "test",
      commands: ["echo 'test'", "ls"],
      logger,
    });

    deepStrictEqual(isOk(result), true);
    if (isOk(result)) {
      deepStrictEqual(result.value.executedCommands, ["echo 'test'", "ls"]);
    }
    deepStrictEqual(execInWorktreeMock.mock.calls.length, 2);
    deepStrictEqual(logger.log.mock.calls.length, 2);
    deepStrictEqual(logger.log.mock.calls[0][0], "Executing: echo 'test'");
    deepStrictEqual(logger.log.mock.calls[1][0], "Executing: ls");
    deepStrictEqual(execInWorktreeMock.mock.calls[0][3], [
      process.env.SHELL || "/bin/sh",
      "-c",
      "echo 'test'",
    ]);
    deepStrictEqual(execInWorktreeMock.mock.calls[1][3], [
      process.env.SHELL || "/bin/sh",
      "-c",
      "ls",
    ]);
  });

  it("should return error if command execution fails", async () => {
    execInWorktreeMock.mockClear();
    logger.log.mockClear();
    execInWorktreeMock.mockImplementation(() =>
      Promise.resolve(err(new Error("Command execution failed"))),
    );

    const result = await executePostCreateCommands({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "test",
      commands: ["invalid-command"],
    });

    deepStrictEqual(isErr(result), true);
    if (isErr(result)) {
      deepStrictEqual(
        result.error.message,
        'Failed to execute post-create command "invalid-command": Command execution failed',
      );
    }
  });

  it("should return error if command exits with non-zero code", async () => {
    execInWorktreeMock.mockClear();
    logger.log.mockClear();
    execInWorktreeMock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 1, stdout: "", stderr: "Error" })),
    );

    const result = await executePostCreateCommands({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "test",
      commands: ["exit 1"],
    });

    deepStrictEqual(isErr(result), true);
    if (isErr(result)) {
      deepStrictEqual(
        result.error.message,
        "Post-create command failed with exit code 1: exit 1",
      );
    }
  });

  it("should execute multiple commands in sequence", async () => {
    let callCount = 0;
    execInWorktreeMock.mockClear();
    logger.log.mockClear();
    execInWorktreeMock.mockImplementation(() => {
      callCount++;
      return Promise.resolve(ok({ exitCode: 0, stdout: "", stderr: "" }));
    });

    const result = await executePostCreateCommands({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "test",
      commands: ["cmd1", "cmd2", "cmd3"],
    });

    deepStrictEqual(isOk(result), true);
    if (isOk(result)) {
      deepStrictEqual(result.value.executedCommands, ["cmd1", "cmd2", "cmd3"]);
    }
    deepStrictEqual(callCount, 3);
  });

  it("should stop execution on first failed command", async () => {
    let callCount = 0;
    execInWorktreeMock.mockClear();
    logger.log.mockClear();
    execInWorktreeMock.mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        return Promise.resolve(ok({ exitCode: 1, stdout: "", stderr: "" }));
      }
      return Promise.resolve(ok({ exitCode: 0, stdout: "", stderr: "" }));
    });

    const result = await executePostCreateCommands({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "test",
      commands: ["cmd1", "cmd2", "cmd3"],
    });

    deepStrictEqual(isErr(result), true);
    deepStrictEqual(callCount, 2); // Should stop after second command fails
    if (isErr(result)) {
      deepStrictEqual(
        result.error.message,
        "Post-create command failed with exit code 1: cmd2",
      );
    }
  });
});
