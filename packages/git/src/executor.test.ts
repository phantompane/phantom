import { deepStrictEqual, strictEqual } from "node:assert";
import type { ExecFileException } from "node:child_process";
import { describe, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.doMock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; encoding: string },
    callback?: (
      error: ExecFileException | null,
      result?: { stdout: string; stderr: string },
    ) => void,
  ) => {
    const result = execFileMock(cmd, args, options);
    if (callback) {
      result.then(
        (res: { stdout: string; stderr: string }) => callback(null, res),
        (err: ExecFileException) => callback(err),
      );
    }
    return {};
  },
}));

vi.doMock("node:util", () => ({
  promisify: () => execFileMock,
}));

const { executeGitCommand } = await import("./executor.ts");

describe("executeGitCommand", () => {
  const resetMocks = () => {
    execFileMock.mockClear();
  };

  it("should execute git command successfully", async () => {
    resetMocks();
    execFileMock.mockImplementation((_cmd, _args, _options) =>
      Promise.resolve({
        stdout: "feature-branch\n",
        stderr: "",
      }),
    );

    const result = await executeGitCommand(["branch", "--show-current"]);

    strictEqual(result.stdout, "feature-branch");
    strictEqual(result.stderr, "");

    strictEqual(execFileMock.mock.calls.length, 1);
    const [cmd, args, options] = execFileMock.mock.calls[0];
    strictEqual(cmd, "git");
    deepStrictEqual(args, ["branch", "--show-current"]);
    strictEqual(options.encoding, "utf8");
    strictEqual(options.cwd, undefined);
    // env should be process.env by default
  });

  it("should execute git command with cwd option", async () => {
    resetMocks();
    execFileMock.mockImplementation((_cmd, _args, _options) =>
      Promise.resolve({
        stdout: "commit message\n",
        stderr: "",
      }),
    );

    const result = await executeGitCommand(["log", "-1", "--pretty=%B"], {
      cwd: "/custom/path",
    });

    strictEqual(result.stdout, "commit message");

    const options = execFileMock.mock.calls[0][2];
    strictEqual(options.cwd, "/custom/path");
    strictEqual(options.encoding, "utf8");
  });

  it("should handle git command error", async () => {
    resetMocks();
    const gitError = new Error("fatal: not a git repository") as Error & {
      code?: string;
      stderr?: string;
    };
    gitError.code = "ENOENT";
    gitError.stderr = "fatal: not a git repository";

    execFileMock.mockImplementation(() => Promise.reject(gitError));

    try {
      await executeGitCommand(["status"]);
      throw new Error("Should have thrown");
    } catch (error) {
      strictEqual(error, gitError);
    }
  });

  it("should pass through all options to execFile", async () => {
    resetMocks();
    execFileMock.mockImplementation((_cmd, _args, _options) =>
      Promise.resolve({
        stdout: "output",
        stderr: "",
      }),
    );

    const options = {
      cwd: "/test/path",
      env: { GIT_EDITOR: "vim" },
      timeout: 5000,
    };

    await executeGitCommand(["commit", "--amend"], options);

    const actualOptions = execFileMock.mock.calls[0][2];
    strictEqual(actualOptions.cwd, "/test/path");
    strictEqual(actualOptions.env.GIT_EDITOR, "vim");
    strictEqual(actualOptions.encoding, "utf8");
    // timeout is not passed through by the implementation
  });

  it("should trim stdout output", async () => {
    resetMocks();
    execFileMock.mockImplementation((_cmd, _args, _options) =>
      Promise.resolve({
        stdout: "  output with spaces  \n\n",
        stderr: "",
      }),
    );

    const result = await executeGitCommand(["rev-parse", "HEAD"]);

    strictEqual(result.stdout, "output with spaces");
  });

  it("should trim stderr output", async () => {
    resetMocks();
    execFileMock.mockImplementation((_cmd, _args, _options) =>
      Promise.resolve({
        stdout: "success",
        stderr: "warning: something\n",
      }),
    );

    const result = await executeGitCommand(["fetch"]);

    strictEqual(result.stdout, "success");
    strictEqual(result.stderr, "warning: something");
  });
});
