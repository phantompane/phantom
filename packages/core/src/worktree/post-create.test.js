import { deepStrictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import { err, ok } from "@phantompane/shared";

const execInWorktreeMock = mock.fn();
const consoleLogMock = mock.fn();

mock.module("../exec.ts", {
  namedExports: {
    execInWorktree: execInWorktreeMock,
  },
});

// Mock console.log
console.log = consoleLogMock;

const { executePostCreateCommands } = await import("./post-create.ts");

describe("executePostCreateCommands", () => {
  it("should execute commands successfully", async () => {
    execInWorktreeMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    execInWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 0, stdout: "", stderr: "" })),
    );

    const result = await executePostCreateCommands({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "test",
      commands: ["echo 'test'", "ls"],
    });

    deepStrictEqual(result.value.executedCommands, ["echo 'test'", "ls"]);
    deepStrictEqual(execInWorktreeMock.mock.calls.length, 2);
    deepStrictEqual(consoleLogMock.mock.calls.length, 2);
    deepStrictEqual(
      consoleLogMock.mock.calls[0].arguments[0],
      "Executing: echo 'test'",
    );
    deepStrictEqual(consoleLogMock.mock.calls[1].arguments[0], "Executing: ls");
    deepStrictEqual(execInWorktreeMock.mock.calls[0].arguments[3], [
      process.env.SHELL || "/bin/sh",
      "-c",
      "echo 'test'",
    ]);
    deepStrictEqual(execInWorktreeMock.mock.calls[1].arguments[3], [
      process.env.SHELL || "/bin/sh",
      "-c",
      "ls",
    ]);
  });

  it("should return error if command execution fails", async () => {
    execInWorktreeMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    execInWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(err(new Error("Command execution failed"))),
    );

    const result = await executePostCreateCommands({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "test",
      commands: ["invalid-command"],
    });

    deepStrictEqual(result.ok, false);
    deepStrictEqual(
      result.error.message,
      'Failed to execute post-create command "invalid-command": Command execution failed',
    );
  });

  it("should return error if command exits with non-zero code", async () => {
    execInWorktreeMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    execInWorktreeMock.mock.mockImplementation(() =>
      Promise.resolve(ok({ exitCode: 1, stdout: "", stderr: "Error" })),
    );

    const result = await executePostCreateCommands({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "test",
      commands: ["exit 1"],
    });

    deepStrictEqual(result.ok, false);
    deepStrictEqual(
      result.error.message,
      "Post-create command failed with exit code 1: exit 1",
    );
  });

  it("should execute multiple commands in sequence", async () => {
    let callCount = 0;
    execInWorktreeMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    execInWorktreeMock.mock.mockImplementation(() => {
      callCount++;
      return Promise.resolve(ok({ exitCode: 0, stdout: "", stderr: "" }));
    });

    const result = await executePostCreateCommands({
      gitRoot: "/repo",
      worktreesDirectory: "/repo/.git/phantom/worktrees",
      worktreeName: "test",
      commands: ["cmd1", "cmd2", "cmd3"],
    });

    deepStrictEqual(result.value.executedCommands, ["cmd1", "cmd2", "cmd3"]);
    deepStrictEqual(callCount, 3);
  });

  it("should stop execution on first failed command", async () => {
    let callCount = 0;
    execInWorktreeMock.mock.resetCalls();
    consoleLogMock.mock.resetCalls();
    execInWorktreeMock.mock.mockImplementation(() => {
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

    deepStrictEqual(result.ok, false);
    deepStrictEqual(callCount, 2); // Should stop after second command fails
    deepStrictEqual(
      result.error.message,
      "Post-create command failed with exit code 1: cmd2",
    );
  });
});
