import { deepStrictEqual, strictEqual } from "node:assert";
// import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it, vi } from "vitest";
import { isErr, isOk } from "@phantompane/utils";
import {
  ProcessExecutionError,
  ProcessSignalError,
  ProcessSpawnError,
} from "./errors.ts";

const spawnMock = vi.fn();

vi.doMock("node:child_process", () => ({
  spawn: spawnMock,
}));

const { spawnProcess } = await import("./spawn.ts");

describe("spawnProcess", () => {
  it("should spawn a process successfully with exit code 0", async () => {
    const mockChildProcess = new EventEmitter();
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        mockChildProcess.emit("exit", 0, null);
      }, 0);
      return mockChildProcess;
    });

    const result = await spawnProcess({
      command: "echo",
      args: ["hello"],
      options: { cwd: "/test/dir" },
    });

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(result.value.exitCode, 0);
    }

    strictEqual(spawnMock.mock.calls.length, 1);
    deepStrictEqual(spawnMock.mock.calls[0], [
      "echo",
      ["hello"],
      { stdio: "inherit", cwd: "/test/dir" },
    ]);
  });

  it("should handle process with non-zero exit code", async () => {
    const mockChildProcess = new EventEmitter();
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        mockChildProcess.emit("exit", 1, null);
      }, 0);
      return mockChildProcess;
    });

    const result = await spawnProcess({
      command: "false",
    });

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof ProcessExecutionError, true);
      if (result.error instanceof ProcessExecutionError) {
        strictEqual(result.error.exitCode, 1);
        strictEqual(
          result.error.message,
          "Command 'false' failed with exit code 1",
        );
      }
    }

    strictEqual(spawnMock.mock.calls.length, 1);
    deepStrictEqual(spawnMock.mock.calls[0], [
      "false",
      [],
      { stdio: "inherit" },
    ]);
  });

  it("should handle process termination by SIGTERM signal", async () => {
    const mockChildProcess = new EventEmitter();
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        mockChildProcess.emit("exit", null, "SIGTERM");
      }, 0);
      return mockChildProcess;
    });

    const result = await spawnProcess({
      command: "sleep",
      args: ["100"],
    });

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof ProcessSignalError, true);
      if (result.error instanceof ProcessSignalError) {
        strictEqual(result.error.exitCode, 143); // 128 + 15 (SIGTERM)
        strictEqual(
          result.error.message,
          "Command terminated by signal: SIGTERM",
        );
      }
    }
  });

  it("should handle process termination by other signals", async () => {
    const mockChildProcess = new EventEmitter();
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        mockChildProcess.emit("exit", null, "SIGKILL");
      }, 0);
      return mockChildProcess;
    });

    const result = await spawnProcess({
      command: "sleep",
      args: ["100"],
    });

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof ProcessSignalError, true);
      if (result.error instanceof ProcessSignalError) {
        strictEqual(result.error.exitCode, 129); // 128 + 1 (default for non-SIGTERM)
        strictEqual(
          result.error.message,
          "Command terminated by signal: SIGKILL",
        );
      }
    }
  });

  it("should handle spawn errors", async () => {
    const mockChildProcess = new EventEmitter();
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        mockChildProcess.emit("error", new Error("Command not found"));
      }, 0);
      return mockChildProcess;
    });

    const result = await spawnProcess({
      command: "nonexistent-command",
    });

    strictEqual(isErr(result), true);
    if (isErr(result)) {
      strictEqual(result.error instanceof ProcessSpawnError, true);
      strictEqual(
        result.error.message,
        "Error executing command 'nonexistent-command': Command not found",
      );
      strictEqual(result.error.exitCode, undefined);
    }
  });

  it("should use default values when args and options are not provided", async () => {
    const mockChildProcess = new EventEmitter();
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        mockChildProcess.emit("exit", 0, null);
      }, 0);
      return mockChildProcess;
    });

    const result = await spawnProcess({
      command: "ls",
    });

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(result.value.exitCode, 0);
    }

    strictEqual(spawnMock.mock.calls.length, 1);
    deepStrictEqual(spawnMock.mock.calls[0], ["ls", [], { stdio: "inherit" }]);
  });

  it("should handle null exit code0", async () => {
    const mockChildProcess = new EventEmitter();
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        mockChildProcess.emit("exit", null, null);
      }, 0);
      return mockChildProcess;
    });

    const result = await spawnProcess({
      command: "echo",
    });

    strictEqual(isOk(result), true);
    if (isOk(result)) {
      strictEqual(result.value.exitCode, 0);
    }
  });

  it("should merge provided options with default stdio option", async () => {
    const mockChildProcess = new EventEmitter();
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        mockChildProcess.emit("exit", 0, null);
      }, 0);
      return mockChildProcess;
    });

    const customEnv = { PATH: "/usr/bin", CUSTOM: "value" };

    const result = await spawnProcess({
      command: "node",
      args: ["--version"],
      options: {
        cwd: "/test/dir",
        env: customEnv,
      },
    });

    strictEqual(isOk(result), true);

    strictEqual(spawnMock.mock.calls.length, 1);
    deepStrictEqual(spawnMock.mock.calls[0], [
      "node",
      ["--version"],
      {
        stdio: "inherit",
        cwd: "/test/dir",
        env: customEnv,
      },
    ]);
  });
});
